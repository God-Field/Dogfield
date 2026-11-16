#!/usr/bin/env node
/**
 * Plays one real training-mode game against the live God Field service.
 *
 * Flow (same as the browser client):
 *   anonymous sign-in -> create-room -> watch room document -> start-game
 *   -> on each actionable game update, submit a command built by the headless
 *      engine -> keep watching until the game ends, then leave-room.
 *
 * Usage:
 *   node tools/live-games/play-game.mjs --players 3 --log logs/game.jsonl
 */
import path from 'node:path';
import {loadEngine, root} from './engine.mjs';
import {LiveTransport, HttpError, toPlain} from './transport.mjs';
import {JsonlLogger} from './log.mjs';
import {createRng, parseSeed} from './rng.mjs';
import {
  loadCatalog,
  decodeRoom,
  serializeRoom,
  serializeGame,
  diffPlayerSnapshots,
  worldChanges,
} from './state.mjs';
import {ExplorationPolicy} from './policy.mjs';
import {
  buildDreamPlan,
  loadDreamCatalog,
  summarizeDreamCatalog,
  updateDreamCatalogFromLogs,
} from './dream.mjs';
import {
  emptyCoverage,
  loadCoverage,
  mergeCoverage,
  writeCoverage,
  collectEvent,
  collectDecision,
  collectStatChange,
} from './coverage.mjs';

const TIERBREAK_CHOICES = [null, 1, 50, 75, 100, 150];

