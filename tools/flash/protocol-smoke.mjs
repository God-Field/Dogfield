import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../server/http/server.ts';
import { field, parseXml } from '../../server/flash/xml.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const version = process.argv.find((argument) => argument.startsWith('--version='))?.slice(10) ?? '2013';
assert.ok(['2013', '201005', '201008'].includes(version));
const legacy = version !== '2013';
const profile = legacy ? '2010' : '2013';
const language = legacy ? 'ja' : 'en';
const protocolLanguage = legacy ? 'JAPANESE' : 'ENGLISH';
const { server, flash } = await createServer({ botInterval: 0 });
const originalReceive = flash.receive.bind(flash);
const originalDraw = flash.accounts.drawBook2010.bind(flash.accounts);
flash.accounts.drawBook2010 = (token) => originalDraw(token, () => 0);
const requests = [];
const replies = [];
const clients = [];
const failures = [];
flash.receive = (session, source) => {
  const request = parseXml(source);
  requests.push(request);
  if (request.name === 'LOGIN') {
    clients.push(session);
    const send = session.send;
    session.send = (message) => {
      replies.push(parseXml(message));
      send(message);
    };
  }
  if (request.name === 'ERROR') {
    failures.push(source);
  }
  return originalReceive(session, source);
};
function fixtureSession(name) {
  const session = flash.connect(() => {});
  const token = `dogfield-local-${name.toLowerCase().padEnd(32, 'a')}`;
  const tokenField = legacy ? 'fcauth' : 'userID';
  originalReceive(session, `<LOGIN><name>${name}</name><language>${protocolLanguage}</language><mode>FREE_FIGHT</mode><version>${profile}</version><${tokenField}>${token}</${tokenField}></LOGIN>`);
  return session;
}
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  let loginBonusShown = false;
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/flash/api/addLoginBonus' && response.ok()) {
      loginBonusShown = Number(field(parseXml(await response.text()), 'bonus')) > 0;
    }
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      failures.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (/Error #|Error running AVM2|Error dispatching event|Error during movie loading/.test(message.text())) {
      failures.push(message.text());
    }
  });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      failures.push(`Unexpected external request ${route.request().url()}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await mkdir(resolve(repository, 'artifacts/flash'), { recursive: true });
  await page.goto(`${origin}/flash/?version=${version}&language=${language}`);
  await page.waitForTimeout(6000);
  await page.mouse.click(590, 495);
  await page.waitForTimeout(500);
  await page.mouse.click(590, 495);
  await page.keyboard.type('FlashTester', { delay: 50 });
  await page.mouse.click(550, 620);
  await page.waitForTimeout(1500);
  if (legacy) {
    assert.ok(loginBonusShown, 'The original client must display its login reward');
    await page.mouse.click(550, 526);
    await page.waitForTimeout(500);
  }
  await page.mouse.click(500, legacy ? 400 : 280);
  await page.waitForTimeout(2000);
  const owner = clients[0];
  assert.ok(owner);
  originalReceive(owner, '<ENTER><name>Protocol</name><playersLimit>4</playersLimit></ENTER>');
  await page.waitForTimeout(2000);
  const room = owner.room;
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${version}-protocol-room.png`) });
  if (legacy) {
    flash.accounts.addBook2010Score(owner.accountToken, 5);
    const bookResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/flash/api/getBook');
    await page.mouse.click(890, 117);
    assert.equal((await bookResponse).status(), 200);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${version}-protocol-book.png`) });
    await page.mouse.click(550, 560);
    await page.waitForTimeout(4000);
    assert.ok(requests.some((request) => request.name === 'DRAW_BOOK'), 'The real book must send DRAW_BOOK');
    assert.deepEqual(flash.accounts.get(owner.accountToken).book2010, { score: 0, elements: [0] });
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${version}-protocol-book-drawn.png`) });
    await page.mouse.click(1025, 148);
    await page.mouse.click(510, 270);
    await page.waitForTimeout(1000);
    assert.ok(requests.some((request) => request.name === 'SET_CHARGE'), 'The real charge toggle must send SET_CHARGE');
    assert.equal(room.needsCharge, true);
  }
  const voters = ['Bob', 'Carol', 'David'].map((name) => fixtureSession(name));
  for (const voter of voters) {
    originalReceive(voter, `<ENTER><id>${room.id}</id></ENTER>`);
  }
  for (const player of [owner, ...voters]) {
    originalReceive(player, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  }
  await page.waitForTimeout(1000);
  replies.length = 0;
  for (const voter of voters) {
    originalReceive(voter, '<FILTER><user>FlashTester</user><isFiltered/></FILTER>');
  }
  await page.waitForTimeout(1500);
  assert.equal(replies[0].name, 'KICKED');
  assert.ok(replies.some((reply) => reply.name === 'ERROR' && field(reply, 'message') === 'kicked'));
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${version}-protocol-kicked.png`) });
  await page.mouse.click(550, 526);
  await page.mouse.click(960, 810);
  await page.waitForTimeout(1000);
  assert.ok(!flash.sessions.has(owner), 'The kicked client must be able to go Back');
  flash.maintenance = true;
  await page.mouse.click(500, legacy ? 400 : 280);
  await page.waitForTimeout(2000);
  const returning = clients[1];
  assert.ok(returning);
  originalReceive(returning, '<ENTER><name>Maintenance</name><playersLimit>2</playersLimit></ENTER>');
  const opponent = fixtureSession('MaintOpponent');
  originalReceive(opponent, `<ENTER><id>${returning.room.id}</id></ENTER>`);
  for (const player of [returning, opponent]) {
    originalReceive(player, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  }
  await page.waitForTimeout(1500);
  replies.length = 0;
  await page.mouse.click(240, 450);
  await page.waitForTimeout(1500);
  assert.ok(replies.some((reply) => reply.name === 'ERROR' && field(reply, 'message') === 'isLocked'));
  assert.equal(returning.room.battle, undefined);
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${version}-protocol-maintenance.png`) });
  await page.mouse.click(550, 526);
  flash.maintenance = false;
  originalReceive(opponent, '<READY><isReady/></READY>');
  await page.mouse.click(240, 450);
  await page.waitForTimeout(2000);
  assert.ok(returning.room.battle, 'The real Ready control must work after maintenance ends');
  assert.deepEqual(failures, []);
  console.log(`SWF ${version}: ${legacy ? 'login bonus, book draw, charge toggle, ' : ''}kick transition, alert, Back, maintenance and resumed entry passed.`);
} finally {
  await browser.close();
  await server.close();
}
