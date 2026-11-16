import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../server/http/server.ts';
import { FlashBattle } from '../../server/flash/battle.ts';
import { itemAt } from '../../server/flash/catalog.ts';
import { field, parseXml } from '../../server/flash/xml.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const version = process.argv.find((argument) => argument.startsWith('--version='))?.slice(10) ?? '2013';
const mode = process.argv.find((argument) => argument.startsWith('--mode='))?.slice(7) ?? 'training';
assert.ok(['2013', '201005', '201008'].includes(version));
assert.ok(['training', 'duel', 'spirit'].includes(mode));
const legacy = version !== '2013';
const profile = legacy ? '2010' : '2013';
const modePosition = legacy
  ? { training: 270, duel: 530, spirit: 660 }[mode]
  : { training: 185, duel: 470, spirit: 565 }[mode];
const spiritEntryPosition = legacy ? 370 : 390;
const capture = `${version}-${mode}-multiple-tabs`;
const failures = [];
const logins = [];
const acceptedCommands = new Set();
const originalGift = FlashBattle.prototype.gift;
const originalStart = FlashBattle.prototype.start;
FlashBattle.prototype.gift = function () {
  return { item: itemAt(legacy ? 8 : 5, profile), costMP: 0 };
};
FlashBattle.prototype.start = function () {
  const originalShuffle = this.random.shuffle.bind(this.random);
  this.random.shuffle = (label, values) => label === 'flashPlayerOrder' ? [...values] : originalShuffle(label, values);
  return originalStart.call(this);
};
const { server, flash } = await createServer({ botInterval: 0, flashStartingCredits: 1000 });
const originalReceive = flash.receive.bind(flash);
flash.receive = (session, source) => {
  const request = parseXml(source);
  if (request.name === 'LOGIN') {
    logins.push(session);
  }
  if (request.name === 'ERROR') {
    failures.push(source);
  }
  const result = originalReceive(session, source);
  if (request.name === 'COMMAND') {
    acceptedCommands.add(session);
  }
  return result;
};
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1100, height: 950 } });
await context.route('**/*', async (route) => {
  if (new URL(route.request().url()).origin !== origin) {
    failures.push(`Unexpected external request ${route.request().url()}`);
    await route.abort();
    return;
  }
  await route.continue();
});
await mkdir(resolve(repository, 'artifacts/flash'), { recursive: true });

async function openTab() {
  const page = await context.newPage();
  let loginBonusShown = false;
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/flash/api/addLoginBonus' && response.ok()) {
      loginBonusShown = Number(field(parseXml(await response.text()), 'bonus')) > 0;
    }
  });
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (/Error #|Error running AVM2|Error dispatching event|Error during movie loading/.test(message.text())) {
      failures.push(message.text());
    }
  });
  await page.goto(`${origin}/flash/?version=${version}&language=en`);
  await page.waitForTimeout(6000);
  await page.mouse.click(590, 495);
  await page.waitForTimeout(500);
  await page.mouse.click(590, 495);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('FlashTester', { delay: 50 });
  await page.mouse.click(550, 620);
  await page.waitForTimeout(1500);
  if (legacy && loginBonusShown) {
    await page.mouse.click(550, 526);
    await page.waitForTimeout(500);
  }
  await page.mouse.click(500, modePosition);
  await page.waitForTimeout(2500);
  return page;
}

function enterOpponent(name) {
  const opponent = flash.connect(() => {});
  const token = `dogfield-local-${name.toLowerCase().padEnd(32, 'a')}`;
  const tokenField = legacy ? 'fcauth' : 'userID';
  originalReceive(opponent, `<LOGIN><name>${name}</name><language>ENGLISH</language><mode>DUEL</mode><version>${profile}</version><${tokenField}>${token}</${tokenField}></LOGIN>`);
  originalReceive(opponent, '<ENTER/>');
}

async function enterGame(page, opponentName) {
  if (mode === 'duel') {
    await page.mouse.click(550, 450);
    await page.waitForTimeout(1000);
    enterOpponent(opponentName);
  } else if (mode === 'spirit') {
    await page.mouse.click(170, spiritEntryPosition);
  }
  await page.waitForTimeout(15000);
}