function parseArguments(argv) {
  const options = {
    players: 2,
    gf: null,
    seed: null,
    log: null,
    coverage: null,
    focus: null,
    shard: null,
    maxSeconds: 240,
    noGlobalLimit: false,
    turnTimeoutMs: 20000,
    stallSeconds: 45,
    pollMs: 250,
    userName: 'e',
    lang: 'en',
    mode: 'training',
    logPolls: 'summary',
    aimPrayer: false,
    preferCommands: null,
    selfTargetChance: 0,
    declineBuyChance: 0,
    respondToIncomingBuy: false,
    incomingBuyMode: 'forgive',
    gameId: null,
    dream: false,
    dreamCatalog: null,
    passive: false,
    targetMode: 'auto',
    targetPlayerId: null,
    accountPool: null,
    accountOffset: 0,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--players': options.players = Number(next()); break;
      case '--gf': {
        const value = next();
        options.gf = value === 'none' || value === 'null' ? null : Number(value);
        break;
      }
      case '--seed': options.seed = next(); break;
      case '--log': options.log = next(); break;
      case '--coverage': options.coverage = next(); break;
      case '--focus': options.focus = next().split(',').filter(Boolean).map(Number); break;
      case '--shard': options.shard = next(); break;
      case '--max-seconds': options.maxSeconds = Number(next()); break;
      case '--no-global-limit': options.noGlobalLimit = true; options.maxSeconds = 0; break;
      case '--turn-timeout-ms': options.turnTimeoutMs = Number(next()); break;
      case '--stall-seconds': options.stallSeconds = Number(next()); break;
      case '--poll-ms': options.pollMs = Number(next()); break;
      case '--user-name': options.userName = next(); break;
      case '--lang': options.lang = next(); break;
      case '--mode': options.mode = next(); break;
      case '--log-polls': options.logPolls = next(); break;
      case '--aim-prayer': options.aimPrayer = true; break;
      case '--prefer-command': options.preferCommands = next().split(',').filter(Boolean); break;
      case '--self-target-chance': options.selfTargetChance = Number(next()); break;
      case '--decline-buy-chance': options.declineBuyChance = Number(next()); break;
      case '--respond-incoming-buy': options.respondToIncomingBuy = true; break;
      case '--incoming-buy-mode': options.incomingBuyMode = next(); break;
      case '--game-id': options.gameId = next(); break;
      case '--dream': options.dream = true; break;
      case '--dream-catalog': options.dreamCatalog = next(); break;
      case '--passive': options.passive = true; break;
      case '--target-mode': options.targetMode = next(); break;
      case '--target-player': options.targetPlayerId = Number(next()); break;
      case '--account-pool': options.accountPool = next(); break;
      case '--account-offset': options.accountOffset = Number(next()); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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
    return new Promise(resolve => {
      const waiter = {resolve, timer: null};
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function focusFor(options, catalog, coverage) {
  if (Array.isArray(options.focus) && options.focus.length !== 0) return options.focus;
  if (!options.shard) return [];
  const [index, count] = options.shard.split('/').map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 0 || index < 0 || index >= count) return [];
  const unseen = catalog.models.filter(model => (coverage.itemModels[String(model.id)]?.uses ?? 0) === 0);
  return unseen.filter((_model, position) => position % count === index).map(model => model.id);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`God Field live-game orchestrator\n\n` +
      `  --players N        training player count (2-9, default 2)\n` +
      `  --gf VALUE         training tiebreak GF (none,1,50,75,100,150)\n` +
      `  --seed VALUE       deterministic RNG seed\n` +
      `  --log FILE         JSONL output file (required)\n` +
      `  --coverage FILE    shared coverage JSON to read/focus and update\n` +
      `  --focus LIST       comma-separated item model ids to prefer\n` +
      `  --shard I/N        focus 1/N of unseen item models when --focus is absent\n` +
      `  --max-seconds N    global limit in seconds; 0 disables it (default 240)\n` +
      `  --no-global-limit  run until game over; per-turn and stall timeouts still apply\n` +
      `  --turn-timeout-ms N abort when a submitted turn gets no state update (default 20000)\n` +
      `  --stall-seconds N  abort when no channel update arrives while waiting (default 45)\n` +
      `  --poll-ms N        Firestore poll interval (default 250)\n` +
      `  --user-name NAME   room display name (default e)\n` +
      `  --aim-prayer       prefer discarding weapons to reach the prayer path\n` +
      `  --dream            chase the Dream curse and use disguised items\n` +
      `  --dream-catalog F  shared dream-transformation catalog to read/update\n` +
      `  --passive          prefer non-damaging actions and keep the game alive\n` +
      `  --target-mode M    auto|self|random|weakest|strongest|specific\n` +
      `  --target-player I  player id for --target-mode specific\n` +
      `  --prefer-command L comma-separated command types to prefer (buy,sell,...)\n` +
      `  --self-target-chance P chance to target yourself with an economic command\n` +
      `  --decline-buy-chance P chance to decline an offered Buy item\n` +
      `  --respond-incoming-buy  experimentally answer a bot's Buy targeting us\n`);
    return;
  }
  if (!options.log) throw new Error('--log is required');
  const engine = await loadEngine();
  if (!Number.isInteger(options.players) || options.players < 2 || options.players > engine.MAX_PLAYERS) {
    throw new Error(`--players must be an integer from 2 to ${engine.MAX_PLAYERS}`);
  }
  if (!TIERBREAK_CHOICES.includes(options.gf)) {
    throw new Error(`--gf must be one of ${TIERBREAK_CHOICES.map(value => value === null ? 'none' : value).join(',')}`);
  }
  const {catalog, itemCount, catalogHash} = await loadCatalog(engine);
  const seed = parseSeed(options.seed);
  const rng = createRng(seed);
  const gameId = options.gameId ?? `game-${seed.toString(16)}-${process.pid}`;
  const logger = new JsonlLogger(options.log, {
    gameId,
    playerCount: options.players,
    seed,
  });
  if (options.dream && options.dreamCatalog === null) {
    options.dreamCatalog = path.join(root, 'logs', 'live', 'dream', 'dream-catalog.json');
  }
  const coverage = await loadCoverage(options.coverage);
  const focus = focusFor(options, catalog, coverage);
  const dreamPlan = options.dreamCatalog === null
    ? null
    : buildDreamPlan(await loadDreamCatalog(options.dreamCatalog), catalog.models);
  const policy = new ExplorationPolicy({
    engine,
    catalog,
    rng,
    coverage,
    options: {
      focus,
      aimForPrayer: options.aimPrayer,
      preferCommands: options.preferCommands,
      selfTargetChance: options.selfTargetChance,
      declineBuyChance: options.declineBuyChance,
      respondToIncomingBuy: options.respondToIncomingBuy,
      incomingBuyMode: options.incomingBuyMode,
      dreamFocus: options.dream,
      dreamDeficits: dreamPlan?.deficits ?? [],
      passive: options.passive,
      targetMode: options.targetMode,
      targetPlayerId: options.targetPlayerId,
    },
  });
  const localCoverage = emptyCoverage();
  localCoverage.playerCounts[String(options.players)] = 1;

  let accountPool = null;
  if (options.accountPool !== null) {
    try {
      accountPool = JSON.parse(
        await (await import('node:fs/promises')).readFile(
          path.resolve(options.accountPool),
          'utf8',
        ),
      );
    } catch (error) {
      accountPool = null;
    }
  }

  const transport = new LiveTransport({
    logger,
    roomMode: options.mode,
    pollIntervalMs: options.pollMs,
    logPolls: options.logPolls,
  });

  let roomId = null;
  let watcher = null;
  let result = 'timeout';
  let endGame = null;
  const eliminations = [];
  let lastChangeAt = Date.now();
  let latest = null;
  let previousGame = null;
  let previousRaw = null;
  let missingRoom = false;
  let userId = null;
  let dreamSummary = null;
  const startedAt = Date.now();

  try {
    const savedAccount = accountPool?.[options.accountOffset] ?? null;
    if (savedAccount?.refreshToken) {
      transport.refreshToken = savedAccount.refreshToken;
      transport.userId = savedAccount.userId;
      try {
        await transport.refreshAuth();
        userId = transport.userId;
      } catch (error) {
        userId = null;
      }
    }
    if (userId === null) {
      userId = await transport.signIn();
    }
    const response = await transport.call(engine.cloudFunction.createRoom, new Map([
      ['mode', options.mode],
      ['userName', options.userName],
      ['lang', options.lang],
    ]));
    roomId = response?.roomId;
    if (typeof roomId !== 'string') throw new Error(`create-room did not return a room id: ${JSON.stringify(response)}`);

    logger.record('meta', {
      type: 'meta',
      gameId,
      schemaVersion: 1,
      roomId,
      userId,
      playerCount: options.players,
      tiebreakGF: options.gf,
      userName: options.userName,
      language: options.lang,
      mode: options.mode,
      seed,
      focus,
      dream: options.dream,
      dreamCatalog: options.dreamCatalog,
      dreamPlan: dreamPlan === null ? null : {
        targetCount: dreamPlan.targetCount,
        coveredItems: dreamPlan.coveredItems,
        observedPairs: dreamPlan.observedPairs,
        expectedPairs: dreamPlan.expectedPairs,
      },
      itemCount,
      catalogHash,
      node: process.version,
      cwd: root,
    });

    const feed = new SnapshotFeed();
    const channelDone = (async () => {
      for (;;) {
        try {
          await transport.watchRoom(roomId, async message => {
            try {
              const room = decodeRoom(engine, message.document);
              const game = room.game;
              const priorGame = previousGame;
              const priorRaw = previousRaw;
              let serializedRoom = null;
              try {
                serializedRoom = serializeRoom(room, catalog);
              } catch (error) {
                logger.record('error', {stage: 'serializeRoom', message: String(error?.message ?? error), stack: error?.stack});
              }
              previousGame = game;
              previousRaw = message.document;
              lastChangeAt = Date.now();
              latest = {raw: message.document, room, game, serializedRoom};
              feed.push(latest);

              try {
                if (game !== null) {
                  const serializedGame = serializeGame(game, catalog);
                  logger.record('state', {
                    channelSequence: message.sequence,
                    updateTime: message.updateTime,
                    updateCount: game.updateCount,
                    game: serializedGame,
                  });
                  if (priorGame === null) {
                    logger.record('gameStart', {updateCount: game.updateCount, game: serializedGame});
                  }
                  if (priorGame === null || game.updateCount !== priorGame.updateCount) {
                    const deadSet = new Set((priorGame?.players ?? game.players).filter(player => player.dead === true).map(player => player.id));
                    const deathPlayers = new Set();
                    let exchangeStart = 0;
                    for (const [index, record] of serializedGame.events.entries()) {
                      logger.record('event', record);
                      collectEvent(localCoverage, record, catalog);
                      if (record.action === 'advanceGF') exchangeStart = index + 1;
                      if (record.action === 'revive') deadSet.delete(record.playerId);
                      if (record.action === 'die') {
                        deadSet.add(record.playerId);
                        deathPlayers.add(record.playerId);
                        const elimination = {
                          updateCount: game.updateCount,
                          eventIndex: index,
                          playerId: record.playerId,
                          playerName: game.players.find(player => player.id === record.playerId)?.name ?? null,
                          remainingPlayers: game.players.length - deadSet.size,
                          cause: serializedGame.events.slice(exchangeStart, index + 1).map(event => event.action),
                        };
                        logger.record('elimination', elimination);
                        eliminations.push(elimination);
                      }
                    }
                    if (priorGame !== null) {
                      const changes = diffPlayerSnapshots(priorGame, game, catalog);
                      for (const change of changes) {
                        logger.record('stat', {updateCount: game.updateCount, cause: game.events.map(event => event.action), ...change});
                        collectStatChange(localCoverage, change, catalog);
                        if (change.fields?.dead?.to === true && !deathPlayers.has(change.playerId)) {
                          const elimination = {
                            updateCount: game.updateCount,
                            eventIndex: null,
                            playerId: change.playerId,
                            playerName: change.playerName,
                            remainingPlayers: game.players.filter(player => player.dead !== true).length,
                            cause: serializedGame.events.slice(-8).map(event => event.action),
                            source: 'stat fallback (death event was outside the captured update)',
                          };
                          logger.record('elimination', elimination);
                          eliminations.push(elimination);
                        }
                      }
                    }
                    const world = worldChanges(priorRaw, message.document);
                    if (world !== null) logger.record('world', {updateCount: game.updateCount, changes: world});
                  }
                } else if (priorGame !== null) {
                  logger.record('lobby', {updateCount: 0, room: serializedRoom});
                }
              } catch (error) {
                logger.record('error', {stage: 'channelLog', message: String(error?.message ?? error), stack: error?.stack});
              }
            } catch (error) {
              logger.record('error', {stage: 'channel', message: String(error?.message ?? error), stack: error?.stack});
            }
          }, {
            intervalMs: options.pollMs,
            onMissing: () => {
              missingRoom = true;
              logger.record('channelMissing', {roomId});
            },
          });
          if (transport.stopped) return;
        } catch (error) {
          logger.record('error', {stage: 'watch', message: String(error?.message ?? error), stack: error?.stack});
          if (transport.stopped) return;
          await sleep(1000);
        }
      }
    })();
    watcher = channelDone;

    await transport.call(engine.roomAction.startGame, new Map([
      ['mode', options.mode],
      ['roomId', roomId],
      ['lang', options.lang],
      ['playerCount', options.players],
      ['gf', options.gf],
    ]));

    const startDeadline = Date.now() + 30000;
    while (Date.now() < startDeadline && latest?.game == null && !missingRoom) await sleep(100);
    if (latest?.game == null) throw new Error('The game did not start');

    let lastSubmit = null;
    let rejectedInState = 0;
    let updatesSeen = 0;
    const turnTimeoutMs = options.turnTimeoutMs;
    const stallMs = options.stallSeconds * 1000;
    const globalDeadline = options.maxSeconds > 0 ? startedAt + options.maxSeconds * 1000 : Infinity;

    while (Date.now() < globalDeadline) {
      if (missingRoom && latest?.game == null) {
        result = 'roomMissing';
        break;
      }
      if (lastSubmit && Date.now() - lastSubmit.at > turnTimeoutMs) {
        logger.record('turnTimeout', {
          updateCount: lastSubmit.updateCount,
          phase: lastSubmit.phase,
          kind: lastSubmit.kind,
          elapsedMs: Date.now() - lastSubmit.at,
        });
        result = 'turnTimeout';
        break;
      }
      const snapshot = await feed.next(1000);
      const current = snapshot ?? latest;
      if (current === null || current?.game == null) {
        if (Date.now() - lastChangeAt > stallMs) {
          logger.record('stallTimeout', {waitingFor: 'game state', elapsedMs: Date.now() - lastChangeAt});
          result = 'stalled';
          break;
        }
        continue;
      }

      const game = current.game;
      if (game.updateCount !== updatesSeen) {
        updatesSeen = game.updateCount;
        rejectedInState = 0;
        if (lastSubmit && game.updateCount > lastSubmit.updateCount) lastSubmit = null;
      }
      if (game.isOver === true) {
        result = 'over';
        endGame = current.serializedRoom?.game ?? null;
        break;
      }
      const self = game.players.find(player => player.userId === userId) ?? null;
      if (self === null) {
        if (Date.now() - lastChangeAt > stallMs) {
          logger.record('stallTimeout', {waitingFor: 'self player', elapsedMs: Date.now() - lastChangeAt});
          result = 'selfMissing';
          break;
        }
        continue;
      }
      if (self.dead === true) {
        // In a multiplayer game, keep watching after our own elimination so the
        // remaining bots can finish and the final placement is recorded.
        if (Date.now() - lastChangeAt > stallMs) {
          logger.record('stallTimeout', {waitingFor: 'remaining players after self death', elapsedMs: Date.now() - lastChangeAt});
          result = 'deadStalled';
          break;
        }
        continue;
      }
      if (lastSubmit && lastSubmit.updateCount === game.updateCount) continue;

      let decision = null;
      let actionable = false;
      let waitingFor = 'bots';
      if (game.attack !== null && game.attack !== undefined) {
        if (game.attack.playerId === self.id) {
          actionable = true;
          waitingFor = 'our command response';
          decision = policy.decideBuyConfirmation(game, self);
          if (decision === null && game.attack.targetPlayerId === self.id) decision = policy.decideDefense(game, self);
        } else if (game.attack.targetPlayerId === self.id) {
          actionable = true;
          waitingFor = 'our defense';
          decision = policy.decideDefense(game, self);
        } else {
          waitingFor = 'another player exchange';
        }
      } else if (game.attackTurnPlayerId === self.id) {
        actionable = true;
        waitingFor = 'our attack';
        decision = policy.decideAttack(game, self);
      }
      if (decision === null) {
        const limit = actionable ? turnTimeoutMs : stallMs;
        if (Date.now() - lastChangeAt > limit) {
          logger.record(actionable ? 'turnTimeout' : 'stallTimeout', {
            updateCount: game.updateCount,
            waitingFor,
            elapsedMs: Date.now() - lastChangeAt,
          });
          result = actionable ? 'turnTimeout' : 'stalled';
          break;
        }
        continue;
      }

      policy.noteDecision(decision);
      collectDecision(localCoverage, decision, catalog);
      const loggedDecision = {
        updateCount: game.updateCount,
        phase: decision.phase,
        kind: decision.kind,
        reason: decision.reason,
        selected: decision.selected,
        summary: decision.summary,
        attack: decision.attack,
        seedModelId: decision.seedModelId,
        command: toPlain(decision.command),
      };
      logger.record('decision', loggedDecision);

      try {
        await transport.call(engine.roomAction.submitCommand, new Map([
          ['mode', options.mode],
          ['roomId', roomId],
          ['command', toPlain(decision.command)],
        ]));
        lastSubmit = {
          updateCount: game.updateCount,
          at: Date.now(),
          phase: decision.phase,
          kind: decision.kind,
        };
        rejectedInState = 0;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        logger.record('rejected', {
          updateCount: game.updateCount,
          phase: decision.phase,
          kind: decision.kind,
          status: error.status,
          body: error.body,
          selected: decision.selected,
          command: toPlain(decision.command),
        });
        if (decision.seedModelId) policy.block(decision.seedModelId);
        if (decision.phase === 'defense') policy.blockDefense();
        if (decision.kind === 'confirmBuy') policy.alternateBuyChoice();
        lastSubmit = null;
        rejectedInState++;
        if (rejectedInState >= 4) {
          result = 'rejected';
          break;
        }
        await sleep(350);
      }
    }

    if (result === 'timeout' && Number.isFinite(globalDeadline)) {
      logger.record('globalTimeout', {maxSeconds: options.maxSeconds, updateCount: updatesSeen});
    }

    if (result === 'over') {
      const game = latest?.game ?? null;
      if (game !== null) {
        const self = game.players.find(player => player.userId === userId) ?? null;
        const winners = game.players.filter(player => player.dead !== true && player.hp > 0).map(player => player.id);
        if (self !== null && winners.includes(self.id)) localCoverage.wins++;
      }
    }
  } catch (error) {
    result = 'error';
    logger.record('error', {
      stage: 'game',
      message: String(error?.message ?? error),
      stack: error?.stack,
      status: error?.status,
      body: error?.body,
    });
  } finally {
    transport.stop();
    if (watcher) await Promise.race([watcher, sleep(1500)]);
    if (roomId !== null && options.mode !== 'training') {
      try {
        await transport.call(engine.roomAction.leaveRoom, new Map([
          ['mode', options.mode],
          ['roomId', roomId],
        ]));
      } catch (error) {
        logger.record('leaveFailed', {
          message: String(error?.message ?? error),
          status: error?.status,
          body: error?.body,
        });
      }
    }
    localCoverage.games += 1;
    logger.record('coverage', {data: localCoverage});
    const finalGame = endGame ?? latest?.serializedRoom?.game ?? null;
    const winnerIds = result === 'over' && finalGame !== null
      ? finalGame.players.filter(player => player.dead !== true && player.hp > 0).map(player => player.id)
      : [];
    if (options.dreamCatalog) {
      try {
        const {catalog: updated, merged} = await updateDreamCatalogFromLogs(options.dreamCatalog, [options.log], catalog.models);
        dreamSummary = {...summarizeDreamCatalog(updated, catalog.models), merged};
        logger.record('dreamCatalog', dreamSummary);
      } catch (error) {
        logger.record('dreamCatalogFailed', {message: String(error?.message ?? error)});
      }
    }
    logger.record('end', {
      result,
      roomId,
      userId,
      durationMs: Date.now() - startedAt,
      winnerIds,
      eliminations,
      game: finalGame,
      dream: dreamSummary,
      coverage: {
        events: Object.keys(localCoverage.eventActions).length,
        itemModels: Object.keys(localCoverage.itemModels).length,
        curses: Object.keys(localCoverage.curses).length,
        guardians: Object.keys(localCoverage.guardians).length,
      },
    });
    await logger.flush();
    if (options.coverage) {
      try {
        const global = await loadCoverage(options.coverage);
        mergeCoverage(global, localCoverage);
        await writeCoverage(options.coverage, global);
      } catch (error) {
        logger.record('coverageWriteFailed', {message: String(error?.message ?? error)});
      }
    }
  }

  process.exitCode = result === 'over' || result === 'timeout' ? 0 : 1;
  process.stdout.write(`${JSON.stringify({
    gameId,
    roomId,
    result,
    seed,
    players: options.players,
    log: path.resolve(options.log),
    events: Object.keys(localCoverage.eventActions).length,
    items: Object.keys(localCoverage.itemModels).length,
    dream: dreamSummary,
  })}\n`);
}

await main();
