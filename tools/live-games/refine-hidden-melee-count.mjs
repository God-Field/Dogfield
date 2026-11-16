#!/usr/bin/env node
/** Companion to a paused private-count collector; resumes its cleanup on exit. */
import fs from 'node:fs/promises';
import { LiveTransport } from './transport.mjs';

const [directory, collectorProcessArgument] = process.argv.slice(2);
const collectorProcess = Number(collectorProcessArgument);
if (!directory || !Number.isInteger(collectorProcess) || collectorProcess <= 0) {
  throw new Error('Usage: refine-hidden-melee-count.mjs RUN_DIRECTORY PAUSED_COLLECTOR_PID');
}
const output = await fs.open(`${directory}/window-refinement.jsonl`, 'wx', 0o600);
const record = async (type, details = {}) => {
  const entry = { ts: new Date().toISOString(), type, ...details };
  await output.appendFile(`${JSON.stringify(entry)}\n`);
  if (type !== 'room') {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let sampling = true;
let sampler;
let latestPublication;
let phase = 'baseline';

try {
  const rooms = JSON.parse(await fs.readFile(`${directory}/rooms.json`, 'utf8'));
  const saved = JSON.parse(await fs.readFile('logs/live/account-pool-100.json', 'utf8'));
  const owners = new Map();
  for (const room of rooms) {
    if (owners.has(room.ownerIndex)) {
      continue;
    }
    const account = saved[room.ownerIndex];
    const transport = new LiveTransport({ logger: { record() {} }, roomMode: 'private' });
    transport.userId = account.userId;
    transport.refreshToken = account.refreshToken;
    await transport.refreshAuth();
    owners.set(room.ownerIndex, transport);
  }
  const early = rooms.filter((room) => room.group === 'independent-accounts');
  const late = rooms.filter((room) => room.group === 'repeated-five-accounts');
  if (early.length !== 20 || late.length !== 20) {
    throw new Error('Expected two cohorts of 20 controlled rooms');
  }
  const observer = owners.get(0);
  const sample = async () => {
    const { raw } = await observer.readDocument('status/user_count', { log: false });
    latestPublication = raw.__documentUpdateTime;
    await record('count', { phase, ...raw });
  };
  await sample();
  sampler = (async () => {
    while (sampling) {
      await sleep(5000);
      if (sampling) {
        await sample();
      }
    }
  })();
  const candidate = Math.floor(Date.now() / 60000) * 60000;
  const targetMinute = candidate + (candidate + 40000 > Date.now() + 2000 ? 0 : 60000);
  await record('scheduled', { early: new Date(targetMinute + 40000).toISOString(),
    late: new Date(targetMinute + 45000).toISOString() });
  for (const [label, cohort, offset] of [
    ['early-lobby-activity', early, 40000],
    ['late-game-activity', late, 45000],
  ]) {
    while (Date.now() < targetMinute + offset) {
      await sleep(Math.min(250, targetMinute + offset - Date.now()));
    }
    phase = label;
    await record('wave-start', { label, rooms: cohort.length });
    const results = await Promise.allSettled(cohort.map(async (room) => {
      const transport = owners.get(room.ownerIndex);
      if (label === 'early-lobby-activity') {
        await transport.call('set-tiebreak', { mode: 'private', roomId: room.roomId, gf: 75 });
      } else {
        await transport.call('set-room-locked', { mode: 'private', roomId: room.roomId, isLocked: false });
        await transport.call('set-room-locked', { mode: 'private', roomId: room.roomId, isLocked: true });
      }
      const { raw } = await transport.readRoom(room.roomId, { log: false });
      const snapshot = { label, roomId: room.roomId, updatedAt: raw.updatedAt,
        documentUpdateTime: raw.__documentUpdateTime, userCount: raw.userCount, users: raw.users,
        gameUpdateCount: raw.game?.updateCount ?? null };
      await record('room', snapshot);
      return snapshot;
    }));
    const failures = results.filter((result) => result.status === 'rejected');
    const snapshots = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const activityTimes = snapshots.map((room) => Date.parse(room.updatedAt));
    await record('wave-end', { label, successes: snapshots.length,
      failures: failures.map((result) => String(result.reason)),
      totalRoomCount: snapshots.reduce((total, room) => total + room.userCount, 0),
      earliest: new Date(Math.min(...activityTimes)).toISOString(),
      latest: new Date(Math.max(...activityTimes)).toISOString() });
    if (failures.length > 0) {
      throw new Error('A timed activity wave was incomplete');
    }
  }
  const desiredPublicationMinute = targetMinute + 4 * 60000;
  const deadline = desiredPublicationMinute + 30000;
  while (Date.parse(latestPublication) < desiredPublicationMinute && Date.now() < deadline) {
    await sleep(500);
  }
  if (Date.parse(latestPublication) < desiredPublicationMinute) {
    throw new Error('Missing the publication that separates the two window hypotheses');
  }
  await record('complete', { latestPublication });
} finally {
  sampling = false;
  await sampler;
  process.kill(collectorProcess, 'SIGCONT');
  await record('collector-resumed', { collectorProcess });
  await output.close();
}
