import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBridge } from '../src/services/local.ts';

test('local document watchers consume snapshots without a presence API', async () => {
  const originalEventSource = globalThis.EventSource;
  const originalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const subscriptions = [];
  const snapshots = [];
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ uid: 'owner', token: 'owner-token' }),
  };
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.isClosed = false;
      subscriptions.push(this);
    }

    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    }

    close() {
      this.isClosed = true;
    }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true };
  };

  try {
    const bridge = createLocalBridge();
    const unsubscribe = bridge.onSnapshot('modes/training/rooms/test', (snapshot) => {
      snapshots.push(snapshot.data());
    });
    const subscription = subscriptions[0];
    subscription.onmessage({ data: JSON.stringify({ users: [{ id: 'owner' }] }) });
    assert.deepEqual(snapshots, [{ users: [{ id: 'owner' }] }]);
    assert.equal(requests.length, 0);
    unsubscribe();
    assert.equal(subscription.isClosed, true);
  } finally {
    globalThis.EventSource = originalEventSource;
    globalThis.localStorage = originalStorage;
    globalThis.fetch = originalFetch;
  }
});
