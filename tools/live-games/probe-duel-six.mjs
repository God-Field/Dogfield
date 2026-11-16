#!/usr/bin/env node
/** Coordinate six fresh Korean-named accounts for controlled Royal Duel probes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { LiveTransport } from './transport.mjs';
import { JsonlLogger } from './log.mjs';
import { root } from './engine.mjs';
import { generateAiNames } from '../../server/rooms/bot-names.ts';
import { Random } from '../../server/random.ts';

const ACTOR_COUNT = 6;
const argumentsList = process.argv.slice(2);
const argumentValue = (name, fallback) => {
  const argumentIndex = argumentsList.indexOf(name);
  return argumentIndex < 0 ? fallback : argumentsList[argumentIndex + 1];
};

if (argumentsList.includes('--help')) {
  process.stdout.write('Usage: node --import tsx tools/live-games/probe-duel-six.mjs [options]\n'
    + '  --seconds 45               observe after all accounts queue\n'
    + '  --matchmaking-seconds 180  wait for controlled pairings\n'
    + '  --leave-at-sec 15          leave from pair 0 and pair 2 at this game age\n'
    + '  --kick-at 15,16.5,18,19,20,24,30  no-userId request ages from game start\n'
    + '  --poll-ms 200              room polling interval\n'
    + '  --output DIRECTORY         output directory (default logs/live/disconnects)\n');
  process.exit(0);
}

const observationSeconds = Number(argumentValue('--seconds', '45'));
const matchmakingSeconds = Number(argumentValue('--matchmaking-seconds', '180'));
const leaveAtSeconds = Number(argumentValue('--leave-at-sec', '15'));
const pollMilliseconds = Number(argumentValue('--poll-ms', '200'));
const kickTimes = argumentValue('--kick-at', '15,16.5,18,19,20,24,30')
  .split(',')
  .filter(Boolean)
  .map(Number)
  .sort((firstTime, secondTime) => firstTime - secondTime);
const invalidTiming = !Number.isFinite(observationSeconds) || observationSeconds <= 0
  || !Number.isFinite(matchmakingSeconds) || matchmakingSeconds <= 0
  || !Number.isFinite(leaveAtSeconds) || leaveAtSeconds < 0
  || !Number.isFinite(pollMilliseconds) || pollMilliseconds <= 0
  || kickTimes.some((kickTime) => !Number.isFinite(kickTime) || kickTime < 0);
if (invalidTiming) {
  throw new Error('All timing values must be finite and in their valid range');
}

const seed = crypto.randomInt(1, 0x7fffffff);
const userNames = generateAiNames(ACTOR_COUNT, [], 'ko', new Random(seed));
const runId = new Date().toISOString().replaceAll(':', '-');
const outputDirectory = path.resolve(argumentValue('--output', path.join(root, 'logs', 'live', 'disconnects', `royal-six-${runId}`)));
const credentialsPath = path.join(outputDirectory, 'temporary-accounts.json');
await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const logger = new JsonlLogger(path.join(outputDirectory, 'observations.jsonl'));
const actors = userNames.map((userName, actorIndex) => {
  const transport = new LiveTransport({
    roomMode: 'duel',
    pollIntervalMs: pollMilliseconds,
    logPolls: 'summary',
    logger: { record: (type, fields) => logger.record(type, { actor: userName, ...fields }) },
  });
  return { actorIndex, userName, transport, userId: null, roomId: null, rating: null };
});
const actorByUserId = new Map();
const membershipByActor = new Set();
const pairByKey = new Map();
const externalMatchKeys = new Set();
const externalMatchedUserIds = new Set();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let shutdownRequested = false;

process.on('SIGINT', () => {
  shutdownRequested = true;
});
process.on('SIGTERM', () => {
  shutdownRequested = true;
});

function gameSummary(raw, pair) {
  const game = raw?.game ?? null;
  const memberIds = new Set((raw?.users ?? []).map((member) => member.id));
  return {
    exists: raw !== null,
    userIds: game?.players?.map((player) => player.userId ?? null) ?? [],
    names: game?.players?.map((player) => player.name ?? null) ?? [],
    isBot: game?.players?.map((player) => player.isBot === true) ?? [],
    playerIds: game?.players?.map((player) => player.id) ?? [],
    attackTurnPlayerId: game?.attackTurnPlayerId ?? null,
    pendingTargetPlayerId: game?.attacks?.[0]?.targetPlayerId ?? game?.attack?.targetPlayerId ?? null,
    expectedPlayerId: expectedPlayerId(game),
    updateCount: game?.updateCount ?? null,
    gameUpdatedAt: game?.updatedAt ?? null,
    isOver: game?.isOver === true,
    memberIds: [...memberIds],
    roomUserCount: raw?.userCount ?? null,
    rating: game?.players?.map((player) => player.rating ?? null) ?? [],
  };
}

function expectedPlayerId(game) {
  if (!game) {
    return null;
  }
  const attack = game.attacks?.[0] ?? game.attack ?? null;
  if (!attack) {
    return game.attackTurnPlayerId ?? null;
  }
  return attack.buyingItemModelId ? attack.playerId : attack.targetPlayerId;
}

function pairKey(userIds) {
  return [...userIds].sort().join(':');
}

async function readActorRoom(actor, { log = false } = {}) {
  const result = await actor.transport.readRoom(actor.roomId, { log });
  return result.raw;
}

async function snapshot(pair, label) {
  const raw = await readActorRoom(pair.reader);
  const state = gameSummary(raw, pair);
  const observation = {
    pair: pair.index,
    label,
    elapsedSinceGameStartMs: pair.gameStartedAt === null ? null : Date.now() - pair.gameStartedAt,
    roomId: pair.roomId,
    state,
  };
  logger.record('duelSnapshot', observation);
  pair.latest = raw;
  pair.latestState = state;
  return raw;
}

async function callAction(actor, action, roomId, payload = {}) {
  const result = await actor.transport.call(action, { mode: 'duel', roomId: actor.roomId ?? roomId, ...payload });
  if (action === 'leave-room') {
    membershipByActor.delete(actor);
  }
  return result;
}

async function detectPairings() {
  const controlledUserIds = new Set(actors.map((actor) => actor.userId));
  const externalMatches = new Set();
  for (const actor of actors) {
    const raw = await readActorRoom(actor);
    const game = raw?.game;
    if (!game || !Array.isArray(game.players) || game.players.length !== 2) {
      continue;
    }
    const userIds = game.players.map((player) => player.userId).filter(Boolean);
    if (userIds.length !== 2) {
      continue;
    }
    const key = pairKey(userIds);
    if (!userIds.every((userId) => controlledUserIds.has(userId))) {
      externalMatches.add(key);
      for (const userId of userIds) {
        if (controlledUserIds.has(userId)) {
          externalMatchedUserIds.add(userId);
        }
      }
      if (!externalMatchKeys.has(key)) {
        externalMatchKeys.add(key);
        logger.record('externalMatch', {
          observedBy: actor.userName,
          roomId: actor.roomId,
          userIds,
          names: game.players.map((player) => player.name),
          note: 'No probe actions are sent to games containing an uncontrolled account.',
        });
      }
      continue;
    }
    if (pairByKey.has(key)) {
      const existingPair = pairByKey.get(key);
      if (!existingPair.roomId || raw.game) {
        existingPair.roomId = actor.roomId;
        existingPair.initialDocument = raw;
      }
      continue;
    }
    const members = userIds.map((userId) => actorByUserId.get(userId));
    const pair = {
      index: pairByKey.size,
      key,
      members,
      reader: actor,
      roomId: actor.roomId,
      initialDocument: raw,
      gameStartedAt: null,
      leaveActor: null,
      caller: null,
      leaveDone: false,
      sentKickTimes: new Set(),
      latest: raw,
      latestState: gameSummary(raw, null),
    };
    pair.gameStartedAt = Date.parse(game.updatedAt);
    if (!Number.isFinite(pair.gameStartedAt)) {
      pair.gameStartedAt = Date.now();
    }
    const initiallyExpectedPlayerId = expectedPlayerId(game);
    const initiallyExpectedUserId = game.players.find(
      (player) => player.id === initiallyExpectedPlayerId,
    )?.userId;
    pair.leaveActor = pair.index === 0 || pair.index === 2
      ? members.find((member) => member.userId === game.players[0].userId)
      : null;
    pair.caller = members.find(
      (member) => member.userId !== initiallyExpectedUserId,
    ) ?? members[0];
    pairByKey.set(key, pair);
    logger.record('controlledMatch', {
      pair: pair.index,
      roomId: pair.roomId,
      userIds,
      names: game.players.map((player) => player.name),
      playerIds: game.players.map((player) => player.id),
      ratings: game.players.map((player) => player.rating ?? null),
      gameUpdatedAt: game.updatedAt,
      leaveActor: pair.leaveActor?.userName ?? null,
      caller: pair.caller?.userName ?? null,
    });
  }
  return { controlledPairCount: pairByKey.size, externalMatches: [...externalMatches] };
}

async function runPairActions(pair) {
  if (pair.latestState?.isOver) {
    return;
  }
  let gameAgeSeconds = (Date.now() - pair.gameStartedAt) / 1000;
  if (pair.leaveActor && !pair.leaveDone && gameAgeSeconds >= leaveAtSeconds) {
    pair.leaveDone = true;
    logger.record('leaveProbe', {
      pair: pair.index,
      actor: pair.leaveActor.userName,
      gameAgeSeconds,
      requestedLeaveAtSeconds: leaveAtSeconds,
      caller: pair.caller.userName,
    });
    await snapshot(pair, 'before-leave');
    try {
      await callAction(pair.leaveActor, 'leave-room', pair.roomId);
      logger.record('actionResult', { pair: pair.index, action: 'leave-room', actor: pair.leaveActor.userName, gameAgeSeconds, status: 200 });
    } catch (error) {
      logger.record('actionError', { pair: pair.index, action: 'leave-room', actor: pair.leaveActor.userName, gameAgeSeconds, status: error.status ?? null, message: error.message });
    }
    await sleep(250);
    await snapshot(pair, 'after-leave');
  }
  for (const kickTime of kickTimes) {
    gameAgeSeconds = (Date.now() - pair.gameStartedAt) / 1000;
    if (pair.sentKickTimes.has(kickTime) || gameAgeSeconds < kickTime) {
      continue;
    }
    pair.sentKickTimes.add(kickTime);
    await snapshot(pair, `before-kick-${kickTime}`);
    logger.record('watchdogProbe', {
      pair: pair.index,
      caller: pair.caller.userName,
      gameAgeSeconds,
      requestedGameAgeSeconds: kickTime,
      currentExpectedPlayerId: pair.latestState?.expectedPlayerId ?? null,
      noUserId: true,
    });
    try {
      await callAction(pair.caller, 'kick-user', pair.roomId);
      logger.record('actionResult', { pair: pair.index, action: 'kick-user', actor: pair.caller.userName, gameAgeSeconds, requestedGameAgeSeconds: kickTime, status: 200 });
    } catch (error) {
      logger.record('actionError', { pair: pair.index, action: 'kick-user', actor: pair.caller.userName, gameAgeSeconds, requestedGameAgeSeconds: kickTime, status: error.status ?? null, message: error.message });
    }
    await sleep(250);
    await snapshot(pair, `after-kick-${kickTime}`);
  }
}

try {
  logger.record('meta', {
    runId,
    seed,
    sdk: 'LiveTransport REST observation; official matchmaking and room actions',
    accountCount: ACTOR_COUNT,
    userNames,
    synchronizedQueue: true,
    observationSeconds,
    matchmakingSeconds,
    leaveAtSeconds,
    kickTimes,
    pollMilliseconds,
    scope: 'Only games whose two player IDs belong to this run receive leave-room or kick-user probes.',
  });

  const signInResults = await Promise.allSettled(actors.map(async (actor) => {
    actor.userId = await actor.transport.signIn();
    actorByUserId.set(actor.userId, actor);
    const recordResult = await actor.transport.readDocument(`records/${actor.userId}`, { log: false });
    actor.rating = recordResult.raw?.rating ?? 0;
    logger.record('freshAccount', {
      actor: actor.userName,
      userId: actor.userId,
      rating: actor.rating,
      recordExists: recordResult.exists,
    });
  }));
  const signInErrors = signInResults.filter((result) => result.status === 'rejected');
  if (signInErrors.length > 0) {
    throw new Error(`Failed to prepare ${signInErrors.length} fresh account(s)`);
  }
  await fs.writeFile(credentialsPath, `${JSON.stringify(actors.map((actor) => ({
    userName: actor.userName,
    userId: actor.userId,
    refreshToken: actor.transport.refreshToken,
  })), null, 2)}\n`, { mode: 0o600 });
  const accountRatings = new Set(actors.map((actor) => actor.rating));
  if (accountRatings.size !== 1) {
    throw new Error(`Fresh accounts have different Elo values: ${actors.map((actor) => actor.rating).join(',')}`);
  }

  const queueStartedAt = Date.now();
  const roomResults = await Promise.allSettled(actors.map(async (actor) => {
    const response = await actor.transport.call('create-room', {
      mode: 'duel',
      userName: actor.userName,
      lang: 'ko',
    });
    actor.roomId = response?.roomId ?? null;
    if (!actor.roomId) {
      throw new Error('create-room did not return roomId');
    }
    membershipByActor.add(actor);
    logger.record('queued', {
      actor: actor.userName,
      userId: actor.userId,
      roomId: actor.roomId,
      gameAgeAnchor: 'server game.updatedAt',
      queueOffsetMs: Date.now() - queueStartedAt,
    });
  }));
  const roomErrors = roomResults.filter((result) => result.status === 'rejected');
  if (roomErrors.length > 0) {
    throw new Error(`Failed to queue ${roomErrors.length} account(s)`);
  }

  const matchmakingDeadline = Date.now() + matchmakingSeconds * 1000;
  let pairingState = { controlledPairCount: 0, externalMatches: [] };
  while (!shutdownRequested && Date.now() < matchmakingDeadline
    && pairByKey.size * 2 + externalMatchedUserIds.size < ACTOR_COUNT) {
    pairingState = await detectPairings();
    if (pairByKey.size * 2 + externalMatchedUserIds.size >= ACTOR_COUNT) {
      break;
    }
    await sleep(pollMilliseconds);
  }
  logger.record('matchmakingResult', {
    controlledPairCount: pairByKey.size,
    expectedControlledPairs: ACTOR_COUNT / 2,
    externallyMatchedControlledAccounts: externalMatchedUserIds.size,
    externalMatches: pairingState.externalMatches,
    elapsedMs: Date.now() - queueStartedAt,
  });

  const observationDeadline = Date.now() + observationSeconds * 1000;
  while (!shutdownRequested && Date.now() < observationDeadline && pairByKey.size > 0) {
    await Promise.all([...pairByKey.values()].map(async (pair) => {
      try {
        const raw = await readActorRoom(pair.reader);
        if (raw?.game) {
          pair.latest = raw;
          pair.latestState = gameSummary(raw, pair);
        }
        await runPairActions(pair);
        await snapshot(pair, 'poll');
      } catch (error) {
        logger.record('observationError', { pair: pair.index, roomId: pair.roomId, status: error.status ?? null, message: error.message });
      }
    }));
    await sleep(pollMilliseconds);
  }

  for (const pair of pairByKey.values()) {
    await snapshot(pair, 'before-cleanup');
  }
  const summary = [...pairByKey.values()].map((pair) => ({
    pair: pair.index,
    roomId: pair.roomId,
    members: pair.members.map((actor) => ({ userName: actor.userName, userId: actor.userId, rating: actor.rating })),
    leaveActor: pair.leaveActor?.userName ?? null,
    leaveDone: pair.leaveDone,
    caller: pair.caller?.userName ?? null,
    latest: pair.latestState,
  }));
  await fs.writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify({ summary, expectedPairs: ACTOR_COUNT / 2 }, null, 2)}\n`);
  process.stdout.write(`report ${path.join(outputDirectory, 'summary.json')}\n`);
} finally {
  await Promise.all([...membershipByActor].map(async (actor) => {
    try {
      await callAction(actor, 'leave-room', actor.roomId);
      logger.record('cleanup', { actor: actor.userName, action: 'leave-room', status: 200 });
    } catch (error) {
      logger.record('cleanupError', { actor: actor.userName, action: 'leave-room', status: error.status ?? null, message: error.message });
    }
  }));
  await fs.rm(credentialsPath, { force: true });
  await logger.flush();
}
