#!/usr/bin/env node
/**
 * Runs a multi-account Royal Duel campaign against the live service.
 *
 * Every account plays one match per round. When the account count is even, all
 * accounts are active at the same time. Move selection uses the same validated
 * server battle policy as local play; only the transport is the live service.
 *
 * Usage:
 *   node --import tsx tools/live-games/run-duel-campaign.mjs \
 *     --accounts 30 --games 50 --pool logs/live/duel-campaign/accounts.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LiveTransport, HttpError, toPlain } from './transport.mjs';
import { JsonlLogger } from './log.mjs';
import { loadEngine, root } from './engine.mjs';
import {
  loadCatalog,
  decodeRoom,
  serializeRoom,
  serializeGame,
  diffPlayerSnapshots,
  worldChanges,
} from './state.mjs';
import { Battle } from '../../server/battle/battle.ts';
import { generateAiNames } from '../../server/rooms/bot-names.ts';
import { Random } from '../../server/random.ts';

const DUEL_ELO_SCALE = 1600;
const DUEL_ELO_K = 32;

function parseArguments(argv) {
  const options = {
    accounts: 30,
    games: 50,
    pool: path.resolve('logs', 'live', 'duel-campaign', 'accounts.json'),
    output: null,
    seed: Date.now(),
    pollMs: 400,
    turnTimeoutMs: 45000,
    stallSeconds: 180,
    matchmakingTimeoutMs: 180000,
    matchMaxSeconds: 900,
    coverage: null,
    help: false,
  };
  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex++) {
    const argument = argv[argumentIndex];
    const next = () => {
      const value = argv[++argumentIndex];
      if (value === undefined) {
        throw new Error(`Missing value for ${argument}`);
      }
      return value;
    };
    switch (argument) {
      case '--accounts':
        options.accounts = Number(next());
        break;
      case '--games':
        options.games = Number(next());
        break;
      case '--pool':
        options.pool = path.resolve(next());
        break;
      case '--output':
        options.output = path.resolve(next());
        break;
      case '--seed':
        options.seed = Number(next());
        break;
      case '--poll-ms':
        options.pollMs = Number(next());
        break;
      case '--turn-timeout-ms':
        options.turnTimeoutMs = Number(next());
        break;
      case '--stall-seconds':
        options.stallSeconds = Number(next());
        break;
      case '--matchmaking-timeout-ms':
        options.matchmakingTimeoutMs = Number(next());
        break;
      case '--match-max-seconds':
        options.matchMaxSeconds = Number(next());
        break;
      case '--coverage':
        options.coverage = next();
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function stamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readPool(poolPath, accountCount) {
  const parsed = JSON.parse(await fs.readFile(poolPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`Account pool is not an array: ${poolPath}`);
  }
  const accounts = parsed
    .filter((entry) => entry?.userId && entry?.refreshToken)
    .slice(0, accountCount);
  if (accounts.length !== accountCount) {
    throw new Error(
      `Account pool has ${accounts.length} usable accounts; ${accountCount} required`,
    );
  }
  return accounts;
}

class SnapshotFeed {
  constructor() {
    this.latest = null;
    this.delivered = null;
    this.waiters = [];
  }

  push(snapshot) {
    this.latest = snapshot;
    while (this.waiters.length !== 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      this.delivered = snapshot;
      waiter.resolve(snapshot);
    }
  }

  next(timeoutMs) {
    if (this.latest !== null && this.latest !== this.delivered) {
      this.delivered = this.latest;
      return Promise.resolve(this.latest);
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function expectedCommandPlayerId(game) {
  const pendingAttack = game.attacks?.[0] ?? game.attack ?? null;
  if (!pendingAttack) {
    return game.attackTurnPlayerId;
  }
  if (pendingAttack.buyingItemModelId) {
    return pendingAttack.playerId;
  }
  return pendingAttack.targetPlayerId;
}

function chooseServerBotCommand(game, random) {
  const candidateGame = structuredClone(game);
  const expectedPlayerId = expectedCommandPlayerId(candidateGame);
  const expectedPlayer = candidateGame.players.find(
    (player) => player.id === expectedPlayerId,
  );
  if (!expectedPlayer) {
    throw new Error(
      `No player ${expectedPlayerId} for update ${game.updateCount}`,
    );
  }
  expectedPlayer.isBot = true;
  const battle = new Battle(candidateGame, random);
  const choice = battle.botCommand();
  if (!choice) {
    throw new Error(
      `Server bot policy declined player ${expectedPlayerId} at update ${game.updateCount}`,
    );
  }
  return choice;
}

function rankingRecords(rankingDocument) {
  if (Array.isArray(rankingDocument?.records)) {
    return rankingDocument.records;
  }
  if (Array.isArray(rankingDocument?.ranking)) {
    return rankingDocument.ranking;
  }
  return [];
}

async function loadRankingSnapshot(transport, logger) {
  try {
    const result = await transport.readDocument('rankings/duel', { log: false });
    const records = rankingRecords(result.exists ? result.raw : null);
    const sorted = [...records].sort(
      (firstRecord, secondRecord) =>
        (secondRecord.rating ?? 0) - (firstRecord.rating ?? 0) ||
        String(firstRecord.userId).localeCompare(String(secondRecord.userId)),
    );
    const recordsByUserId = new Map();
    const positionByUserId = new Map();
    for (const [recordIndex, record] of sorted.entries()) {
      recordsByUserId.set(record.userId, record);
      positionByUserId.set(record.userId, recordIndex + 1);
    }
    return { recordsByUserId, positionByUserId };
  } catch (error) {
    logger.record('rankingReadFailed', {
      message: String(error?.message ?? error),
      status: error?.status ?? null,
    });
    return { recordsByUserId: new Map(), positionByUserId: new Map() };
  }
}

function rankEntryFromRecord(account, record, snapshot) {
  return {
    userId: account.userId,
    name: account.name,
    rating: record?.rating ?? 0,
    position: snapshot.positionByUserId.get(account.userId) ?? null,
    gameCount: record?.gameCount ?? 0,
  };
}

function rankEntryFromGame(account, game) {
  const player = game.players.find(
    (candidatePlayer) => candidatePlayer.userId === account.userId,
  );
  return {
    userId: account.userId,
    name: account.name,
    ratingBefore: player?.rating ?? 0,
    ratingAfter: (player?.rating ?? 0) + (player?.ratingGain ?? 0),
    ratingGain: player?.ratingGain ?? 0,
    dead: player?.dead === true,
  };
}

function rankDelta(beforeEntry, afterEntry) {
  return {
    rating: (afterEntry?.rating ?? 0) - (beforeEntry?.rating ?? 0),
    position:
      beforeEntry?.position === null ||
      beforeEntry?.position === undefined ||
      afterEntry?.position === null ||
      afterEntry?.position === undefined
        ? null
        : beforeEntry.position - afterEntry.position,
  };
}

async function readDuelRecord(account) {
  try {
    const result = await account.transport.readDocument(
      `records/${account.userId}`,
      { log: false },
    );
    return result.exists ? result.raw : null;
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }
    throw error;
  }
}

function createAccountChoices(account, beforeRecord, snapshot) {
  return rankEntryFromRecord(account, beforeRecord, snapshot);
}

async function createDuelRoom(account, logger, context) {
  const response = await account.transport.call(
    account.engine.cloudFunction.createRoom,
    new Map([
      ['mode', 'duel'],
      ['userName', account.name],
      ['lang', 'en'],
    ]),
  );
  if (typeof response?.roomId !== 'string') {
    throw new Error(
      `create-room did not return a room id for ${account.name}: ${JSON.stringify(response)}`,
    );
  }
  logger.record('createRoom', {
    ...context,
    userId: account.userId,
    name: account.name,
    roomId: response.roomId,
  });
  return response.roomId;
}

async function leaveDuelRoom(account, roomId, logger) {
  try {
    await account.transport.call(
      account.engine.roomAction.leaveRoom,
      new Map([
        ['mode', 'duel'],
        ['roomId', roomId],
      ]),
    );
    logger.record('leaveRoom', {
      userId: account.userId,
      name: account.name,
      roomId,
      ok: true,
    });
  } catch (error) {
    logger.record('leaveRoom', {
      userId: account.userId,
      name: account.name,
      roomId,
      ok: false,
      status: error?.status ?? null,
      body: error?.body ?? null,
      message: String(error?.message ?? error),
    });
  }
}

async function playRoom({
  roomId,
  controlledAccounts,
  beforeEntries,
  outputDirectory,
  gameId,
  seed,
  options,
  engine,
  catalog,
  campaignLogger,
  matchIndex,
  round,
}) {
  const logger = new JsonlLogger(
    path.join(outputDirectory, 'matches', `${gameId}.jsonl`),
    {
      gameId,
      playerCount: 2,
      seed,
      roomId,
      round,
      match: matchIndex,
    },
  );
  const accountLoggers = new Map();
  for (const account of controlledAccounts) {
    accountLoggers.set(account, account.transport.logger);
    account.transport.logger = logger;
  }
  const accountByUserId = new Map(
    controlledAccounts.map((account) => [account.userId, account]),
  );
  const random = new Random(seed);
  const feed = new SnapshotFeed();
  const watcherAccount = controlledAccounts[0];
  let latest = null;
  let previousGame = null;
  let previousRaw = null;
  let lastChangeAt = Date.now();
  let missingRoom = false;
  let gameStart = null;
  let finalGame = null;
  let result = 'error';
  let rejectionCount = 0;
  let lastSubmit = null;
  let updatesSeen = 0;
  const startedAt = Date.now();
  const eliminations = [];
  let watcher = null;

  logger.record('meta', {
    type: 'meta',
    schemaVersion: 1,
    mode: 'duel',
    roomId,
    accounts: controlledAccounts.map((account) => ({
      userId: account.userId,
      name: account.name,
      before: beforeEntries.get(account.userId) ?? null,
    })),
    policy: 'server.actions.battle.Battle.botCommand',
    seed,
  });

  try {
    watcher = (async () => {
      for (;;) {
        try {
          await watcherAccount.transport.watchRoom(
            roomId,
            async (message) => {
              try {
                const room = decodeRoom(engine, message.document);
                const game = room.game;
                const priorGame = previousGame;
                const priorRaw = previousRaw;
                let serializedRoom = null;
                try {
                  serializedRoom = serializeRoom(room, catalog);
                } catch (error) {
                  logger.record('error', {
                    stage: 'serializeRoom',
                    message: String(error?.message ?? error),
                  });
                }
                previousGame = game;
                previousRaw = message.document;
                lastChangeAt = Date.now();
                latest = {
                  raw: message.document,
                  room,
                  game,
                  serializedRoom,
                };
                feed.push(latest);

                if (game !== null) {
                  const serializedGame = serializeGame(game, catalog);
                  logger.record('state', {
                    channelSequence: message.sequence,
                    updateTime: message.updateTime,
                    updateCount: game.updateCount,
                    game: serializedGame,
                  });
                  if (priorGame === null) {
                    gameStart = serializedGame;
                    logger.record('gameStart', {
                      updateCount: game.updateCount,
                      game: serializedGame,
                    });
                  }
                  if (
                    priorGame === null ||
                    game.updateCount !== priorGame.updateCount
                  ) {
                    const deadSet = new Set(
                      (priorGame?.players ?? game.players)
                        .filter((player) => player.dead === true)
                        .map((player) => player.id),
                    );
                    const deathPlayers = new Set();
                    let exchangeStart = 0;
                    for (const [eventIndex, record] of serializedGame.events.entries()) {
                      logger.record('event', record);
                      if (record.action === 'advanceGF') {
                        exchangeStart = eventIndex + 1;
                      }
                      if (record.action === 'revive') {
                        deadSet.delete(record.playerId);
                      }
                      if (record.action === 'die') {
                        deadSet.add(record.playerId);
                        deathPlayers.add(record.playerId);
                        const elimination = {
                          updateCount: game.updateCount,
                          eventIndex,
                          playerId: record.playerId,
                          playerName:
                            game.players.find(
                              (player) => player.id === record.playerId,
                            )?.name ?? null,
                          remainingPlayers: game.players.length - deadSet.size,
                          cause: serializedGame.events
                            .slice(exchangeStart, eventIndex + 1)
                            .map((event) => event.action),
                        };
                        logger.record('elimination', elimination);
                        eliminations.push(elimination);
                      }
                    }
                    if (priorGame !== null) {
                      const changes = diffPlayerSnapshots(
                        priorGame,
                        game,
                        catalog,
                      );
                      for (const change of changes) {
                        logger.record('stat', {
                          updateCount: game.updateCount,
                          cause: game.events.map((event) => event.action),
                          ...change,
                        });
                        if (
                          change.fields?.dead?.to === true &&
                          !deathPlayers.has(change.playerId)
                        ) {
                          const elimination = {
                            updateCount: game.updateCount,
                            eventIndex: null,
                            playerId: change.playerId,
                            playerName: change.playerName,
                            remainingPlayers: game.players.filter(
                              (player) => player.dead !== true,
                            ).length,
                            cause: serializedGame.events
                              .slice(-8)
                              .map((event) => event.action),
                            source:
                              'stat fallback (death event was outside the captured update)',
                          };
                          logger.record('elimination', elimination);
                          eliminations.push(elimination);
                        }
                      }
                    }
                    const world = worldChanges(
                      priorRaw,
                      message.document,
                    );
                    if (world !== null) {
                      logger.record('world', {
                        updateCount: game.updateCount,
                        changes: world,
                      });
                    }
                  }
                } else if (priorGame !== null) {
                  logger.record('lobby', { room: serializedRoom });
                }
              } catch (error) {
                logger.record('error', {
                  stage: 'channelLog',
                  message: String(error?.message ?? error),
                  stack: error?.stack,
                });
              }
            },
            {
              intervalMs: options.pollMs,
              onMissing: () => {
                missingRoom = true;
                logger.record('channelMissing', { roomId });
              },
            },
          );
          if (watcherAccount.transport.stopped) {
            return;
          }
        } catch (error) {
          logger.record('error', {
            stage: 'watch',
            message: String(error?.message ?? error),
            stack: error?.stack,
          });
          if (watcherAccount.transport.stopped) {
            return;
          }
          await sleep(1000);
        }
      }
    })();

    const matchmakingDeadline = Date.now() + options.matchmakingTimeoutMs;
    while (latest?.game == null && !missingRoom) {
      if (Date.now() > matchmakingDeadline) {
        logger.record('matchmakingTimeout', {
          roomId,
          elapsedMs: Date.now() - startedAt,
        });
        result = 'matchmakingTimeout';
        break;
      }
      await sleep(250);
    }
    if (result !== 'matchmakingTimeout') {
      if (missingRoom) {
        throw new Error(`The duel room ${roomId} disappeared during matchmaking`);
      }
      if (latest?.game == null) {
        throw new Error('Matchmaking ended without a game');
      }
      logger.record('matched', {
        roomId,
        updateCount: latest.game.updateCount,
        game:
          latest.serializedRoom?.game ??
          serializeGame(latest.game, catalog),
      });
    }

    const turnDeadlineMs = options.turnTimeoutMs;
    const stallMs =
      options.stallSeconds > 0 ? options.stallSeconds * 1000 : Infinity;
    const matchDeadline =
      options.matchMaxSeconds > 0
        ? startedAt + options.matchMaxSeconds * 1000
        : Infinity;

    while (result === 'error' && Date.now() < matchDeadline) {
      if (missingRoom && latest?.game == null) {
        result = 'roomMissing';
        break;
      }
      if (lastSubmit && Date.now() - lastSubmit.at > turnDeadlineMs) {
        logger.record('turnTimeout', {
          updateCount: lastSubmit.updateCount,
          phase: lastSubmit.phase,
          elapsedMs: Date.now() - lastSubmit.at,
        });
        result = 'turnTimeout';
        break;
      }
      const snapshot = await feed.next(1000);
      const current = snapshot ?? latest;
      if (current === null || current?.game == null) {
        if (Date.now() - lastChangeAt > stallMs) {
          logger.record('stallTimeout', {
            waitingFor: 'game state',
            elapsedMs: Date.now() - lastChangeAt,
          });
          result = 'stalled';
          break;
        }
        continue;
      }

      const game = current.game;
      if (game.updateCount !== updatesSeen) {
        updatesSeen = game.updateCount;
        if (
          lastSubmit &&
          game.updateCount > lastSubmit.updateCount
        ) {
          lastSubmit = null;
        }
      }
      if (game.isOver === true) {
        finalGame = current.raw.game;
        result = 'over';
        break;
      }
      if (lastSubmit && lastSubmit.updateCount === game.updateCount) {
        continue;
      }

      const expectedPlayerId = expectedCommandPlayerId(game);
      const expectedPlayer = game.players.find(
        (player) => player.id === expectedPlayerId,
      );
      if (!expectedPlayer?.userId) {
        continue;
      }
      const actingAccount = accountByUserId.get(expectedPlayer.userId);
      if (!actingAccount) {
        continue;
      }

      const choice = chooseServerBotCommand(current.raw.game, random);
      const command = toPlain(choice.command);
      logger.record('decision', {
        updateCount: game.updateCount,
        phase: 'serverBot',
        playerId: choice.player.id,
        playerName: choice.player.name,
        userId: actingAccount.userId,
        command,
        policy: 'server.actions.battle.Battle.botCommand',
      });

      const submittedUpdate = game.updateCount;
      try {
        await actingAccount.transport.call(
          actingAccount.engine.roomAction.submitCommand,
          new Map([
            ['mode', 'duel'],
            ['roomId', roomId],
            ['command', command],
          ]),
        );
        lastSubmit = {
          updateCount: submittedUpdate,
          at: Date.now(),
          phase: 'serverBot',
        };
        rejectionCount = 0;
      } catch (error) {
        if (!(error instanceof HttpError)) {
          throw error;
        }
        rejectionCount++;
        logger.record('rejected', {
          updateCount: submittedUpdate,
          userId: actingAccount.userId,
          name: actingAccount.name,
          status: error.status,
          errorCode: `HTTP_${error.status}`,
          body: error.body,
          command,
        });
        lastSubmit = null;
        if (rejectionCount >= 4) {
          result = 'rejected';
          break;
        }
        await sleep(350);
      }
    }

    if (result === 'error' && Date.now() >= matchDeadline) {
      result = 'matchTimeout';
      logger.record('matchTimeout', {
        elapsedMs: Date.now() - startedAt,
        maxSeconds: options.matchMaxSeconds,
      });
    }

    const endGame = finalGame ?? latest?.raw?.game ?? null;
    const rankingAfter = await loadRankingSnapshot(
      watcherAccount.transport,
      logger,
    );
    const afterEntries = new Map();
    for (const account of controlledAccounts) {
      const record = await readDuelRecord(account);
      const player = endGame?.players.find(
        (candidatePlayer) => candidatePlayer.userId === account.userId,
      );
      const enemy = endGame?.players.find(
        (candidatePlayer) => candidatePlayer.userId !== account.userId,
      );
      const before = beforeEntries.get(account.userId) ?? null;
      const after = rankEntryFromRecord(account, record, rankingAfter);
      const enemyBefore =
        enemy?.userId !== undefined &&
        beforeEntries.has(enemy.userId)
          ? beforeEntries.get(enemy.userId)
          : {
              userId: enemy?.userId ?? null,
              name: enemy?.name ?? null,
              rating: enemy?.rating ?? 0,
              position: null,
              gameCount: null,
            };
      const enemyAfter =
        enemy?.userId !== undefined &&
        afterEntries.has(enemy.userId)
          ? afterEntries.get(enemy.userId)
          : {
              userId: enemy?.userId ?? null,
              name: enemy?.name ?? null,
              rating:
                (enemy?.rating ?? 0) + (enemy?.ratingGain ?? 0),
              position:
                enemy?.userId === undefined
                  ? null
                  : rankingAfter.positionByUserId.get(enemy.userId) ?? null,
              gameCount: null,
            };
      afterEntries.set(account.userId, after);
      logger.record('duelRecord', {
        phase: 'after',
        userId: account.userId,
        name: account.name,
        record,
        playerRating: player?.rating ?? null,
        ratingGain: player?.ratingGain ?? null,
      });
      if (before !== null) {
        logger.record('rankingUpdate', {
          perspective: account.name,
          playerRankBefore: before,
          playerRankAfter: after,
          playerRankDelta: rankDelta(before, after),
          enemyRankBefore: enemyBefore,
          enemyRankAfter: enemyAfter,
          enemyRankDelta: rankDelta(enemyBefore, enemyAfter),
        });
      }
    }

    const winner = endGame?.players.find((player) => !player.dead) ?? null;
    const loser = endGame?.players.find((player) => player !== winner) ?? null;
    const winnerGain = winner?.ratingGain ?? null;
    const expectedWinnerGain =
      winner !== null &&
      loser !== null &&
      winner.isBot !== true
        ? Math.round(
            DUEL_ELO_K *
              (1 -
                1 /
                  (1 +
                    10 **
                      (((loser.rating ?? 0) - (winner.rating ?? 0)) /
                        DUEL_ELO_SCALE))),
          )
        : 0;
    const eloCheck = {
      winnerUserId: winner?.userId ?? null,
      loserUserId: loser?.userId ?? null,
      winnerRatingBefore: winner?.rating ?? null,
      loserRatingBefore: loser?.rating ?? null,
      winnerGain,
      loserGain: loser?.ratingGain ?? null,
      expectedWinnerGain,
      winnerIsBot: winner?.isBot === true,
      matches:
        winnerGain === expectedWinnerGain &&
        (loser?.ratingGain ?? null) === -expectedWinnerGain,
    };
    logger.record('eloCheck', eloCheck);
    logger.record('end', {
      result,
      roomId,
      durationMs: Date.now() - startedAt,
      updateCount: endGame?.updateCount ?? null,
      winnerIds: endGame?.players
        .filter((player) => !player.dead)
        .map((player) => player.id) ?? [],
      players:
        endGame?.players.map((player) => ({
          id: player.id,
          userId: player.userId,
          name: player.name,
          alias: player.alias,
          hp: player.hp,
          dead: player.dead === true,
          rating: player.rating ?? null,
          ratingGain: player.ratingGain ?? null,
        })) ?? [],
      eliminations,
      rejectionCount,
      eloCheck,
      game: endGame === null ? null : serializeGame(decodeRoom(engine, latest.raw).game, catalog),
    });

    campaignLogger.record('matchResult', {
      gameId,
      round,
      match: matchIndex,
      roomId,
      result,
      updateCount: endGame?.updateCount ?? null,
      durationMs: Date.now() - startedAt,
      controlledUserIds: controlledAccounts.map((account) => account.userId),
      opponentUserIds:
        endGame?.players
          .filter(
            (player) =>
              !controlledAccounts.some(
                (account) => account.userId === player.userId,
              ),
          )
          .map((player) => player.userId) ?? [],
      rejectionCount,
      eloCheck,
      updatedAt: new Date().toISOString(),
    });

    return {
      gameId,
      roomId,
      result,
      eloCheck,
      endGame,
      rejectionCount,
    };
  } catch (error) {
    result = 'error';
    logger.record('error', {
      stage: 'game',
      message: String(error?.message ?? error),
      stack: error?.stack,
      status: error?.status ?? null,
      body: error?.body ?? null,
    });
    campaignLogger.record('matchResult', {
      gameId,
      round,
      match: matchIndex,
      roomId,
      result,
      error: String(error?.message ?? error),
      status: error?.status ?? null,
      controlledUserIds: controlledAccounts.map((account) => account.userId),
      updatedAt: new Date().toISOString(),
    });
    return {
      gameId,
      roomId,
      result,
      eloCheck: null,
      endGame: finalGame,
      rejectionCount,
    };
  } finally {
    watcherAccount.transport.stop();
    if (watcher) {
      await Promise.race([watcher, sleep(1500)]);
    }
    for (const account of controlledAccounts) {
      await leaveDuelRoom(account, roomId, logger);
    }
    await logger.flush();
    for (const [account, accountLogger] of accountLoggers) {
      account.transport.logger = accountLogger;
    }
  }
}

async function runAccountCampaign({
  account,
  options,
  runDirectory,
  engine,
  catalog,
  campaignLogger,
}) {
  let completedGames = 0;
  let failedGames = 0;
  let attempts = 0;
  const maximumAttempts =
    options.games + Math.max(10, Math.ceil(options.games * 0.2));
  const eloChecks = new Map();

  while (completedGames < options.games && attempts < maximumAttempts) {
    attempts++;
    const rankingBefore = await loadRankingSnapshot(
      account.transport,
      campaignLogger,
    );
    const record = await readDuelRecord(account);
    const beforeEntry = createAccountChoices(
      account,
      record,
      rankingBefore,
    );
    let roomId;
    try {
      roomId = await createDuelRoom(account, campaignLogger, {
        account: account.name,
        accountIndex: account.index,
        game: completedGames + 1,
        attempt: attempts,
      });
    } catch (error) {
      failedGames++;
      campaignLogger.record('accountGameError', {
        account: account.name,
        accountIndex: account.index,
        stage: 'create-room',
        message: String(error?.message ?? error),
        status: error?.status ?? null,
        body: error?.body ?? null,
      });
      await sleep(3000);
      continue;
    }

    const result = await playRoom({
      roomId,
      controlledAccounts: [account],
      beforeEntries: new Map([[account.userId, beforeEntry]]),
      outputDirectory: runDirectory,
      gameId: `account-${String(account.index + 1).padStart(2, '0')}-game-${String(completedGames + 1).padStart(2, '0')}-${roomId}`,
      seed:
        options.seed +
        account.index * 100000 +
        (completedGames + 1) * 1000 +
        attempts,
      options,
      engine,
      catalog,
      campaignLogger,
      matchIndex: completedGames + 1,
      round: account.index + 1,
    });

    if (result.result === 'over') {
      completedGames++;
    } else {
      failedGames++;
    }
    if (result.eloCheck && result.roomId) {
      eloChecks.set(result.roomId, {
        gameId: result.gameId,
        account: account.name,
        ...result.eloCheck,
      });
    }
    campaignLogger.record('accountGameResult', {
      account: account.name,
      accountIndex: account.index,
      completedGames,
      attempt: attempts,
      roomId,
      result: result.result,
      rejectionCount: result.rejectionCount,
      eloCheck: result.eloCheck,
    });
    process.stdout.write(
      `${account.name}: ${completedGames}/${options.games} (${result.result})\n`,
    );
    await sleep(1000);
  }

  return {
    account: account.name,
    accountIndex: account.index,
    userId: account.userId,
    completedGames,
    failedGames,
    attempts,
    eloChecks: [...eloChecks.values()],
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'God Field live Royal Duel campaign\n\n' +
        '  --accounts N   number of accounts from the pool (default 30)\n' +
        '  --games N      matches per account (default 50)\n' +
        '  --pool FILE    account pool with userId/refreshToken\n' +
        '  --output DIR   log directory\n' +
        '  --poll-ms N    Firestore polling interval (default 400)\n' +
        '  --coverage FILE optional coverage file\n',
    );
    return;
  }
  if (!Number.isInteger(options.accounts) || options.accounts < 2) {
    throw new Error('--accounts must be an integer of at least 2');
  }
  if (options.accounts % 2 !== 0) {
    throw new Error('--accounts must be even');
  }
  if (!Number.isInteger(options.games) || options.games < 1) {
    throw new Error('--games must be a positive integer');
  }

  const runDirectory =
    options.output ??
    path.resolve('logs', 'live', 'duel-campaign', `run-${stamp()}`);
  await fs.mkdir(runDirectory, { recursive: true });
  const campaignLogger = new JsonlLogger(
    path.join(runDirectory, 'campaign.jsonl'),
    {
      campaign: path.basename(runDirectory),
      accounts: options.accounts,
      gamesPerAccount: options.games,
      seed: options.seed,
    },
  );

  const engine = await loadEngine();
  const { catalog, itemCount, catalogHash } = await loadCatalog(engine);
  const pool = await readPool(options.pool, options.accounts);
  const accountNames = generateAiNames(
    options.accounts,
    [],
    'ko',
    new Random(options.seed),
  );
  const accounts = [];
  for (const [accountIndex, entry] of pool.entries()) {
    const accountName = accountNames[accountIndex];
    const accountLogger = new JsonlLogger(
      path.join(
        runDirectory,
        'accounts',
        `account-${String(accountIndex + 1).padStart(2, '0')}.jsonl`,
      ),
      { accountIndex, userId: entry.userId, name: accountName },
    );
    const transport = new LiveTransport({
      logger: accountLogger,
      roomMode: 'duel',
      pollIntervalMs: options.pollMs,
      logPolls: 'summary',
      logChannelDocument: true,
    });
    transport.refreshToken = entry.refreshToken;
    transport.userId = entry.userId;
    await transport.refreshAuth();
    const account = {
      index: accountIndex,
      userId: entry.userId,
      name: accountName,
      refreshToken: entry.refreshToken,
      transport,
      engine,
      logger: accountLogger,
    };
    accounts.push(account);
    campaignLogger.record('accountReady', {
      accountIndex,
      userId: account.userId,
      name: account.name,
    });
  }

  campaignLogger.record('start', {
    runDirectory,
    pool: options.pool,
    accounts: accounts.length,
    gamesPerAccount: options.games,
    itemCount,
    catalogHash,
    seed: options.seed,
    node: process.version,
    cwd: root,
  });

  try {
    const accountResults = await Promise.all(
      accounts.map((account) =>
        runAccountCampaign({
          account,
          options,
          runDirectory,
          engine,
          catalog,
          campaignLogger,
        }),
      ),
    );
    const eloChecksByRoom = new Map();
    for (const accountResult of accountResults) {
      for (const eloCheck of accountResult.eloChecks) {
        eloChecksByRoom.set(eloCheck.roomId, eloCheck);
      }
    }
    const eloChecks = [...eloChecksByRoom.values()];
    const failedGames = accountResults.reduce(
      (total, accountResult) => total + accountResult.failedGames,
      0,
    );
    const completedGames = accountResults.reduce(
      (total, accountResult) => total + accountResult.completedGames,
      0,
    );
    const accountsWithWrongGameCount = accountResults.filter(
      (accountResult) => accountResult.completedGames !== options.games,
    );
    const finalRanking = await loadRankingSnapshot(
      accounts[0].transport,
      campaignLogger,
    );
    const finalEntries = accounts.map((account) => {
      const record = finalRanking.recordsByUserId.get(account.userId);
      return {
        userId: account.userId,
        name: account.name,
        rating: record?.rating ?? 0,
        position:
          finalRanking.positionByUserId.get(account.userId) ?? null,
        gameCount: record?.gameCount ?? 0,
      };
    });
    const matchingChecks = eloChecks.filter((check) => check.matches).length;
    const mismatchChecks = eloChecks.filter((check) => !check.matches);
    const eloAnalysis = {
      formula:
        'winnerGain = round(32 * (1 - 1 / (1 + 10 ** ((loserRating - winnerRating) / 1600))))',
      totalMatches: eloChecks.length,
      matchingMatches: matchingChecks,
      mismatchingMatches: mismatchChecks.length,
      zeroSumFailures: eloChecks.filter(
        (check) =>
          check.winnerGain !== null &&
          check.loserGain !== null &&
          check.winnerGain + check.loserGain !== 0,
      ).length,
      winnerBotMatches: eloChecks.filter((check) => check.winnerIsBot).length,
      mismatches: mismatchChecks.slice(0, 100),
    };
    await writeJson(
      path.join(runDirectory, 'elo-analysis.json'),
      eloAnalysis,
    );
    campaignLogger.record('finalRanking', {
      entries: finalEntries,
    });
    campaignLogger.record('campaignSummary', {
      accounts: accountResults,
      completedGames,
      targetPlayerGames: accounts.length * options.games,
      failedGames,
      accountsWithWrongGameCount,
      matches: eloChecks.length,
      elo: eloAnalysis,
      finalEntries,
    });
    process.stdout.write(
      `${JSON.stringify({
        output: runDirectory,
        accounts: accounts.map((account) => ({
          name: account.name,
          userId: account.userId,
        })),
        completedGames,
        targetPlayerGames: accounts.length * options.games,
        failedGames,
        matches: eloChecks.length,
        accountsWithWrongGameCount: accountsWithWrongGameCount.length,
        elo: eloAnalysis,
      })}\n`,
    );
  } catch (error) {
    campaignLogger.record('error', {
      stage: 'campaign',
      message: String(error?.message ?? error),
      status: error?.status ?? null,
      stack: error?.stack,
    });
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  } finally {
    await campaignLogger.flush();
    for (const account of accounts) {
      await account.logger.flush();
    }
  }
}

await main();
