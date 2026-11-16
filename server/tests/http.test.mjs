import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../http/server.ts';
async function identity(server) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/auth',
  });
  assert.equal(response.statusCode, 200);
  const account = response.json();
  assert.match(account.uid, /^[A-Za-z0-9]{28}$/);
  return account;
}
test('native clients can read minimum-version status without widening document access', async () => {
  const { server, store } = await createServer({
    botInterval: 0,
  });
  try {
    const { token } = await identity(server);
    const headers = {
      authorization: `Bearer ${token}`,
    };
    const url = '/api/doc?path=status/min_version';
    const initial = await server.inject({ url, headers });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(initial.json(), { android: '1.5.31' });
    const versionStatus = { android: '1.5.32' };
    store.set('status/min_version', versionStatus);
    const configured = await server.inject({ url, headers });
    assert.equal(configured.statusCode, 200);
    assert.deepEqual(configured.json(), versionStatus);
    assert.equal((await server.inject({ url })).statusCode, 403);
    const unrelated = await server.inject({
      url: '/api/doc?path=status/internal',
      headers,
    });
    assert.equal(unrelated.statusCode, 403);
  } finally {
    await server.close();
  }
});
test('Fastify handles JSON errors, request limits, auth and empty success responses', async () => {
  const { server } = await createServer({
    botInterval: 0,
  });
  try {
    const { token } = await identity(server);
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    for (const [payload, status] of [
      ['{', 400],
      [
        JSON.stringify({
          text: 'x'.repeat(65536),
        }),
        413,
      ],
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/functions/update-account',
        headers,
        payload,
      });
      assert.equal(response.statusCode, status);
      assert.equal(
        response.body,
        `${status} ${status === 400 ? 'Bad Request' : 'Payload Too Large'}\n`,
      );
    }
    const ok = await server.inject({
      method: 'POST',
      url: '/api/functions/update-account',
      headers,
      payload: '{}',
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body, '');
    const forbidden = await server.inject({
      method: 'POST',
      url: '/api/functions/update-account',
      headers: {
        'content-type': 'application/json',
      },
      payload: '{',
    });
    assert.equal(
      forbidden.statusCode,
      403,
      'authentication precedes body parsing',
    );
    for (const origin of ['https://example.com', 'null', 'invalid origin']) {
      const response = await server.inject({
        url: '/api/doc?path=status/min_version',
        headers: {
          ...headers,
          origin,
        },
      });
      assert.equal(response.statusCode, 403);
    }
    const absent = await server.inject({
      url: '/api/doc?path=rankings/duel',
      headers,
    });
    assert.equal(absent.statusCode, 200);
    assert.equal(absent.body, 'null');
    assert.equal(absent.headers['cache-control'], 'no-store');
    const unknown = await server.inject({
      method: 'POST',
      url: '/api/functions/unknown',
      headers,
      payload: '{}',
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.body, '404 Not Found\n');
    const deleted = await server.inject({
      method: 'DELETE',
      url: '/api/auth',
      headers: {
        authorization: headers.authorization,
      },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(
      (
        await server.inject({
          url: '/api/doc?path=status/user_count',
          headers,
        })
      ).statusCode,
      403,
    );
  } finally {
    await server.close();
  }
});
test('user count reads use the periodic aggregate document', async () => {
  const { server, rooms, store } = await createServer({
    botInterval: 0,
  });
  try {
    const { token, uid } = await identity(server);
    rooms.invoke('create-room', uid, {
      mode: 'training',
      userName: 'Prophet',
    });

    const readCount = async () => {
      const response = await server.inject({
        url: '/api/doc?path=status/user_count',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(response.statusCode, 200);
      return response.json();
    };
    const beforeRefresh = await readCount();
    assert.equal(beforeRefresh.training, 0);
    assert.equal('updatedAt' in beforeRefresh, false);

    rooms.publishUserCounts();
    const afterRefresh = await readCount();
    assert.equal(afterRefresh.training, 1);
    assert.deepEqual(store.get('status/user_count'), afterRefresh);
  } finally {
    await server.close();
  }
});
test('cross-origin requests from the official client pass CORS preflight', async () => {
  const { server } = await createServer({
    botInterval: 0,
    allowedOrigins: ['https://custom.example'],
  });
  try {
    const { token } = await identity(server);
    const authHeaders = {
      authorization: `Bearer ${token}`,
    };
    for (const origin of [
      'https://godfield.net',
      'https://www.godfield.net',
      'https://custom.example',
    ]) {
      const response = await server.inject({
        url: '/api/doc?path=status/min_version',
        headers: {
          ...authHeaders,
          origin,
        },
      });
      assert.equal(response.statusCode, 200, origin);
      assert.equal(response.headers['access-control-allow-origin'], origin);
      assert.equal(response.headers['access-control-allow-headers'], 'authorization, content-type');
    }
    const preflight = await server.inject({
      method: 'OPTIONS',
      url: '/api/functions/update-account',
      headers: {
        origin: 'https://godfield.net',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(
      preflight.headers['access-control-allow-origin'],
      'https://godfield.net',
    );
    assert.equal(preflight.headers['access-control-allow-methods'], 'GET, POST, DELETE, OPTIONS');
    assert.equal(preflight.headers['access-control-max-age'], '600');
    const unauthenticated = await server.inject({
      method: 'POST',
      url: '/api/functions/update-account',
      headers: {
        origin: 'https://godfield.net',
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    assert.equal(unauthenticated.statusCode, 403);
    assert.equal(
      unauthenticated.headers['access-control-allow-origin'],
      'https://godfield.net',
      'error responses must stay readable by the cross-origin client',
    );
    const extension = await server.inject({
      url: '/api/doc?path=status/min_version',
      headers: {
        ...authHeaders,
        origin: 'chrome-extension://abcdefghijklmnop',
      },
    });
    assert.equal(extension.statusCode, 200);
    assert.equal(
      extension.headers['access-control-allow-origin'],
      'chrome-extension://abcdefghijklmnop',
    );
    const rejected = await server.inject({
      url: '/api/doc?path=status/min_version',
      headers: {
        ...authHeaders,
        origin: 'https://example.com',
      },
    });
    assert.equal(rejected.statusCode, 403);
  } finally {
    await server.close();
  }
});
test('the static asset route serves files and HEAD requests without exposing server files', async () => {
  const assets = await mkdtemp(join(tmpdir(), 'godfield-assets-'));
  await writeFile(join(assets, 'fixture.json'), '{}');
  const { server } = await createServer({
    botInterval: 0,
    assets,
  });
  try {
    const get = await server.inject('/fixture.json');
    assert.equal(get.statusCode, 200);
    assert.equal(get.body, '{}');
    assert.match(get.headers['content-type'], /application\/json/);
    const head = await server.inject({
      method: 'HEAD',
      url: '/fixture.json',
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    const index = await server.inject('/');
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /godfieldLocalServer/);
    assert.equal((await server.inject('/main.dart.js')).statusCode, 200);
    for (const path of [
      '/server/start.ts',
      '/package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2fpackage.json',
    ]) {
      assert.equal((await server.inject(path)).statusCode, 404, path);
    }
    const missing = await server.inject('/images/missing.webp');
    assert.equal(missing.statusCode, 302);
    assert.equal(
      missing.headers.location,
      'https://godfield.net/images/missing.webp',
    );
    assert.equal((await server.inject('/missing')).statusCode, 404);
  } finally {
    await server.close();
    await rm(assets, {
      recursive: true,
      force: true,
    });
  }
});
async function waitUntil(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }

  assert.ok(predicate(), 'subscription listener was not released');
}
async function readSnapshot(reader) {
  let frame = '';
  while (!frame.includes('\n\n')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    frame += new TextDecoder().decode(value);
  }

  return JSON.parse(frame.split('\n\n')[0].slice('data: '.length));
}
test('SSE sends null snapshots and releases subscriptions on disconnect and shutdown', async () => {
  const { server, store } = await createServer({
    botInterval: 0,
  });
  const base = await server.listen({
    host: '127.0.0.1',
    port: 0,
  });
  const { token } = await identity(server);
  const path = 'rankings/duel';
  const abort = new AbortController();
  try {
    const url = `${base}/api/watch?path=${path}&token=${token}`;
    const response = await fetch(url, {
      signal: abort.signal,
      headers: {
        Accept: 'text/event-stream',
      },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(await readSnapshot(response.body.getReader()), null);
    assert.equal(store.listenerCount(path), 1);
    abort.abort();
    await waitUntil(() => store.listenerCount(path) === 0);
    const live = await fetch(url);
    await readSnapshot(live.body.getReader());
    assert.equal(store.listenerCount(path), 1);
    await server.close();
    await waitUntil(() => store.listenerCount(path) === 0);
  } finally {
    abort.abort();
    await server.close();
  }
});

test('local watch API has no application-level heartbeat endpoint', async () => {
  const { server } = await createServer({ botInterval: 0 });
  try {
    const { token } = await identity(server);
    const response = await server.inject({
      method: 'POST',
      url: '/api/watch/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: { connectionId: 'obsolete' },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await server.close();
  }
});

test('chat SSE closes when room membership is revoked', async () => {
  const { server, rooms, store } = await createServer({
    botInterval: 0,
  });
  const base = await server.listen({
    host: '127.0.0.1',
    port: 0,
  });
  const owner = await identity(server);
  const visitor = await identity(server);
  const abort = new AbortController();
  try {
    const { roomId } = rooms.invoke('create-room', owner.uid, {
      mode: 'private',
      userName: 'Owner',
      password: 'chat-test',
    });
    const payload = {
      mode: 'private',
      roomId,
    };
    rooms.invoke('join-room', visitor.uid, {
      ...payload,
      userName: 'Visitor',
    });
    const path = `modes/private/rooms/${roomId}/messages/all`;
    const response = await fetch(
      `${base}/api/watch?path=${path}&token=${visitor.token}`,
      {
        signal: abort.signal,
      },
    );
    const reader = response.body.getReader();
    assert.equal(await readSnapshot(reader), null);
    rooms.invoke('kick-user', owner.uid, {
      ...payload,
      userId: visitor.uid,
    });
    assert.equal((await reader.read()).done, true);
    rooms.invoke('post-message', owner.uid, {
      ...payload,
      text: 'After kick',
    });
    await waitUntil(() => store.listenerCount(path) === 0);
    assert.equal(store.listenerCount(`modes/private/rooms/${roomId}`), 0);
  } finally {
    abort.abort();
    await server.close();
  }
});
