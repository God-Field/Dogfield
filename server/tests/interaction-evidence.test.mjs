import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../battle/battle.ts';
import { Random } from '../random.ts';
import { engine, getItemDefinition } from '../engine.ts';
import { selectDirectAttackTarget } from '../battle/targets.ts';

const createPlayer = (id, items = []) => ({
  id,
  userId: `u${id}`,
  name: `Player ${id}`,
  hp: 40,
  mp: 10,
  cp: 20,
  items: items.map((modelId, index) => ({
    id: index + 1,
    modelId,
  })),
});

const createGame = (players) => ({
  players,
  gf: 1,
  attackTurnPlayerId: 1,
  events: [],
  updateCount: 1,
});

const submitAttack = (battle, game, attackerUserId, itemIds, targetPlayerId) => {
  battle.submit(attackerUserId, {
    itemIds,
    targetPlayerId,
  });
  return game;
};

const attack = (attackerItems, defenderItems) => {
  const attacker = createPlayer(1, attackerItems);
  const defender = createPlayer(2, defenderItems);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new Random(3));
  submitAttack(battle, game, 'u1', attackerItems.map((unused, index) => index + 1), 2);
  return {attacker, defender, game, battle};
};

test('Rainbow Curtain followed by weapon or miracle response resolves', () => {
  const cases = [
    { attack: 59, response: 21, expected: 'bounce', name: 'Bouncing Sword' },
    { attack: 59, response: 38, expected: 'reflect', name: 'Reflection Sword' },
    { attack: 211, response: 234, expected: 'bounce', name: 'Turbulence' },
  ];
  for (const testCase of cases) {
    const attacker = createPlayer(1, [testCase.attack]);
    const defender = createPlayer(2, [189, testCase.response]);
    const game = createGame([attacker, defender]);
    const battle = new Battle(game, new Random(3));
    submitAttack(battle, game, 'u1', [1], 2);
    battle.submit('u2', { itemIds: [1, 2] });
    assert.ok(
      game.events.some((event) => event.action === testCase.expected),
      `${testCase.name} should produce ${testCase.expected}`,
    );
  }
});

test('all counter rings fire against a matching attack', () => {
  const cases = [
    [181, 60],
    [182, 59],
    [183, 69],
    [184, 61],
    [185, 59],
    [186, 6],
    [187, 6],
    [188, 6],
  ];
  for (const [ringModelId, attackModelId] of cases) {
    const attacker = createPlayer(1, [attackModelId]);
    const defender = createPlayer(2, [ringModelId]);
    const game = createGame([attacker, defender]);
    const battle = new Battle(game, new Random(3));
    submitAttack(battle, game, 'u1', [1], 2);
    battle.submit('u2', { itemIds: [1] });
    assert.ok(
      game.events.some((event) => event.action === 'counterAttack'),
      `ring ${ringModelId} should counter`,
    );
  }
});

test('cutCost cards make a miracle free without adding attack', () => {
  const cases = [46, 143, 163, 173, 204];
  for (const cutCostModelId of cases) {
    const attacker = createPlayer(1, [211, cutCostModelId]);
    const defender = createPlayer(2, [113]);
    const game = createGame([attacker, defender]);
    const battle = new Battle(game, new Random(3));
    battle.submit('u1', { itemIds: [1, 2], targetPlayerId: 2 });
    assert.equal(
      attacker.mp,
      10,
      `cutCost ${cutCostModelId} should not charge MP`,
    );
    battle.submit('u2', {});
    assert.equal(
      defender.hp,
      36,
      `cutCost ${cutCostModelId} should not add its attack`,
    );
  }
});

test('setElement and plus cards produce the logged damage', () => {
  const attacker = createPlayer(1, [23, 22, 210, 66]);
  const defender = createPlayer(2, [113]);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1, 2, 3, 4], targetPlayerId: 2 });
  battle.submit('u2', {});
  assert.equal(defender.hp, 25);
});

test('Dreaming Hat defense keeps a performed miracle through redraw', () => {
  const attacker = createPlayer(1, [6]);
  const defender = createPlayer(2, [178, 214, 6]);
  defender.items[1].used = true;
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new Random(3));
  submitAttack(battle, game, 'u1', [1], 2);
  battle.submit('u2', { itemIds: [1] });
  const performed = defender.items.find((item) => item.modelId === 214);
  assert.ok(performed);
  assert.equal(performed.used, true);
  assert.ok(
    game.events.some((event) => event.action === 'redraw'),
    'Dreaming Hat should redraw ordinary cards',
  );
  assert.equal(
    defender.items.filter((item) => !item.modelId).length,
    0,
    'the consumed Hat slot should be filled',
  );
});

