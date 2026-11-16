import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameDriver } from '../tools/live-games/probe-protocols.mjs';

test('GameDriver reads the current decoded room property names', async () => {
  const game = {
    isOver: true,
    updateCount: 1,
    gf: 1,
    attackTurnPlayerId: 1,
    attack: null,
    players: [],
    events: [],
  };
  const room = {
    game,
    users: [],
    entries: [],
    tiebreakGF: null,
  };
  const engine = {
    decodeJson: (value) => value,
    decodeLobbyState: () => room,
  };
  let closeWatch = () => {};
  const bot = {
    userId: 'u1',
    transport: {
      logChannelDocument: true,
      watchRoom: async (roomId, onSnapshot) => {
        onSnapshot({
          document: {},
          updateTime: new Date().toISOString(),
          sequence: 1,
        });
        await new Promise((resolve) => {
          closeWatch = resolve;
        });
      },
      stop: () => closeWatch(),
    },
    policy: {},
  };
  const driver = new GameDriver({
    engine,
    catalog: { findByIndex: () => null },
    logger: { record: () => {} },
    roomId: 'room',
    mode: 'private',
    bots: [bot],
    pollMs: 1,
    turnTimeoutMs: 1000,
    timeoutSeconds: 2,
    runId: 'driver-smoke',
  });

  const outcome = await driver.run();
  assert.equal(outcome.result, 'over');
  assert.equal(outcome.latest.game, game);
});
