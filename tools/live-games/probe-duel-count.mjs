#!/usr/bin/env node
/** Measure official Royal Duel counts using generated Korean bot names. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateAiNames } from '../../server/rooms/bot-names.ts';
import { Random } from '../../server/random.ts';
import { loadEngine, root } from './engine.mjs';
import { loadCatalog, decodeRoom } from './state.mjs';
import { ExplorationPolicy } from './policy.mjs';
import { createRng } from './rng.mjs';
import { LiveTransport, toPlain } from './transport.mjs';

const accountPoolPath = process.env.DUEL_COUNT_ACCOUNT_POOL
  ? path.resolve(process.env.DUEL_COUNT_ACCOUNT_POOL)
  : null;
const accountPool = accountPoolPath
  ? JSON.parse(await fs.readFile(accountPoolPath, 'utf8'))
  : null;
// Use an even cohort; the default new-account run has 75 measured seats plus a buffer.
const ACTOR_COUNT = Number(process.env.DUEL_COUNT_ACTOR_COUNT ?? accountPool?.length ?? 76);
const sampleIntervalMs = 2000;
const idleProbe = process.env.DUEL_COUNT_IDLE_PROBE === '1';
const timedIdleWaves = process.env.DUEL_COUNT_TIMED_IDLE_WAVES === '1';
const repeatAllMatches = process.env.DUEL_COUNT_REPEAT_ALL_MATCHES === '1';
const observationMs = Number(process.env.DUEL_COUNT_OBSERVATION_MS ?? (idleProbe ? 360000 : 125000));
const minimumControlledPlayers = Number(process.env.DUEL_COUNT_MIN_CONTROLLED_PLAYERS ?? 2);
const queueBatchSize = Number(process.env.DUEL_COUNT_QUEUE_BATCH_SIZE ?? 20);
const firstWaveLeadSeconds = Number(process.env.DUEL_COUNT_FIRST_WAVE_LEAD_SECONDS ?? 55);
const secondWaveLeadSeconds = Number(process.env.DUEL_COUNT_SECOND_WAVE_LEAD_SECONDS ?? 45);
if (!Number.isInteger(ACTOR_COUNT) || ACTOR_COUNT < 2 || ACTOR_COUNT % 2 !== 0) {
  throw new Error('Actor count must be a positive even number of at least 2');
}
if (!Number.isInteger(minimumControlledPlayers)
  || minimumControlledPlayers < 2
  || minimumControlledPlayers > ACTOR_COUNT
  || minimumControlledPlayers % 2 !== 0) {
  throw new Error('Minimum controlled player count must be an even number within the cohort');
}
if (!Number.isInteger(queueBatchSize) || queueBatchSize < 1 || queueBatchSize > 100) {
  throw new Error('Queue batch size must be an integer between 1 and 100');
}
if (!Number.isInteger(firstWaveLeadSeconds)
  || !Number.isInteger(secondWaveLeadSeconds)
  || firstWaveLeadSeconds < 1
  || firstWaveLeadSeconds > 59
  || secondWaveLeadSeconds < 1
  || secondWaveLeadSeconds > 59
  || firstWaveLeadSeconds <= secondWaveLeadSeconds) {
  throw new Error('Timed wave leads must be 1–59 seconds, with the first wave earlier');
}
if (accountPool && accountPool.length !== ACTOR_COUNT) {
  throw new Error(`Account pool has ${accountPool.length} entries; expected ${ACTOR_COUNT}`);
}
const engine = await loadEngine();
const { catalog } = await loadCatalog(engine);
const seed = crypto.randomInt(1, 0x7fffffff);
const userNames = generateAiNames(ACTOR_COUNT, [], 'ko', new Random(seed));
const runId = new Date().toISOString().replaceAll(':', '-');
const outputDirectory = path.join(root, 'logs', 'live', 'duel-count', runId);
const credentialsPath = path.join(outputDirectory, 'temporary-accounts.json');
const credentials = [];
let matchmakingStarted = false;
const logger = await fs.open(path.join(outputDirectory, 'observations.jsonl'), 'wx', 0o600)
  .catch(async (error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    return fs.open(path.join(outputDirectory, 'observations.jsonl'), 'wx', 0o600);
  });
const actors = userNames.map((userName, actorIndex) => ({
  userName,
  transport: new LiveTransport({ roomMode: 'duel', logger: { record() {} } }),
  policy: null,
  userId: null,
  rating: null,
  recordExists: null,
  pooledAccount: accountPool?.[actorIndex] ?? null,
  roomId: null,
  cleanupRoomId: null,
}));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const record = async (type, fields = {}) => {
  const entry = { ts: new Date().toISOString(), type, ...fields };
  await logger.appendFile(`${JSON.stringify(entry)}\n`);
  if (type !== 'sample') {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
};

async function sample(phase) {
  const { raw } = await actors[0].transport.readDocument('status/user_count', { log: false });
  await record('sample', {
    phase,
    training: raw?.training ?? null,
    private: raw?.private ?? null,
    duel: raw?.duel ?? null,
    documentUpdateTime: raw?.__documentUpdateTime ?? null,
  });
  return raw?.__documentUpdateTime ?? null;
}

async function observe(phase, durationMs, { play = true } = {}) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (play) {
      await playOneRound();
    }
    await sample(phase);
    await sleep(Math.min(sampleIntervalMs, deadline - Date.now()));
  }
  await sample(`${phase}-end`);
}

async function recordRoomActivity(phase) {
  const roomIds = [...new Set(actors
    .map((actor) => actor.roomId)
    .filter(Boolean))];
  const snapshots = await Promise.all(roomIds.map(async (roomId) => {
    const actor = actors.find((candidate) => candidate.roomId === roomId);
    const { raw } = await actor.transport.readRoom(roomId, { log: false });
    const game = raw?.game ? decodeRoom(engine, raw).game : null;
    return {
      roomId,
      updatedAt: raw?.updatedAt ?? null,
      documentUpdateTime: raw?.__documentUpdateTime ?? null,
      gameUpdatedAt: game?.updatedAt ?? null,
      updateCount: game?.updateCount ?? null,
      userCount: raw?.userCount ?? null,
    };
  }));
  await record('room-activity-snapshot', { phase, snapshots });
}

async function planTimedActivityWaves() {
  const { raw } = await actors[0].transport.readDocument('status/user_count', { log: false });
  const publishedAt = Date.parse(raw?.__documentUpdateTime ?? '');
  if (!Number.isFinite(publishedAt)) {
    throw new Error('Could not read the latest duel-count publication time');
  }

  let expectedNextPublication = publishedAt + 60000;
  const firstWaveLeadMs = firstWaveLeadSeconds * 1000;
  while (expectedNextPublication - firstWaveLeadMs <= Date.now() + 15000) {
    expectedNextPublication += 60000;
  }

  return {
    currentPublicationAt: new Date(publishedAt).toISOString(),
    expectedPublicationAt: new Date(expectedNextPublication).toISOString(),
    firstWaveAt: expectedNextPublication - firstWaveLeadMs,
    secondWaveAt: repeatAllMatches
      ? expectedNextPublication + 60000 - secondWaveLeadSeconds * 1000
      : expectedNextPublication - secondWaveLeadSeconds * 1000,
  };
}

async function waitUntil(timestamp) {
  const waitMs = timestamp - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

async function waitForNextPublication(previousPublicationAt, notBeforeTimestamp) {
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    const documentUpdateTime = await sample('waiting-for-count-publication');
    const publishedAt = Date.parse(documentUpdateTime ?? '');
    const publicationIsNew = documentUpdateTime !== previousPublicationAt;
    const publicationFollowsActivity = publishedAt > notBeforeTimestamp;
    if (documentUpdateTime && publicationIsNew && publicationFollowsActivity) {
      return documentUpdateTime;
    }
    await sleep(1000);
  }
  throw new Error('No new duel-count publication arrived during the 25-second wait');
}

async function playOneRound({ matchRange = null } = {}) {
  const matchGroups = new Map();
  const activeActorsById = new Map(actors
    .filter((actor) => actor.roomId)
    .map((actor) => [actor.userId, actor]));
  const roomIds = [...new Set([...activeActorsById.values()].map((actor) => actor.roomId))];
  const roomGames = await Promise.all(roomIds.map(async (roomId) => {
    const actor = [...activeActorsById.values()].find((candidate) => candidate.roomId === roomId);
    const { raw } = await actor.transport.readRoom(roomId, { log: false });
    const game = raw?.game ? decodeRoom(engine, raw).game : null;
    return { game };
  }));
  for (const { game } of roomGames) {
    if (!game || game.isOver) {
      continue;
    }
    const matchUserIds = game.players.map((player) => player.userId).filter(Boolean);
    if (matchUserIds.length !== 2) {
      continue;
    }
    const matchKey = [...matchUserIds].sort().join(':');
    const matchGroup = matchGroups.get(matchKey) ?? { game, actors: new Map() };
    for (const userId of matchUserIds) {
      const actor = activeActorsById.get(userId);
      if (actor) {
        matchGroup.actors.set(actor.userId, actor);
      }
    }
    matchGroups.set(matchKey, matchGroup);
  }

  const sortedMatchGroups = [...matchGroups.entries()]
    .sort(([firstMatchKey], [secondMatchKey]) => firstMatchKey.localeCompare(secondMatchKey));
  const selectedMatchGroups = matchRange
    ? sortedMatchGroups.slice(matchRange[0], matchRange[1])
    : sortedMatchGroups;
  await Promise.all(selectedMatchGroups.map(async ([matchKey, matchGroup]) => {
    const game = matchGroup.game;
    const matchActors = [...matchGroup.actors.values()];
    const expectedPlayerId = game.attack?.playerId ?? game.attackTurnPlayerId;
    const expectedUserId = game.players.find((player) => player.id === expectedPlayerId)?.userId;
    matchActors.sort((firstActor, secondActor) => {
      if (firstActor.userId === expectedUserId) {
        return -1;
      }
      if (secondActor.userId === expectedUserId) {
        return 1;
      }
      return 0;
    });
    for (const actor of matchActors) {
      const player = game.players.find((candidate) => candidate.userId === actor.userId);
      if (!player || player.dead) {
        continue;
      }
      let decision = null;
      if (game.attack) {
        if (game.attack.playerId === player.id) {
          decision = actor.policy.decideBuyConfirmation(game, player);
          if (!decision && game.attack.targetPlayerId === player.id) {
            decision = actor.policy.decideDefense(game, player);
          }
        } else if (game.attack.targetPlayerId === player.id) {
          decision = actor.policy.decideDefense(game, player);
        }
      } else if (game.attackTurnPlayerId === player.id) {
        decision = actor.policy.decideAttack(game, player);
      }
      if (!decision) {
        continue;
      }
      actor.policy.noteDecision(decision);
      try {
        await actor.transport.call('submit-command', {
          mode: 'duel',
          roomId: actor.roomId,
          command: toPlain(decision.command),
        });
        await record('policy-action', {
          userName: actor.userName,
          matchKey,
          roomId: actor.roomId,
          updateCount: game.updateCount,
          phase: decision.phase,
          kind: decision.kind,
        });
      } catch (error) {
        await record('policy-action-error', {
          userName: actor.userName,
          matchKey,
          roomId: actor.roomId,
          updateCount: game.updateCount,
          status: error.status ?? null,
          message: error.message,
        });
      }
      break;
    }
  }));
}

async function leaveAll() {
  const actorsToLeave = actors.filter((actor) => actor.roomId || actor.cleanupRoomId);
  for (const actor of actorsToLeave) {
    try {
      const roomId = actor.roomId ?? actor.cleanupRoomId;
      await actor.transport.call('leave-room', { mode: 'duel', roomId });
      await record('left', { userName: actor.userName, roomId });
    } catch (error) {
      await record('leave-error', {
        userName: actor.userName,
        roomId: actor.roomId ?? actor.cleanupRoomId,
        status: error.status ?? null,
        message: error.message,
      });
    }
  }

  const uniqueRoomIds = [...new Set(actorsToLeave.map((actor) =>
    actor.roomId ?? actor.cleanupRoomId,
  ))];
  const deadline = Date.now() + 30000;
  let remainingRoomIds = uniqueRoomIds;
  while (remainingRoomIds.length > 0 && Date.now() < deadline) {
    const roomStates = await Promise.all(remainingRoomIds.map(async (roomId) => {
      const actor = actorsToLeave.find((candidate) =>
        candidate.roomId === roomId || candidate.cleanupRoomId === roomId,
      );
      try {
        const { raw } = await actor.transport.readRoom(roomId, { log: false });
        const memberUserIds = raw?.users?.map((member) => member.id).filter(Boolean) ?? [];
        return { roomId, memberUserIds };
      } catch (error) {
        return { roomId, error: error.message };
      }
    }));
    const controlledUserIds = new Set(actors.map((actor) => actor.userId));
    remainingRoomIds = roomStates
      .filter((roomState) => roomState.error
        || roomState.memberUserIds?.some((userId) => controlledUserIds.has(userId)))
      .map((roomState) => roomState.roomId);
    await record('cleanup-verification', { roomStates });
    if (remainingRoomIds.length > 0) {
      await sleep(1000);
    }
  }

  if (remainingRoomIds.length === 0 && matchmakingStarted) {
    await fs.rm(credentialsPath, { force: true });
  } else if (remainingRoomIds.length > 0) {
    await record('cleanup-incomplete', { roomIds: remainingRoomIds, credentialsPath });
  }
}

async function verifyControlledMatches() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const activeActors = actors.filter((actor) => actor.roomId !== null);
    const controlledUserIds = new Set(activeActors.map((actor) => actor.userId));
    const expectedRoomIds = new Set(activeActors.map((actor) => actor.roomId));
    const roomStates = await Promise.all([...expectedRoomIds].map(async (roomId) => {
      const actor = activeActors.find((candidate) => candidate.roomId === roomId);
      const { raw } = await actor.transport.readRoom(roomId, { log: false });
      const playerUserIds = raw?.game?.players?.map((player) => player.userId).filter(Boolean) ?? [];
      const isMatched = playerUserIds.length === 2;
      const allPlayersControlled = isMatched
        && playerUserIds.every((userId) => controlledUserIds.has(userId));
      return { roomId, playerUserIds, isMatched, allPlayersControlled };
    }));
    const externalRooms = roomStates.filter((roomState) =>
      roomState.isMatched && !roomState.allPlayersControlled,
    );
    if (externalRooms.length > 0) {
      for (const externalRoom of externalRooms) {
        const affectedActors = actors.filter((actor) => actor.roomId === externalRoom.roomId);
        for (const actor of affectedActors) {
          actor.cleanupRoomId = actor.roomId;
          try {
            await actor.transport.call('leave-room', {
              mode: 'duel',
              roomId: actor.roomId,
            });
            actor.roomId = null;
          } catch (error) {
            await record('leave-error', {
              userName: actor.userName,
              roomId: actor.roomId,
              status: error.status ?? null,
              message: error.message,
            });
          }
          actor.roomId = null;
        }
        await record('excluded-external-match', {
          roomId: externalRoom.roomId,
          userNames: affectedActors.map((actor) => actor.userName),
        });
      }
      continue;
    }
    const controlledPairsByKey = new Map();
    for (const roomState of roomStates) {
      if (!roomState.allPlayersControlled) {
        continue;
      }
      const pairKey = [...roomState.playerUserIds].sort().join(':');
      controlledPairsByKey.set(pairKey, roomState.playerUserIds);
    }
    const controlledPlayerIds = new Set([...controlledPairsByKey.values()].flat());
    const controlledPairs = controlledPairsByKey.size;
    const unmatchedActors = activeActors.filter((actor) => !controlledPlayerIds.has(actor.userId));
    if (controlledPairs * 2 >= minimumControlledPlayers) {
      for (const actor of unmatchedActors) {
        actor.cleanupRoomId = actor.roomId;
        try {
          const roomId = actor.roomId;
          await actor.transport.call('leave-room', { mode: 'duel', roomId });
          await record('excluded-unmatched-account', { userName: actor.userName, roomId });
        } catch (error) {
          await record('leave-error', {
            userName: actor.userName,
            roomId: actor.roomId,
            status: error.status ?? null,
            message: error.message,
          });
        }
        actor.roomId = null;
      }
      await record('match-verification', {
        queuedAccountCount: ACTOR_COUNT,
        excludedAccountCount: ACTOR_COUNT - controlledPlayerIds.size,
        controlledPairs,
        minimumControlledPlayers,
      });
      return { controlledPairs };
    }
    await sample('matchmaking');
    await sleep(1000);
  }
  await leaveAll();
  throw new Error('The remaining controlled accounts did not finish matchmaking within 120 seconds');
}

await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });

try {
  await record('meta', {
    seed,
    actorCount: ACTOR_COUNT,
    userNames,
    language: 'ko',
    accountSource: accountPoolPath ?? 'new anonymous accounts',
    matchmaking: 'standard ExplorationPolicy plays only verified controlled matches',
    idleProbe,
    timedIdleWaves,
    repeatAllMatches,
    observationMs,
    minimumControlledPlayers,
    queueBatchSize,
    firstWaveLeadSeconds,
    secondWaveLeadSeconds,
  });
  for (let batchStart = 0; batchStart < actors.length; batchStart += 10) {
    const accountBatch = actors.slice(batchStart, batchStart + 10);
    const batchResults = await Promise.allSettled(accountBatch.map(async (actor) => {
      if (actor.pooledAccount) {
        actor.userId = actor.pooledAccount.userId;
        actor.transport.refreshToken = actor.pooledAccount.refreshToken;
        await actor.transport.refreshAuth();
      } else {
        actor.userId = await actor.transport.signIn();
      }
      const recordResult = await actor.transport.readDocument(`records/${actor.userId}`, {
        log: false,
      });
      actor.rating = recordResult.raw?.rating ?? 0;
      actor.recordExists = recordResult.exists;
      const actorIndex = actors.indexOf(actor);
      actor.policy = new ExplorationPolicy({
        engine,
        catalog,
        rng: createRng(seed + actorIndex),
      });
      return {
        userName: actor.userName,
        userId: actor.userId,
        refreshToken: actor.transport.refreshToken,
        rating: actor.rating,
        recordExists: actor.recordExists,
      };
    }));
    for (const result of batchResults) {
      if (result.status === 'rejected') {
        await record('account-error', {
          message: result.reason?.message ?? String(result.reason),
          status: result.reason?.status ?? null,
        });
        continue;
      }
      credentials.push(result.value);
      await fs.writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
        mode: 0o600,
      });
      await record('account', {
        userName: result.value.userName,
        rating: result.value.rating,
        recordExists: result.value.recordExists,
      });
    }
    if (batchResults.some((result) => result.status === 'rejected')) {
      throw new Error('Unable to authenticate every account in this batch');
    }
    await sleep(750);
  }
  const accountRatings = actors.map((actor) => actor.rating);
  const minimumRating = Math.min(...accountRatings);
  const maximumRating = Math.max(...accountRatings);
  if (maximumRating - minimumRating > 200) {
    throw new Error(`Account ratings span ${minimumRating} to ${maximumRating}, over 200 points`);
  }
  await record('rating-verification', {
    accountCount: ACTOR_COUNT,
    minimumRating,
    maximumRating,
  });
  await sample('baseline');

  /*
   * Queue all accounts together so the last account cannot be exposed to
   * unrelated public matchmaking while the controlled cohort is incomplete.
   */
  matchmakingStarted = true;
  for (let batchStart = 0; batchStart < actors.length; batchStart += queueBatchSize) {
    const actorBatch = actors.slice(batchStart, batchStart + queueBatchSize);
    const queueResults = await Promise.allSettled(actorBatch.map(async (actor) => {
      const result = await actor.transport.call('create-room', {
        mode: 'duel',
        userName: actor.userName,
        lang: 'ko',
      });
      actor.roomId = result?.roomId ?? null;
      if (typeof actor.roomId !== 'string') {
        throw new Error(`No duel room was returned for ${actor.userName}`);
      }
      actor.cleanupRoomId = actor.roomId;
      await record('queued', { userName: actor.userName, roomId: actor.roomId });
    }));
    for (const [resultIndex, queueResult] of queueResults.entries()) {
      if (queueResult.status === 'rejected') {
        const actor = actorBatch[resultIndex];
        await record('queue-error', {
          userName: actor.userName,
          status: queueResult.reason?.status ?? null,
          message: queueResult.reason?.message ?? String(queueResult.reason),
        });
      }
    }
  }
  const matchVerification = await verifyControlledMatches();

  if (idleProbe) {
    await sample('matched-before-policy-action');
    if (timedIdleWaves) {
      const middleMatchIndex = Math.ceil(matchVerification.controlledPairs / 2);
      const waves = await planTimedActivityWaves();
      await record('timed-wave-plan', {
        controlledPairs: matchVerification.controlledPairs,
        firstWaveMatchRange: repeatAllMatches ? null : [0, middleMatchIndex],
        secondWaveMatchRange: repeatAllMatches
          ? null
          : [middleMatchIndex, matchVerification.controlledPairs],
        expectedPublicationAt: waves.expectedPublicationAt,
        firstWaveAt: new Date(waves.firstWaveAt).toISOString(),
        secondWaveAt: new Date(waves.secondWaveAt).toISOString(),
        targetActivityAgesSeconds: [firstWaveLeadSeconds, secondWaveLeadSeconds],
      });

      await waitUntil(waves.firstWaveAt);
      await record('timed-wave-start', { wave: 1, targetAt: new Date(waves.firstWaveAt).toISOString() });
      await playOneRound(repeatAllMatches ? {} : { matchRange: [0, middleMatchIndex] });
      await recordRoomActivity('after-timed-wave-1');
      await sample('after-timed-wave-1');

      let secondWaveAt = waves.secondWaveAt;
      if (repeatAllMatches) {
        const firstPublicationAt = await waitForNextPublication(
          waves.currentPublicationAt,
          waves.firstWaveAt,
        );
        secondWaveAt = Date.parse(firstPublicationAt) + 60000 - secondWaveLeadSeconds * 1000;
        await record('first-wave-publication', {
          documentUpdateTime: firstPublicationAt,
          secondWaveAt: new Date(secondWaveAt).toISOString(),
        });
      }
      await waitUntil(secondWaveAt);
      await record('timed-wave-start', { wave: 2, targetAt: new Date(secondWaveAt).toISOString() });
      await playOneRound(repeatAllMatches
        ? {}
        : { matchRange: [middleMatchIndex, matchVerification.controlledPairs] });
      await recordRoomActivity('after-timed-wave-2');
      await sample('after-timed-wave-2');
      await observe('idle-after-timed-waves', observationMs, { play: false });
    } else {
      await playOneRound();
      await recordRoomActivity('after-final-policy-action');
      await sample('after-final-policy-action');
      await observe('idle-after-final-policy-action', observationMs, { play: false });
    }
    await leaveAll();
    await observe('after-leave', 120000, { play: false });
  } else {
    await observe('queued-and-matched', observationMs);
    await leaveAll();
    await observe('after-leave', observationMs);
  }

  for (const actor of actors) {
    if (!actor.roomId) {
      continue;
    }
    const result = await actor.transport.readRoom(actor.roomId, { log: false });
    await record('final-room', {
      userName: actor.userName,
      roomId: actor.roomId,
      userCount: result.raw?.userCount ?? null,
      memberNames: result.raw?.users?.map((member) => member.name) ?? null,
      gameIsOver: result.raw?.game?.isOver ?? null,
    });
  }
  } finally {
    await leaveAll();
    await logger.close();
  }

  process.stdout.write(`Evidence: ${path.join(outputDirectory, 'observations.jsonl')}\n`);