test('Fog redirects an enemy-targeted artifact', () => {
  class FogTargetRandom extends Random {
    pick(label, values, weight) {
      if (label === 'fogTarget') {
        return values.find((value) => value.id === 3);
      }
      return super.pick(label, values, weight);
    }
  }
  const attacker = createPlayer(1, [13]);
  attacker.curses = ['fog'];
  const firstEnemy = createPlayer(2, [113]);
  const secondEnemy = createPlayer(3, [113]);
  const game = createGame([attacker, firstEnemy, secondEnemy]);
  const battle = new Battle(game, new FogTargetRandom(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  const setTargetPlayer = game.events.find(
    (event) => event.action === 'setTargetPlayer',
  );
  assert.equal(setTargetPlayer.playerId, 3);
});

test('selectDirectAttackTarget with Fog does not throw when no living enemies exist', () => {
  const attacker = createPlayer(1, [6]);
  attacker.curses = ['fog'];
  const deadEnemy = createPlayer(2);
  deadEnemy.dead = true;
  deadEnemy.hp = 0;
  const game = createGame([attacker, deadEnemy]);
  const battle = new Battle(game, new Random(3));
  const definition = getItemDefinition(6);
  assert.doesNotThrow(() => {
    const target = selectDirectAttackTarget(battle, attacker, definition, 2);
    assert.equal(target.id, 2);
  });
});

test('self-targeted attacks resolve against the attacker', () => {
  const attacker = createPlayer(1, [6]);
  const defender = createPlayer(2, [113]);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 1 });
  assert.equal(attacker.hp, 39);
});

test('attackSomebody overrides selected targets and Fog using all living players', () => {
  class SomebodyTargetRandom extends Random {
    pick(label, candidates) {
      assert.equal(label, 'defaultAttackTarget');
      assert.deepEqual(candidates.map((candidate) => candidate.id), [1, 2, 3]);
      return candidates.find((candidate) => candidate.id === this.targetId);
    }
  }
  const attacker = createPlayer(1);
  attacker.curses = ['fog'];
  const firstEnemy = createPlayer(2);
  const secondEnemy = createPlayer(3);
  const deadEnemy = createPlayer(4);
  deadEnemy.dead = true;
  deadEnemy.hp = 0;
  const game = createGame([attacker, firstEnemy, secondEnemy, deadEnemy]);
  const random = new SomebodyTargetRandom(3);
  const battle = new Battle(game, random);
  const definition = getItemDefinition(291);

  for (const randomTargetId of [1, 2, 3]) {
    random.targetId = randomTargetId;
    for (const requestedPlayerId of [undefined, 1, 2, 3]) {
      const target = selectDirectAttackTarget(
        battle, attacker, definition, requestedPlayerId,
      );
      assert.equal(target.id, randomTargetId);
    }
  }
});

test('native attack commands with an omitted target resolve against self', () => {
  for (const modelId of [6, 35, 59, 60, 211]) {
    for (const attackerId of [1, 3]) {
      const attacker = createPlayer(attackerId, [modelId]);
      const defender = createPlayer(2, [113]);
      const game = createGame([attacker, defender]);
      game.attackTurnPlayerId = attackerId;
      const explicitTargetGame = structuredClone(game);
      const explicitTargetBattle = new Battle(explicitTargetGame, new Random(3));
      explicitTargetBattle.submit(`u${attackerId}`, {
        itemIds: [1],
        targetPlayerId: attackerId,
      });
      const battle = new Battle(game, new Random(3));

      battle.submit(`u${attackerId}`, { itemIds: [1] });

      assert.ok(attacker.hp < 40);
      assert.equal(defender.hp, 40);
      assert.ok(game.events.some((event) =>
        event.action === 'setTargetPlayer' && event.playerId === attackerId,
      ));
      assert.equal(battle.attack, undefined);
      explicitTargetGame.updatedAt = game.updatedAt;
      assert.deepEqual(game, explicitTargetGame);
    }
  }
});

test('Apocalypse sacrifice works while Fogged', () => {
  const playerOne = createPlayer(1, [6, 113]);
  const playerTwo = createPlayer(2, [6]);
  const game = createGame([playerOne, playerTwo]);
  game.tiebreakGF = 1;
  playerOne.curses = ['fog'];
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [0, 2] });
  assert.ok(
    game.events.some((event) => event.action === 'sacrifice'),
    'Apocalypse virtual slot 0 should sacrifice',
  );
  assert.ok(
    game.events.some((event) => event.action === 'gift'),
    'sacrifice should gift replacements',
  );
  assert.notEqual(getItemDefinition(playerOne.items[0].modelId).ability, 'discard');
});

