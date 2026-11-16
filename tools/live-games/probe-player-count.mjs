#!/usr/bin/env node
/** Probe official training counts with existing accounts and real Firestore listeners. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {FIREBASE, LiveTransport} from './transport.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = path.join(repositoryRoot, 'logs/live/player-count');
const accountPool = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'logs/live/account-pool-100.json'), 'utf8'));
const preflightOnly = process.argv.includes('--preflight');
const spacingMs = 750;
const sampleIntervalMs = 15000;
const increaseWindowMs = 30 * 60 * 1000;
const decreaseWindowMs = 90 * 60 * 1000;

await fs.mkdir(outputRoot, {recursive: true});
const runPath = path.join(outputRoot, `${new Date().toISOString().replaceAll(':', '-')}.jsonl`);
const log = await fs.open(runPath, 'wx', 0o600);
const record = async (value) => log.appendFile(`${JSON.stringify({ts: new Date().toISOString(), ...value})}\n`);
const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));
const transportFor = () => new LiveTransport({logger: {record: () => {}}});

const previousRunPaths = (await fs.readdir(outputRoot))
  .filter((fileName) => fileName.endsWith('.jsonl') && fileName !== path.basename(runPath))
  .sort()
  .reverse();
let rooms = null;
for (const fileName of previousRunPaths) {
  const contents = await fs.readFile(path.join(outputRoot, fileName), 'utf8');
  const startedRooms = contents.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'started')
    .map((entry) => ({accountIndex: entry.accountIndex, roomId: entry.roomId}));
  if (startedRooms.length >= 100) {
    rooms = startedRooms.slice(0, preflightOnly ? 1 : 100);
    break;
  }
}
if (rooms === null || accountPool.length < rooms.length) {
  throw new Error('Could not find existing accounts and 100 started training rooms');
}

const credentials = [];
for (const room of rooms) {
  const account = accountPool[room.accountIndex - 1];
  const transport = transportFor();
  transport.userId = account.userId;
  transport.refreshToken = account.refreshToken;
  await transport.refreshAuth();
  credentials.push({
    accountIndex: room.accountIndex,
    roomId: room.roomId,
    userId: transport.userId,
    idToken: transport.idToken,
    refreshToken: transport.refreshToken,
  });
  await sleep(spacingMs);
}

const observer = transportFor();
observer.userId = credentials[0].userId;
observer.idToken = credentials[0].idToken;
observer.refreshToken = credentials[0].refreshToken;
observer.expiresAt = Date.now() + 50 * 60 * 1000;

const readCount = async (phase) => {
  const result = await observer.readDocument('status/user_count', {log: false});
  const counts = result.raw ?? {};
  const training = counts.training ?? null;
  await record({
    type: 'count',
    phase,
    training,
    private: counts.private ?? null,
    duel: counts.duel ?? null,
    documentUpdateTime: counts.__documentUpdateTime ?? null,
  });
  process.stdout.write(`${new Date().toISOString()} ${phase} training=${training}\n`);
  return training;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'],
});
const context = await browser.newContext({locale: 'en-US'});
const page = await context.newPage();
await page.exposeFunction('recordListener', async (details) => record({type: 'listener', ...details}));
page.on('console', (message) => {
  if (message.type() === 'error') void record({type: 'browserConsoleError', message: message.text()});
});
page.on('requestfailed', (request) => {
  void record({type: 'requestFailed', url: request.url(), error: request.failure()?.errorText ?? null});
});
await page.addInitScript(() => {
  let bridge;
  Object.defineProperty(window, 'firebase', {
    configurable: true,
    get: () => bridge,
    set: (value) => {
      bridge = value;
      const initialize = value.initializeApp.bind(value);
      value.initializeApp = (...arguments_) => {
        window.probeApplication = initialize(...arguments_);
        return window.probeApplication;
      };
      const getAuth = value.getAuth.bind(value);
      value.getAuth = (app) => {
        window.probeAuth = getAuth(app);
        return window.probeAuth;
      };
      const signInAnonymously = value.signInAnonymously.bind(value);
      value.signInAnonymously = (auth) => {
        window.probeAuth = auth;
        return signInAnonymously(auth);
      };
    },
  });
});
await page.goto('https://godfield.net');
await page.locator('input').first().fill('Player Count SDK Probe');
await page.getByText('Genesis', {exact: true}).click({force: true});
await page.waitForFunction(() => Boolean(window.probeAuth?.currentUser?.uid), null, {timeout: 30000});

await page.evaluate(async (configuration) => {
  const authModule = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js');
  const appModule = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js');
  const firestoreModule = await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js');
  const userTemplate = window.probeAuth.currentUser.toJSON();
  const userImplementation = window.probeAuth.currentUser.constructor;
  window.probeSessions = [];
  for (const credential of configuration.credentials) {
    const app = appModule.initializeApp(
      configuration.firebase,
      `player-count-${credential.accountIndex}`,
    );
    const auth = authModule.getAuth(app);
    await auth.authStateReady();
    const userData = {
      ...userTemplate,
      uid: credential.userId,
      apiKey: app.options.apiKey,
      appName: app.name,
      stsTokenManager: {
        refreshToken: credential.refreshToken,
        accessToken: credential.idToken,
        expirationTime: Date.now() + 3600000,
      },
    };
    const user = userImplementation._fromJSON(auth, userData);
    await authModule.updateCurrentUser(auth, user);
    window.probeSessions.push({
      auth,
      database: firestoreModule.getFirestore(app),
      firestoreModule,
      accountIndex: credential.accountIndex,
      roomId: credential.roomId,
    });
  }
}, {
  firebase: {apiKey: FIREBASE.apiKey, projectId: FIREBASE.projectId, authDomain: FIREBASE.authDomain},
  credentials,
});

const baseline = await readCount('baseline');
await record({type: 'run', accountCount: credentials.length, preflightOnly, baseline});
await page.evaluate(async () => {
  const sessions = window.probeSessions;
  window.probeUnsubscribers = [];
  const acknowledgements = sessions.map((session, sessionIndex) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No server snapshot for account ${session.accountIndex}`)), 60000);
    const reference = session.firestoreModule.doc(
      session.database,
      `modes/training/rooms/${session.roomId}`,
    );
    const unsubscribe = session.firestoreModule.onSnapshot(reference, {includeMetadataChanges: true}, (snapshot) => {
      void window.recordListener({
        accountIndex: session.accountIndex,
        fromCache: snapshot.metadata.fromCache,
        exists: snapshot.exists(),
      });
      if (!snapshot.metadata.fromCache) {
        clearTimeout(timer);
        resolve();
      }
    }, (error) => {
      clearTimeout(timer);
      void window.recordListener({
        accountIndex: session.accountIndex,
        error: {code: error.code ?? null, message: error.message},
      });
      reject(error);
    });
    window.probeUnsubscribers.push(unsubscribe);
  }));
  await Promise.all(acknowledgements);
});

if (preflightOnly) {
  await page.evaluate(() => window.probeUnsubscribers.forEach((unsubscribe) => unsubscribe()));
  await context.close();
  await browser.close();
  await record({type: 'preflightComplete', listenerCount: credentials.length});
  await log.close();
  process.stdout.write(`preflight succeeded with ${credentials.length} listener\n`);
  process.exit(0);
}

await record({type: 'connected', listenerCount: credentials.length});
let highestConnectedCount = baseline;
let increaseReached = false;
const increaseDeadline = Date.now() + increaseWindowMs;
while (Date.now() < increaseDeadline) {
  const training = await readCount('connected');
  if (training !== null && (highestConnectedCount === null || training > highestConnectedCount)) {
    highestConnectedCount = training;
  }
  if (baseline !== null && training !== null && training - baseline > 50) {
    increaseReached = true;
    break;
  }
  await sleep(sampleIntervalMs);
}

await record({type: 'disconnect', highestConnectedCount, increaseReached});
await page.evaluate(() => window.probeUnsubscribers.forEach((unsubscribe) => unsubscribe()));
await context.close();
await browser.close();

let decreaseReached = false;
const decreaseDeadline = Date.now() + decreaseWindowMs;
while (Date.now() < decreaseDeadline) {
  const training = await readCount('disconnected');
  if (highestConnectedCount !== null && training !== null && highestConnectedCount - training > 50) {
    decreaseReached = true;
    break;
  }
  await sleep(sampleIntervalMs);
}

const finalCount = await readCount('final');
await record({type: 'complete', baseline, highestConnectedCount, finalCount, increaseReached, decreaseReached, runPath});
await log.close();
process.stdout.write(`complete log=${runPath} increaseReached=${increaseReached} decreaseReached=${decreaseReached}\n`);
