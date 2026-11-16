import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, requireValue } from '../errors.ts';
import type { FlashService } from './service.ts';
import { account2013 } from './accounts.ts';
import { element, tag } from './xml.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.swf': 'application/x-shockwave-flash',
  '.js': 'text/javascript', '.wasm': 'application/wasm',
};

export function registerFlashRoutes(server: FastifyInstance, service: FlashService, directories: { assets: string; ruffle: string }): void {
  server.get('/crossdomain.xml', async (_request, reply) => reply.type('application/xml').send(
    '<cross-domain-policy><allow-access-from domain="*"/><allow-http-request-headers-from domain="*" headers="*"/></cross-domain-policy>',
  ));
  server.get('/flash/', async (_request, reply) => reply.type('text/html').send(
    await readFile(resolve(root, 'server/flash/index.html'), 'utf8'),
  ));
  server.get('/flash/api/:method', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const method = (request.params as { method: string }).method;
    const query = request.query as Record<string, string>;
    const token = query.userID ?? query.fcauth ?? '';
    const localAccount = service.accounts.validToken(token);
    let content = '';
    if (method === 'getUserCount') {
      content = tag('userCount', service.maintenance ? -1 : service.sessions.size);
    } else if (method === 'getCoin') {
      const modern = localAccount ? account2013(service.accounts.get(token)) : undefined;
      content = tag('coin', modern?.coin ?? 0) + (modern?.ticket ? tag('ticket', modern.ticket) : '');
    } else if (method === 'drawLot') {
      requireValue(service.accounts.validToken(query.userID ?? ''), 403);
      const claim = service.accounts.drawLot(query.userID!);
      content = tag('coin', claim.coin) + (claim.ticket ? tag('ticket', claim.ticket) : '');
    } else if (method === 'buyCharinByMoritapo') {
      // Historical credit purchase method, unimplemented
      requireValue(localAccount, 403);
      throw new HttpError(501);
    } else if (method === 'getData') {
      const account = localAccount ? service.accounts.get(token) : undefined;
      content = tag('charin', account?.credits ?? 0) + (account?.hasPaid ? tag('hasPaid') : '');
    } else if (method === 'getRecord') {
      content = localAccount ? service.accounts.recordsXml(token) : '';
    } else if (method === 'getSpiritResult') {
      content = localAccount ? service.accounts.recordsXml(token, '2013') : '';
    } else if (method === 'getDuelResult') {
      const year = Number(query.year);
      if (!Number.isInteger(year) || year < 2010 || year > 9999) {
        throw new HttpError(400);
      }
      content = localAccount ? service.accounts.duelResultXml(token, year) : '';
    } else if (method === 'addLoginBonus') {
      requireValue(service.accounts.validToken(query.fcauth ?? ''), 403);
      content = tag('bonus', service.accounts.claimLoginBonus(query.fcauth!));
    } else if (method === 'getBook' || method === 'addBookElement') {
      requireValue(['ENGLISH', 'JAPANESE'].includes(query.language ?? 'ENGLISH'));
      const language = query.language ?? 'ENGLISH';
      if (method === 'addBookElement') {
        requireValue(service.accounts.validToken(query.userID ?? ''), 403);
        content = service.accounts.addBookElement(query.userID!, language);
      } else {
        if (!localAccount) {
          content = tag('score', 0);
        } else if (query.fcauth) {
          content = service.accounts.book2010Xml(token, language);
        } else {
          content = service.accounts.bookXml(token, language);
        }
      }
    } else {
      throw new HttpError(404);
    }
    return reply.type('application/xml').send(element('response', content));
  });
  for (const [prefix, directory] of Object.entries(directories)) {
    server.get(`/flash/${prefix}/*`, async (request, reply) => {
      const requestedPath = (request.params as Record<string, string>)['*'] ?? '';
      const isRuffleRuntimeFile = prefix !== 'ruffle'
        || requestedPath === 'ruffle.js'
        || /^core\.ruffle\.[a-f0-9]+\.js$/.test(requestedPath)
        || /^[a-f0-9]+\.wasm$/.test(requestedPath);
      if (!isRuffleRuntimeFile) {
        throw new HttpError(404);
      }
      const relative = requestedPath;
      const base = resolve(directory);
      const filename = resolve(base, relative);
      if (!filename.startsWith(`${base}${sep}`)) {
        throw new HttpError(404);
      }
      try {
        const data = await readFile(filename);
        return reply.type(mimeTypes[extname(filename)] ?? 'application/octet-stream').send(data);
      } catch {
        // The supplied art backup is newer than the 2010 UI. Reuse matching
        // panels and controls at the legacy URLs without altering the SWFs.
        let replacement: string | undefined;
        if (prefix === 'assets' && /^images\/component(?:_(?:en|ja))?\/freefight\/book\//.test(relative)) {
          replacement = relative.replace('/freefight/book/', '/offline/book/');
        } else if (prefix === 'assets' && ['images/component/offline/entrance/login_bonus.png', 'images/component/freefight/bonus.png'].includes(relative)) {
          replacement = 'images/component/duel/bonus.png';
        }
        if (replacement) {
          try {
            return reply.type(mimeTypes[extname(replacement)] ?? 'application/octet-stream').send(await readFile(resolve(base, replacement)));
          } catch {
            throw new HttpError(404);
          }
        }
        throw new HttpError(404);
      }
    });
  }
}
