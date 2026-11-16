#!/usr/bin/env node
/** Observe official-server presence using genuine Firebase 13.1.0 listeners. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { LiveTransport, FIREBASE } from './transport.mjs';
import { JsonlLogger } from './log.mjs';
import { loadEngine } from './engine.mjs';
import { loadCatalog, decodeRoom } from './state.mjs';
import { ExplorationPolicy } from './policy.mjs';
import { createRng } from './rng.mjs';

const specifications = [
  ['training-watch', 'training', 'watch'],
  ['training-unsubscribe', 'training', 'unsubscribe'],
  ['training-close', 'training', 'close'],
  ['training-reconnect', 'training', 'reconnect'],
  ['training-disable-network', 'training', 'disable-network'],
  ['training-all-closed', 'training', 'all-close'],
  ['private-watch', 'private', 'watch'],
  ['private-watch-keepalive', 'private', 'watch', true],
  ['private-unsubscribe-keepalive', 'private', 'unsubscribe', true],
  ['private-offline-keepalive', 'private', 'offline', true],
  ['private-close', 'private', 'close'],
  ['private-rest', 'private', 'rest'],
  ['private-all-closed', 'private', 'all-close'],
  ['private-attack-watch', 'private', 'watch', false, 'attack'],
  ['private-attack-close', 'private', 'close', false, 'attack'],
  ['private-defense-close', 'private', 'close', false, 'defense'],
  ['private-passive-close', 'private', 'close', false, 'passive'],
  ['duel-watch', 'duel', 'watch'],
  ['duel-close', 'duel', 'close'],
];
const publicDuelSpecifications = [
  ['duel-public-watch', 'duel', 'watch'],
  ['duel-public-close', 'duel', 'close'],
];
const argumentsList = process.argv.slice(2);
const argumentValue = (name, fallback) => {
  const index = argumentsList.indexOf(name);
  return index < 0 ? fallback : argumentsList[index + 1];
};
if (argumentsList.includes('--help')) {
  process.stdout.write('Usage: probe-disconnects.mjs [--cases comma,separated] [--seconds 330] [--output directory]\n'
    + '  --kick-at 10,70       send no-userId watchdog requests at these elapsed seconds\n'
    + '  --watchdog-from-target send watchdog requests as the target account\n'
    + '  --wait-for-target     start public duel cases on the target player\'s decision\n'
    + '  --game-clock          measure watchdog times from game.updatedAt\n'
    + '  --poll-ms 500         set observation and watchdog polling interval\n'
    + '  --rejoin              explicitly rejoin removed private-room members\n'
    + '  --duel-language en    matchmaking language for controlled duel pairing attempts\n'
    + 'Public-opponent duel cases are opt-in: duel-public-watch,duel-public-close.\n');
  process.exit(0);
}
const selectedCases = argumentValue('--cases', specifications.map(([name]) => name).join(',')).split(',');
const seconds = Number(argumentValue('--seconds', '330'));
const kickTimes = argumentValue('--kick-at', '').split(',').filter(Boolean).map(Number);
const duelLanguage = argumentValue('--duel-language', 'en');
const watchdogFromTarget = argumentsList.includes('--watchdog-from-target');
const rejoinRemoved = argumentsList.includes('--rejoin');
const waitForTarget = argumentsList.includes('--wait-for-target');
const useGameClock = argumentsList.includes('--game-clock');
const pollMs = Number(argumentValue('--poll-ms', '5000'));
const availableCases = new Set([...specifications, ...publicDuelSpecifications].map(([name]) => name));
const invalidKickTimes = kickTimes.some((kickTime) => !Number.isFinite(kickTime) || kickTime < 0);
if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(pollMs) || pollMs <= 0
  || invalidKickTimes || selectedCases.some((name) => !availableCases.has(name))) {
  throw new Error('Choose known cases and a positive observation duration');
}
const output = path.resolve(argumentValue('--output', `logs/live/disconnects/${new Date().toISOString().replaceAll(':', '-')}`));
await fs.mkdir(output, { recursive: true });
const logger = new JsonlLogger(path.join(output, 'observations.jsonl'));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'],
});
const experiments = [];
const roomMemberships = new Map();
const recoveries = [];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const engine = await loadEngine();
const { catalog } = await loadCatalog(engine);

async function makeActor(name) {
  const context = await browser.newContext({ locale: 'en-US' });
  await context.route('https://godfield.net/__disconnect_probe__', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Controlled disconnect probe</title>',
  }));
  const page = await context.newPage();
  await page.exposeFunction('recordProbe', (event) => logger.record('sdk', { actor: name, ...event }));
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    logger.record('networkFailure', { actor: name, host: url.host, path: url.pathname, error: request.failure()?.errorText });
  });
  await page.goto('https://godfield.net/__disconnect_probe__');
  const authentication = await page.evaluate(async (configuration) => {
    const appModule = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js');
    const authModule = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js');
    const firestore = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js');
    const app = appModule.initializeApp(configuration);
    const auth = authModule.getAuth(app);
    const { user } = await authModule.signInAnonymously(auth);
    window.probe = { database: firestore.getFirestore(app), firestore, listeners: new Map() };
    return { idToken: await user.getIdToken(), refreshToken: user.refreshToken, localId: user.uid, expiresIn: '3600', sdkVersion: appModule.SDK_VERSION };
  }, { apiKey: FIREBASE.apiKey, projectId: FIREBASE.projectId, authDomain: FIREBASE.authDomain });
  const transport = new LiveTransport({ logger: { record: (type, fields) => logger.record(type, { actor: name, ...fields }) } });
  transport.applyAuth(authentication);
  const actor = { name, userName: `p${crypto.randomBytes(4).toString('hex')}`, context, page, transport, userId: transport.userId, closed: false };
  logger.record('actor', { actor: name, userId: actor.userId, sdkVersion: authentication.sdkVersion });
  return actor;
}

async function watch(actor, roomPath) {
  await actor.page.evaluate(async (documentPath) => {
    const probe = window.probe;
    probe.listeners.get(documentPath)?.();
    const reference = probe.firestore.doc(probe.database, documentPath);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No server-confirmed Firestore snapshot within 30 seconds')), 30000);
      const unsubscribe = probe.firestore.onSnapshot(reference, { includeMetadataChanges: true }, (snapshot) => {
        void window.recordProbe({ documentPath, fromCache: snapshot.metadata.fromCache, document: snapshot.data() ?? null });
        if (!snapshot.metadata.fromCache) {
          clearTimeout(timeout);
          resolve();
        }
      }, (error) => {
        clearTimeout(timeout);
        void window.recordProbe({ documentPath, error: { code: error.code, message: error.message } });
        reject(error);
      });
      probe.listeners.set(documentPath, unsubscribe);
    });
  }, roomPath);
}

async function call(actor, action, mode, roomId, extra = {}) {
  const result = await actor.transport.call(action, { mode, ...(roomId ? { roomId } : {}), ...extra });
  if (mode !== 'training') {
    const membershipRoomId = action === 'create-room' ? result?.roomId : roomId;
    const membershipKey = `${mode}/${membershipRoomId}/${actor.userId}`;
    if (action === 'create-room' || action === 'join-room') {
      roomMemberships.set(membershipKey, { actor, mode, roomId: membershipRoomId });
    } else if (action === 'leave-room') {
      roomMemberships.delete(membershipKey);
    }
  }
  return result;
}

function expectedPlayerId(game) {
  const attack = game?.attack ?? game?.attacks?.[0];
  if (attack) {
    return attack.buyingItemModelId ? attack.playerId : attack.targetPlayerId;
  }
  return game?.attackTurnPlayerId;
}

function summary(raw, target) {
  const player = raw?.game?.players?.find((entry) => entry.userId === target.userId);
  return {
    exists: raw !== null,
    member: raw?.users?.some((entry) => entry.id === target.userId) ?? false,
    memberUpdatedAt: raw?.users?.find((entry) => entry.id === target.userId)?.updatedAt ?? null,
    userCount: raw?.userCount,
    isBot: player?.isBot ?? false,
    dead: player?.dead ?? false,
    hp: player?.hp,
    playerId: player?.id,
    updateCount: raw?.game?.updateCount,
    gf: raw?.game?.gf,
    isOver: raw?.game?.isOver ?? false,
    expectedPlayerId: expectedPlayerId(raw?.game),
    actions: raw?.game?.events?.map((event) => event.action) ?? [],
  };
}

async function observe(experiment, observer, label) {
  const result = await observer.transport.readDocument(experiment.roomPath, { log: false });
  const raw = result.raw;
  const state = summary(raw, experiment.target);
  const observation = { name: experiment.name, label, secondsAfterDisconnect: (Date.now() - experiment.startedAt) / 1000, state, document: raw };
  logger.record('observation', observation);
  experiment.last = state;
  if (!state.member && experiment.removedAfterSeconds === null) {
    experiment.removedAfterSeconds = observation.secondsAfterDisconnect;
    process.stdout.write(`${experiment.name}: membership removed at ${observation.secondsAfterDisconnect.toFixed(1)}s\n`);
  }
  return raw;
}

async function preparePhase(target, opponent, mode, roomId, phase) {
  const policy = new ExplorationPolicy({ engine, catalog, rng: createRng(1), options: { passive: false, targetMode: 'auto' } });
  for (let step = 0; step < 20; step++) {
    const { raw } = await opponent.transport.readDocument(`modes/${mode}/rooms/${roomId}`, { log: false });
    const game = decodeRoom(engine, raw).game;
    if (!game || game.isOver) {
      throw new Error('Game ended while preparing the requested decision phase');
    }
    const targetPlayer = game.players.find((player) => player.userId === target.userId);
    const attack = game.attack;
    const expectedId = expectedPlayerId(game);
    const isTargetTurn = expectedId === targetPlayer.id;
    let ready;
    if (phase === 'attack') {
      ready = isTargetTurn && !attack;
    } else if (phase === 'defense') {
      ready = isTargetTurn && attack && !attack.buyingItemModelId;
    } else {
      ready = !isTargetTurn && !attack;
    }
    if (ready) {
      return;
    }
    const player = game.players.find((entry) => entry.id === expectedId);
    const actor = player.userId === target.userId ? target : opponent;
    let command;
    if (!attack && phase === 'defense' && actor === opponent) {
      const weapon = player.items.find((slot) => {
        if (!slot.modelId || slot.used) {
          return false;
        }
        const model = slot.getItemModel(catalog);
        const isReliableWeapon = model.category.key === 'weapons' && !model.isPlusAttack && !model.hitRate;
        const isLegalAlone = engine.validateItemAction({ models: [model], availableMp: player.mp, mode: 'normal', hasSpecialItemCommand: true }) === null;
        return isReliableWeapon && isLegalAlone;
      });
      if (weapon) {
        command = { itemIds: [weapon.id], targetPlayerId: targetPlayer.id };
      }
    }
    if (!command) {
      let decision;
      if (attack?.buyingItemModelId) {
        decision = policy.decideBuyConfirmation(game, player, attack);
      } else if (attack) {
        decision = policy.decideDefense(game, player, attack);
      } else {
        decision = policy.decideAttack(game, player);
      }
      if (!decision) {
        throw new Error('No legal command while preparing decision phase');
      }
      command = decision.command;
    }
    await call(actor, 'submit-command', mode, roomId, { command });
    await sleep(300);
  }
  throw new Error(`Could not prepare phase ${phase}`);
}

async function prepare(specification, observer) {
  const [name, mode, treatment, keepAlive = false, phase = null] = specification;
  const target = await makeActor(name);
  const usesPublicOpponent = name.startsWith('duel-public-');
  const needsSeparateOpponent = (mode === 'duel' && !usesPublicOpponent)
    || (mode === 'private' && treatment === 'all-close');
  const opponent = needsSeparateOpponent ? await makeActor(`${name}-opponent`) : observer;
  let roomId;
  if (mode === 'training') {
    ({ roomId } = await call(target, 'create-room', mode, null, { userName: target.userName, lang: 'en' }));
    await call(target, 'start-game', mode, roomId, { playerCount: 2, gf: null });
  } else if (mode === 'private') {
    const password = `p${crypto.randomBytes(6).toString('hex')}`;
    ({ roomId } = await call(opponent, 'create-room', mode, null, { userName: opponent.userName, password, lang: 'en' }));
    await call(target, 'join-room', mode, roomId, { userName: target.userName });
    await call(opponent, 'make-entry', mode, roomId, { team: 0 });
    await call(target, 'make-entry', mode, roomId, { team: 0 });
    await call(opponent, 'start-game', mode, roomId);
  } else {
    const first = await call(target, 'create-room', mode, null, { userName: target.userName, lang: duelLanguage });
    await watch(target, `modes/${mode}/rooms/${first.roomId}`);
    const second = usesPublicOpponent ? null
      : await call(opponent, 'create-room', mode, null, { userName: opponent.userName, lang: duelLanguage });
    roomId = first.roomId;
    if (second) {
      await watch(opponent, `modes/${mode}/rooms/${second.roomId}`);
    }
    let check;
    const matchDeadline = Date.now() + 20000;
    do {
      check = await observer.transport.readDocument(`modes/${mode}/rooms/${roomId}`, { log: false });
      if (check.raw?.game) {
        break;
      }
      await sleep(500);
    } while (Date.now() < matchDeadline);
    const controlled = new Set([target.userId, opponent.userId]);
    const onlyControlledPlayers = check.raw?.game?.players?.every((player) => controlled.has(player.userId));
    if (!onlyControlledPlayers && !usesPublicOpponent) {
      logger.record('duelPairingFailure', { name, firstRoomId: first.roomId, secondRoomId: second.roomId, document: check.raw });
      await Promise.allSettled([
        call(target, 'leave-room', mode, first.roomId),
        call(opponent, 'leave-room', mode, second.roomId),
      ]);
      throw new Error('Duel did not pair our controlled accounts; left both queues immediately');
    }
  }
  if (phase !== null) {
    await preparePhase(target, opponent, mode, roomId, phase);
  }
  const roomPath = `modes/${mode}/rooms/${roomId}`;
  await watch(target, roomPath);
  if (mode !== 'training' || treatment !== 'all-close') {
    await watch(opponent, roomPath);
  }
  if (waitForTarget && usesPublicOpponent) {
    const targetDeadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < targetDeadline) {
      const { raw } = await observer.transport.readDocument(roomPath, { log: false });
      const targetPlayer = raw?.game?.players?.find((player) => player.userId === target.userId);
      const isPresent = raw?.users?.some((member) => member.id === target.userId);
      if (!isPresent || raw?.game?.isOver) {
        throw new Error('Duel ended or target was removed before the requested decision');
      }
      if (targetPlayer?.id === expectedPlayerId(raw.game)) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    if (!ready) {
      throw new Error('Target did not receive a decision within 45 seconds');
    }
  }
  const experiment = { name, mode, treatment, keepAlive, phase, usesPublicOpponent, roomId, roomPath, target, opponent, startedAt: Date.now(), nextKeepAliveAt: Date.now() + 30000, removedAfterSeconds: null, sentKicks: new Set() };
  experiments.push(experiment);
  const initialDocument = await observe(experiment, observer, 'before-disconnect');
  experiment.turnStartedAt = Date.parse(initialDocument.game.updatedAt);
  await sleep(1200);
  experiment.startedAt = Date.now();
  logger.record('treatment', { name, mode, treatment, keepAlive, roomId, targetUserId: target.userId });
  if (treatment === 'unsubscribe' || treatment === 'rest') {
    await target.page.evaluate((documentPath) => {
      window.probe.listeners.get(documentPath)?.();
      window.probe.listeners.delete(documentPath);
    }, roomPath);
  } else if (treatment === 'close' || treatment === 'all-close') {
    target.closed = true;
    await target.context.close();
    if (treatment === 'all-close' && opponent !== observer) {
      opponent.closed = true;
      await opponent.context.close();
    }
  } else if (treatment === 'disable-network') {
    await target.page.evaluate(() => window.probe.firestore.disableNetwork(window.probe.database));
  } else if (treatment === 'offline' || treatment === 'reconnect') {
    await target.context.setOffline(true);
    if (treatment === 'reconnect') {
      recoveries.push((async () => {
        await sleep(10000);
        await target.context.setOffline(false);
        logger.record('reconnect', { name, secondsAfterDisconnect: (Date.now() - experiment.startedAt) / 1000 });
      })());
    }
  }
  process.stdout.write(`prepared ${name}\n`);
  return experiment;
}

try {
  logger.record('meta', {
    sdkVersion: '13.1.0', selectedCases, seconds, kickTimes, watchdogFromTarget, waitForTarget, useGameClock, pollMs, rejoinRemoved, duelLanguage,
    scope: 'No implicit client timers or leave calls during observation. Phase preparation, explicit watchdog calls, and public opponents are distinguished in the log.',
  });
  const observer = await makeActor('probe-observer');
  for (const specification of [...specifications, ...publicDuelSpecifications].filter(([name]) => selectedCases.includes(name))) {
    try {
      await prepare(specification, observer);
    } catch (error) {
      logger.record('setupError', { name: specification[0], message: error.message });
      process.stdout.write(`setup failed ${specification[0]}: ${error.message}\n`);
    }
  }
  const deadline = Date.now() + seconds * 1000;
  let nextProgressAt = Date.now();
  while (Date.now() < deadline) {
    await Promise.all(experiments.map(async (experiment) => {
      try {
        for (const kickTime of kickTimes) {
          const watchdogBase = useGameClock ? experiment.turnStartedAt : experiment.startedAt;
          const maySendWatchdog = !experiment.usesPublicOpponent || watchdogFromTarget;
          if (experiment.mode !== 'training' && maySendWatchdog && !experiment.sentKicks.has(kickTime)
            && Date.now() - watchdogBase >= kickTime * 1000) {
            experiment.sentKicks.add(kickTime);
            await observe(experiment, observer, `before-watchdog-${kickTime}`);
            try {
              const watchdogActor = watchdogFromTarget ? experiment.target : experiment.opponent;
              await call(watchdogActor, 'kick-user', experiment.mode, experiment.roomId);
            } catch (error) {
              logger.record('watchdogError', { name: experiment.name, kickTime, status: error.status, message: error.message });
            }
            await observe(experiment, observer, `after-watchdog-${kickTime}`);
          }
        }
        if (Date.now() >= experiment.nextKeepAliveAt) {
          experiment.nextKeepAliveAt = Date.now() + 30000;
          if (experiment.mode === 'private' && experiment.treatment !== 'all-close') {
            await call(experiment.opponent, 'keep-alive', experiment.mode, experiment.roomId);
            if (experiment.keepAlive && experiment.last?.member) {
              await call(experiment.target, 'keep-alive', experiment.mode, experiment.roomId);
            }
          }
          if (experiment.treatment === 'rest') {
            const read = await experiment.target.transport.readDocument(experiment.roomPath);
            logger.record('targetRestRead', { name: experiment.name, member: summary(read.raw, experiment.target).member });
          }
        }
        await observe(experiment, observer, 'poll');
      } catch (error) {
        logger.record('observationError', { name: experiment.name, status: error.status, message: error.message });
      }
    }));
    if (Date.now() >= nextProgressAt) {
      nextProgressAt = Date.now() + 30000;
      process.stdout.write(`remaining ${Math.ceil((deadline - Date.now()) / 1000)}s; ${experiments.map((experiment) => `${experiment.name}=${experiment.last?.member ? 'present' : 'absent'}`).join(' ')}\n`);
    }
    await sleep(pollMs);
  }
  await Promise.allSettled(recoveries);
  for (const experiment of experiments) {
    const beforeFollowUp = await observe(experiment, observer, 'before-follow-up');
    if (experiment.mode === 'private') {
      try {
        await call(experiment.target, 'keep-alive', experiment.mode, experiment.roomId);
        await observe(experiment, observer, 'after-target-keepalive');
      } catch (error) {
        logger.record('followUpError', { name: experiment.name, action: 'keep-alive', status: error.status, message: error.message });
      }
      if (rejoinRemoved) {
        for (const actor of [experiment.target, experiment.opponent]) {
          if (!beforeFollowUp.users.some((member) => member.id === actor.userId)) {
            await call(actor, 'join-room', experiment.mode, experiment.roomId, { userName: actor.userName });
            await observe(experiment, observer, `after-rejoin-${actor.name}`);
          }
        }
      }
    }
  }
  const report = experiments.map((experiment) => ({ name: experiment.name, mode: experiment.mode, treatment: experiment.treatment, keepAlive: experiment.keepAlive, phase: experiment.phase, roomId: experiment.roomId, observedSeconds: (Date.now() - experiment.startedAt) / 1000, removedAfterSeconds: experiment.removedAfterSeconds, final: experiment.last }));
  await fs.writeFile(path.join(output, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`report ${path.join(output, 'summary.json')}\n`);
} finally {
  for (const membership of [...roomMemberships.values()]) {
    try {
      await call(membership.actor, 'leave-room', membership.mode, membership.roomId);
    } catch (error) {
      logger.record('cleanupError', { actor: membership.actor.name, mode: membership.mode, roomId: membership.roomId, status: error.status, message: error.message });
    }
  }
  await browser.close();
  await logger.flush();
}
