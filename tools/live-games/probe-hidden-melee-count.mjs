#!/usr/bin/env node
/** Manual official private-room count probe. Never imported by offline tests. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { FIREBASE, LiveTransport, toPlain } from './transport.mjs';
import { loadEngine } from './engine.mjs';
import { loadCatalog, decodeRoom } from './state.mjs';
import { ExplorationPolicy } from './policy.mjs';
import { createRng } from './rng.mjs';

const directory = `logs/live/private-count/${new Date().toISOString().replaceAll(':', '-')}`;
await fs.mkdir(directory, { recursive: true });
const output = await fs.open(`${directory}/observations.jsonl`, 'wx', 0o600);
const record = async (type, details = {}) => {
  const entry = { ts: new Date().toISOString(), type, ...details };
  await output.appendFile(`${JSON.stringify(entry)}\n`);
  if (!['room', 'sdk'].includes(type)) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const savedAccounts = JSON.parse(await fs.readFile('logs/live/account-pool-100.json', 'utf8'));
const actors = [];
for (const [accountIndex, saved] of savedAccounts.entries()) {
  const transport = new LiveTransport({ logger: { record() {} }, roomMode: 'private' });
  transport.userId = saved.userId;
  transport.refreshToken = saved.refreshToken;
  await transport.refreshAuth();
  actors.push({ accountIndex, transport });
}
const rooms = [];
let browser;
let sampling = true;
let sampler;
let phase = 'baseline';
let latestPublication = null;
let cleanedUp = false;

async function sample() {
  const { raw } = await actors[0].transport.readDocument('status/user_count', { log: false });
  latestPublication = raw.__documentUpdateTime;
  await record('count', { phase, ...raw });
}

async function roomSnapshot(room, label) {
  const owner = actors[room.ownerIndex];
  const { raw } = await owner.transport.readRoom(room.roomId, { log: false });
  if (!raw) {
    throw new Error(`Our room disappeared: ${room.roomId}`);
  }
  await record('room', { label, group: room.group, roomId: room.roomId,
    userCount: raw.userCount, users: raw.users,
    updatedAt: raw.updatedAt, documentUpdateTime: raw.__documentUpdateTime,
    gameUpdateCount: raw.game?.updateCount ?? null, gameIsOver: raw.game?.isOver === true });
  return raw;
}

async function call(accountIndex, action, room, extra = {}) {
  return actors[accountIndex].transport.call(action, { mode: 'private', roomId: room.roomId, ...extra });
}

async function atMinuteOffset(offset = 20000) {
  const candidate = Math.floor(Date.now() / 60000) * 60000 + offset;
  const target = candidate > Date.now() + 1500 ? candidate : candidate + 60000;
  await record('scheduled', { phase, target: new Date(target).toISOString() });
  while (Date.now() < target) {
    await sleep(Math.min(500, target - Date.now()));
  }
}

async function publications(number) {
  let previous = latestPublication;
  let remaining = number;
  const deadline = Date.now() + (number + 1) * 60000;
  while (remaining > 0 && Date.now() < deadline) {
    await sleep(250);
    if (latestPublication !== previous) {
      remaining--;
      previous = latestPublication;
    }
  }
  if (remaining > 0) {
    throw new Error('Timed out waiting for the next official aggregate publication');
  }
}

async function createCohort(group, sharedAccounts) {
  await atMinuteOffset();
  phase = `${group}-creation`;
  await record('wave-start', { phase, rooms: 20, memberships: 100 });
  const results = await Promise.allSettled(Array.from({ length: 20 }, async (_, roomIndex) => {
    const ownerIndex = sharedAccounts ? 0 : roomIndex * 5;
    const memberIndexes = Array.from({ length: 5 }, (_, memberIndex) =>
      sharedAccounts ? memberIndex : ownerIndex + memberIndex);
    const password = [...crypto.randomBytes(9)].map((value) => String.fromCharCode(97 + value % 26)).join('');
    const response = await actors[ownerIndex].transport.call('create-room', {
      mode: 'private', userName: `Count${ownerIndex}`, password, lang: 'en',
    });
    const room = { roomId: response.roomId, group, ownerIndex, memberIndexes: [ownerIndex] };
    rooms.push(room);
    const initial = await roomSnapshot(room, `${group}-owner-created`);
    const expectedOwnerId = actors[ownerIndex].transport.userId;
    if (initial.users.length !== 1 || initial.users[0].id !== expectedOwnerId) {
      throw new Error('The returned room is not a new room containing only our owner');
    }
    for (const accountIndex of memberIndexes.slice(1)) {
      await call(accountIndex, 'join-room', room, { userName: `Count${accountIndex}` });
      room.memberIndexes.push(accountIndex);
    }
    await call(ownerIndex, 'set-room-locked', room, { isLocked: true });
    const raw = await roomSnapshot(room, `${group}-created`);
    if (raw.users.length !== 5) {
      throw new Error(`Expected five controlled members in ${room.roomId}`);
    }
    return room;
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    await record('cohort-errors', { group, failures: failures.map((result) => String(result.reason)) });
    throw new Error(`Failed to create ${failures.length} controlled private rooms`);
  }
  const created = results.map((result) => result.value);
  await fs.writeFile(`${directory}/rooms.json`, `${JSON.stringify(rooms, null, 2)}\n`, { mode: 0o600 });
  await record('wave-end', { phase, rooms: created.length });
  return created;
}

async function connectSdk(cohort) {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'] });
  const page = await browser.newPage({ locale: 'en-US' });
  await page.exposeFunction('recordSdk', (details) => record('sdk', details));
  await page.addInitScript(() => {
    let bridge;
    Object.defineProperty(window, 'firebase', {
      configurable: true,
      get: () => bridge,
      set: (value) => {
        bridge = value;
        const getAuth = value.getAuth.bind(value);
        value.getAuth = (app) => {
          window.probeAuth = getAuth(app);
          return window.probeAuth;
        };
        const signIn = value.signInAnonymously.bind(value);
        value.signInAnonymously = (auth) => {
          window.probeAuth = auth;
          return signIn(auth);
        };
      },
    });
  });
  await page.goto('https://godfield.net');
  await page.locator('input').first().fill('Private count probe');
  await page.getByText('Genesis', { exact: true }).click({ force: true });
  await page.waitForFunction(() => Boolean(window.probeAuth?.currentUser?.uid));
  const credentials = cohort.flatMap((room) => room.memberIndexes.map((accountIndex) => {
    const transport = actors[accountIndex].transport;
    return { accountIndex, roomId: room.roomId, userId: transport.userId,
      idToken: transport.idToken, refreshToken: transport.refreshToken };
  }));
  await page.evaluate(async (configuration) => {
    const appModule = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js');
    const authModule = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js');
    const firestore = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js');
    const template = window.probeAuth.currentUser.toJSON();
    const implementation = window.probeAuth.currentUser.constructor;
    window.countUnsubscribers = [];
    await Promise.all(configuration.credentials.map(async (credential) => {
      const app = appModule.initializeApp(configuration.firebase, `private-count-${credential.accountIndex}`);
      const auth = authModule.getAuth(app);
      await auth.authStateReady();
      const user = implementation._fromJSON(auth, {
        ...template, uid: credential.userId, apiKey: app.options.apiKey, appName: app.name,
        stsTokenManager: { accessToken: credential.idToken, refreshToken: credential.refreshToken,
          expirationTime: Date.now() + 3600000 },
      });
      await authModule.updateCurrentUser(auth, user);
      const database = firestore.getFirestore(app);
      const reference = firestore.doc(database, `modes/private/rooms/${credential.roomId}`);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No server snapshot')), 45000);
        const unsubscribe = firestore.onSnapshot(reference, { includeMetadataChanges: true }, (snapshot) => {
          void window.recordSdk({ accountIndex: credential.accountIndex, exists: snapshot.exists(),
            fromCache: snapshot.metadata.fromCache });
          if (!snapshot.metadata.fromCache) {
            clearTimeout(timeout);
            resolve();
          }
        }, (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        window.countUnsubscribers.push(unsubscribe);
      });
    }));
  }, { credentials, firebase: { apiKey: FIREBASE.apiKey, projectId: FIREBASE.projectId,
    authDomain: FIREBASE.authDomain } });
  await record('sdk-connected', { listeners: credentials.length });
}

async function ownerWave(cohort, label) {
  await record('wave-start', { label, owners: cohort.length });
  const snapshots = await Promise.all(cohort.map(async (room) => {
    await call(room.ownerIndex, 'keep-alive', room);
    return roomSnapshot(room, label);
  }));
  await record('wave-end', { label, roomCounts: snapshots.map((raw) => raw.userCount),
    membershipSizes: snapshots.map((raw) => raw.users.length) });
}

async function cleanup() {
  phase = 'cleanup';
  const failures = [];
  await Promise.all(rooms.map(async (room) => {
    for (const accountIndex of [...room.memberIndexes].reverse()) {
      try {
        await call(accountIndex, 'leave-room', room);
      } catch (error) {
        failures.push({ roomId: room.roomId, accountIndex, error: String(error) });
      }
    }
    await roomSnapshot(room, 'after-cleanup');
  }));
  cleanedUp = failures.length === 0;
  await record('cleanup', { rooms: rooms.length, failures });
}

try {
  await record('run', { directory, accounts: actors.length,
    scope: 'Private password-protected rooms containing only controlled accounts; no public matchmaking.' });
  await sample();
  sampler = (async () => {
    while (sampling) {
      await sleep(5000);
      if (sampling) {
        await sample();
      }
    }
  })();
  const cohort = await createCohort('independent-accounts', false);
  const createdAt = Date.now();
  await connectSdk(cohort);
  phase = 'idle-sdk-control';
  let nextControl = 10000;
  let ownerWaveSent = false;
  while (Date.now() - createdAt < 240000) {
    const age = Date.now() - createdAt;
    if (age >= nextControl) {
      await ownerWave(cohort.slice(0, 1), `control-age-${Math.round(age / 1000)}`);
      const interval = age >= 180000 && age < 220000 ? 2000 : 10000;
      nextControl = Date.now() - createdAt + interval;
    }
    if (!ownerWaveSent && age >= 140000) {
      ownerWaveSent = true;
      phase = 'owner-only-refresh';
      await ownerWave(cohort.slice(1), 'owner-only-refresh');
    }
    await sleep(250);
  }
  await Promise.all(cohort.map((room) => roomSnapshot(room, 'aged-240s')));
  await browser.close();
  browser = null;
  await record('sdk-disconnected');
  for (const accountIndex of cohort[0].memberIndexes) {
    await call(accountIndex, 'keep-alive', cohort[0]);
  }
  await roomSnapshot(cohort[0], 'all-members-refreshed');

  const repeated = await createCohort('repeated-five-accounts', true);
  await publications(1);
  phase = 'controlled-private-games';
  await atMinuteOffset();
  const engine = await loadEngine();
  const { catalog } = await loadCatalog(engine);
  const results = await Promise.allSettled(repeated.map(async (room, roomIndex) => {
    for (const accountIndex of room.memberIndexes) {
      await call(accountIndex, 'make-entry', room, { team: 0 });
    }
    await call(room.ownerIndex, 'start-game', room, { lang: 'en' });
    const raw = await roomSnapshot(room, 'game-started');
    const game = decodeRoom(engine, raw).game;
    if (!game) {
      throw new Error('Private game did not start');
    }
    const player = game.players.find((candidate) => candidate.id === game.attackTurnPlayerId);
    const actor = actors.find((candidate) => candidate.transport.userId === player.userId);
    const policy = new ExplorationPolicy({ engine, catalog, rng: createRng(roomIndex + 1) });
    const decision = policy.decideAttack(game, player);
    if (!actor || !decision) {
      throw new Error('No controlled actor or standard policy decision');
    }
    await call(actor.accountIndex, 'submit-command', room, { command: toPlain(decision.command) });
    return roomSnapshot(room, 'after-game-command');
  }));
  await record('game-wave', { successes: results.filter((result) => result.status === 'fulfilled').length,
    failures: results.filter((result) => result.status === 'rejected').map((result) => String(result.reason)) });
  await publications(1);
  await cleanup();
  await record('complete');
} finally {
  if (browser) {
    await browser.close();
  }
  if (!cleanedUp && rooms.length > 0) {
    await cleanup();
  }
  sampling = false;
  await sampler;
  await output.close();
}
