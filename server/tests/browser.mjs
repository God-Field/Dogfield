import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from '../http/server.ts';
import { Battle } from '../battle/battle.ts';
import { getItemDefinition } from '../engine.ts';
test('local client signs in and plays through HTTP snapshots', async () => {
  const { server, store } = await createServer({
    botInterval: 0,
  });
  await server.listen({
    port: 0,
    host: '127.0.0.1',
  });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'],
  });
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: {
        width: 1200,
        height: 850,
      },
    });
    await context.addInitScript(() => {
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) =>
        timeout(callback, Math.min(Number(delay) || 0, 20), ...args);
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        return animate.call(
          this,
          frames,
          typeof options === 'number'
            ? 10
            : {
                ...options,
                duration: 10,
                delay: 0,
              },
        );
      };
    });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', (entry) => errors.push(String(entry)));
    page.on('request', (request) => {
      if (
        !request.url().startsWith(base) &&
        !request.url().startsWith('data:')
      ) {
        external.push(request.url());
      }
    });
    const diagnostic = await build({
      entryPoints: ['server/tests/browser-entry.ts'],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
    });
    await page.route('**/main.dart.js', (route) =>
      route.fulfill({
        body: diagnostic.outputFiles[0].text,
        contentType: 'text/javascript',
      }),
    );
    await page.goto(base + '/?lang=en');
    await page.locator('input').fill('Local player');
    await page.locator('input').press('Enter');
    await page
      .getByText('Training', {
        exact: true,
      })
      .locator('xpath=ancestor::div[contains(@style,"cursor: pointer")][1]')
      .click();
    await page
      .getByText('Start Battle', {
        exact: true,
      })
      .locator('xpath=ancestor::div[contains(@style,"cursor: pointer")][1]')
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll('img[src*="/images/items/"]').length >= 9,
    );
    const path = [...store.docs.keys()].find((player) =>
      player.startsWith('modes/training/rooms/'),
    );
    assert.ok(path);
    let room = store.get(path);
    assert.equal(room.game.players.length, 2);
    await page.waitForFunction(
      () =>
        !window.localServerTest.getApplication().dialog?.gamePage
          ?.turnController?.isProcessing,
    );
    // Drive the battle through real HTTP while the real client subscribes.
    for (let index = 0; index < 8 && !room.game.isOver; index++) {
      const battle = new Battle(structuredClone(room.game));
      let choice = battle.botCommand();
      const pendingAttack = battle.attack;
      const actor = battle.requirePlayer(
        pendingAttack
          ? pendingAttack.buyingItemModelId
            ? pendingAttack.playerId
            : pendingAttack.targetPlayerId
          : room.game.attackTurnPlayerId,
      );
      if (!choice) {
        if (pendingAttack) {
          choice = {
            player: actor,
            command: pendingAttack.buyingItemModelId
              ? {
                  bought: false,
                }
              : {},
          };
        } else {
          const weapon = actor.items.find(
            (itemSlot) =>
              getItemDefinition(itemSlot.modelId)?.category.key === 'weapons',
          );
          choice = {
            player: actor,
            command: weapon
              ? {
                  itemIds: [weapon.id],
                  targetPlayerId: room.game.players.find(
                    (player) => player.id !== actor.id,
                  ).id,
                }
              : {},
          };
        }
      }
      if (choice.player.isBot) {
        const player = room.game.players.find(
          (candidatePlayer) => candidatePlayer.id === choice.player.id,
        );
        player.userId = 'browser-bot';
        const commandBattle = new Battle(room.game);
        commandBattle.submit('browser-bot', choice.command);
        delete player.userId;
        store.set(path, room);
      } else {
        const [response] = await Promise.all([
          page.waitForResponse((response) =>
            response.url().endsWith('/api/functions/submit-command'),
          ),
          page.evaluate(async (command) => {
            const page = window.localServerTest.getApplication().dialog.gamePage;
            const rules = page.commandRules;
            if (command.bought !== undefined) {
              await rules.submitCommand(command.bought);
              return;
            }
            for (const id of command.itemIds ?? []) {
              rules.selectExchangeItem(page.itemPanel.getItemAtSlot(id));
            }
            if (command.targetPlayerId !== undefined) {
              rules.resolveActiveTarget(
                page.playerRoster.requirePlayer(command.targetPlayerId),
              );
            }
            await window.localServerTest.submitItemActionCommand(rules)();
          }, choice.command),
        ]);
        assert.equal(response.status(), 200, await response.text());
      }
      room = store.get(path);
      await page.waitForFunction(
        (update) => {
          const page =
            window.localServerTest.getApplication().dialog?.gamePage;
          return (
            window.localServerTest.errors.length > 0 ||
            (page?.updateCount >= update &&
              !page.turnController?.isProcessing)
          );
        },
        room.game.updateCount,
      );
      assert.deepEqual(
        await page.evaluate(() => window.localServerTest.errors),
        [],
      );
    }
    await page.waitForFunction(
      () =>
        window.localServerTest.errors.length > 0 ||
        window.localServerTest.getApplication().dialog?.gamePage
          ?.tiebreakBadge?.currentCount >= 3,
    );
    const diagnosticState = await page.evaluate(() => ({
      errors: window.localServerTest.errors,
      gf: window.localServerTest.getApplication().dialog?.gamePage
        ?.tiebreakBadge?.currentCount,
      processing:
        window.localServerTest.getApplication().dialog?.gamePage
          ?.turnController?.isProcessing,
    }));
    assert.deepEqual(diagnosticState.errors, []);
    await page.waitForFunction(
      (expected) =>
        window.localServerTest.getApplication().dialog?.gamePage
          ?.tiebreakBadge?.currentCount === expected,
      room.game.gf,
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.localServerTest.getApplication().dialog.gamePage.tiebreakBadge
            .currentCount,
      ),
      room.game.gf,
    );
    assert.ok(room.game.updateCount > 3);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], 'All game assets should be served locally');
    await page.screenshot({
      path: '/tmp/godfield-local-battle.png',
    });
    console.log(
      'Local browser: sign-in, training lobby, battle snapshots and 8 HTTP turns passed.',
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
test('a second browser subscribes to Hidden Melee before joining, like the official client', async () => {
  const { server, store, rooms } = await createServer({
    botInterval: 0,
  });
  await server.listen({
    port: 0,
    host: '127.0.0.1',
  });
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'],
    });
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const owner = await browser.newContext({
      locale: 'en-US',
    });
    const visitor = await browser.newContext({
      locale: 'en-US',
    });
    const ownerPage = await owner.newPage();
    const visitorPage = await visitor.newPage();
    const errors = [];
    const visitorFlow = [];
    for (const page of [ownerPage, visitorPage]) {
      page.on('pageerror', (error) => errors.push(String(error)));
    }
    visitorPage.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === '/api/functions/join-room' ||
        url.pathname === '/api/watch'
      ) {
        visitorFlow.push(url.pathname);
      }
    });
    const click = async (page, text) =>
      page
        .getByText(text, {
          exact: true,
        })
        .locator('xpath=ancestor::div[contains(@style,"cursor: pointer")][1]')
        .click();
    async function openLobby(page, name) {
      await page.goto(base + '/?lang=en');
      await page.locator('input').fill(name);
      await page.locator('input').press('Enter');
      await click(page, 'Hidden Melee');
      await page.locator('input').fill('localjoin');
      const watch = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/watch' &&
          new URL(response.url()).searchParams
            .get('path')
            ?.match(/^modes\/private\/rooms\/[^/]+$/),
      );
      await page.locator('input').press('Enter');
      assert.equal((await watch).status(), 200);
    }
    await openLobby(ownerPage, 'Lobby owner');
    await openLobby(visitorPage, 'Lobby visitor');
    await visitorPage
      .getByText('Lobby owner', {
        exact: true,
      })
      .waitFor();
    await ownerPage
      .getByText('Lobby visitor', {
        exact: true,
      })
      .waitFor();
    const path = [...store.docs.keys()].find((path) =>
      /^modes\/private\/rooms\/[^/]+$/.test(path),
    );
    const room = store.get(path);
    assert.deepEqual(
      room.users.map((user) => user.name),
      ['Lobby owner', 'Lobby visitor'],
    );
    assert.ok(visitorFlow.indexOf('/api/functions/join-room') >= 0);
    assert.ok(
      visitorFlow.indexOf('/api/watch') <
        visitorFlow.indexOf('/api/functions/join-room'),
    );
    // Reconnecting an existing member must also work once the room is locked.
    rooms.invoke('set-room-locked', room.users[0].id, {
      mode: 'private',
      roomId: path.split('/')[3],
      isLocked: true,
    });
    visitorFlow.length = 0;
    await openLobby(visitorPage, 'Lobby visitor');
    assert.ok(!visitorFlow.includes('/api/functions/join-room'));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
