import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../../server/http/server.ts';
import { FlashAccounts, account2013 } from '../../server/flash/accounts.ts';
import { FlashBattle } from '../../server/flash/battle.ts';
import { Random } from '../../server/random.ts';
import { children, field, parseXml } from '../../server/flash/xml.ts';
import { itemAt } from '../../server/flash/catalog.ts';

const version = process.argv.find((argument) => argument.startsWith('--version='))?.slice(10) ?? '2013';
assert.ok(['2013', '201005', '201008'].includes(version));
const language = process.argv.find((argument) => argument.startsWith('--language='))?.slice(11) ?? 'en';
assert.ok(['en', 'ja'].includes(language));
const profile = version === '2013' ? '2013' : '2010';
const mode = process.argv.find((argument) => argument.startsWith('--mode='))?.slice(7) ?? 'training';
assert.ok(['training', 'duel', 'spirit'].includes(mode));
const entrancePositions = profile === '2010'
  ? { training: 270, duel: 530, spirit: 660 }
  : { training: 185, duel: language === 'ja' ? 565 : 470, spirit: language === 'ja' ? 650 : 565 };
const entranceModeY = entrancePositions[mode];
const spiritEntryY = profile === '2010' ? 370 : 390;
const payment = process.argv.find((argument) => argument.startsWith('--payment='))?.slice(10) ?? 'charin';
assert.ok(['charin', 'coin', 'ticket'].includes(payment));
assert.ok(payment === 'charin' || (profile === '2013' && mode === 'duel'));
const lottery = process.argv.find((argument) => argument.startsWith('--lottery='))?.slice(10);
assert.ok(!lottery || ['coin', 'ticket'].includes(lottery));
assert.ok(!lottery || (profile === '2013' && mode === 'duel' && payment === 'charin'));
const book = process.argv.includes('--book');
assert.ok(!book || (profile === '2013' && language === 'ja' && mode === 'duel' && !lottery && payment === 'charin'));
const twoClients = process.argv.includes('--two-clients');
assert.ok(!twoClients || mode === 'duel');
assert.ok(!lottery || !twoClients);
const broom = process.argv.includes('--broom');
assert.ok(!broom || mode === 'training', 'The Broom fixture targets Training');
const devil = process.argv.includes('--devil');
assert.ok(!devil || (profile === '2013' && mode === 'training'), 'The Devil fixture targets 2013 Training');
const illusion = process.argv.includes('--illusion');
assert.ok(!illusion || (profile === '2013' && mode === 'spirit'), 'The Illusion fixture targets 2013 Spirit');
const megumi = process.argv.find((argument) => argument.startsWith('--megumi='))?.slice(9);
assert.ok(!megumi || ['hp', 'mp', 'yen'].includes(megumi));
assert.ok(!megumi || mode === 'training');
const randomHand = process.argv.includes('--random-hand');
const seed = Number(process.argv.find((argument) => argument.startsWith('--seed='))?.slice(7) ?? 7);
assert.ok(Number.isInteger(seed));
const missingSounds = process.argv.includes('--missing-sounds');
assert.ok(!missingSounds || profile === '2010', 'The missing-sound fixture targets the 2010 clients');
const missingSoundPath = '/flash/assets/sounds/open_cover.mp3';
const missingSoundRequests = [];
const soundRequests = new Set();
const bookMissingPath = '/flash/assets/images/card/weapon/pikopiko_hammer.png';
let bookDrawCount = 0;
const missingImages = process.argv.includes('--missing-images');
assert.ok(!missingImages || profile === '2010', 'The missing-art fixture targets the 2010 clients');
assert.ok(!(randomHand && missingImages), 'Choose one hand fixture');
let weaponId = broom ? (profile === '2010' ? 350 : 240) : missingImages ? 65 : profile === '2010' ? 8 : 5;
const missingPaths = ['/flash/assets/images/card/weapon/pikopiko_hammer.png', '/flash/assets/images/card/weapon/hagane_no_ono.png'];
const missingRequests = [];
const capture = `${version}-${language}${lottery ? `-lottery-${lottery}` : ''}${book ? '-book' : ''}${payment === 'charin' ? '' : `-${payment}`}-${illusion ? 'illusion' : devil ? 'devil' : megumi ? `megumi-${megumi}` : broom ? 'broom' : randomHand ? `random-${seed}` : missingImages ? 'missing' : 'knife'}${missingSounds ? '-no-sound' : ''}-${mode}`;
const repository = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const ruffleDirectory = process.env.FLASH_RUFFLE_DIR
  ? resolve(process.env.FLASH_RUFFLE_DIR)
  : resolve(require.resolve('@ruffle-rs/ruffle'), '..');
