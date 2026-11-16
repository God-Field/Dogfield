import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';

/** @returns {Promise<typeof import("./engine-entry") & {context: any}>} */
async function headlessEngine() {
  const result = await build({
    entryPoints: ['tests/engine-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const context = vm.createContext({
    module: {exports: {}},
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
  });
  vm.runInContext(result.outputFiles[0].text, context, {timeout: 10000});
  return {context, ...context.module.exports};
}

const fixture = JSON.parse(fs.readFileSync('tests/fixtures/en.json', 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

/** @param {typeof import("./engine-entry")} engine */
function catalogFor(engine) {
  const catalog = new engine.ItemCatalog();
  engine.decodeItemModel(engine.decodeJson(fixture.items), catalog);
  return catalog;
}

test('the engine bundle runs without any DOM or browser globals', async () => {
  const engine = await headlessEngine();
  assert.equal(engine.context.document, undefined);
  assert.equal(engine.context.window, undefined);
  assert.equal(engine.context.navigator, undefined);
  const catalog = catalogFor(engine);
  assert.equal(catalog.length, fixture.items.length);
  assert.equal(catalog.totalGiftRate, fixture.items.reduce((sum, item) => sum + (item.giftRate ?? 0), 0));
});

test('the engine bundle has no UI, application, service, or room dependencies', async () => {
  const result = await build({
    entryPoints: ['tests/engine-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  const forbidden = /src\/(ui|app|services|rooms|battle|chat|reference|i18n)\//;
  for (const input of inputs) assert.doesNotMatch(input, forbidden, input);
  const source = result.outputFiles[0].text;
  assert.equal(source.includes('document'), false);
  assert.equal(source.includes('window'), false);
  assert.equal(source.includes('navigator'), false);
});

test('damage, cost, and element calculations are pure and catalog-driven', async () => {
  const engine = await headlessEngine();
  const catalog = catalogFor(engine);
  const fireball = catalog.findById(210);
  const ice = catalog.findById(211);
  const club = catalog.findById(6);
  const silverClub = catalog.findById(7);
  const cutCost = catalog.findById(46);
  const filter = catalog.findById(189);
  assert.ok(fireball && ice && club && silverClub && cutCost && filter);

  assert.equal(engine.calculateMpCost([fireball]), fireball.cost);
  assert.equal(engine.calculateMpCost([fireball, cutCost]), 0);
  assert.equal(engine.calculateAttackDamage([club, silverClub], 0), club.attack + silverClub.attack);
  assert.equal(engine.calculateAttackDamage([club, silverClub], 5), 5 + silverClub.attack);
  assert.equal(engine.getAttackElement([fireball, ice]), null);
  assert.equal(engine.getAttackElement([fireball, filter]), null);
  assert.equal(engine.getSharedElement([club]), club.element);
});

test('item command validation matches the client rules without UI objects', async () => {
  const engine = await headlessEngine();
  const catalog = catalogFor(engine);
  const discard = catalog.findById(1);
  const sell = catalog.findById(4);
  const weapon = catalog.findById(6);
  const plusWeapon = catalog.findById(9);
  const sundry = catalog.findById(191);
  const armor = catalog.findById(113);
  const fireball = catalog.findById(210);
  assert.ok(discard && sell && weapon && plusWeapon && sundry && armor && fireball);

  const normal = {mode: 'normal', hasFlashCurse: false};
  assert.equal(engine.canApplyCommand([], weapon, normal), true);
  assert.equal(engine.canApplyCommand([discard], weapon, normal), false);
  assert.equal(engine.canApplyCommand([discard], sundry, normal), true);
  assert.equal(engine.canApplyCommand([plusWeapon], plusWeapon, normal), true);
  assert.equal(engine.canApplyCommand([sell], plusWeapon, normal), true);
  assert.equal(engine.canApplyCommand([sell], plusWeapon, {...normal, candidateHasSelectionOverlay: true}), false);
  assert.equal(engine.getCommandDiscardMode(false, [weapon]), false);
  assert.equal(engine.getCommandDiscardMode(true, [fireball]), true);

  const defense = {
    mode: 'defense',
    hasFlashCurse: false,
    incomingAttack: {items: [weapon], hasAttackValue: true},
  };
  assert.equal(engine.canApplyCommand([], armor, defense), true);
  assert.equal(engine.canApplyCommand([weapon], armor, {...defense, hasFlashCurse: true}), false);

  assert.equal(engine.validateItemAction({models: [fireball], availableMp: 1, mode: 'normal', hasSpecialItemCommand: false}), 'miracles');
  assert.equal(engine.validateItemAction({models: [discard], availableMp: 99, mode: 'normal', hasSpecialItemCommand: false}), 'discard');
  assert.equal(engine.validateItemAction({models: [sell], availableMp: 99, mode: 'normal', hasSpecialItemCommand: false}), 'sell');
  assert.equal(engine.validateItemAction({models: [], availableMp: 99, mode: 'normal', hasSpecialItemCommand: true}), 'pray');
  assert.equal(engine.validateItemAction({models: [weapon], availableMp: 99, mode: 'normal', hasSpecialItemCommand: false}), null);
});

test('active miracle-response armor requires a leading defense position', async () => {
  const engine = await headlessEngine();
  const catalog = catalogFor(engine);
  const response = catalog.findById(167);
  const curtain = catalog.findById(189);
  const cases = [
    { attacks: [210], armor: 127 },
    { attacks: [211], armor: 138 },
    { attacks: [212], armor: 113 },
    { attacks: [210, 189], armor: 113 },
  ];

  for (const testCase of cases) {
    const attacks = testCase.attacks.map((modelId) => catalog.findById(modelId));
    const armor = catalog.findById(testCase.armor);
    const context = {
      mode: 'defense',
      hasFlashCurse: false,
      incomingAttack: {items: attacks, hasAttackValue: true},
    };

    assert.equal(engine.canApplyCommand([], response, context), true);
    assert.equal(engine.canApplyCommand([curtain], response, context), true);
    assert.equal(engine.canApplyCommand([armor], response, context), false);
    assert.equal(engine.canApplyCommand([curtain, armor], response, context), false);
  }
});

test('inactive miracle-response armor follows ordinary defense element rules', async () => {
  const engine = await headlessEngine();
  const catalog = catalogFor(engine);
  const response = catalog.findById(167);
  const waterArmor = catalog.findById(127);
  const curtain = catalog.findById(189);
  const fireWeapon = catalog.findById(59);
  const context = {
    mode: 'defense',
    hasFlashCurse: false,
    incomingAttack: {items: [fireWeapon], hasAttackValue: true},
  };

  assert.equal(engine.canApplyCommand([waterArmor], response, context), false);
  assert.equal(engine.canApplyCommand([curtain, waterArmor], response, context), true);
  assert.equal(engine.canApplyCommand([waterArmor], response, {
    ...context,
    incomingAttack: {items: [fireWeapon, curtain], hasAttackValue: true},
  }), true);
  assert.equal(engine.canApplyCommand([waterArmor], response, {
    ...context,
    incomingAttack: {items: [catalog.findById(6)], hasAttackValue: true},
  }), true);
});

test('defense reaction lookup skips non-responding items', async () => {
  const engine = await headlessEngine();
  const catalog = catalogFor(engine);
  const reflection = catalog.findById(167);
  const curtain = catalog.findById(189);

  assert.equal(engine.findDefenseResponse([], engine.CategoryMiracles, null), null);
  assert.equal(engine.findDefenseResponse([curtain], engine.CategoryMiracles, null), null);
  assert.equal(engine.findDefenseResponse([curtain, reflection], engine.CategoryMiracles, null), 'reflect');
  assert.equal(engine.findDefenseResponse([curtain, reflection], engine.CategoryWeapons, null), null);
});

test('recorded training-room state decodes and runs headlessly', async () => {
  const engine = await headlessEngine();
  const catalog = catalogFor(engine);
  const snapshots = JSON.parse(fs.readFileSync('tests/fixtures/training-room.json', 'utf8'));
  const room = engine.decodeLobbyState(engine.decodeJson(snapshots.at(-1).data));
  assert.ok(room.game);
  const battle = engine.BattleEngine.fromGameState(room.game, catalog);
  assert.equal(battle.state.gf, 2);
  assert.equal(battle.state.attackTurnPlayerId, 2);
  assert.equal(battle.players.length, 2);
  assert.equal(battle.currentTurnPlayer().name, 'RefactorTest');
  const slots = battle.currentTurnPlayer().items;
  assert.equal(slots.length, 9);
  assert.equal(slots.map(slot => slot.getItemModel(catalog)).length, 9);
  const plan = battle.planSelectedSlots([slots[0]], {availableMp: 10});
  assert.equal(plan.ok, true);
  assert.deepEqual([...plan.itemIds], [slots[0].id]);
});

test('stat arithmetic clamps at zero and the maximum and cascades downward', async () => {
  const engine = await headlessEngine();
  assert.deepEqual(plain(engine.changeHp(40, -100)), {hp: 0});
  assert.deepEqual(plain(engine.changeHp(90, 100)), {hp: 99});
  assert.deepEqual(plain(engine.changeMp(50, 2, -5)), {hp: 47, mp: 0});
  assert.deepEqual(plain(engine.changeMp(50, 10, 500)), {hp: 50, mp: 99});
  assert.deepEqual(plain(engine.changeCp(50, 2, 0, -5)), {hp: 47, mp: 0, cp: 0});
  assert.deepEqual(plain(engine.changeCp(50, 10, 4, -6)), {hp: 50, mp: 8, cp: 0});
  assert.deepEqual(plain(engine.changeCp(50, 10, 4, 500)), {hp: 50, mp: 10, cp: 99});
});

test('training stat transfers and enablement are pure engine rules', async () => {
  const engine = await headlessEngine();
  assert.deepEqual(plain(engine.transferStat(50, 10, 5)), {hp: 45, target: 15});
  assert.deepEqual(plain(engine.transferStat(2, 98, 10)), {hp: 1, target: 99});
  assert.deepEqual(plain(engine.transferStat(50, 10, -5)), {hp: 55, target: 5});
  assert.deepEqual(plain(engine.transferStat(99, 5, -5)), {hp: 99, target: 5});
  assert.equal(engine.isStatTransferEnabled(50, 10, 1), true);
  assert.equal(engine.isStatTransferEnabled(0, 10, 1), false);
  assert.equal(engine.isStatTransferEnabled(50, 99, 1), false);
  assert.equal(engine.isStatTransferEnabled(50, 10, -1), true);
  assert.equal(engine.isStatTransferEnabled(50, 0, -1), false);
  assert.equal(engine.isStatTransferEnabled(99, 10, -1), false);
});

test('status-effect grouping rules stay in the engine', async () => {
  const engine = await headlessEngine();
  assert.equal(engine.isVisibleStatusEffect(engine.CurseCold), true);
  assert.equal(engine.isVisibleStatusEffect(engine.CurseFever), true);
  assert.equal(engine.isVisibleStatusEffect(engine.CurseDream), false);
  assert.equal(engine.findVisibleStatusEffect([engine.CurseDream, engine.CurseFever]), engine.CurseFever);
  assert.equal(engine.findVisibleStatusEffect([engine.CurseDream]), null);
  assert.equal(engine.hasStatusEffect([engine.CurseDream], engine.CurseDream), true);
  assert.equal(engine.hasStatusEffect([engine.CurseDream], engine.CurseCold), false);
});

test('the headless engine plans commands from decoded game state and item slots', async () => {
  const engine = await headlessEngine();
  const catalog = catalogFor(engine);
  const fireball = catalog.findById(210);
  const weapon = catalog.findById(6);
  assert.ok(fireball && weapon);

  const game = engine.decodeGameState(engine.decodeJson({
    gf: 3,
    tiebreakGF: null,
    attackTurnPlayerId: 1,
    isOver: false,
    updateCount: 1,
    attacks: [],
    events: [],
    players: [
      {id: 1, name: 'Alice', team: 0, hp: 100, mp: 30, cp: 5, items: [{id: 0, modelId: weapon.id, fakeModelId: 0, used: false}]},
      {id: 2, name: 'Bob', team: 0, hp: 90, mp: 20, cp: 0, items: []},
    ],
  }));
  const battle = engine.BattleEngine.fromGameState(game, catalog);
  assert.equal(battle.players.length, 2);
  assert.equal(battle.playerById(2).name, 'Bob');
  assert.equal(battle.currentTurnPlayer().name, 'Alice');
  assert.equal(battle.state.gf, 3);
  assert.equal(battle.isOver, false);

  const slot = new engine.ItemSlot(4, fireball.id, 0, false);
  const insufficient = battle.planSelectedSlots([slot], {availableMp: 1});
  assert.deepEqual(JSON.parse(JSON.stringify(insufficient)), {ok: false, alert: 'miracles'});

  const planned = battle.planSelectedSlots([slot], {availableMp: 30});
  assert.equal(planned.ok, true);
  assert.deepEqual([...planned.itemIds], [4]);
  assert.equal(planned.mpCost, fireball.cost);
  assert.equal(planned.commandType, fireball.ability);

  const payload = engine.createCommandPayload({itemIds: [4], mp: 10, cp: 2, targetPlayerId: 2});
  assert.deepEqual([...payload.keys()], ['itemIds', 'mp', 'cp', 'targetPlayerId']);
  assert.deepEqual([...payload.get('itemIds')], [4]);

  const summary = battle.summarizeAttack([weapon, fireball], 0);
  assert.equal(summary.damage, weapon.attack + fireball.attack);
  assert.equal(summary.mpCost, fireball.cost);
});