try {
  const ownerPage = await openTab();
  await enterGame(ownerPage, 'Opponent1');
  const owner = logins[0];
  assert.ok(owner?.room?.battle, 'The first tab must be in an actual game');
  const originalRoom = owner.room;
  const originalSnapshot = originalRoom.battle.snapshot(originalRoom.battle.player('FlashTester'));
  const credits = owner.accountToken ? flash.accounts.get(owner.accountToken).credits : undefined;
  const duplicatePage = await openTab();
  const duplicate = logins[1];
  assert.equal(duplicate?.name, owner.name);
  if (mode !== 'training') {
    assert.equal(duplicate.accountToken, owner.accountToken, 'Both browser tabs must share the account');
    assert.equal(duplicate.room, undefined, 'The second tab must open a lobby');
    const received = [];
    let alertRequested = false;
    duplicatePage.on('request', (request) => {
      if (new URL(request.url()).pathname === '/flash/assets/sounds/alert.mp3') {
        alertRequested = true;
      }
    });
    const send = duplicate.send;
    duplicate.send = (message) => {
      received.push(message);
      send(message);
    };
    const entryPosition = mode === 'duel' ? { x: 550, y: 450 } : { x: 170, y: spiritEntryPosition };
    await duplicatePage.mouse.click(entryPosition.x, entryPosition.y);
    await duplicatePage.waitForTimeout(1500);
    const rejectionIndex = received.findIndex((message) => field(parseXml(message), 'message') === 'userExists');
    assert.ok(rejectionIndex > 0);
    assert.equal(parseXml(received[rejectionIndex - 1]).name, 'ENTER', 'The lobby must reset pending entry controls');
    assert.ok(!received.some((message) => field(parseXml(message), 'message') === 'isLocked'));
    assert.equal(alertRequested, false, 'Ordinary entry rejection must not display the maintenance alert');
    assert.equal(duplicate.room, undefined);
    assert.ok(!flash.duelQueue.has(duplicate));
    assert.equal(flash.accounts.get(owner.accountToken).credits, credits, 'Blocked entry must not charge the account');
    assert.equal(owner.room, originalRoom);
    assert.equal(originalRoom.battle.snapshot(originalRoom.battle.player('FlashTester')), originalSnapshot);
    await duplicatePage.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-locked.png`) });
    await duplicatePage.mouse.click(960, 810);
    await duplicatePage.waitForTimeout(1000);
    assert.ok(!flash.sessions.has(duplicate), 'The second tab must remain able to go Back');
    assert.ok(flash.sessions.has(owner));
    assert.equal(owner.room, originalRoom);
    await ownerPage.close();
    await duplicatePage.mouse.click(500, modePosition);
    await duplicatePage.waitForTimeout(2500);
    const resumesSpiritGame = mode === 'spirit' && Boolean(logins[2]?.room?.battle);
    if (resumesSpiritGame) {
      await duplicatePage.waitForTimeout(15000);
    } else {
      await enterGame(duplicatePage, 'Opponent2');
    }
    assert.ok(logins[2]?.room?.battle, 'The second tab must enter or resume a game after the first tab closes');
    if (mode === 'duel') {
      assert.notEqual(logins[2].room.id, originalRoom.id);
    }
  } else {
    await duplicatePage.waitForTimeout(15000);
    assert.ok(duplicate.room?.battle, 'The second Training tab must enter its own game');
    assert.notEqual(duplicate.room.id, originalRoom.id);
    for (let attempt = 0; attempt < 10 && !acceptedCommands.has(duplicate); attempt++) {
      await duplicatePage.mouse.click(80, 580);
      await duplicatePage.mouse.click(850, 300);
      await duplicatePage.mouse.click(150, 490);
      await duplicatePage.waitForTimeout(500);
      await duplicatePage.mouse.click(475, 526);
      await duplicatePage.waitForTimeout(1000);
    }
    assert.ok(acceptedCommands.has(duplicate), 'The second Training tab must submit an accepted command');
    assert.equal(originalRoom.battle.snapshot(originalRoom.battle.player('FlashTester')), originalSnapshot);
  }
  await duplicatePage.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-playing.png`) });
  assert.deepEqual(failures, []);
  console.log(`SWF ${version} ${mode}: two tabs with the same name passed; ${mode === 'training' ? 'independent playable games' : 'lobby, rejected entry without a maintenance alert, Back, and game entry after closing the first tab'}.`);
} finally {
  await browser.close();
  await server.close();
  FlashBattle.prototype.gift = originalGift;
  FlashBattle.prototype.start = originalStart;
}
