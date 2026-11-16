import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRoomEvent } from '../src/app/room-page.ts';
import { getApplication, getSettings, registerApplication } from '../src/app/runtime.ts';
import { GameModePrivate } from '../src/domain/enums.ts';
import { decodeJson } from '../src/shared/collections.ts';
import { Timestamp } from '../src/shared/timestamp.ts';

for (const scenario of ['removed member', 'restoring removed member', 'manual join']) {
  test(`room membership updates handle ${scenario}`, () => {
    const originalWindow = globalThis.window;
    let originalApplication;
    try {
      originalApplication = getApplication();
    } catch {
      originalApplication = undefined;
    }

    const savedSettings = [];
    globalThis.window = {
      localStorage: {
        getItem: () => null,
        setItem(_key, value) {
          savedSettings.push(JSON.parse(value));
        },
      },
      location: {
        reload() {
          assert.fail('membership removal must return to the menu without reloading');
        },
      },
    };
    const settings = getSettings();
    const originalSettings = { ...settings };
    const menuCalls = [];
    const joinCalls = [];
    const application = {
      userId: 'user-1',
      userName: 'First',
      isRestoringRoom: scenario === 'restoring removed member',
      openHomePage(mode) {
        menuCalls.push(mode);
      },
      referenceMenu: { refreshItemsIfNeeded() {} },
    };
    registerApplication(application);

    try {
      settings.lastMode = GameModePrivate;
      settings.lastRoomId = 'timed-out-room';
      const lastGameUpdatedAt = new Timestamp(Date.now(), 0, false);
      settings.lastGameUpdatedAt = lastGameUpdatedAt;
      const room = {
        findRoomUser: () => scenario === 'removed member' ? { userId: 'user-1' } : null,
        isJoining: false,
        updateRoomState(action, refreshActivity, payload) {
          joinCalls.push({ action, refreshActivity, payload });
          return Promise.resolve(null);
        },
      };

      handleRoomEvent(room)(decodeJson({ users: [{ id: 'user-2', name: 'Second' }] }));

      if (scenario === 'manual join') {
        assert.deepEqual(menuCalls, []);
        assert.equal(joinCalls.length, 1);
        assert.equal(joinCalls[0].action, 'join-room');
        assert.equal(joinCalls[0].payload.get('userName'), 'First');
        assert.equal(room.isJoining, true);
      } else {
        assert.deepEqual(menuCalls, [null]);
        assert.deepEqual(joinCalls, []);
        assert.equal(application.isRestoringRoom, false);
        assert.equal(settings.lastRoomId, 'timed-out-room');
        assert.equal(settings.lastMode, GameModePrivate);
        assert.equal(settings.lastGameUpdatedAt, lastGameUpdatedAt);
        assert.equal(savedSettings.length, 0);
      }
    } finally {
      Object.assign(settings, originalSettings);
      registerApplication(originalApplication);
      globalThis.window = originalWindow;
    }
  });
}
