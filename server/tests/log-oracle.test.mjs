import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../battle/battle.ts';
import {
  canonicalize,
  OracleRandom,
  removeStaleChannels,
  checkSnapshotStructure,
  createComparisonSummary,
  compareRejectedCommand,
  createReplayBattle,
  groupLogRowsByGame,
  indexRejectedCommandUsers,
  takeRejectedCommandUser,
} from '../verify-logs.mjs';

test('merged logs keep overlapping snapshot update counts in separate games', () => {
  const meta = { type: 'meta' };
  const first = { type: 'state', gameId: 'first', updateCount: 1 };
  const second = { type: 'state', gameId: 'second', updateCount: 1 };
  const firstNext = { ...first, updateCount: 2 };
  const secondNext = { ...second, updateCount: 2 };

  const rows = [meta, first, second, secondNext, firstNext];
  assert.deepEqual([...groupLogRowsByGame(rows)], [
    [meta], [first, firstNext], [second, secondNext],
  ]);
  assert.deepEqual([...groupLogRowsByGame([meta, first])], [[meta, first]]);
});

test('oracle replay reconstructs the offered slot before a declined Buy', () => {
  const before = {
    players: [
      { id: 1, userId: 'buyer', hp: 40, mp: 10, cp: 20, items: [] },
      { id: 2, userId: 'seller', hp: 40, mp: 10, cp: 20, items: [
        { id: 1, modelId: 6 },
      ] },
    ],
    gf: 1,
    attackTurnPlayerId: 1,
    updateCount: 1,
    events: [
      { action: 'useDefenseItems' },
      { action: 'buy', item: { id: 2, modelId: 113 } },
    ],
    attacks: [{ playerId: 1, targetPlayerId: 2, itemModelIds: [5], buyingItemModelId: 113 }],
  };
  const battle = createReplayBattle(before);
  battle.submit('buyer', { bought: false });
  assert.deepEqual(battle.game.events[0], {
    action: 'setBought', item: { id: 2, modelId: 113 },
  });
  assert.deepEqual(battle.game.players[1].items, [
    { id: 1, modelId: 6 },
    { id: 2, modelId: 113 },
  ]);
  assert.equal(before.serverTurn, undefined);
});

test('rejected submissions compare command acceptance without changing the snapshot', () => {
  const before = {
    players: [
      { id: 1, userId: 'attacker', hp: 40, mp: 10, cp: 20, items: [] },
      {
        id: 2, userId: 'defender', hp: 40, mp: 10, cp: 20,
        items: [{ id: 1, modelId: 127 }, { id: 2, modelId: 167 }],
      },
    ],
    gf: 1,
    attackTurnPlayerId: 1,
    attacks: [{ playerId: 1, targetPlayerId: 2, itemModelIds: [229] }],
    events: [],
    updateCount: 1,
  };
  const original = structuredClone(before);
  const summary = createComparisonSummary();
  const context = { file: 'synthetic', update: 1 };

  compareRejectedCommand({
    before, command: { itemIds: [1, 2] }, commandUserId: 'defender',
    status: 400, context, summary,
  });
  assert.equal(summary.rejectedCommandTransitions, 1);
  assert.equal(summary.differences.size, 0);
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(before, original);

  compareRejectedCommand({
    before, command: { itemIds: [2] }, commandUserId: 'defender',
    status: 400, context, summary,
  });
  assert.equal(summary.rejectedCommandTransitions, 2);
  const difference = [...summary.differences.values()][0];
  assert.equal(difference.path, '/command/status');
  assert.equal(difference.expected, 400);
  assert.equal(difference.actual, 200);
  assert.equal(difference.rejected, true);
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(before, original);
});

test('rejected commands replay as the account that submitted them', () => {
  const before = {
    players: [
      { id: 1, userId: 'attacker', hp: 40, mp: 10, cp: 20, items: [] },
      {
        id: 2, userId: 'defender', hp: 40, mp: 10, cp: 20,
        items: [{ id: 1, modelId: 167 }],
      },
    ],
    gf: 1,
    attackTurnPlayerId: 1,
    attacks: [{ playerId: 1, targetPlayerId: 2, itemModelIds: [229] }],
    events: [],
    updateCount: 1,
  };
  const context = { file: 'synthetic', update: 1 };

  const wrongActor = createComparisonSummary();
  compareRejectedCommand({
    before, command: { itemIds: [1] }, commandUserId: 'attacker',
    status: 400, context, summary: wrongActor,
  });
  assert.equal(wrongActor.differences.size, 0);

  const expectedActor = createComparisonSummary();
  compareRejectedCommand({
    before, command: { itemIds: [1] }, commandUserId: 'defender',
    status: 400, context, summary: expectedActor,
  });
  assert.equal(expectedActor.differences.size, 1);
});