await access(resolve(ruffleDirectory, 'ruffle.js'));
const flashAssetDirectory = resolve(process.env.FLASH_ASSET_DIR ?? resolve(repository, 'public/flash/assets'));
await access(resolve(flashAssetDirectory, 'images'));
await mkdir(resolve(repository, 'artifacts/flash'), { recursive: true });
const originalStart = FlashBattle.prototype.start;
const originalGift = FlashBattle.prototype.gift;
// A deterministic hand and first turn make the actual SWF interaction repeatable.
FlashBattle.prototype.gift = function () {
  if (randomHand) {
    return originalGift.call(this);
  }
  const giftIndex = this.smokeGiftIndex ?? 0;
  this.smokeGiftIndex = giftIndex + 1;
  if (megumi && giftIndex === 1) {
    const megumiBase = profile === '2010' ? 361 : 251;
    return { item: itemAt(megumiBase + ['hp', 'mp', 'yen'].indexOf(megumi), profile), costMP: 0 };
  }
  if (illusion && giftIndex >= 10 && giftIndex < 20) {
    return { item: itemAt(213, profile), costMP: 0 };
  }
  if (devil && giftIndex === 1) {
    return { item: itemAt(246, profile), costMP: 0 };
  }
  const itemId = missingImages && giftIndex < 8 ? (giftIndex % 2 === 0 ? 9 : 65) : weaponId;
  return { item: itemAt(itemId, profile), costMP: 0 };
};
FlashBattle.prototype.start = function () {
  if (megumi) {
    const originalPick = this.random.pick.bind(this.random);
    this.random.pick = (label, values, weight) => label === 'flashCreatureTarget'
      ? values.find((player) => player.name === 'FlashTester') : originalPick(label, values, weight);
  }
  const originalShuffle = this.random.shuffle.bind(this.random);
  this.random.shuffle = (label, values) => label === 'flashPlayerOrder' ? [...values] : originalShuffle(label, values);
  return originalStart.call(this);
};
const { server, flash } = await createServer({ botInterval: 0,
  flashAssets: flashAssetDirectory,
  flashRuffle: ruffleDirectory,
  flashStartingCredits: lottery === 'ticket' ? 0 : lottery === 'coin' ? 50 : 1000 });
if (lottery) {
  const lotteryAccounts = new FlashAccounts(flash.accounts.store, flash.accounts.startingCredits, {
    randomInt: () => lottery === 'ticket' ? 1 : 0,
  });
  flash.accounts.drawLot = lotteryAccounts.drawLot.bind(lotteryAccounts);
}
flash.random = new Random(seed);
if (profile === '2013' && mode === 'duel' && (payment !== 'charin' || book)) {
  const originalAccountGet = flash.accounts.get.bind(flash.accounts);
  const initializedAccounts = new Set();
  flash.accounts.get = (token) => {
    const account = originalAccountGet(token);
    if (!initializedAccounts.has(token)) {
      initializedAccounts.add(token);
      const modern = account2013(account);
      if (book) {
        modern.book = { score: 8, elements: [] };
      } else {
        account.credits = 0;
        modern.coin = payment === 'coin' ? 50 : 0;
        modern.ticket = payment === 'ticket' ? 'DUEL' : undefined;
        // Nonzero SCORE_BONUS also exercises the original winner's reward display.
        modern.scoreBonus = 30;
      }
      flash.accounts.set(token, account);
    }
    return account;
  };
}
if (book) {
  const originalAddBookElement = flash.accounts.addBookElement.bind(flash.accounts);
  flash.accounts.addBookElement = (token, language) => originalAddBookElement(token, language, () => 9);
}
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  let loginBonusShown = false;
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/flash/api/addLoginBonus' && response.ok()) {
      loginBonusShown = Number(field(parseXml(await response.text()), 'bonus')) > 0;
    }
  });
