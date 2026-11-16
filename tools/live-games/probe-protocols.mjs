#!/usr/bin/env node
/**
 * Exercises the room/battle protocols that the game runners do not normally
 * touch, against the live service, and writes one JSONL probe log.
 *
 * Covered here:
 *   private: keep-alive, make-entry/change-team/cancel-entry, shuffle-teams,
 *            set-tiebreak (owner/non-owner/invalid), set-room-locked,
 *            join-while-locked, kick-user (payload/no payload/non-owner),
 *            post-message (all/team/empty/non-member), reset-game
 *            (lobby/active/game-over), leave-room, start-game twice,
 *            make-entry/cancel-entry after start.
 *   training: the same room actions, which the browser client never sends in
 *            training mode.
 *   account: update-account and the profile documents it touches.
 *
 * It never joins a public game. Every room uses a fresh random password and
 * every account is anonymous.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadEngine, root} from './engine.mjs';
import {LiveTransport, HttpError, toPlain} from './transport.mjs';
import {JsonlLogger} from './log.mjs';
import {
  loadCatalog,
  decodeRoom,
  serializeGame,
  serializeAttack,
} from './state.mjs';
import {createRng, parseSeed} from './rng.mjs';
import {ExplorationPolicy} from './policy.mjs';
import {emptyCoverage} from './coverage.mjs';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const ACCOUNT_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function parseArguments(argv) {
  const options = {
    logDir: null,
    password: null,
    pollMs: 300,
    seed: null,
    settleMs: 300,
    skipTraining: false,
    skipGame: false,
    onlyTrainingGameOver: false,
    turnTimeoutMs: 25000,
    gameTimeoutSeconds: 240,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--log-dir': options.logDir = next(); break;
      case '--password': options.password = next(); break;
      case '--poll-ms': options.pollMs = Number(next()); break;
      case '--seed': options.seed = next(); break;
      case '--settle-ms': options.settleMs = Number(next()); break;
      case '--skip-training': options.skipTraining = true; break;
      case '--skip-game': options.skipGame = true; break;
      case '--only-training-gameover': options.onlyTrainingGameOver = true; break;
      case '--turn-timeout-ms': options.turnTimeoutMs = Number(next()); break;
      case '--game-timeout-seconds': options.gameTimeoutSeconds = Number(next()); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function makePassword(rng) {
  let password = '';
  for (let index = 0; index < 9; index++) password += ALPHABET[rng.int(ALPHABET.length)];
  return password;
}

function randomPassword() {
  return [...crypto.randomBytes(9)].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
}

function documentHash(document) {
  return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function summarizeRoom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const game = raw.game ?? null;
  return {
    userCount: raw.userCount ?? null,
    users: (raw.users ?? []).map(user => ({id: user.id, name: user.name, updatedAt: user.updatedAt ?? null})),
    entries: (raw.entries ?? []).map(entry => ({userId: entry.userId, team: entry.team ?? 0})),
    tiebreakGF: raw.tiebreakGF ?? null,
    isLocked: raw.isLocked ?? null,
    password: raw.password ?? null,
    updatedAt: raw.updatedAt ?? null,
    game: game === null ? null : {
      updateCount: game.updateCount ?? null,
      gf: game.gf ?? null,
      isOver: game.isOver ?? false,
      attackTurnPlayerId: game.attackTurnPlayerId ?? null,
      players: (game.players ?? []).map(player => ({
        id: player.id,
        userId: player.userId,
        name: player.name,
        team: player.team ?? 0,
        hp: player.hp,
        mp: player.mp,
        cp: player.cp,
        dead: player.dead === true,
        itemCount: (player.items ?? []).length,
      })),
    },
  };
}

function roomPath(mode, roomId) {
  return `modes/${mode}/rooms/${roomId}`;
}

function messagePath(mode, roomId, audience) {
  return `modes/${mode}/rooms/${roomId}/messages/${audience}`;
}

function messagesCollection(mode, roomId) {
  return `modes/${mode}/rooms/${roomId}/messages`;
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

export class Prober {
  constructor({logger, settleMs}) {
    this.logger = logger;
    this.settleMs = settleMs;
    this.sequence = 0;
  }

  async readDocument(transport, documentPath) {
    const client = transport?.transport ?? transport;
    try {
      const result = await client.readDocument(documentPath, {log: false});
      return {
        exists: result.exists,
        status: result.status,
        document: result.raw,
        summary: documentPath.includes('/rooms/') && !documentPath.includes('/messages/')
          ? summarizeRoom(result.raw)
          : result.raw,
      };
    } catch (error) {
      return {
        exists: false,
        status: error?.status ?? null,
        error: error?.body ?? String(error?.message ?? error),
      };
    }
  }

  async listDocuments(transport, collectionPath) {
    const client = transport?.transport ?? transport;
    try {
      const result = await client.listCollection(collectionPath, {log: false});
      return {status: result.status, documents: result.documents};
    } catch (error) {
      return {status: error?.status ?? null, error: error?.body ?? String(error?.message ?? error), documents: []};
    }
  }

  async snapshot(transport, mode, roomId) {
    return this.readDocument(transport, roomPath(mode, roomId));
  }

  async action(id, transport, action, payload, {
    note = null,
    mode = 'private',
    roomId = null,
    readWith = transport,
    readRoom = true,
    documentPath = null,
    collectionPath = null,
    settleMs = this.settleMs,
    before = true,
  } = {}) {
    const normalized = payload ?? {};
    const client = transport?.transport ?? transport;
    const roomBefore = readRoom && roomId !== null && before
      ? await this.snapshot(readWith, mode, roomId)
      : null;
    const documentBefore = documentPath !== null
      ? await this.readDocument(readWith, documentPath)
      : null;
    const collectionBefore = collectionPath !== null
      ? await this.listDocuments(readWith, collectionPath)
      : null;
    const started = Date.now();
    let status = null;
    let ok = false;
    let body = null;
    let response = null;
    try {
      response = await client.call(action, new Map(Object.entries(normalized)));
      ok = true;
      status = 200;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      status = error.status;
      body = error.body;
    }
    if (settleMs > 0) await sleep(settleMs);
    const roomAfter = readRoom && roomId !== null
      ? await this.snapshot(readWith, mode, roomId)
      : null;
    const documentAfter = documentPath !== null
      ? await this.readDocument(readWith, documentPath)
      : null;
    const collectionAfter = collectionPath !== null
      ? await this.listDocuments(readWith, collectionPath)
      : null;
    this.logger.record('probe', {
      id,
      sequence: this.sequence++,
      action,
      payload: normalized,
      note,
      status,
      ok,
      body,
      response,
      durationMs: Date.now() - started,
      roomBefore: roomBefore?.summary ?? null,
      roomAfter: roomAfter?.summary ?? null,
      documentPath,
      documentBefore: documentBefore?.summary ?? null,
      documentAfter: documentAfter?.summary ?? null,
      documentBeforeStatus: documentBefore?.status ?? null,
      documentAfterStatus: documentAfter?.status ?? null,
      documentBeforeError: documentBefore?.error ?? null,
      documentAfterError: documentAfter?.error ?? null,
      collectionPath,
      collectionBefore: collectionBefore?.documents ?? null,
      collectionAfter: collectionAfter?.documents ?? null,
      collectionBeforeStatus: collectionBefore?.status ?? null,
      collectionAfterStatus: collectionAfter?.status ?? null,
    });
    return {id, ok, status, body, response, roomBefore, roomAfter, documentBefore, documentAfter};
  }
}

async function signInAccounts(engine, {logger, pollMs, count, runId, roomMode = 'private'}) {
  const accounts = [];
  for (let index = 0; index < count; index++) {
    const key = ACCOUNT_LETTERS[index] ?? `x${index}`;
    const accountLogger = new JsonlLogger(path.join(path.dirname(logger.file), `account-${key}.jsonl`), {
      gameId: runId,
      role: 'account',
      account: key,
    });
    const transport = new LiveTransport({
      logger: accountLogger,
      roomMode,
      pollIntervalMs: pollMs,
      logPolls: 'summary',
      logChannelDocument: false,
    });
    const userId = await transport.signIn();
    accountLogger.record('identity', {account: key, userId});
    accounts.push({
      key,
      name: `probe-${key}-${runId.slice(-6)}`,
      transport,
      logger: accountLogger,
      userId,
    });
  }
  return accounts;
}

function accountByKey(accounts, key) {
  const account = accounts.find(entry => entry.key === key);
  if (!account) throw new Error(`Missing account ${key}`);
  return account;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function decodePendingAttacks(engine, raw, game) {
  const values = raw?.game?.attacks ?? [];
  if (Array.isArray(values) && values.length !== 0) {
    return values.map(value => engine.decodeCommandPayload(engine.decodeJson(value)));
  }
  return game.attack === null || game.attack === undefined ? [] : [game.attack];
}

function latestBuyOffer(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].action === 'buy') return events[index];
    if (events[index].action === 'setBought') return null;
  }
  return null;
}

export class GameDriver {
  constructor({engine, catalog, logger, roomId, mode, bots, pollMs, turnTimeoutMs, timeoutSeconds, runId}) {
    this.engine = engine;
    this.catalog = catalog;
    this.logger = logger;
    this.roomId = roomId;
    this.mode = mode;
    this.bots = bots;
    this.pollMs = pollMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.timeoutSeconds = timeoutSeconds;
    this.runId = runId;
    this.feed = new SnapshotFeed();
    this.latest = null;
    this.stopped = false;
    this.watchers = [];
    this.lastChangeAt = Date.now();
  }

  startWatching() {
    for (const bot of this.bots) {
      bot.transport.logChannelDocument = false;
      this.watchers.push((async () => {
        for (;;) {
          if (this.stopped) return;
          try {
            await bot.transport.watchRoom(this.roomId, message => {
              const room = decodeRoom(this.engine, message.document);
              this.latest = {
                raw: message.document,
                room,
                game: room.game,
                updateTime: message.updateTime,
                sequence: message.sequence,
              };
              this.lastChangeAt = Date.now();
              this.feed.push(this.latest);
            }, {intervalMs: this.pollMs});
          } catch (error) {
            if (this.stopped) return;
            this.logger.record('driverWatchError', {message: String(error?.message ?? error), status: error?.status});
            await sleep(500);
          }
          if (this.stopped) return;
        }
      })());
    }
  }

  stop() {
    this.stopped = true;
    for (const bot of this.bots) bot.transport.stop();
  }

  recordStall(reason) {
    const game = this.latest?.game ?? null;
    this.logger.record('driverStall', {
      roomId: this.roomId,
      reason,
      updateCount: game?.updateCount ?? null,
      gf: game?.gf ?? null,
      attackTurnPlayerId: game?.attackTurnPlayerId ?? null,
      rawAttacks: this.latest?.raw?.game?.attacks ?? null,
      rawEvents: this.latest?.raw?.game?.events ?? null,
      decodedEvents: game?.events ?? null,
      players: game?.players?.map(player => ({
        id: player.id,
        name: player.name,
        userId: player.userId,
        hp: player.hp,
        mp: player.mp,
        cp: player.cp,
        dead: player.dead === true,
        items: (player.items ?? []).map(slot => ({
          slot: slot.id,
          modelId: slot.modelId,
          name: this.catalog.findByIndex(slot.modelId - 1)?.name ?? null,
        })),
      })) ?? null,
    });
  }

  async run() {
    this.startWatching();
    const startedAt = Date.now();
    let lastSubmit = null;
    let rejectedInState = 0;
    let updatesSeen = 0;
    let result = 'timeout';
    try {
      await waitFor(() => this.latest?.game != null, 30000, 'driver game start');
      while (Date.now() < startedAt + this.timeoutSeconds * 1000) {
        const snapshot = await this.feed.next(500) ?? this.latest;
        if (snapshot?.game == null) {
          if (Date.now() - this.lastChangeAt > 30000) {
            this.recordStall('no game state');
            result = 'stalled';
            break;
          }
          continue;
        }
        const {raw, game} = snapshot;
        if (game.updateCount !== updatesSeen) {
          updatesSeen = game.updateCount;
          rejectedInState = 0;
          if (lastSubmit && game.updateCount > lastSubmit.updateCount) lastSubmit = null;
        }
        if (game.isOver === true) {
          result = 'over';
          break;
        }
        const playerIdFor = bot => game.players.find(player => player.userId === bot.userId)?.id ?? null;
        const attacks = decodePendingAttacks(this.engine, raw, game);
        let action = null;
        for (const attack of attacks) {
          const targetBot = this.bots.find(bot => playerIdFor(bot) === attack.targetPlayerId) ?? null;
          const attackerBot = this.bots.find(bot => playerIdFor(bot) === attack.playerId) ?? null;
          const attackModels = attack.itemModelIds.map(id => this.catalog.findByIndex(id - 1)).filter(Boolean);
          const first = attackModels[0] ?? null;
          if (first?.ability === 'buy') {
            if (attack.playerId === attack.targetPlayerId) continue;
            const offer = latestBuyOffer(game.events);
            const attackerPlayer = game.players.find(player => player.id === attack.playerId) ?? null;
            if (offer !== null && attackerBot !== null && attackerPlayer !== null) {
              const decision = attackerBot.policy.decideBuyConfirmation(game, attackerPlayer, attack);
              if (decision !== null) {
                action = {bot: attackerBot, player: attackerPlayer, decision, attack};
                break;
              }
            }
            if (targetBot === null) continue;
            const targetPlayer = game.players.find(player => player.id === attack.targetPlayerId) ?? null;
            if (targetPlayer === null || targetPlayer.dead === true) continue;
            const decision = targetBot.policy.decideDefense(game, targetPlayer, attack);
            if (decision !== null) {
              action = {bot: targetBot, player: targetPlayer, decision, attack};
              break;
            }
            continue;
          }
          if (targetBot === null) continue;
          const targetPlayer = game.players.find(player => player.id === attack.targetPlayerId) ?? null;
          if (targetPlayer === null || targetPlayer.dead === true) continue;
          const decision = targetBot.policy.decideDefense(game, targetPlayer, attack);
          if (decision !== null) {
            action = {bot: targetBot, player: targetPlayer, decision, attack};
            break;
          }
        }
        if (action === null && attacks.length === 0) {
          const turnBot = this.bots.find(bot => playerIdFor(bot) === game.attackTurnPlayerId) ?? null;
          if (turnBot !== null) {
            const self = game.players.find(player => player.id === game.attackTurnPlayerId) ?? null;
            if (self !== null && self.dead !== true) {
              const decision = turnBot.policy.decideAttack(game, self);
              if (decision !== null) action = {bot: turnBot, player: self, decision, attack: null};
            }
          }
        }
        if (action === null) {
          if (Date.now() - this.lastChangeAt > 30000) {
            this.recordStall('no pending action');
            result = 'stalled';
            break;
          }
          continue;
        }
        if (lastSubmit && lastSubmit.updateCount === game.updateCount) continue;
        const {bot, player, decision} = action;
        bot.policy.noteDecision(decision);
        this.logger.record('driverDecision', {
          updateCount: game.updateCount,
          source: 'probe-driver',
          playerId: player.id,
          account: bot.account,
          phase: decision.phase,
          kind: decision.kind,
          reason: decision.reason,
          command: toPlain(decision.command),
        });
        try {
          await bot.transport.call(this.engine.roomAction.submitCommand, new Map([
            ['mode', this.mode],
            ['roomId', this.roomId],
            ['command', toPlain(decision.command)],
          ]));
          lastSubmit = {updateCount: game.updateCount, at: Date.now()};
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          this.logger.record('driverRejected', {
            updateCount: game.updateCount,
            account: bot.account,
            phase: decision.phase,
            kind: decision.kind,
            status: error.status,
            body: error.body,
            command: toPlain(decision.command),
          });
          if (decision.seedModelId) bot.policy.block(decision.seedModelId);
          if (decision.phase === 'defense') bot.policy.blockDefense();
          if (decision.kind === 'confirmBuy') bot.policy.alternateBuyChoice();
          lastSubmit = null;
          rejectedInState++;
          if (rejectedInState >= 6) {
            result = 'rejected';
            break;
          }
          await sleep(250);
        }
        await sleep(80);
      }
    } finally {
      this.stop();
      await Promise.race([Promise.allSettled(this.watchers), sleep(1500)]);
    }
    return {result, latest: this.latest};
  }
}

async function privateLobbyProbes(prober, accounts, password, runId) {
  const A = accountByKey(accounts, 'a');
  const B = accountByKey(accounts, 'b');
  const C = accountByKey(accounts, 'c');
  const D = accountByKey(accounts, 'd');
  const E = accountByKey(accounts, 'e');
  const F = accountByKey(accounts, 'f');

  const created = await prober.action('private.create.owner', A, 'create-room', {
    mode: 'private', userName: A.name, password, lang: 'en',
  }, {note: 'owner creates a fresh private room', readRoom: false});
  const roomId = created.response?.roomId ?? null;
  if (typeof roomId !== 'string') throw new Error('create-room did not return a roomId');
  await prober.snapshot(A, 'private', roomId);

  await prober.action('private.create.same-password', B, 'create-room', {
    mode: 'private', userName: B.name, password, lang: 'en',
  }, {note: 'second account resolves the same password to the same room', mode: 'private', roomId, readWith: A});

  await prober.action('private.join.member', B, 'join-room', {
    mode: 'private', roomId, userName: B.name,
  }, {note: 'join-room adds the second account', mode: 'private', roomId, readWith: A});

  await prober.action('private.create.third', C, 'create-room', {
    mode: 'private', userName: C.name, password, lang: 'en',
  }, {note: 'third account resolves the same room', mode: 'private', roomId, readWith: A});

  await prober.action('private.join.duplicate-name', C, 'join-room', {
    mode: 'private', roomId, userName: B.name,
  }, {note: 'duplicate display name is expected to be refused', mode: 'private', roomId, readWith: A});

  await prober.action('private.join.unique-name', C, 'join-room', {
    mode: 'private', roomId, userName: C.name,
  }, {note: 'third account joins with its own name', mode: 'private', roomId, readWith: A});

  await prober.action('private.create.fourth', D, 'create-room', {
    mode: 'private', userName: D.name, password, lang: 'en',
  }, {note: 'fourth account resolves the same room', mode: 'private', roomId, readWith: A});

  await prober.action('private.join.fourth', D, 'join-room', {
    mode: 'private', roomId, userName: D.name,
  }, {note: 'fourth account joins', mode: 'private', roomId, readWith: A});

  await sleep(1100);
  await prober.action('private.keep-alive', B, 'keep-alive', {
    mode: 'private', roomId,
  }, {note: 'keep-alive refreshes the sender activity timestamp', mode: 'private', roomId, readWith: A});

  await prober.action('private.make-entry.solo', B, 'make-entry', {
    mode: 'private', roomId, team: 0,
  }, {note: 'solo entry', mode: 'private', roomId, readWith: A});

  await prober.action('private.make-entry.change-team', B, 'make-entry', {
    mode: 'private', roomId, team: 1,
  }, {note: 'second make-entry changes the team instead of adding a duplicate entry', mode: 'private', roomId, readWith: A});

  await prober.action('private.cancel-entry', B, 'cancel-entry', {
    mode: 'private', roomId,
  }, {note: 'cancel-entry removes the caller from entries', mode: 'private', roomId, readWith: A});

  await prober.action('private.make-entry.a-team2', A, 'make-entry', {
    mode: 'private', roomId, team: 2,
  }, {note: 'owner entry for shuffle testing', mode: 'private', roomId, readWith: A});
  await prober.action('private.make-entry.b-team1', B, 'make-entry', {
    mode: 'private', roomId, team: 1,
  }, {note: 'mixed teams before shuffle', mode: 'private', roomId, readWith: A});
  await prober.action('private.make-entry.c-team1', C, 'make-entry', {
    mode: 'private', roomId, team: 1,
  }, {note: 'mixed teams before shuffle', mode: 'private', roomId, readWith: A});
  await prober.action('private.make-entry.d-team2', D, 'make-entry', {
    mode: 'private', roomId, team: 2,
  }, {note: 'mixed teams before shuffle', mode: 'private', roomId, readWith: A});

  for (let index = 1; index <= 3; index++) {
    await prober.action(`private.shuffle-teams.owner.${index}`, A, 'shuffle-teams', {
      mode: 'private', roomId,
    }, {note: `owner shuffle attempt ${index}`, mode: 'private', roomId, readWith: A});
  }
  await prober.action('private.shuffle-teams.non-owner', B, 'shuffle-teams', {
    mode: 'private', roomId,
  }, {note: 'non-owner shuffle attempt', mode: 'private', roomId, readWith: A});

  await prober.action('private.set-tiebreak.owner.50', A, 'set-tiebreak', {
    mode: 'private', roomId, gf: 50,
  }, {note: 'owner sets Apocalypse GF 50', mode: 'private', roomId, readWith: A});
  await prober.action('private.set-tiebreak.non-owner.100', B, 'set-tiebreak', {
    mode: 'private', roomId, gf: 100,
  }, {note: 'non-owner set-tiebreak attempt', mode: 'private', roomId, readWith: A});
  await prober.action('private.set-tiebreak.invalid.7', A, 'set-tiebreak', {
    mode: 'private', roomId, gf: 7,
  }, {note: 'unsupported GF 7', mode: 'private', roomId, readWith: A});
  await prober.action('private.set-tiebreak.owner.1', A, 'set-tiebreak', {
    mode: 'private', roomId, gf: 1,
  }, {note: 'owner sets Apocalypse GF 1', mode: 'private', roomId, readWith: A});
  await prober.action('private.set-tiebreak.owner.75', A, 'set-tiebreak', {
    mode: 'private', roomId, gf: 75,
  }, {note: 'owner sets Apocalypse GF 75', mode: 'private', roomId, readWith: A});
  await prober.action('private.set-tiebreak.owner.150', A, 'set-tiebreak', {
    mode: 'private', roomId, gf: 150,
  }, {note: 'owner sets Apocalypse GF 150', mode: 'private', roomId, readWith: A});
  await prober.action('private.set-tiebreak.null', A, 'set-tiebreak', {
    mode: 'private', roomId, gf: null,
  }, {note: 'disable Apocalypse tiebreak', mode: 'private', roomId, readWith: A});
  await prober.action('private.set-tiebreak.final.50', A, 'set-tiebreak', {
    mode: 'private', roomId, gf: 50,
  }, {note: 'leave the room on GF 50', mode: 'private', roomId, readWith: A});

  await prober.action('private.lock.non-owner', B, 'set-room-locked', {
    mode: 'private', roomId, isLocked: true,
  }, {note: 'non-owner lock attempt', mode: 'private', roomId, readWith: A});
  await prober.action('private.lock.true', A, 'set-room-locked', {
    mode: 'private', roomId, isLocked: true,
  }, {note: 'lock the room', mode: 'private', roomId, readWith: A});

  await prober.action('private.create.locked', E, 'create-room', {
    mode: 'private', userName: E.name, password, lang: 'en',
  }, {note: 'locked room password resolution', mode: 'private', roomId, readWith: A});
  await prober.action('private.join.locked', E, 'join-room', {
    mode: 'private', roomId, userName: E.name,
  }, {note: 'join into a locked room is expected to be refused', mode: 'private', roomId, readWith: A});

  await sleep(1100);
  await prober.action('private.keep-alive.locked', B, 'keep-alive', {
    mode: 'private', roomId,
  }, {note: 'keep-alive while the room is locked', mode: 'private', roomId, readWith: A});

  await prober.action('private.lock.false', A, 'set-room-locked', {
    mode: 'private', roomId, isLocked: false,
  }, {note: 'unlock the room', mode: 'private', roomId, readWith: A});

  await prober.action('private.join.after-unlock', E, 'join-room', {
    mode: 'private', roomId, userName: E.name,
  }, {note: 'the same account can join after unlock', mode: 'private', roomId, readWith: A});

  await prober.action('private.chat.all', A, 'post-message', {
    mode: 'private', roomId, text: 'probe-all', team: null,
  }, {
    note: 'all-room chat',
    mode: 'private',
    roomId,
    readWith: A,
    documentPath: messagePath('private', roomId, 'all'),
    collectionPath: messagesCollection('private', roomId),
  });
  await prober.action('private.chat.team1', B, 'post-message', {
    mode: 'private', roomId, text: 'probe-team1', team: 1,
  }, {
    note: 'team 1 chat; B is on team 1 and reads the team1 audience',
    mode: 'private',
    roomId,
    readWith: B,
    documentPath: messagePath('private', roomId, 'team1'),
    collectionPath: messagesCollection('private', roomId),
  });
  await prober.action('private.chat.team0', C, 'post-message', {
    mode: 'private', roomId, text: 'probe-team0', team: 0,
  }, {
    note: 'team 0 chat; C is on team 1',
    mode: 'private',
    roomId,
    readWith: C,
    documentPath: messagePath('private', roomId, 'team0'),
    collectionPath: messagesCollection('private', roomId),
  });
  await prober.action('private.chat.empty', A, 'post-message', {
    mode: 'private', roomId, text: '', team: null,
  }, {
    note: 'empty chat text',
    mode: 'private',
    roomId,
    readWith: A,
    documentPath: messagePath('private', roomId, 'all'),
  });
  await prober.action('private.chat.non-member', F, 'post-message', {
    mode: 'private', roomId, text: 'probe-outsider', team: null,
  }, {
    note: 'chat from an account that is not in the room',
    mode: 'private',
    roomId,
    readWith: A,
    documentPath: messagePath('private', roomId, 'all'),
  });
  await prober.action('private.keep-alive.non-member', F, 'keep-alive', {
    mode: 'private', roomId,
  }, {note: 'keep-alive from an account that is not in the room', mode: 'private', roomId, readWith: A});
  await prober.action('private.make-entry.non-member', F, 'make-entry', {
    mode: 'private', roomId, team: 0,
  }, {note: 'entry from an account that is not in the room', mode: 'private', roomId, readWith: A});

  await prober.action('private.kick.non-owner', B, 'kick-user', {
    mode: 'private', roomId, userId: C.userId,
  }, {note: 'non-owner kick attempt', mode: 'private', roomId, readWith: A});
  await prober.action('private.kick.owner', A, 'kick-user', {
    mode: 'private', roomId, userId: D.userId,
  }, {note: 'owner kicks D', mode: 'private', roomId, readWith: A});
  await prober.action('private.keep-alive.kicked', D, 'keep-alive', {
    mode: 'private', roomId,
  }, {note: 'kicked account activity check', mode: 'private', roomId, readWith: A});
  await prober.action('private.rejoin.kicked', D, 'join-room', {
    mode: 'private', roomId, userName: D.name,
  }, {note: 'kicked account join-room without re-resolving the password', mode: 'private', roomId, readWith: A});
  await prober.action('private.rejoin.kicked.create-room', D, 'create-room', {
    mode: 'private', userName: D.name, password, lang: 'en',
  }, {note: 'kicked account re-resolves the room password', mode: 'private', roomId, readWith: A});
  await prober.action('private.rejoin.kicked.retry', D, 'join-room', {
    mode: 'private', roomId, userName: D.name,
  }, {note: 'kicked account joins after re-resolving the password', mode: 'private', roomId, readWith: A});

  await prober.action('private.reset.lobby', A, 'reset-game', {
    mode: 'private', roomId,
  }, {note: 'reset-game before the game starts', mode: 'private', roomId, readWith: A});

  await prober.action('private.submit.before-start', A, 'submit-command', {
    mode: 'private', roomId, command: {},
  }, {note: 'submit-command before the game starts', mode: 'private', roomId, readWith: A});

  // Make a valid two-team entry set. A and B share team 1; C and E share
  // team 2. This makes team chat meaningful and keeps the game alive while
  // one member of each side is kicked/left.
  const gameEntries = [[A, 1], [B, 1], [C, 2], [E, 2]];
  for (const [entry, team] of gameEntries) {
    await prober.action(`private.make-entry.game.${entry.key}`, entry, 'make-entry', {
      mode: 'private', roomId, team,
    }, {note: `team ${team} entry for the protocol game`, mode: 'private', roomId, readWith: A});
  }

  const roomBeforeStart = await prober.snapshot(B, 'private', roomId);
  const usersBeforeStart = (roomBeforeStart.summary?.users ?? []);
  const firstUserId = usersBeforeStart[0]?.id ?? null;
  const owner = accounts.find(account => account.userId === firstUserId) ?? A;
  const presentAccounts = accounts.filter(account => usersBeforeStart.some(user => user.id === account.userId));
  const leaver = presentAccounts.find(account => account.userId !== owner.userId) ?? owner;

  await prober.action('private.lock.before-start', owner, 'set-room-locked', {
    mode: 'private', roomId, isLocked: true,
  }, {note: 'lock immediately before start', mode: 'private', roomId, readWith: A});
  await prober.action('private.start.locked', owner, 'start-game', {
    mode: 'private', roomId,
  }, {note: 'start-game while the room is locked', mode: 'private', roomId, readWith: A});
  const afterLockedStart = await prober.snapshot(A, 'private', roomId);
  if (afterLockedStart.summary?.game == null) {
    await prober.action('private.lock.release-for-start', owner, 'set-room-locked', {
      mode: 'private', roomId, isLocked: false,
    }, {note: 'unlock because the locked start did not produce a game', mode: 'private', roomId, readWith: A});
    await prober.action('private.start.retry', owner, 'start-game', {
      mode: 'private', roomId,
    }, {note: 'start-game after unlocking', mode: 'private', roomId, readWith: A});
  }

  return {roomId, owner, reader: owner, leaver};
}

async function privateGameProbes(prober, accounts, roomId, owner, reader, leaver) {
  const A = accountByKey(accounts, 'a');
  const B = accountByKey(accounts, 'b');
  const C = accountByKey(accounts, 'c');
  const F = accountByKey(accounts, 'f');

  await prober.action('private.game.keep-alive', B, 'keep-alive', {
    mode: 'private', roomId,
  }, {note: 'keep-alive during a game', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.chat.all', B, 'post-message', {
    mode: 'private', roomId, text: 'probe-in-game', team: null,
  }, {
    note: 'chat during a game',
    mode: 'private',
    roomId,
    readWith: reader,
    documentPath: messagePath('private', roomId, 'all'),
    collectionPath: messagesCollection('private', roomId),
  });
  await prober.action('private.game.chat.team1', B, 'post-message', {
    mode: 'private', roomId, text: 'probe-in-game-team1', team: 1,
  }, {
    note: 'team 1 chat during a team game where B is on team 1',
    mode: 'private',
    roomId,
    readWith: B,
    documentPath: messagePath('private', roomId, 'team1'),
    collectionPath: messagesCollection('private', roomId),
  });
  await prober.action('private.game.set-tiebreak', owner, 'set-tiebreak', {
    mode: 'private', roomId, gf: 100,
  }, {note: 'set-tiebreak during a game', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.lock', owner, 'set-room-locked', {
    mode: 'private', roomId, isLocked: true,
  }, {note: 'lock during a game', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.make-entry', A, 'make-entry', {
    mode: 'private', roomId, team: 0,
  }, {note: 'make-entry after the game started', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.cancel-entry', A, 'cancel-entry', {
    mode: 'private', roomId,
  }, {note: 'cancel-entry after the game started', mode: 'private', roomId, readWith: reader});
  // Kick one member of team 1 and leave one member of team 2. Both teams keep
  // a surviving player, so the game stays active for the remaining probes.
  await prober.action('private.game.kick', owner, 'kick-user', {
    mode: 'private', roomId, userId: B.userId,
  }, {note: 'kick B during a game', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.leave', C, 'leave-room', {
    mode: 'private', roomId,
  }, {note: 'leave during a game', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.start-again', owner, 'start-game', {
    mode: 'private', roomId,
  }, {note: 'start-game while a game is already running', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.kick.no-payload', owner, 'kick-user', {
    mode: 'private', roomId,
  }, {note: 'battle-style kick-user with no userId during a game', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.unlock', owner, 'set-room-locked', {
    mode: 'private', roomId, isLocked: false,
  }, {note: 'unlock so the outsider join tests the started state, not the lock', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.join-outsider', F, 'join-room', {
    mode: 'private', roomId, userName: F.name,
  }, {note: 'join a started room from outside', mode: 'private', roomId, readWith: reader});
  await prober.action('private.game.reset', owner, 'reset-game', {
    mode: 'private', roomId,
  }, {note: 'reset-game during an active game', mode: 'private', roomId, readWith: reader});
}

async function leaveRoomProbe(prober, accounts) {
  const F = accountByKey(accounts, 'f');
  const G = accountByKey(accounts, 'g');
  const password = randomPassword();
  const created = await prober.action('private.leave.create-room', F, 'create-room', {
    mode: 'private', userName: F.name, password, lang: 'en',
  }, {note: 'separate room for the leave-room probe', readRoom: false});
  const roomId = created.response?.roomId ?? null;
  if (typeof roomId !== 'string') return;
  await prober.action('private.leave.room', F, 'leave-room', {
    mode: 'private', roomId,
  }, {note: 'leave the room that was just created', mode: 'private', roomId, readWith: G});
  await prober.action('private.leave.recreate', F, 'create-room', {
    mode: 'private', userName: F.name, password, lang: 'en',
  }, {note: 'create-room again with the same password after leaving', mode: 'private', roomId, readWith: G});
  await prober.action('private.leave.rejoin', F, 'join-room', {
    mode: 'private', roomId, userName: F.name,
  }, {note: 'rejoin the room after re-resolving the password following leave', mode: 'private', roomId, readWith: G});
  await prober.action('private.leave.invalid-room-id', F, 'join-room', {
    mode: 'private', roomId: 'does-not-exist-probe', userName: F.name,
  }, {note: 'join-room with an invalid room id', readRoom: false});
}

async function invalidCreateProbes(prober, accounts) {
  const G = accountByKey(accounts, 'g');
  await prober.action('private.create.password-too-long', G, 'create-room', {
    mode: 'private', userName: G.name, password: 'abcdefghij', lang: 'en',
  }, {note: '10-letter private password', readRoom: false});
  await prober.action('private.create.password-symbols', G, 'create-room', {
    mode: 'private', userName: G.name, password: 'abc123', lang: 'en',
  }, {note: 'non-letter private password', readRoom: false});
}

async function gameOverResetProbe(prober, engine, catalog, accounts, options, logger, runId) {
  const G = accountByKey(accounts, 'g');
  const H = accountByKey(accounts, 'h');
  const password = randomPassword();
  const created = await prober.action('gameover.create.owner', G, 'create-room', {
    mode: 'private', userName: G.name, password, lang: 'en',
  }, {note: 'separate room for the game-over reset probe', readRoom: false});
  const roomId = created.response?.roomId ?? null;
  if (typeof roomId !== 'string') return;
  await prober.action('gameover.create.second', H, 'create-room', {
    mode: 'private', userName: H.name, password, lang: 'en',
  }, {note: 'resolve the same room for the second driver', mode: 'private', roomId, readWith: G});
  await prober.action('gameover.join.second', H, 'join-room', {
    mode: 'private', roomId, userName: H.name,
  }, {note: 'join the game-over room', mode: 'private', roomId, readWith: G});
  await prober.action('gameover.make-entry.owner', G, 'make-entry', {
    mode: 'private', roomId, team: 0,
  }, {note: 'solo entry for the game-over game', mode: 'private', roomId, readWith: G});
  await prober.action('gameover.make-entry.second', H, 'make-entry', {
    mode: 'private', roomId, team: 0,
  }, {note: 'solo entry for the game-over game', mode: 'private', roomId, readWith: G});
  await prober.action('gameover.start', G, 'start-game', {
    mode: 'private', roomId,
  }, {note: 'start the game-over game', mode: 'private', roomId, readWith: G});

  const bots = [G, H].map((account, index) => ({
    ...account,
    account: account.key,
    index,
    policy: new ExplorationPolicy({
      engine,
      catalog,
      rng: createRng(0x51a7 + index * 7919),
      coverage: emptyCoverage(),
      options: {passive: false, targetMode: 'auto'},
    }),
  }));
  const driver = new GameDriver({
    engine,
    catalog,
    logger,
    roomId,
    mode: 'private',
    bots,
    pollMs: options.pollMs,
    turnTimeoutMs: options.turnTimeoutMs,
    timeoutSeconds: options.gameTimeoutSeconds,
    runId,
  });
  const result = await driver.run();
  const final = await prober.snapshot(G, 'private', roomId);
  logger.record('gameOverResult', {
    roomId,
    result: result.result,
    game: final.summary?.game ?? null,
  });

  await prober.action('gameover.reset.non-owner', H, 'reset-game', {
    mode: 'private', roomId,
  }, {note: 'reset-game after game over from a non-owner', mode: 'private', roomId, readWith: G});
  await prober.action('gameover.reset.owner', G, 'reset-game', {
    mode: 'private', roomId,
  }, {note: 'reset-game after game over from the owner', mode: 'private', roomId, readWith: G});
  await prober.action('gameover.leave', H, 'leave-room', {
    mode: 'private', roomId,
  }, {note: 'leave after the reset', mode: 'private', roomId, readWith: G});
}

async function trainingProbes(prober, engine, catalog, accounts, options, logger, runId) {
  const A = accountByKey(accounts, 'f');
  const B = accountByKey(accounts, 'g');
  const created = await prober.action('training.create.owner', A, 'create-room', {
    mode: 'training', userName: A.name, lang: 'en',
  }, {note: 'training room creation', readRoom: false});
  const roomId = created.response?.roomId ?? null;
  if (typeof roomId !== 'string') return;

  await prober.action('training.join.other', B, 'join-room', {
    mode: 'training', roomId, userName: B.name,
  }, {note: 'join-room against a training room', mode: 'training', roomId, readWith: A});
  await prober.action('training.keep-alive', A, 'keep-alive', {
    mode: 'training', roomId,
  }, {note: 'keep-alive in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.make-entry', A, 'make-entry', {
    mode: 'training', roomId, team: 0,
  }, {note: 'make-entry in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.cancel-entry', A, 'cancel-entry', {
    mode: 'training', roomId,
  }, {note: 'cancel-entry in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.shuffle-teams', A, 'shuffle-teams', {
    mode: 'training', roomId,
  }, {note: 'shuffle-teams in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.set-tiebreak.50', A, 'set-tiebreak', {
    mode: 'training', roomId, gf: 50,
  }, {note: 'set-tiebreak in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.set-tiebreak.invalid.7', A, 'set-tiebreak', {
    mode: 'training', roomId, gf: 7,
  }, {note: 'unsupported GF in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.lock.true', A, 'set-room-locked', {
    mode: 'training', roomId, isLocked: true,
  }, {note: 'lock in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.chat.all', A, 'post-message', {
    mode: 'training', roomId, text: 'probe-training', team: null,
  }, {
    note: 'chat in training mode',
    mode: 'training',
    roomId,
    readWith: A,
    documentPath: messagePath('training', roomId, 'all'),
    collectionPath: messagesCollection('training', roomId),
  });
  await prober.action('training.kick.with-user', A, 'kick-user', {
    mode: 'training', roomId, userId: B.userId,
  }, {note: 'kick-user with a userId in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.kick.no-payload', A, 'kick-user', {
    mode: 'training', roomId,
  }, {note: 'kick-user without a userId in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.reset.lobby', A, 'reset-game', {
    mode: 'training', roomId,
  }, {note: 'reset-game before a training game', mode: 'training', roomId, readWith: A});
  await prober.action('training.leave', A, 'leave-room', {
    mode: 'training', roomId,
  }, {note: 'leave-room in training mode', mode: 'training', roomId, readWith: A});
  await prober.action('training.submit.before-start', A, 'submit-command', {
    mode: 'training', roomId, command: {},
  }, {note: 'submit-command before a training game', mode: 'training', roomId, readWith: A});
  await prober.action('training.start', A, 'start-game', {
    mode: 'training', roomId, lang: 'en', playerCount: 2, gf: null,
  }, {note: 'start a training game', mode: 'training', roomId, readWith: A});

  await prober.action('training.game.keep-alive', A, 'keep-alive', {
    mode: 'training', roomId,
  }, {note: 'keep-alive during a training game', mode: 'training', roomId, readWith: A});
  await prober.action('training.game.chat', A, 'post-message', {
    mode: 'training', roomId, text: 'probe-training-game', team: null,
  }, {
    note: 'chat during a training game',
    mode: 'training',
    roomId,
    readWith: A,
    documentPath: messagePath('training', roomId, 'all'),
  });
  await prober.action('training.game.set-tiebreak', A, 'set-tiebreak', {
    mode: 'training', roomId, gf: 100,
  }, {note: 'set-tiebreak during a training game', mode: 'training', roomId, readWith: A});
  await prober.action('training.game.lock', A, 'set-room-locked', {
    mode: 'training', roomId, isLocked: true,
  }, {note: 'set-room-locked during a training game', mode: 'training', roomId, readWith: A});
  await prober.action('training.game.kick', A, 'kick-user', {
    mode: 'training', roomId,
  }, {note: 'kick-user during a training game', mode: 'training', roomId, readWith: A});
  await prober.action('training.game.start-again', A, 'start-game', {
    mode: 'training', roomId, lang: 'en', playerCount: 2, gf: null,
  }, {note: 'start-game while a training game is running', mode: 'training', roomId, readWith: A});
  await prober.action('training.game.leave', A, 'leave-room', {
    mode: 'training', roomId,
  }, {note: 'leave-room during a training game', mode: 'training', roomId, readWith: A});
  await prober.action('training.game.reset', A, 'reset-game', {
    mode: 'training', roomId,
  }, {note: 'reset-game during a training game', mode: 'training', roomId, readWith: A});

  return {roomId};
}

async function trainingGameOverProbe(prober, engine, catalog, accounts, options, logger, runId) {
  const H = accounts.find(account => account.key === 'h') ?? accounts[0];
  // The driver watches through the transport, so it must read the training
  // room path rather than the private room path.
  H.transport.roomMode = 'training';
  const created = await prober.action('training-gameover.create', H, 'create-room', {
    mode: 'training', userName: H.name, lang: 'en',
  }, {note: 'separate training room for the game-over reset probe', readRoom: false});
  const roomId = created.response?.roomId ?? null;
  if (typeof roomId !== 'string') return;
  await prober.action('training-gameover.start', H, 'start-game', {
    mode: 'training', roomId, lang: 'en', playerCount: 2, gf: null,
  }, {note: 'start a training game and play it out', mode: 'training', roomId, readWith: H});

  const bot = {
    ...H,
    account: H.key,
    index: 0,
    policy: new ExplorationPolicy({
      engine,
      catalog,
      rng: createRng(0x7a11),
      coverage: emptyCoverage(),
      options: {passive: false, targetMode: 'auto'},
    }),
  };
  const driver = new GameDriver({
    engine,
    catalog,
    logger,
    roomId,
    mode: 'training',
    bots: [bot],
    pollMs: options.pollMs,
    turnTimeoutMs: options.turnTimeoutMs,
    timeoutSeconds: options.gameTimeoutSeconds,
    runId,
  });
  const result = await driver.run();
  const final = await prober.snapshot(H, 'training', roomId);
  logger.record('trainingGameOverResult', {
    roomId,
    result: result.result,
    game: final.summary?.game ?? null,
  });
  await prober.action('training-gameover.reset', H, 'reset-game', {
    mode: 'training', roomId,
  }, {note: 'reset-game after a training game ended', mode: 'training', roomId, readWith: H});
  await prober.action('training-gameover.leave', H, 'leave-room', {
    mode: 'training', roomId,
  }, {note: 'leave after the training reset', mode: 'training', roomId, readWith: H});
}

async function updateAccountProbe(prober, accounts) {
  const F = accountByKey(accounts, 'f');
  const paths = [`records/${F.userId}`, 'status/user_count', 'rankings/duel'];
  const before = {};
  for (const documentPath of paths) {
    before[documentPath] = await prober.readDocument(F.transport, documentPath);
  }
  await prober.action('account.update.first', F, 'update-account', {}, {
    note: 'update-account on a fresh anonymous account',
    readRoom: false,
    documentPath: paths[0],
  });
  const afterFirst = {};
  for (const documentPath of paths) {
    afterFirst[documentPath] = await prober.readDocument(F.transport, documentPath);
  }
  await prober.action('account.update.repeat', F, 'update-account', {}, {
    note: 'repeat update-account',
    readRoom: false,
    documentPath: paths[0],
  });
  const afterRepeat = {};
  for (const documentPath of paths) {
    afterRepeat[documentPath] = await prober.readDocument(F.transport, documentPath);
  }
  prober.logger.record('account.documents', {
    id: 'account.documents',
    userId: F.userId,
    documents: paths.map(documentPath => ({
      documentPath,
      before: before[documentPath]?.summary ?? null,
      afterFirst: afterFirst[documentPath]?.summary ?? null,
      afterRepeat: afterRepeat[documentPath]?.summary ?? null,
      exists: {
        before: before[documentPath]?.exists ?? false,
        afterFirst: afterFirst[documentPath]?.exists ?? false,
        afterRepeat: afterRepeat[documentPath]?.exists ?? false,
      },
      status: {
        before: before[documentPath]?.status ?? null,
        afterFirst: afterFirst[documentPath]?.status ?? null,
        afterRepeat: afterRepeat[documentPath]?.status ?? null,
      },
    })),
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`God Field protocol probe\n\n` +
      `  --log-dir DIR             JSONL output directory\n` +
      `  --password TEXT           private room password (default random 9 letters)\n` +
      `  --poll-ms N               Firestore poll interval (default 300)\n` +
      `  --settle-ms N             wait before reading the room after an action (default 300)\n` +
      `  --seed VALUE              deterministic RNG seed\n` +
      `  --skip-training           skip the training-mode probes\n` +
      `  --skip-game               skip the game-over reset probes\n` +
      `  --only-training-gameover  replay only the training game-over reset case\n` +
      `  --game-timeout-seconds N  maximum driver time per game (default 240)\n`);
    return;
  }

  const engine = await loadEngine();
  const {catalog, itemCount, catalogHash} = await loadCatalog(engine);
  const runId = `protocols-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-${process.pid.toString(36)}`;
  const logDir = path.resolve(options.logDir ?? path.join('logs/live/protocols', runId));
  await fs.mkdir(logDir, {recursive: true});
  const seed = parseSeed(options.seed);
  const rng = createRng(seed);
  const password = options.password ?? makePassword(rng);
  const logger = new JsonlLogger(path.join(logDir, 'probes.jsonl'), {
    gameId: runId,
    mode: 'protocols',
    roomPassword: password,
  });
  logger.record('meta', {
    type: 'meta',
    runId,
    logDir,
    password,
    seed,
    itemCount,
    catalogHash,
    node: process.version,
    cwd: root,
  });

  const status = {runId, logDir, password, rooms: {}, results: []};
  let accounts = [];
  const prober = new Prober({logger, settleMs: options.settleMs});

  try {
    const signInCount = options.onlyTrainingGameOver ? 1 : ACCOUNT_LETTERS.length;
    logger.record('phase', {phase: 'sign-in', accounts: signInCount});
    accounts = await signInAccounts(engine, {
      logger,
      pollMs: options.pollMs,
      count: signInCount,
      runId,
    });
    logger.record('accounts', {
      accounts: accounts.map(account => ({key: account.key, userId: account.userId, name: account.name})),
    });

    if (options.onlyTrainingGameOver) {
      logger.record('phase', {phase: 'training-game-over-reset'});
      await trainingGameOverProbe(prober, engine, catalog, accounts, options, logger, runId);
      logger.record('done', {status});
      await logger.flush();
      process.stdout.write(`${JSON.stringify({
        runId,
        logDir,
        password,
        rooms: status.rooms,
        error: null,
      })}\n`);
      return;
    }

    logger.record('phase', {phase: 'private-lobby'});
    const lobby = await privateLobbyProbes(prober, accounts, password, runId);
    status.rooms.private = lobby.roomId;
    logger.record('phase', {phase: 'private-game'});
    await privateGameProbes(prober, accounts, lobby.roomId, lobby.owner, lobby.reader, lobby.leaver);
    logger.record('phase', {phase: 'private-leave'});
    await leaveRoomProbe(prober, accounts);
    logger.record('phase', {phase: 'invalid-create'});
    await invalidCreateProbes(prober, accounts);

    if (!options.skipGame) {
      logger.record('phase', {phase: 'private-game-over-reset'});
      await gameOverResetProbe(prober, engine, catalog, accounts, options, logger, runId);
    }

    if (!options.skipTraining) {
      logger.record('phase', {phase: 'training-lobby'});
      const training = await trainingProbes(prober, engine, catalog, accounts, options, logger, runId);
      status.rooms.training = training?.roomId ?? null;
      if (!options.skipGame) {
        logger.record('phase', {phase: 'training-game-over-reset'});
        await trainingGameOverProbe(prober, engine, catalog, accounts, options, logger, runId);
      }
    }

    logger.record('phase', {phase: 'update-account'});
    await updateAccountProbe(prober, accounts);
  } catch (error) {
    logger.record('error', {
      message: String(error?.message ?? error),
      stack: error?.stack,
      status: error?.status ?? null,
      body: error?.body ?? null,
    });
    status.error = String(error?.message ?? error);
  } finally {
    for (const account of accounts) {
      try {
        await account.logger.flush();
      } catch {
        // Ignore log flush errors; the coordinator log still has the probe.
      }
    }
    logger.record('done', {status});
    await logger.flush();
  }

  process.stdout.write(`${JSON.stringify({
    runId,
    logDir,
    password,
    rooms: status.rooms,
    error: status.error ?? null,
  })}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