test('rejected command users are matched by update and command', () => {
  const rows = [
    { type: 'rejected', updateCount: 4, userId: 'first', command: { itemIds: [6, 5] } },
    { type: 'rejected', updateCount: 4, userId: 'second', command: { itemIds: [6, 5] } },
    { type: 'rejected', updateCount: 4, userId: 'other', command: { itemIds: [6] } },
  ];
  const usersByCommand = indexRejectedCommandUsers(rows);

  assert.equal(takeRejectedCommandUser(usersByCommand, 4, { itemIds: [6, 5] }), 'first');
  assert.equal(takeRejectedCommandUser(usersByCommand, 4, { itemIds: [6, 5] }), 'second');
  assert.equal(takeRejectedCommandUser(usersByCommand, 4, { itemIds: [6, 5] }), null);
  assert.equal(takeRejectedCommandUser(usersByCommand, 4, { itemIds: [6] }), 'other');
  assert.equal(takeRejectedCommandUser(usersByCommand, 5, { itemIds: [6] }), null);
});

test('oracle lookups use the same gift-free event cursor as prefix checks', () => {
  const gift = { action: 'gift', playerId: 1, item: { id: 1, modelId: 244 } };
  const useDevil = { action: 'useDevilItem', playerId: 1, item: gift.item };
  const boost = { action: 'boostMP', mp: 10 };
  const random = new OracleRandom([gift, useDevil, boost, { action: 'hit', playerId: 2 }], {});
  const battle = { game: { events: [gift, useDevil] } };
  random.attach(battle);

  assert.equal(random.pick('devilStat', ['hp', 'mp', 'cp']), 'mp');
  battle.game.events.push(boost);
  assert.equal(random.chance('hit', 75), true);
});

test('oracle Dream draws distinguish the real disguise from a missing observation', () => {
  const random = new OracleRandom([], {});
  random.attach({ game: { events: [] } });
  random.lastGiftItem = { modelId: 19, fakeModelId: 19 };
  assert.equal(random.chance('dreamReal', 50), true);
  random.lastGiftItem = { modelId: 19, fakeModelId: 26 };
  assert.equal(random.chance('dreamReal', 50), false);
  random.lastGiftItem = { modelId: 19 };
  assert.throws(() => random.chance('dreamReal', 50), /dreamRealOracle/);
});

test('stale channel documents cannot replace snapshots for the current match', () => {
  const current = {
    type: 'channel',
    document: { __createTime: '2026-11-10T21:00:24.544493Z', game: { updateCount: 6 } },
  };
  const stale = {
    type: 'channel',
    document: { __createTime: '2026-11-10T21:00:15.797414Z', game: { updateCount: 7 } },
  };
  const decision = { type: 'decision', updateCount: 6, command: {} };
  const next = { ...current, document: { ...current.document, game: { updateCount: 7 } } };
  const legacy = { type: 'channel', document: { game: { updateCount: 8 } } };

  assert.deepEqual(removeStaleChannels([current, stale, decision, next, stale, legacy]), [
    current, decision, next, legacy,
  ]);
});

test('missing event history cannot establish a GF delta violation', () => {
  const summary = createComparisonSummary();
  checkSnapshotStructure({ gf: 29 }, { gf: 30 }, {}, summary);
  assert.equal(summary.eventlessTransitions, 1);
  assert.deepEqual(summary.structuralViolations, []);

  checkSnapshotStructure({ gf: 29 }, { gf: 30, events: [] }, {}, summary);
  assert.equal(summary.structuralViolations.length, 1);
  assert.equal(summary.structuralViolations[0].path, 'gf-delta');
});

test('oracle replay preserves interleaved devil effects and replacement gifts', () => {
  const players = [1, 2].map((playerId) => ({
    id: playerId,
    hp: 40,
    mp: 10,
    cp: 20,
    items: [{ id: 0, modelId: 0 }],
  }));
  const game = {
    players, gf: 1, tiebreakGF: 1, attackTurnPlayerId: 1, events: [], updateCount: 1,
  };
  const events = [
    { action: 'gift', playerId: 1, item: { id: 1, modelId: 244 } },
    { action: 'useDevilItem', playerId: 1, item: { id: 1, modelId: 244 } },
    { action: 'boostHP', hp: 10 },
    { action: 'gift', playerId: 2, item: { id: 1, modelId: 244 } },
    { action: 'useDevilItem', playerId: 2, item: { id: 1, modelId: 244 } },
    { action: 'boostMP', mp: 10 },
    { action: 'gift', playerId: 1, item: { id: 1, modelId: 6 } },
    { action: 'gift', playerId: 2, item: { id: 1, modelId: 6 } },
  ];
  const random = new OracleRandom(events, {}, {}, structuredClone(game));
  const battle = new Battle(game, random);
  random.attach(battle);
  battle.refillConsumedSlots(players[0]);

  assert.deepEqual(game.events, events);
  assert.equal(players[0].hp, 50);
  assert.equal(players[1].mp, 20);
  assert.deepEqual(players.map((player) => player.items), [
    [{ id: 1, modelId: 6 }], [{ id: 1, modelId: 6 }],
  ]);
});

test('canonicalize preserves guardianPlayerIds queue order instead of sorting numerically', () => {
  const rawGame = {
    guardianPlayerIds: [4, 9, 5, 1, 6, 8, 7, 3],
  };
  const canonicalGame = canonicalize(rawGame);
  assert.deepEqual(
    canonicalGame.guardianPlayerIds,
    [4, 9, 5, 1, 6, 8, 7, 3],
    'guardian queue order is preserved',
  );
});
