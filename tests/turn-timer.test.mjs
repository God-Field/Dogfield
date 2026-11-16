import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ItemCommandOverlay, createTurnControls } from '../src/battle/item-commands.ts';
import { RoomController } from '../src/rooms/room-controller.ts';
import { getApplication, registerApplication, state } from '../src/app/runtime.ts';
import { GameModeTraining, GameModePrivate, GameModeDuel } from '../src/domain/enums.ts';

for (const [mode, warningMs, finalMs] of [
  [GameModeTraining, 0, 0],
  [GameModePrivate, 40000, 20000],
  [GameModeDuel, 10000, 5000],
]) {
  test(`${mode.key} leaves only after its visible turn timer finishes`, async () => {
    const originalDocument = globalThis.document;
    const originalMuted = state.isMuted;
    let originalApplication;
    try {
      originalApplication = getApplication();
    } catch {
      originalApplication = undefined;
    }
    const animations = [];
    const menuCalls = [];
    const roomActions = [];
    state.isMuted = true;
    globalThis.document = {
      createElement() {
        return {
          style: { left: '', top: '', width: '', height: '' },
          animate(_frames, options) {
            let finish;
            const finished = new Promise((resolve) => { finish = resolve; });
            animations.push({ duration: options.duration, finish });
            return { finished };
          },
        };
      },
    };
    const room = Object.create(RoomController.prototype);
    room.sendRoomAction = async (action) => { roomActions.push(action); };
    const application = {
      mode,
      dialog: room,
      openHomePage(selectedMode) { menuCalls.push(selectedMode); },
    };
    registerApplication(application);
    const overlay = new ItemCommandOverlay(new Set(), { append() {} });

    try {
      overlay.initializeItemCommandOverlay();
      assert.equal(overlay.turnDurationSeconds * 1000, warningMs + finalMs);
      const playback = createTurnControls(overlay)();
      if (mode !== GameModeTraining) {
        assert.equal(animations[0].duration, warningMs);
        assert.deepEqual(roomActions, []);
        animations[0].finish();
        while (animations.length < 2) {
          await Promise.resolve();
        }
        assert.equal(animations[1].duration, finalMs);
        assert.deepEqual(roomActions, []);
        animations[1].finish();
      }
      await playback;
      if (mode === GameModeTraining) {
        assert.deepEqual(animations, []);
        assert.deepEqual(roomActions, []);
        assert.deepEqual(menuCalls, []);
      } else {
        assert.deepEqual(roomActions, ['leave-room']);
        assert.deepEqual(menuCalls, [null]);
        assert.equal(room.isLeaving, true);
      }
    } finally {
      globalThis.document = originalDocument;
      state.isMuted = originalMuted;
      registerApplication(originalApplication);
    }
  });
}