test('Apocalypse sacrifice works while Dreamed', () => {
  const playerOne = createPlayer(1, [6, 113]);
  const playerTwo = createPlayer(2, [6]);
  const game = createGame([playerOne, playerTwo]);
  game.tiebreakGF = 1;
  playerOne.curses = ['dream'];
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [0, 2] });
  assert.ok(
    game.events.some((event) => event.action === 'sacrifice'),
    'Dream does not block post-apocalypse sacrifice',
  );
  assert.ok(
    game.events.some((event) => event.action === 'gift'),
    'sacrifice still gifts replacements',
  );
});

test('Dangerous Mortar still absorbs a Pestle hit as 99 direct damage', () => {
  const pestleUser = createPlayer(1, [94, 74]);
  const mortarHolder = createPlayer(2, [209]);
  const game = createGame([pestleUser, mortarHolder]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1, 2] });
  const attractDanger = game.events.find(
    (event) => event.action === 'attractDanger',
  );
  assert.ok(attractDanger);
  assert.equal(attractDanger.playerId, 2);
  assert.equal(
    game.events.find((event) => event.action === 'dealDamage').damage,
    99,
  );
  assert.equal(mortarHolder.hp, 0);
});

test('high-evidence plus modifiers match their logged outcomes', () => {
  const auraAttacker = createPlayer(1, [6, 231]);
  const auraDefender = createPlayer(2, [113]);
  const auraGame = createGame([auraAttacker, auraDefender]);
  const auraBattle = new Battle(auraGame, new Random(3));
  auraBattle.submit('u1', { itemIds: [1, 2], targetPlayerId: 2 });
  auraBattle.submit('u2', {});
  assert.equal(auraDefender.hp, 38, 'Aura doubles the weapon damage');

  const mirageAttacker = createPlayer(1, [6, 232]);
  const mirageDefender = createPlayer(2, [113]);
  const mirageThird = createPlayer(3, [113]);
  const mirageGame = createGame([mirageAttacker, mirageDefender, mirageThird]);
  const mirageBattle = new Battle(mirageGame, new Random(3));
  mirageBattle.submit('u1', { itemIds: [1, 2], targetPlayerId: 2 });
  let mirageGuard = 0;
  while (mirageBattle.attack && mirageGuard++ < 8) {
    const actor = mirageBattle.findPlayer(mirageBattle.expectedCommandPlayerId);
    mirageBattle.submit(actor.userId, {});
  }
  assert.equal(mirageDefender.hp, 39);
  assert.equal(mirageThird.hp, 39);

  const stickAttacker = createPlayer(1, [58]);
  const stickDefender = createPlayer(2, [113]);
  const stickGame = createGame([stickAttacker, stickDefender]);
  const stickBattle = new Battle(stickGame, new Random(3));
  stickBattle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  assert.equal(stickAttacker.mp, 0, 'Magical Stick consumes all MP');
  stickBattle.submit('u2', {});
  assert.equal(stickDefender.hp, 20, 'Magical Stick deals 2x MP');
});

