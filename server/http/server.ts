import Fastify, {
  LogController,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifySSE from '@fastify/sse';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { STATUS_CODES } from 'node:http';
import { Store } from '../store.ts';
import {
  RoomService,
  USER_COUNT_REFRESH_INTERVAL_MS,
} from '../rooms/service.ts';
import { AccountService } from '../accounts.ts';
import { HttpError, requireValue } from '../errors.ts';
import { registerDocumentRoutes } from './documents.ts';
import { FlashAccounts } from '../flash/accounts.ts';
import { FlashService } from '../flash/service.ts';
import { attachFlashWebSocket } from '../flash/transport.ts';
import { registerFlashRoutes } from '../flash/http.ts';
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const defaultRuffleDirectory = resolve(require.resolve('@ruffle-rs/ruffle'), '..');
const defaultAllowedOrigins = [
  'https://godfield.net',
  'https://www.godfield.net',
];
const corsAllowHeaders = 'authorization, content-type';
const corsAllowMethods = 'GET, POST, DELETE, OPTIONS';
const extensionOriginProtocols = new Set([
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
]);
function isExtensionOrigin(origin: string) {
  try {
    return extensionOriginProtocols.has(new URL(origin).protocol);
  } catch {
    return false;
  }
}

function addCrossOriginHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  origin: string,
) {
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Vary', 'Origin');
  reply.header('Access-Control-Allow-Headers', corsAllowHeaders);
  reply.header('Access-Control-Allow-Methods', corsAllowMethods);
  reply.header('Access-Control-Max-Age', '600');
  if (request.headers['access-control-request-private-network'] === 'true') {
    reply.header('Access-Control-Allow-Private-Network', 'true');
  }
}

interface ServerOptions {
  store?: Store;
  botInterval?: number;
  assets?: string;
  allowedOrigins?: Iterable<string>;
  flashAssets?: string;
  flashStartingCredits?: number;
  flashRuffle?: string;
}
export async function createServer({
  store = new Store(),
  botInterval = 500,
  assets = resolve(repositoryRoot, 'public'),
  allowedOrigins = [],
  flashAssets = resolve(repositoryRoot, 'public/flash/assets'),
  flashStartingCredits = 1000,
  flashRuffle = defaultRuffleDirectory,
}: ServerOptions = {}) {
  const rooms = new RoomService(store);
  const accounts = new AccountService(store);
  const flash = new FlashService(undefined, new FlashAccounts(store, flashStartingCredits));
  const crossOriginAllowlist = new Set([
    ...defaultAllowedOrigins,
    ...allowedOrigins,
  ]);
  const server = Fastify({
    bodyLimit: 65536,
    forceCloseConnections: true,
    logger: {
      level: 'error',
    },
    logController: new LogController({
      disableRequestLogging: true,
    }),
  });
  const authenticateRequest = (request: FastifyRequest) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    return accounts.authenticate(
      request.headers.authorization?.replace(/^Bearer /, '') ??
        requestUrl.searchParams.get('token'),
    );
  };
  server.addHook('onRequest', async (request, reply) => {
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      let originHost: string;
      try {
        originHost = new URL(requestOrigin).host;
      } catch {
        throw new HttpError(403);
      }
      const isCrossOrigin = originHost !== request.headers.host;
      if (isCrossOrigin) {
        const isAllowedOrigin =
          crossOriginAllowlist.has(requestOrigin) ||
          isExtensionOrigin(requestOrigin);
        requireValue(isAllowedOrigin, 403);
        addCrossOriginHeaders(request, reply, requestOrigin);
      }
    }
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
    if (
      request.url.startsWith('/api/') &&
      !(request.method === 'POST' && request.url.split('?')[0] === '/api/auth')
    ) {
      authenticateRequest(request);
    }
  });
  server.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof HttpError
        ? error.status
        : ((
            error as {
              statusCode?: number;
            }
          ).statusCode ?? 500);
    if (status >= 500) {
      request.log.error(error);
    }
    const message =
      error instanceof HttpError
        ? error.message
        : `${status} ${STATUS_CODES[status] ?? 'Error'}\n`;
    void reply.code(status).type('text/plain; charset=utf-8').send(message);
  });
  server.setNotFoundHandler((request, reply) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      /^\/(images|audio)\/[a-zA-Z0-9_./-]+$/.test(path)
    ) {
      return reply.redirect(`https://godfield.net${path}`);
    }
    return reply
      .code(404)
      .type('text/plain; charset=utf-8')
      .send('404 Not Found\n');
  });
  await server.register(fastifySSE, {
    heartbeatInterval: 15000,
  });
  await server.register(fastifyStatic, {
    root: resolve(assets),
    index: false,
  });
  registerFlashRoutes(server, flash, { assets: flashAssets, ruffle: flashRuffle });
  const closeFlashWebSocket = attachFlashWebSocket(server.server, flash);
  server.addHook('preClose', async () => {
    closeFlashWebSocket();
  });
  server.post('/api/auth', async () => accounts.create());
  server.delete('/api/auth', async (request) => {
    accounts.delete(authenticateRequest(request));
    return {};
  });
  server.addHook('onSend', async (request, reply, payload) => {
    if (
      request.url.startsWith('/api/') &&
      !request.url.startsWith('/api/watch')
    ) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
  registerDocumentRoutes(server, store, authenticateRequest);
  server.post<{
    Params: {
      action: string;
    };
  }>('/api/functions/:action', async (request, reply) => {
    const payload = request.body ?? {};
    const action = request.params.action;
    try {
      const result = rooms.invoke(
        action,
        authenticateRequest(request),
        payload,
      );
      const actionPayload =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : {};
      request.log.info(
        {
          action,
          mode: actionPayload.mode,
          roomId:
            actionPayload.roomId ??
            (typeof result === 'object' && result !== null
              ? (result as Record<string, unknown>).roomId
              : undefined),
          requestId: request.id,
        },
        'Room action completed',
      );
      return result === null ? reply.code(200).send() : reply.send(result);
    } catch (error) {
      request.log.warn(
        {
          action,
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Room action failed',
      );
      throw error;
    }
  });
  server.get('/', (_request, reply) =>
    reply.sendFile('index.html', resolve(repositoryRoot, 'server')),
  );
  server.get('/main.dart.js', (_request, reply) =>
    reply.sendFile('main.dart.js', resolve(repositoryRoot, 'dist')),
  );
  const botTimer =
    botInterval > 0
      ? setInterval(() => {
          try {
            rooms.advanceBotTurns();
            flash.tick();
          } catch (error) {
            server.log.error(error, 'Bot turn failed');
          }
        }, botInterval)
      : null;
  const userCountTimer = setInterval(() => {
    try {
      rooms.refreshUserCounts();
    } catch (error) {
      server.log.error(error, 'User count refresh failed');
    }
  }, USER_COUNT_REFRESH_INTERVAL_MS);
  userCountTimer.unref();
  server.addHook('onClose', async () => {
    if (botTimer) {
      clearInterval(botTimer);
    }
    clearInterval(userCountTimer);
  });
  if (!store.get('status/user_count')) {
    store.set('status/user_count', {
      training: 0,
      private: 0,
      duel: 0,
    });
  }
  if (!store.get('status/min_version')) {
    store.set('status/min_version', {
      android: '1.5.31',
    });
  }
  return {
    server,
    store,
    rooms,
    flash,
  };
}
