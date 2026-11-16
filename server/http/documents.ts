import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../store.ts';
import type { Room, StoredDocument } from '../types.ts';
import { requireValue } from '../errors.ts';

export function canReadDocument(
  store: Store,
  path: string,
  userId: string,
): boolean {
  if (
    path === 'status/user_count' ||
    path === 'status/min_version' ||
    path === 'rankings/duel' ||
    path === `records/${userId}`
  ) {
    return true;
  }
  const documentMatch =
    /^modes\/(training|private|duel)\/rooms\/([^/]+)(?:\/messages\/(all|team[1-4]))?$/.exec(
      path,
    );
  if (!documentMatch) {
    return false;
  }
  const [, mode, roomId, channel] = documentMatch;
  // The official client subscribes before joining. Actions and chat require membership.
  if (!channel) {
    return true;
  }
  const room = store.get<Room>(
    `modes/${mode}/rooms/${roomId}`,
  );
  if (!room) {
    return true;
  }
  if (!room.users.some((user) => user.id === userId)) {
    return false;
  }
  if (channel.startsWith('team')) {
    return (
      room.game?.players.some(
        (player) =>
          player.userId === userId &&
          `team${player.team}` === channel,
      ) ?? false
    );
  }
  return true;
}

export function registerDocumentRoutes(
  server: FastifyInstance,
  store: Store,
  authenticateRequest: (request: FastifyRequest) => string,
): void {
  function getAuthorizedDocument(request: FastifyRequest): {
    path: string;
    userId: string;
  } {
    const userId = authenticateRequest(request);
    const path = new URL(request.url, 'http://localhost').searchParams.get(
      'path',
    );
    requireValue(path && canReadDocument(store, path, userId), 403);
    return {
      path,
      userId,
    };
  }

  server.get('/api/doc', async (request, reply) => {
    const { path } = getAuthorizedDocument(request);
    return reply.send(store.get(path));
  });
  server.get(
    '/api/watch',
    {
      sse: 'manual',
    },
    async (request, reply) => {
      const { path, userId } = getAuthorizedDocument(request);
      reply.sse.keepAlive();
      const sendSnapshot = (value: StoredDocument | null) => {
        if (!canReadDocument(store, path, userId)) {
          reply.sse.close();
          return;
        }
        void reply.sse
          .send({
            data: value,
          })
          .catch(() => reply.sse.close());
      };
      const roomPath = path.includes('/messages/')
        ? path.split('/messages/')[0]
        : null;
      const closeIfAccessRevoked = () => {
        if (!canReadDocument(store, path, userId)) {
          reply.sse.close();
        }
      };
      store.on(path, sendSnapshot);
      if (roomPath) {
        store.on(roomPath, closeIfAccessRevoked);
      }
      reply.sse.onClose(() => {
        store.off(path, sendSnapshot);
        if (roomPath) {
          store.off(roomPath, closeIfAccessRevoked);
        }
      });
      sendSnapshot(store.get(path));
    },
  );
}
