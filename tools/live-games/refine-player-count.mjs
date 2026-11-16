#!/usr/bin/env node
/** Controlled training activity waves; never imported by the offline tests. */
import fs from 'node:fs/promises';
import { LiveTransport, toPlain } from './transport.mjs';
import { loadEngine } from './engine.mjs';
import { loadCatalog, decodeRoom } from './state.mjs';
import { ExplorationPolicy } from './policy.mjs';
import { createRng } from './rng.mjs';

const outputDirectory = `logs/live/player-count/refinement-${new Date().toISOString().replaceAll(':', '-')}`;
await fs.mkdir(outputDirectory, { recursive: true });
const output = await fs.open(`${outputDirectory}/observations.jsonl`, 'wx', 0o600);
const record = async (type, details) => {
  const entry = { ts: new Date().toISOString(), type, ...details };
  await output.appendFile(`${JSON.stringify(entry)}\n`);
  if (type !== 'room' && type !== 'action') {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
};
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
const argumentsList = process.argv.slice(2);
const argumentValue = (name, fallback) => {
  const argumentIndex = argumentsList.indexOf(name);
  return argumentIndex < 0 ? fallback : argumentsList[argumentIndex + 1];
};
const accountPath = argumentValue('--accounts', 'logs/live/account-pool-100.json');
const roomPath = argumentValue('--rooms', 'logs/live/player-count/training-rooms.json');
const offsets = argumentValue('--offsets', '10000,15000').split(',').map(Number);
if (offsets.some((offset) => !Number.isFinite(offset) || offset < 0 || offset >= 60000)) {
  throw new Error('Offsets must be milliseconds within a minute');
}
const accounts = JSON.parse(await fs.readFile(accountPath, 'utf8'));
const rooms = JSON.parse(await fs.readFile(roomPath, 'utf8'));
await fs.copyFile(roomPath, `${outputDirectory}/rooms.json`);
const engine = await loadEngine();
const { catalog } = await loadCatalog(engine);
const participants = [];
for (const { accountIndex, roomId } of rooms) {
  const account = accounts[accountIndex];
  if (!account?.refreshToken || typeof roomId !== 'string') {
    throw new Error(`Invalid room or missing saved account at index ${accountIndex}`);
  }
  const transport = new LiveTransport({ logger: { record() {} } });
  transport.userId = account.userId;
  transport.refreshToken = account.refreshToken;
  await transport.refreshAuth();
  participants.push({
    accountIndex,
    roomId,
    transport,
    policy: new ExplorationPolicy({ engine, catalog, rng: createRng(accountIndex + 1) }),
  });
}

let sampling = true;
let phase = 'no-op-control';
let lastStatusUpdate = null;
const observer = participants[0].transport;
const sample = async () => {
  const { raw } = await observer.readDocument('status/user_count', { log: false });
  lastStatusUpdate = raw.__documentUpdateTime;
  await record('count', { phase, ...raw });
};
const sampler = (async () => {
  while (sampling) {
    await sample();
    await sleep(2000);
  }
})();

async function snapshot(participant, label) {
  const { raw } = await participant.transport.readRoom(participant.roomId, { log: false });
  await record('room', {
    label, accountIndex: participant.accountIndex, roomId: participant.roomId,
    updatedAt: raw.updatedAt, documentUpdateTime: raw.__documentUpdateTime,
    userCount: raw.userCount, users: raw.users.length, gameUpdateCount: raw.game?.updateCount,
    gameIsOver: raw.game?.isOver === true,
  });
  return raw;
}

async function nextPublishedUpdates(numberOfUpdates) {
  let previousUpdate = lastStatusUpdate;
  let remaining = numberOfUpdates;
  const deadline = Date.now() + (numberOfUpdates + 1) * 60000;
  while (remaining > 0 && Date.now() < deadline) {
    await sleep(250);
    if (lastStatusUpdate !== previousUpdate) {
      remaining--;
      previousUpdate = lastStatusUpdate;
    }
  }
  if (remaining > 0) {
    throw new Error('Count publication did not arrive before the observation deadline');
  }
}

async function prepareCommand(participant) {
  const raw = await snapshot(participant, 'prepare-command');
  const game = decodeRoom(engine, raw).game;
  if (!game || game.isOver) {
    await record('skipped', { accountIndex: participant.accountIndex, reason: 'game is not running' });
    return null;
  }
  const self = game.players.find((player) => player.userId === participant.transport.userId);
  let decision;
  if (game.attack) {
    if (game.attack.playerId === self.id) {
      decision = participant.policy.decideBuyConfirmation(game, self);
    }
    if (!decision && game.attack.targetPlayerId === self.id) {
      decision = participant.policy.decideDefense(game, self);
    }
  } else if (game.attackTurnPlayerId === self.id) {
    decision = participant.policy.decideAttack(game, self);
  }
  if (!decision) {
    throw new Error(`No standard-policy command for account ${participant.accountIndex}`);
  }
  return { participant, command: toPlain(decision.command) };
}

async function wave(offsetMilliseconds, label) {
  const prepared = (await Promise.all(participants.map(prepareCommand))).filter(Boolean);
  const currentMinute = Math.floor(Date.now() / 60000) * 60000;
  const candidateTime = currentMinute + offsetMilliseconds;
  const targetTime = candidateTime > Date.now() + 1500 ? candidateTime : candidateTime + 60000;
  await record('scheduled', { label, targetTime: new Date(targetTime).toISOString() });
  while (Date.now() < targetTime) {
    await sleep(Math.min(500, targetTime - Date.now()));
  }
  phase = label;
  await record('wave-start', { label, participants: prepared.length });
  const results = await Promise.allSettled(prepared.map(async ({ participant, command }) => {
    const requestStartedAt = new Date().toISOString();
    await participant.transport.call('submit-command', {
      mode: 'training', roomId: participant.roomId, command,
    });
    await record('action', { label, accountIndex: participant.accountIndex, requestStartedAt });
    return snapshot(participant, label);
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  await record('wave-end', { label, successes: results.length - failures.length,
    failures: failures.map((failure) => String(failure.reason)) });
  await nextPublishedUpdates(1);
}

try {
  await record('run', { participants: participants.length, outputDirectory });
  if (!argumentsList.includes('--skip-control')) {
    await Promise.all(participants.map(async (participant) => {
      await snapshot(participant, 'before-no-op');
      await participant.transport.call('start-game', {
        mode: 'training', roomId: participant.roomId, playerCount: 2, lang: 'en', gf: null,
      });
      await snapshot(participant, 'after-no-op');
    }));
    await record('control-complete', {});
    await nextPublishedUpdates(1);
  }
  for (const offset of offsets) {
    await wave(offset, `command-offset-${offset}`);
  }
  phase = 'cooldown';
  await nextPublishedUpdates(1);
} finally {
  sampling = false;
  await sampler;
  await output.close();
}
