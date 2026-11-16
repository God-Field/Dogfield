import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../server/http/server.ts';
import { field, parseXml } from '../../server/flash/xml.ts';

// Exercise the actual SWF: a protocol-only test cannot detect a discarded ERROR.
const repository = fileURLToPath(new URL('../..', import.meta.url));
const version = process.argv.find((argument) => argument.startsWith('--version='))?.slice(10) ?? '2013';
assert.ok(['2013', '201005', '201008'].includes(version));
const legacy = version !== '2013';
const sequence = process.argv.find((argument) => argument.startsWith('--sequence='))?.slice(11) ?? 'server';
assert.ok(['server', 'error-only', 'delayed-error', 'error-enter', 'enter-error', 'enter-delayed-error'].includes(sequence));
const capture = `${version}-duplicate-login-${sequence}`;
const { server, flash } = await createServer({ botInterval: 0 });
const owner = flash.connect(() => {});
flash.receive(owner, `<LOGIN><name>FlashTester</name><language>ENGLISH</language><mode>FREE_FIGHT</mode>${legacy ? '<version>2010</version>' : ''}</LOGIN>`);
const failures = [];
const loginRequests = [];
const originalReceive = flash.receive.bind(flash);
flash.receive = (session, source) => {
  const request = parseXml(source);
  if (request.name === 'LOGIN') {
    loginRequests.push(request);
  }
  if (request.name === 'ERROR') {
    failures.push(source);
  }
  if (sequence !== 'server' && request.name === 'LOGIN' && loginRequests.length === 1) {
    const send = session.send;
    session.send = (xml) => {
      if (parseXml(xml).name === 'ENTER') {
        return;
      }
      if (xml.includes('<message>userExists</message>')) {
        const enter = '<ENTER><lobby/></ENTER>';
        if (sequence === 'enter-error' || sequence === 'enter-delayed-error') {
          send(enter);
        }
        if (sequence === 'delayed-error' || sequence === 'enter-delayed-error') {
          setTimeout(() => send(xml), 250);
        } else {
          send(xml);
        }
        if (sequence === 'error-enter') {
          send(enter);
        }
        return;
      }
      send(xml);
    };
  }
  return originalReceive(session, source);
};
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
  let loginBonusShown = false;
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/flash/api/addLoginBonus' && response.ok()) {
      loginBonusShown = Number(field(parseXml(await response.text()), 'bonus')) > 0;
    }
  });
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (/Error #|Error running AVM2|Error dispatching event/.test(message.text())) {
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

  await page.goto(`${origin}/flash/?version=${version}&language=en`);
  await page.waitForTimeout(6000);
  await page.mouse.click(590, 495);
  await page.waitForTimeout(500);
  await page.mouse.click(590, 495);
  await page.keyboard.type('FlashTester', { delay: 50 });
  await page.mouse.click(550, 620);
  await page.waitForTimeout(1500);
  if (legacy && loginBonusShown) {
    await page.mouse.click(550, 526);
    await page.waitForTimeout(500);
  }
  await mkdir(resolve(repository, 'artifacts/flash'), { recursive: true });
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${version}-duplicate-login-entrance.png`) });
  let alertRequested = false;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/flash/assets/sounds/alert.mp3') {
      alertRequested = true;
    }
  });
  await page.mouse.click(500, legacy ? 400 : 280);
  await page.waitForTimeout(1500);
  assert.equal(loginRequests.length, 1);
  assert.equal(field(loginRequests[0], 'mode'), 'FREE_FIGHT');
  assert.deepEqual([...flash.sessions], [owner], 'The rejected tab must not replace the original session');
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-response.png`) });
  if (alertRequested) {
    await page.mouse.click(550, 526);
  }
  // An initialized Free Fight lobby has a Back button here. A frozen entrance does not.
  await page.mouse.click(960, 810);
  await page.waitForTimeout(500);
  flash.disconnect(owner);
  await page.mouse.click(500, legacy ? 400 : 280);
  await page.waitForTimeout(1500);
  const retrySucceeded = loginRequests.length === 2 && flash.sessions.size === 1;
  await page.screenshot({ path: resolve(repository, `artifacts/flash/${capture}-retry.png`) });
  assert.deepEqual(failures, []);
  const expectFrozen = sequence === 'error-only' || sequence === 'delayed-error';
  const expectAlert = !legacy && ['server', 'enter-error', 'enter-delayed-error'].includes(sequence);
  assert.equal(alertRequested, expectAlert, `Unexpected alert for ${sequence}`);
  assert.equal(retrySucceeded, !expectFrozen, `Unexpected recovery for ${sequence}`);
  console.log(JSON.stringify({ version, sequence, alert: alertRequested, retrySucceeded, clientErrors: failures.length }));
} finally {
  await browser.close();
  await server.close();
}