const failures = [];
const clientErrors = [];
const sentFrames = [];
const acceptedCommands = [];
let lotteryRequestCount = 0;
page.on('request', (request) => {
  if (new URL(request.url()).pathname === '/flash/api/addBookElement') {
    bookDrawCount++;
  }
  if (new URL(request.url()).pathname === '/flash/api/drawLot') {
    lotteryRequestCount++;
  }
});
page.on('pageerror', (error) => failures.push(error.message));
page.on('console', (message) => {
  const expectedMissingArt = message.text().includes('Error during movie loading') && message.text().includes('404')
    && ((missingImages && missingPaths.some((path) => message.text().includes(path)))
      || (randomHand && message.text().includes('/flash/assets/images/card/'))
      || (megumi && message.text().includes('/flash/assets/images/card/creature/megumi_san.png'))
      || (book && message.text().includes(bookMissingPath)));
  if (!expectedMissingArt && /Error #|Error running AVM2|Error dispatching event|Error during movie loading/.test(message.text())) {
    failures.push(message.text());
  }
});
page.on('response', (response) => {
  const path = new URL(response.url()).pathname;
  if (path.startsWith('/flash/assets/sounds/')) {
    soundRequests.add(path);
  }
  const expectedMissingSound = missingSounds && response.status() === 404 && path === missingSoundPath;
  const expectedMissingArt = response.status() === 404
    && ((missingImages && missingPaths.includes(path)) || (randomHand && path.startsWith('/flash/assets/images/card/'))
      || (megumi && path === '/flash/assets/images/card/creature/megumi_san.png')
      || (book && path === bookMissingPath));
  if (expectedMissingArt && (randomHand || megumi || book)) {
    missingRequests.push(path);
  }
  if (!expectedMissingArt && !expectedMissingSound && response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    failures.push(`HTTP ${response.status()} ${response.url()}`);
  }
});
const originalReceive = flash.receive.bind(flash);
flash.receive = (session, source) => {
  sentFrames.push(source);
  if (/^\s*<ERROR\b/.test(source)) {
    clientErrors.push(source);
  }
  const result = originalReceive(session, source);
  if (/^\s*<COMMAND\b/.test(source)) {
    acceptedCommands.push(parseXml(source));
  }
  return result;
};
await page.route('**/*', (route) => {
  if (new URL(route.request().url()).origin !== origin) {
    failures.push(`Unexpected external request ${route.request().url()}`);
    return route.abort();
  }
  if (missingSounds && new URL(route.request().url()).pathname === missingSoundPath) {
    missingSoundRequests.push(missingSoundPath);
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Missing sound fixture' });
  }
  if (missingImages && missingPaths.includes(new URL(route.request().url()).pathname)) {
    missingRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Missing card art fixture' });
  }
  return route.continue();
});
try {
  await page.goto(`${origin}/flash/?version=${version}&language=${language}`);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-login.png`) });
  await page.mouse.click(590, 495);
  await page.waitForTimeout(500);
  await page.mouse.click(590, 495);
  await page.keyboard.type('FlashTester', { delay: 80 });
  await page.mouse.click(550, 620);
  await page.waitForTimeout(1500);
  if (profile === '2010' && loginBonusShown) {
    await page.mouse.click(550, 526);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-entrance.png`) });
  if (lottery) {
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/flash/api/drawLot');
    await page.mouse.click(140, 765);
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const reward = parseXml(await response.text());
    assert.equal(field(reward, 'coin'), lottery === 'coin' ? '25' : '0');
    assert.equal(field(reward, 'ticket'), lottery === 'ticket' ? 'DUEL' : '');
    const token = new URL(response.url()).searchParams.get('userID');
    const account = flash.accounts.get(token);
    assert.equal(account.credits, lottery === 'coin' ? 50 : 0, 'A coin prize alone cannot cover Duel entry');
    assert.equal(account.flash2013.coin, lottery === 'coin' ? 25 : 0);
    assert.equal(account.flash2013.ticket, lottery === 'ticket' ? 'DUEL' : undefined);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-lottery.png`) });
    await page.mouse.click(550, 526);
  }
  await page.mouse.click(500, entranceModeY);
  if (mode !== 'training') {
    await page.waitForTimeout(2500);
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-mode.png`) });
    assert.ok(sentFrames.some((frame) => frame.includes(`<mode>${mode.toUpperCase()}</mode>`)), 'The selected mode must log in');
    if (lottery) {
      await page.mouse.click(960, 810);
      await page.waitForTimeout(1500);
      await page.mouse.click(140, 765);
      await page.waitForTimeout(500);
      assert.equal(lotteryRequestCount, 1, 'The original client must hide the lottery after a successful draw');
      await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-cooldown.png`) });
      await page.mouse.click(500, entranceModeY);
      await page.waitForTimeout(2500);
    }
    if (mode === 'duel') {
      await page.mouse.click(550, 450);
      await page.waitForTimeout(500);
      assert.equal(flash.duelQueue.size, 1, 'The real SWF must join the Duel queue');
      await page.mouse.click(550, 500);
      await page.waitForTimeout(500);
      assert.equal(flash.duelQueue.size, 0, 'The real SWF must cancel queueing');
      await page.mouse.click(550, 450);
      await page.waitForTimeout(500);
      if (twoClients) {
        const opponentPage = await browser.newPage({ viewport: { width: 1100, height: 950 } });
        let opponentFrame = '';
        opponentPage.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
          opponentFrame = payload.toString();
        }));
        opponentPage.on('pageerror', (error) => failures.push(error.message));
        opponentPage.on('console', (message) => {
          if (/Error #|Error running AVM2|Error dispatching event|Error during movie loading/.test(message.text())) {
            failures.push(`Opponent: ${message.text()} Last frame: ${opponentFrame}`);
          }
        });
        await opponentPage.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== origin) {
            failures.push(`Unexpected opponent external request ${route.request().url()}`);
            return route.abort();
          }
          return route.continue();
        });
        let opponentLoginBonusShown = false;
        opponentPage.on('response', async (response) => {
          if (new URL(response.url()).pathname === '/flash/api/addLoginBonus' && response.ok()) {
            opponentLoginBonusShown = Number(field(parseXml(await response.text()), 'bonus')) > 0;
          }
        });
        await opponentPage.goto(`${origin}/flash/?version=${version}&language=${language}`);
        await opponentPage.waitForTimeout(6000);
        await opponentPage.mouse.click(590, 495);
        await opponentPage.waitForTimeout(500);
        await opponentPage.mouse.click(590, 495);
        await opponentPage.keyboard.type('Opponent', { delay: 80 });
        await opponentPage.mouse.click(550, 620);
        await opponentPage.waitForTimeout(1500);
        if (profile === '2010' && opponentLoginBonusShown) {
          await opponentPage.mouse.click(550, 526);
          await opponentPage.waitForTimeout(500);
        }
        await opponentPage.mouse.click(500, entranceModeY);
        await opponentPage.waitForTimeout(2500);
        await opponentPage.mouse.click(550, 450);
      } else {
        const opponent = flash.connect(() => {});
        if (lottery) {
          flash.accounts.drawLot('dogfield-local-opponent000000000000000000000000');
        }
        flash.receive(opponent, `<LOGIN><name>Opponent</name><language>${language === 'ja' ? 'JAPANESE' : 'ENGLISH'}</language><mode>DUEL</mode><version>${profile}</version><${profile === '2010' ? 'fcauth' : 'userID'}>dogfield-local-opponent000000000000000000000000</${profile === '2010' ? 'fcauth' : 'userID'}></LOGIN>`);
        flash.receive(opponent, '<ENTER/>');
      }
    } else {
      await page.mouse.click(170, spiritEntryY);
    }
  }
  await page.waitForTimeout(15000);
  const room = [...flash.rooms.values()][0];
  assert.ok(room?.battle, `The SWF must enter a battle. Frames: ${JSON.stringify(sentFrames)}; failures: ${JSON.stringify(failures)}`);
  assert.equal(room.battle.expected.name, 'FlashTester');
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-training.png`) });
  let slot = missingImages ? 7 : 0;
  if (randomHand) {
    // Initial cards retain DEAL order; sorting occurs after a completed inning.
    const hand = room.battle.player('FlashTester').items;
    slot = hand.findIndex(({ item }) => item.type === 'WEAPON' && item.attackKind === 'ATK'
      && !item.attackExtra && item.attribute !== 'DARK' && !item.hitRate);
    assert.ok(slot >= 0, 'The seeded random hand must contain a simple attack');
    weaponId = hand[slot].item.id;
    assert.equal(hand.length, profile === '2010' ? 8 : 10);
  }
  // Wait through slow rendering under concurrent browser test load. A broken
  // response queue still fails: no accepted command arrives within this bound.
  for (let attempt = 0; attempt < 15 && acceptedCommands.length === 0; attempt++) {
    await page.mouse.click(80 + 83 * slot, 580);
    await page.mouse.click(850, 300);
    await page.mouse.click(150, 490);
    await page.waitForTimeout(500);
    // Confirm the legitimate self-target warning if that shuffled row is ours.
    await page.mouse.click(475, 526);
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-submitted.png`) });
  assert.ok(sentFrames.some((frame) => /^\s*<COMMAND\b/.test(frame)),
    `The actual SWF must submit a legal attack. Frames: ${JSON.stringify(sentFrames)}; failures: ${JSON.stringify(failures)}`);
  const selectedCardAccepted = acceptedCommands.some((request) => {
    const selectedPiece = children(request, 'piece')[0];
    return selectedPiece && field(selectedPiece, 'item') === String(weaponId);
  });
  assert.ok(selectedCardAccepted, 'The server must accept the selected card through the real SWF command');
  const humanResponsePending = room.battle.pending?.commander === 'FlashTester';
  if (humanResponsePending) {
    assert.equal(room.battle.pending.commander, 'FlashTester');
    assert.equal(room.battle.pending.pieces[0].item.id, weaponId);
    // Resolve the bot response through the same authoritative command path.
    if (randomHand) {
      room.battle.submit(room.battle.pending.defender, parseXml('<COMMAND/>'));
      flash.flush(room);
    } else {
      if (mode === 'duel') {
        room.battle.submit(room.battle.pending.defender, parseXml('<COMMAND/>'));
        flash.flush(room);
      } else {
        flash.tick();
      }
    }
  }
  if (!randomHand && !broom && !megumi) {
    assert.ok(room.battle.players.some((player) => player.hp === 40 - itemAt(weaponId, profile).value));
  }
  await page.waitForTimeout(5000);
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-attack.png`) });
  if (broom || megumi || illusion) {
    const previousCommands = acceptedCommands.length;
    if (megumi) {
      room.battle.submit(room.battle.expected.name, parseXml(`<COMMAND target="FlashTester"><piece><item>${weaponId}</item></piece></COMMAND>`));
      flash.flush(room);
    } else {
      flash.tick();
    }
    assert.equal(room.battle.pending?.defender, 'FlashTester');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-defending.png`) });
    for (let attempt = 0; attempt < 10 && acceptedCommands.length === previousCommands; attempt++) {
      await page.mouse.click(610, 490);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(6500);
    assert.ok(acceptedCommands.length > previousCommands, `The SWF must keep processing commands after the item effect. Frames: ${JSON.stringify(sentFrames)}; errors: ${JSON.stringify(clientErrors)}; failures: ${JSON.stringify(failures)}`);
    assert.equal(room.battle.pending, undefined);
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-continued.png`) });
    if (illusion) {
      assert.ok(room.battle.player('FlashTester').harms.includes('ILLUSION'), 'The Spirit bot must inflict Illusion through a real command');
      assert.equal(room.battle.expected.name, 'FlashTester');
      const commandsBeforeIllusionTurn = acceptedCommands.length;
      for (let attempt = 0; attempt < 10 && acceptedCommands.length === commandsBeforeIllusionTurn; attempt++) {
        await page.mouse.click(80, 580);
        await page.mouse.click(850, 345);
        await page.mouse.click(150, 490);
        await page.waitForTimeout(1500);
      }
      assert.ok(acceptedCommands.length > commandsBeforeIllusionTurn,
        'The SWF must enable and submit the human attack after the bot inflicts Illusion');
      assert.equal(room.battle.pending?.commander, 'FlashTester');
      flash.tick();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-illusion-attack.png`) });
    }
  }
  if (mode !== 'training') {
    const account = flash.accounts.get([...room.participants.values()][0]);
    const coinReward = profile === '2013' && mode === 'duel';
    const balanceBefore = coinReward ? account.flash2013.coin : account.credits;
    room.battle.forfeit(room.players.find((player) => player.name !== 'FlashTester').name);
    flash.flush(room);
    const settledAccount = flash.accounts.get([...room.participants.values()][0]);
    const balanceAfter = coinReward ? settledAccount.flash2013.coin : settledAccount.credits;
    assert.ok(balanceAfter > balanceBefore);
    await page.waitForTimeout(14000);
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-finished.png`) });
    const completedSession = [...flash.sessions].find((session) => session.name === 'FlashTester');
    for (let attempt = 0; attempt < 20 && completedSession.room; attempt++) {
      await page.mouse.click(550, 526);
      await page.mouse.click(620, 810);
      await page.waitForTimeout(1500);
    }
    assert.ok(!completedSession.room,
      `The real SWF must exit the completed battle; client errors: ${JSON.stringify(clientErrors)}; failures: ${JSON.stringify(failures)}`);
    await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-returned.png`) });
    if (book) {
      const token = room.participants.get('FlashTester');
      assert.equal(flash.accounts.get(token).flash2013.book.score, 10, 'The Duel victory must credit two Magatama');
      await page.mouse.click(960, 810);
      await page.waitForTimeout(1500);
      const bookResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/flash/api/getBook');
      await page.mouse.click(550, 755);
      const bookResponse = await bookResponsePromise;
      assert.equal(field(parseXml(await bookResponse.text()), 'score'), '10');
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-book.png`) });
      const drawResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/flash/api/addBookElement');
      await page.mouse.click(620, 590);
      const drawResponse = await drawResponsePromise;
      assert.equal(drawResponse.status(), 200);
      const draw = parseXml(await drawResponse.text());
      assert.equal(field(draw, 'score'), '0');
      assert.equal(children(draw, 'element')[0].attributes.id, '9');
      await page.waitForTimeout(4000);
      await page.mouse.move(617, 458);
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-book-revealed.png`) });
      await page.mouse.click(620, 590);
      await page.waitForTimeout(500);
      assert.equal(bookDrawCount, 1, 'The original client must disable drawing below ten Magatama');
      assert.deepEqual(flash.accounts.get(token).flash2013.book, { score: 0, elements: [9] });
      await page.mouse.click(120, 500);
      await page.waitForTimeout(1000);
      await page.mouse.move(245, 690);
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-book-collection.png`) });
      await page.mouse.click(1030, 160);
      await page.mouse.click(550, 755);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-book-reopened.png`) });
      assert.equal(missingRequests.length, 1, 'Retired encyclopedia artwork must use the cached image fallback');
    } else if (mode === 'spirit') {
      const account = flash.accounts.get([...room.participants.values()][0]);
      assert.equal((profile === '2010' ? account.spirit : account.flash2013.spirit)[2].score, 2);
      await page.mouse.click(170, spiritEntryY);
    } else {
      if (profile === '2013') {
        await page.mouse.click(550, 775);
        await page.waitForTimeout(1000);
        await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-records.png`) });
        await page.mouse.click(1030, 170);
      }
      await page.mouse.click(550, 450);
    }
    await page.waitForTimeout(1000);
    if (!book) {
      const canEnterAgain = mode === 'spirit'
        ? [...flash.rooms.values()].some((current) => current !== room) : flash.duelQueue.size === 1;
      assert.ok(canEnterAgain, 'The returned lobby must permit another entry');
    }
  }
  if (megumi) {
    assert.ok(soundRequests.has('/flash/assets/sounds/megumi_san.mp3'));
    assert.ok(missingRequests.length <= 1, 'Missing Megumi-san artwork must use the cached fallback');
  }
  if (missingImages) {
    assert.deepEqual([...new Set(missingRequests)].sort(), [...missingPaths].sort());
    assert.equal(missingRequests.length, 2, 'Failed image URLs must be cached, including subsequent card displays');
  }
  if (missingSounds) {
    assert.equal(missingSoundRequests.length, 1, 'A failed sound must be requested once despite eight card-opening animations');
  }
  if (devil) {
    assert.ok(soundRequests.has('/flash/assets/sounds/devil.mp3'), 'The creature effect must finish through the native client response queue');
  }
  assert.equal(clientErrors.length, 0, clientErrors.join('\n'));
  assert.deepEqual(failures, []);
  console.log(`SWF ${version} login, ${mode}, legal attack, defense and rendering passed (${sentFrames.length} client frames, ${missingRequests.length} missing-art requests, ${missingSoundRequests.length} forced sound failures${randomHand ? `, random seed ${seed}` : ''}).`);
} finally {
  await browser.close();
  await server.close();
  FlashBattle.prototype.start = originalStart;
  FlashBattle.prototype.gift = originalGift;
}