test('attack twice, absorb, same damage, and fixed responses match recorded expectations', () => {
  const sawAttacker = createPlayer(1, [14]);
  const sawDefender = createPlayer(2, [113]);
  const sawGame = createGame([sawAttacker, sawDefender]);
  const sawBattle = new Battle(sawGame, new Random(3));
  sawBattle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  let sawGuard = 0;
  while (sawBattle.attack && sawGuard++ < 6) {
    const actor = sawBattle.findPlayer(sawBattle.expectedCommandPlayerId);
    sawBattle.submit(actor.userId, {});
  }
  assert.equal(sawDefender.hp, 34, 'Saw Boom Boom attacks twice');

  const absorbAttacker = createPlayer(1, [27]);
  const absorbDefender = createPlayer(2, [113]);
  absorbDefender.hp = 10;
  const absorbGame = createGame([absorbAttacker, absorbDefender]);
  const absorbBattle = new Battle(absorbGame, new Random(3));
  absorbBattle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  absorbBattle.submit('u2', {});
  assert.equal(absorbAttacker.hp, 47, 'Ghost Sword absorbs its damage');

  const sameAttacker = createPlayer(1, [53]);
  const sameDefender = createPlayer(2, [113]);
  sameDefender.hp = 10;
  const sameGame = createGame([sameAttacker, sameDefender]);
  const sameBattle = new Battle(sameGame, new Random(3));
  sameBattle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  sameBattle.submit('u2', {});
  assert.equal(sameAttacker.hp, 26, 'Evil Broadsword takes the same damage');

  const wallAttacker = createPlayer(1, [6]);
  const wallDefender = createPlayer(2, [233]);
  const wallGame = createGame([wallAttacker, wallDefender]);
  const wallBattle = new Battle(wallGame, new Random(3));
  wallBattle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  wallBattle.submit('u2', { itemIds: [1] });
  assert.ok(wallGame.events.some((event) => event.action === 'block'));

  const mirrorAttacker = createPlayer(1, [211]);
  const mirrorDefender = createPlayer(2, [190]);
  const mirrorGame = createGame([mirrorAttacker, mirrorDefender]);
  const mirrorBattle = new Battle(mirrorGame, new Random(3));
  mirrorBattle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  mirrorBattle.submit('u2', { itemIds: [1] });
  assert.ok(mirrorGame.events.some((event) => event.action === 'reflect'));
  mirrorBattle.submit('u1', {});
  assert.equal(mirrorDefender.hp, 40, 'Super Mirror leaves the defender unharmed');
});

test('Sun Amulet and Dangerous Mortar cannot be discarded', () => {
  const discard = getItemDefinition(1);
  const context = {mode: 'normal', hasFlashCurse: false};
  const forbidden = [
    ['Sun Amulet', 208],
    ['Dangerous Mortar', 209],
  ];
  for (const [name, modelId] of forbidden) {
    assert.equal(
      engine.canApplyCommand([discard], getItemDefinition(modelId), context),
      false,
      `${name} must not be a valid discard target`,
    );
    assert.equal(
      engine.isDiscardOrSaleCommand([discard], getItemDefinition(modelId), context),
      false,
      `${name} must not be offered as a discard target`,
    );
  }
  const discardableSundry = getItemDefinition(193);
  assert.equal(
    engine.canApplyCommand([discard], discardableSundry, context),
    true,
    'ordinary sundries remain discardable',
  );
});

test('Rainbow Curtain combinations resolve their real response category', () => {
  const blockWeapon = attack([6], [189, 233]);
  blockWeapon.battle.submit('u2', {itemIds: [1, 2]});
  assert.ok(
    blockWeapon.game.events.some((event) => event.action === 'block'),
    'Rainbow + Wall blocks a non-element weapon',
  );

  const blockMiracle = attack([211], [189, 42]);
  blockMiracle.battle.submit('u2', {itemIds: [1, 2]});
  assert.ok(
    blockMiracle.game.events.some((event) => event.action === 'block'),
    'Rainbow + Angel Knife blocks a miracle',
  );

  const reflectMiracle = attack([211], [189, 156]);
  reflectMiracle.battle.submit('u2', {itemIds: [1, 2]});
  assert.ok(
    reflectMiracle.game.events.some((event) => event.action === 'reflect'),
    'Rainbow + Moonlight Helm reflects a miracle',
  );

  const bounceMiracle = attack([211], [189, 164]);
  bounceMiracle.battle.submit('u2', {itemIds: [1, 2]});
  assert.ok(
    bounceMiracle.game.events.some((event) => event.action === 'bounce'),
    'Rainbow + Sky Armor bounces a miracle',
  );

  const reflectAnything = attack([6], [189, 190]);
  reflectAnything.battle.submit('u2', {itemIds: [1, 2]});
  assert.ok(
    reflectAnything.game.events.some((event) => event.action === 'reflect'),
    'Rainbow + Super Mirror reflects a weapon',
  );
});

test('hand item placeholders remain contiguous at the tail when slots are filled', () => {
  const player = createPlayer(1, [6, 113]);
  player.items.push({ id: 0, modelId: 0 }, { id: 0, modelId: 0 });
  const game = createGame([player, createPlayer(2, [])]);
  const battle = new Battle(game, new Random(1));

  battle.addSlot(player, 16);
  assert.equal(player.items.length, 4);
  assert.equal(player.items[0].modelId, 6);
  assert.equal(player.items[1].modelId, 113);
  assert.equal(player.items[2].modelId, 16);
  assert.equal(
    player.items[3].modelId,
    0,
    'remaining placeholder stays at the tail',
  );
  assert.equal(player.items[3].id, 0);
});
