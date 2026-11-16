import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanExchangeTransition } from '../tools/live-games/analyze-exchange.mjs';
import { itemCatalog } from '../server/engine.ts';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonl } from '../tools/live-games/log-files.mjs';

const player = (playerId, hp, mp, cp) => ({
  id: playerId,
  hp,
  mp,
  cp,
  isBot: true,
  confusionCount: 0,
  items: [],
});

const exchangeItems = { action: 'useAttackItems', items: [{ modelId: 3 }] };

test('Exchange analysis follows confusion application and expiry inside one update', () => {
  const previous = { gf: 49, tiebreakGF: 50, attackTurnPlayerId: 1, players: [player(1, 20, 20, 12)] };
  const current = {
    gf: 53,
    updateCount: 2,
    players: [player(1, 50, 2, 0)],
    events: [
      { action: 'confuseEverybody' },
      exchangeItems,
      { action: 'exchange', hp: 19, mp: 1, cp: 32 },
      { action: 'advanceGF', playerId: 1 },
      exchangeItems,
      { action: 'exchange', hp: 2, mp: 15, cp: 35 },
      { action: 'advanceGF', playerId: 1 },
      exchangeItems,
      { action: 'exchange', hp: 5, mp: 27, cp: 20 },
      { action: 'advanceGF', playerId: 1 },
      exchangeItems,
      { action: 'exchange', hp: 50, mp: 2, cp: 0 },
      { action: 'advanceGF', playerId: 1 },
    ],
  };
  const result = scanExchangeTransition(previous, current);
  assert.deepEqual(result.records.map((record) => record.confusionCount), [3, 2, 1, 0]);
  assert.deepEqual(result.records.map((record) => record.apocalypse), [false, true, true, true]);
  assert.deepEqual(result.records.map((record) => record.before), [
    [20, 20, 12], [19, 1, 32], [2, 15, 35], [5, 27, 20],
  ]);
  assert.equal(result.records.every((record) => record.statsConserved), true);
  assert.deepEqual(result.statMismatches, []);
  assert.equal(result.gfMatches, true);
});

test('Exchange before-stats include earlier effects and miracle costs, not the previous snapshot', () => {
  const miracle = itemCatalog.find((definition) => definition.category.key === 'miracles' && definition.cost > 0);
  const previous = { gf: 1, attackTurnPlayerId: 1, players: [player(1, 20, 50, 12)] };
  const before = [25, 60 - miracle.cost, 15];
  const resultStats = [30, before.reduce((total, value) => total + value, 0) - 45, 15];
  const current = {
    gf: 2,
    updateCount: 2,
    players: [player(1, ...resultStats)],
    events: [
      { action: 'useAttackItems', items: [{ modelId: miracle.id }] },
      { action: 'setTargetPlayer', playerId: 1 },
      { action: 'boostHP', hp: 5 },
      { action: 'boostMP', mp: 10 },
      { action: 'boostCP', cp: 3 },
      { action: 'advanceGF', playerId: 1 },
      exchangeItems,
      { action: 'exchange', hp: resultStats[0], mp: resultStats[1], cp: resultStats[2] },
    ],
  };
  const result = scanExchangeTransition(previous, current);
  assert.deepEqual(result.records[0].before, before);
  assert.deepEqual(result.records[0].snapshotBefore, [20, 50, 12]);
  assert.equal(result.records[0].statsConserved, true);
  assert.deepEqual(result.statMismatches, []);
});

test('guardian Exchange is excluded, and missing stat fields are zero', () => {
  const previous = { gf: 1, attackTurnPlayerId: 1, players: [player(1, 20, 20, 12), player(2, 10, 10, 10)] };
  const current = {
    gf: 1,
    updateCount: 2,
    players: [player(1, 30, 22, 0), player(2, 0, 0, 30)],
    events: [
      exchangeItems,
      { action: 'exchange', hp: 30, mp: 22 },
      { action: 'attackByGuardian', attack: { playerId: 2, guardian: 'earth', itemModelIds: [3] } },
      { action: 'exchange', cp: 30 },
    ],
  };
  const result = scanExchangeTransition(previous, current);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].result, [30, 22, 0]);
  assert.deepEqual(result.statMismatches, []);
});

test('stat replay retains guardian phenomenon ownership, Stick consumption, and Danger targeting', () => {
  const previous = {
    gf: 1, attackTurnPlayerId: 1,
    players: [player(1, 30, 10, 20), player(2, 10, 20, 10)],
  };
  const current = {
    gf: 1,
    players: [{ ...player(1, 0, 10, 20), dead: true }, player(2, 60, 0, 10)],
    events: [
      { action: 'attackByGuardian', attack: { playerId: 2, guardian: 'earth', itemModelIds: [207] } },
      { action: 'phenomenon', itemModelId: 293 },
      { action: 'boostHP', hp: 50 },
      { action: 'attackByGuardian', attack: { playerId: 2, guardian: 'earth', itemModelIds: [58] } },
      { action: 'attractDanger', playerId: 1 },
      { action: 'dealDamage', damage: 99 },
      { action: 'die', playerId: 1 },
    ],
  };
  const result = scanExchangeTransition(previous, current);
  assert.deepEqual(result.statMismatches, []);
});

test('the Exchange CLI reads a temporary manifest and writes corrected gzip records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dogfield-exchange-'));
  try {
    const previous = {
      gf: 49, tiebreakGF: 50, attackTurnPlayerId: 1,
      players: [player(1, 20, 20, 12)],
    };
    const current = {
      gf: 50, tiebreakGF: 50, updateCount: 2,
      players: [player(1, 50, 2, 0)],
      events: [
        { action: 'advanceGF', playerId: 1 },
        exchangeItems,
        { action: 'exchange', hp: 50, mp: 2 },
      ],
    };
    await writeFile(join(directory, 'game.jsonl'), [
      JSON.stringify({ type: 'state', updateCount: 1, game: previous }),
      JSON.stringify({ type: 'state', updateCount: 2, game: current }),
    ].join('\n'));
    const manifest = join(directory, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ files: [{ file: 'game.jsonl', gameId: 'fixture' }] }));
    const output = join(directory, 'events.jsonl.gz');
    const report = join(directory, 'report.json');
    const command = fileURLToPath(new URL('../tools/live-games/analyze-exchange.mjs', import.meta.url));
    await promisify(execFile)(process.execPath, [
      '--import', 'tsx', command,
      '--manifest', manifest, '--logs-root', directory,
      '--output', output, '--report', report,
    ]);
    const records = await readJsonl(output);
    assert.equal(records.length, 1);
    assert.equal(records[0].apocalypse, true);
    assert.deepEqual(records[0].before, [20, 20, 12]);
    const audit = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(audit.summary.calmAllocationMismatches, 0);
    assert.equal(audit.summary.exchangeConservationFailures, 0);
    assert.deepEqual(audit.diagnostics, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
