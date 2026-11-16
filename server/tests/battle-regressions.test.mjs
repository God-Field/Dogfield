import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../battle/battle.ts';
import { Random } from '../random.ts';
import { getItemDefinition } from '../engine.ts';
import { HttpError } from '../errors.ts';

const createPlayer = (playerId, modelIds = []) => ({
  id: playerId,
  userId: `user-${playerId}`,
  name: `Player ${playerId}`,
  hp: 40,
  mp: 50,
  cp: 50,
  items: modelIds.map((modelId, itemIndex) => ({
    id: itemIndex + 1,
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

class FixtureRandom extends Random {
  chance(label) {
    return label === 'hit';
  }

  pick(label, candidates) {
    if (label === 'reviveItem' || label === 'dangerHolder') {
      return candidates.at(-1);
    }
    if (label.startsWith('giftModel')) {
      return candidates.find((definition) => definition.id === 6);
    }
    return candidates[0];
  }
}

class PhenomenonRandom extends FixtureRandom {
  constructor(seed, phenomenonId) {
    super(seed);
    this.phenomenonId = phenomenonId;
  }

  pick(label, candidates, weight) {
    if (label === 'phenomenon') {
      return candidates.find(
        (definition) => definition.id === this.phenomenonId,
      );
    }
    if (label === 'defaultAttackTarget') {
      return candidates.find((candidate) => candidate.id === 2) ?? candidates[0];
    }
    return super.pick(label, candidates, weight);
  }
}

test('internal player submissions use the same attack and defense lifecycle as account submissions', () => {
  const accountGame = createGame([createPlayer(1, [6]), createPlayer(2)]);
  const internalGame = structuredClone(accountGame);
  for (const player of internalGame.players) {
    delete player.userId;
  }
  const accountBattle = new Battle(accountGame, new FixtureRandom(1));
  const internalBattle = new Battle(internalGame, new FixtureRandom(1));
  for (const [playerId, command] of [
    [1, { itemIds: [1], targetPlayerId: 2 }],
    [2, {}],
  ]) {
    accountBattle.submit(`user-${playerId}`, command);
    assert.equal(internalBattle.submitPlayerCommand(playerId, command), internalGame);
    const expected = structuredClone(accountGame);
    for (const player of expected.players) {
      delete player.userId;
    }
    expected.updatedAt = internalGame.updatedAt;
    assert.deepEqual(internalGame, expected);
  }
  assert.equal(internalGame.updateCount, 3);
});

test('account authorization and internal player submissions reject invalid callers and commands', () => {
  const player = createPlayer(1, [6]);
  delete player.userId;
  const game = createGame([player, createPlayer(2)]);
  const battle = new Battle(game, new FixtureRandom(1));
  const invalidOperations = [
    () => battle.submit(undefined, {}),
    () => battle.submit('bot:1', {}),
    () => battle.submit('user-2', {}),
    () => battle.submitPlayerCommand(2, {}),
    () => battle.submitPlayerCommand(99, {}),
    () => battle.submitPlayerCommand(1, null),
    () => battle.submitPlayerCommand(1, []),
    () => battle.submitPlayerCommand(1, 'attack'),
    () => battle.submitPlayerCommand(1, { itemIds: [999] }),
  ];
  for (const operation of invalidOperations) {
    assert.throws(operation, (error) => error instanceof HttpError && error.status === 400);
    assert.equal(Object.hasOwn(player, 'userId'), false);
    assert.equal(game.updateCount, 1);
  }
  player.dead = true;
  assert.throws(() => battle.submitPlayerCommand(1, {}), HttpError);
  delete player.dead;
  game.isOver = true;
  assert.throws(() => battle.submitPlayerCommand(1, {}), HttpError);
});

// Official: r35-round20-soap-3/game-1, u248. Exactly one of two amulets
// activates, then the owner receives a replacement during the turn's gifts.
test('revival consumes one selected amulet and refills its slot', () => {
  const attacker = createPlayer(1, [52]);
  const defender = createPlayer(2, [208, 208]);
  defender.hp = 1;
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });
  battle.submit(defender.userId, {});

  assert.equal(defender.hp, 10);
  assert.equal(defender.items.length, 2);
  assert.equal(defender.items.filter((item) => item.modelId === 208).length, 1);
  const revivals = game.events.filter((event) => event.action === 'revive');
  assert.equal(revivals.length, 1);
  assert.equal(revivals[0].item.id, 2);
  assert.equal(game.events.filter(
    (event) => event.action === 'gift' && event.playerId === defender.id,
  ).length, 1);
});

// Official: r34-multi-plus/game-0, u84. The replacement stays empty while
// another queued attack awaits defense.
test('revival leaves a placeholder until queued attacks finish', () => {
  const defender = createPlayer(2, [208]);
  defender.hp = 1;
  const game = createGame([createPlayer(1), defender, createPlayer(3)]);
  game.attacks = [
    { playerId: 1, targetPlayerId: 2, itemModelIds: [52] },
    { playerId: 3, targetPlayerId: 1, itemModelIds: [6] },
  ];
  new Battle(game, new FixtureRandom()).submit(defender.userId, {});
  assert.deepEqual(defender.items, [{ id: 0, modelId: 0 }]);
  assert.equal(game.events.some((event) => event.action === 'gift'), false);
  assert.equal(game.attacks[0].playerId, 3);
});

// Official: r34-postapoc-revive/game-0, u70 (Apocalypse), and duel-2, u24.
test('only Apocalypse resolves replacement gifts after a winning attack', () => {
  for (const apocalypse of [false, true]) {
    const attacker = createPlayer(1, [52]);
    const defender = createPlayer(2);
    defender.hp = 1;
    const game = createGame([attacker, defender]);
    if (apocalypse) {
      game.tiebreakGF = 1;
    }
    const battle = new Battle(game, new FixtureRandom());
    battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });
    battle.submit(defender.userId, {});
    assert.deepEqual(game.events.map((event) => event.action), [
      'useDefenseItems', 'dealDamage', 'die',
      ...(apocalypse ? ['gift'] : []), 'endGame',
    ]);
    assert.equal(attacker.items[0].modelId, apocalypse ? 6 : 0);
    assert.equal(game.isOver, true);
  }
});

// Official: r36-round10-moon-reflect/game-1, u86.
test('a winning guardian refills survivors even after the turn player dies', () => {
  const turnPlayer = createPlayer(1);
  turnPlayer.hp = 1;
  const guardianOwner = createPlayer(2);
  guardianOwner.guardian = 'saturn';
  guardianOwner.items = [{ id: 0, modelId: 0 }];
  const game = createGame([turnPlayer, guardianOwner]);
  game.tiebreakGF = 1;
  game.attacks = [{
    playerId: 2, targetPlayerId: 1, guardian: 'saturn', itemModelIds: [263],
  }];
  new Battle(game, new FixtureRandom()).submit(turnPlayer.userId, {});
  assert.deepEqual(game.events.map((event) => event.action), [
    'useDefenseItems', 'dealDamage', 'die', 'gift', 'endGame',
  ]);
  assert.equal(game.events[3].playerId, guardianOwner.id);
});

// Official: dream-run-20261106-021703-8pxt-g168, u9.
test('resuming a guardian defense does not repeat disease or previous guardians', () => {
  const turnPlayer = createPlayer(1);
  turnPlayer.curses = ['cold'];
  const guardianOwner = createPlayer(2);
  guardianOwner.guardian = 'mars';
  const defender = createPlayer(3);
  const game = createGame([turnPlayer, guardianOwner, defender]);
  game.guardianPlayerIds = [];
  game.attacks = [{
    playerId: 2, targetPlayerId: 3, guardian: 'mars', itemModelIds: [245],
  }];
  new Battle(game, new FixtureRandom()).submit(defender.userId, {});
  assert.deepEqual(game.events.map((event) => event.action), [
    'useDefenseItems', 'dealDamage', 'advanceGF',
  ]);
  assert.equal(turnPlayer.hp, 40);
});

// Official: r35-round24-rainbow-reflectmiracle/game-3, u79.
test('a direct duplicate curse reports safe without stacking it', () => {
  const attacker = createPlayer(1, [221]);
  const defender = createPlayer(2);
  defender.curses = ['fog'];
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });
  battle.submit(defender.userId, {});
  assert.equal(game.events[1].action, 'safe');
  assert.deepEqual(defender.curses, ['fog']);
});

// Official: r35-round19-typed-dark/game-3, u134.
test('disease ticks before a queued death retaliation', () => {
  const attacker = createPlayer(1);
  attacker.curses = ['hell'];
  attacker.hp = 12;
  const defender = createPlayer(2, [112]);
  defender.hp = 1;
  const game = createGame([attacker, defender]);
  game.diseasePlayerId = attacker.id;
  game.attacks = [{ playerId: 1, targetPlayerId: 2, itemModelIds: [42] }];
  new Battle(game, new FixtureRandom()).submit(defender.userId, {});
  const actions = game.events.map((event) => event.action);
  assert.ok(actions.indexOf('disease') < actions.indexOf('attackDyingly'));
  assert.equal(attacker.hp, 7);
  assert.equal(game.attacks[0].playerId, defender.id);
});

// Official: r35-round28-typed-dark/game-1, u104.
test('a double attack resolves the second hit after the target dies', () => {
  const attacker = createPlayer(1, [14]);
  const defender = createPlayer(2);
  defender.hp = 1;
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });
  battle.submit(defender.userId, {});
  assert.deepEqual(game.events.map((event) => event.action), [
    'useDefenseItems', 'dealDamage', 'die', 'nextAttack',
    'setTargetPlayer', 'dealDamage', 'endGame',
  ]);
});

// Official: r36-round25-typed-water/game-1, u117.
test('Evil Broadsword resolves the target death before the attacker death', () => {
  const attacker = createPlayer(1, [53]);
  const defender = createPlayer(2);
  attacker.hp = 11;
  defender.hp = 10;
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });
  battle.submit(defender.userId, {});
  assert.deepEqual(game.events.filter(
    (event) => event.action === 'die',
  ).map((event) => event.playerId), [2, 1]);
});

// Official: r36-round20-dream-sell/game-1, u167.
test('a full-hand purchase fills the placeholder and preserves existing cards', () => {
  const buyer = createPlayer(1, [211, ...Array(16).fill(113)]);
  buyer.items[0].used = true;
  buyer.items.push({ id: 0, modelId: 0 });
  const seller = createPlayer(2);
  const game = createGame([buyer, seller]);
  game.attacks = [{
    playerId: 1,
    targetPlayerId: 2,
    itemModelIds: [5],
    buyingItemModelId: 166,
  }];
  const battle = new Battle(game, new FixtureRandom());
  const originalItems = structuredClone(buyer.items.slice(0, -1));
  battle.submit(buyer.userId, { bought: true });
  assert.deepEqual(buyer.items.slice(0, -1), originalItems);
  assert.equal(buyer.items.at(-1).modelId, 166);
  assert.equal(buyer.items.length, 18);
  assert.deepEqual(game.events.map((event) => event.action), [
    'setBought', 'advanceGF',
  ]);
  assert.equal(game.events[0].overflowItem, undefined);
});

// Official: gaps-r33-blockweapon/game-8, u205, and
// r35-round27-typed-water/game-0, u190: overflow is selected before disease,
// while the replacement is drawn only if the player survives the tick.
test('full-hand prayer handles disease before drawing a replacement', () => {
  for (const startingHp of [1, 10]) {
    const player = createPlayer(1, Array(18).fill(113));
    player.hp = startingHp;
    player.curses = ['cold'];
    const game = createGame([player, createPlayer(2)]);
    new Battle(game, new FixtureRandom()).submit(player.userId, {});
    const actions = game.events.map((event) => event.action);
    assert.deepEqual(actions.slice(0, 4), [
      'useAttackItems', 'pray', 'disease', 'dealDamage',
    ]);
    assert.equal(game.events[1].overflowItem.id, 1);
    if (startingHp === 1) {
      assert.deepEqual(actions.slice(4), ['die', 'endGame']);
      assert.equal(player.items.at(-1).modelId, 0);
    } else {
      assert.deepEqual(actions.slice(4), ['gift', 'advanceGF']);
      assert.equal(game.events[4].playerId, player.id);
      assert.equal(
        player.items.some((itemSlot) => itemSlot.modelId === 0),
        false,
        'the replacement gift fills the prayer overflow slot',
      );
      assert.equal(player.items.length, 18);
    }
  }
});

// Official: r35-round4-full-hand-buy/game-1, u177, and
// r36-round12-typed-dark/game-1, u147: prayer overflow may remove a used miracle.
test('prayer overflow can select a performed miracle', () => {
  const player = createPlayer(1, [211, ...Array(17).fill(113)]);
  player.items[0].used = true;
  const game = createGame([player, createPlayer(2)]);
  new Battle(game, new FixtureRandom()).submit(player.userId, {});
  assert.equal(game.events[1].action, 'pray');
  assert.equal(game.events[1].overflowItem.modelId, 211);
  assert.equal(game.events[1].overflowItem.used, true);
  assert.equal(player.items.some((item) => item.modelId === 211), false);
});

// Official: r36-round29-dream-sell/game-3, u250: a full-hand sale displaced
// the buyer's performed <Thunder> even though unused cards were present.
test('sale overflow includes performed miracles', () => {
  const seller = createPlayer(1, [4, 192]);
  const buyer = createPlayer(2, [227, ...Array(17).fill(113)]);
  buyer.items[0].used = true;
  const game = createGame([seller, buyer]);
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(seller.userId, {
    itemIds: [1, 2],
    targetPlayerId: buyer.id,
  });
  battle.submit(buyer.userId, {});
  const sellEvent = game.events.find((event) => event.action === 'sell');
  assert.equal(sellEvent.overflowItem.modelId, 227);
  assert.equal(sellEvent.overflowItem.used, true);
  assert.equal(buyer.items.some((item) => item.modelId === 227), false);
});

// Official: broom-long4/game-7, u110, u114, u122, u123, u138 and three other
// full-hand Earth Drop cases displaced an unused card while a performed
// miracle stayed in hand.
test('guardian add overflow keeps performed miracles', () => {
  const player = createPlayer(1, [211, ...Array(17).fill(113)]);
  player.items[0].used = true;
  const game = createGame([player, createPlayer(2)]);
  const slot = new Battle(game, new FixtureRandom()).addSlot(player, 146);
  assert.equal(slot.overflowItem.modelId, 113);
  assert.notEqual(slot.overflowItem.used, true);
  assert.equal(
    player.items.some((item) => item.modelId === 211 && item.used),
    true,
  );
});

// Official states never contain a used item with a fake model: using a
// dreamed miracle reveals the real card and keeps it undreamed afterward.
test('performing a dreamed miracle removes its disguise', () => {
  const player = createPlayer(1, [214]);
  player.items[0].fakeModelId = 215;
  const game = createGame([player, createPlayer(2)]);
  new Battle(game, new FixtureRandom()).submit(player.userId, {
    itemIds: [1],
    targetPlayerId: 2,
  });
  const performed = player.items.find((item) => item.modelId === 214);
  assert.equal(performed.used, true);
  assert.equal(performed.fakeModelId, undefined);
});

// Official: r35-round26-fog-sacrifice/game-1, u35, selects player 5 while
// player 4 also has a Mortar. r36-round11-fog-discard/game-2, u11, selects 4.
test('Dangerous Pestle selects one of multiple Mortar holders', () => {
  const attacker = createPlayer(1, [94]);
  const firstHolder = createPlayer(2, [209]);
  const secondHolder = createPlayer(3, [209]);
  const game = createGame([attacker, firstHolder, secondHolder]);
  new Battle(game, new FixtureRandom()).submit(attacker.userId, { itemIds: [1] });
  assert.equal(firstHolder.hp, 40);
  assert.equal(firstHolder.items[0].modelId, 209);
  assert.equal(secondHolder.dead, true);
  const attractions = game.events.filter(
    (event) => event.action === 'attractDanger',
  );
  assert.equal(attractions.length, 1);
  assert.equal(attractions[0].playerId, secondHolder.id);
});

// Official: r36-round9-full-hand-buy/game-1, u86, a real Smile Shell
// displayed as Nocturnal Broom uses its self effect without target events.
test('a dreamed self-effect ignores the redundant self target', () => {
  const player = createPlayer(1, [199]);
  player.items[0].fakeModelId = 205;
  player.curses = ['dream', 'flash'];
  const game = createGame([player, createPlayer(2)]);
  new Battle(game, new FixtureRandom()).submit(player.userId, {
    itemIds: [1], targetPlayerId: player.id,
  });
  assert.deepEqual(game.events.map((event) => event.action), [
    'useAttackItems', 'removeCurses', 'gift', 'advanceGF',
  ]);
  assert.deepEqual(player.curses, ['dream']);
});

// Official: r35-round30-multi-plus/game-3, u49-50, and
// r36-round17-rainbow-reflectmiracle/game-1, u116.
test('a bounced Evil Broadsword belongs to the player who bounced it', () => {
  for (const bounceToSelf of [false, true]) {
    class BounceRandom extends FixtureRandom {
      pick(label, candidates) {
        if (label === 'bounceTarget') {
          return candidates[bounceToSelf ? 1 : 0];
        }
        return super.pick(label, candidates);
      }
    }
    const attacker = createPlayer(1, [53]);
    const defender = createPlayer(2, [21]);
    const game = createGame([attacker, defender]);
    const battle = new Battle(game, new BounceRandom());
    battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });
    battle.submit(defender.userId, { itemIds: [1] });
    if (!bounceToSelf) {
      assert.equal(game.attacks[0].playerId, defender.id);
      assert.equal(game.attacks[0].reversed, true);
      battle.submit(attacker.userId, {});
    }
    assert.equal(attacker.hp, bounceToSelf ? 40 : 26);
    assert.equal(defender.hp, bounceToSelf ? 12 : 26);
    const damageEvents = game.events.filter(
      (event) => event.action === 'dealDamage',
    );
    assert.equal(damageEvents.length, 2);
    assert.equal(damageEvents[1].playerId, defender.id);
    assert.equal(
      game.events.filter((event) => event.action === 'gift').length,
      2,
      'the sword and bounce cards both receive replacement gifts',
    );
    assert.equal(
      game.players.some((player) =>
        player.items.some((itemSlot) => itemSlot.modelId === 0),
      ),
      false,
      'both used slots are filled after the attack resolves',
    );
  }
});

test('reflected Evil Broadsword damage refills the sword and mirror slots', () => {
  const attacker = createPlayer(1, [53]);
  const defender = createPlayer(2, [190]);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new FixtureRandom());

  battle.submit(attacker.userId, {itemIds: [1], targetPlayerId: defender.id});
  battle.submit(defender.userId, {itemIds: [1]});
  assert.ok(game.events.some((event) => event.action === 'reflect'));
  battle.submit(attacker.userId, {});

  assert.equal(attacker.hp, 26, 'the reflected sword deals the same damage');
  assert.equal(defender.hp, 26, 'the mirror holder takes the sword damage too');
  assert.equal(
    game.events.filter((event) => event.action === 'gift').length,
    2,
    'the sword and mirror slots both receive gifts',
  );
  assert.equal(
    game.players.some((player) =>
      player.items.some((itemSlot) => itemSlot.modelId === 0),
    ),
    false,
    'both used slots are filled after the reflected attack',
  );
});

// Official: melee-danger-batch1/game-2, u62 and u65. A player in Hell
// becomes Fever; a later Afterglow leaves Fever at the same level.
test('Afterglow sets Fever rather than upgrading an existing disease', () => {
  const turnPlayer = createPlayer(1);
  const target = createPlayer(2);
  const game = createGame([turnPlayer, target, createPlayer(3)]);
  const battle = new Battle(game, new FixtureRandom());
  for (const disease of ['cold', 'fever', 'hell', 'heaven']) {
    target.curses = ['dream', disease];
    game.events = [];
    battle.applyItemEffect(turnPlayer, turnPlayer, getItemDefinition(287));
    assert.deepEqual(target.curses, ['dream', 'fever']);
    assert.deepEqual(game.events, [{ action: 'setCurseOfEverybody', curse: 'fever' }]);
  }
});

// Official logs resolve String of Fate immediately in the same update as its
// useAttackItems event. There is no intervening target selection or defense
// prompt for a lone [207] attack.
test('String of Fate resolves a non-damaging phenomenon immediately', () => {
  const attacker = createPlayer(1, [207]);
  const defender = createPlayer(2, [113]);
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new PhenomenonRandom(1, 287));
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });

  assert.equal(game.attacks, undefined);
  assert.ok(
    game.events.some((event) => event.action === 'phenomenon'),
  );
  const curseEvent = game.events.find(
    (event) => event.action === 'setCurseOfEverybody',
  );
  assert.ok(curseEvent);
  assert.equal(curseEvent.curse, 'fever');
  assert.ok(defender.curses?.includes('fever'));
  assert.notEqual(game.attackTurnPlayerId, attacker.id);
});

// An attacking phenomenon is queued immediately; the resulting [207, 292]
// attacks then take the ordinary defense path.
test('String of Fate queues an attacking phenomenon before defense', () => {
  const attacker = createPlayer(1, [207]);
  const secondPlayer = createPlayer(2, [113]);
  secondPlayer.isBot = true;
  const thirdPlayer = createPlayer(3, [113]);
  const game = createGame([attacker, secondPlayer, thirdPlayer]);
  const battle = new Battle(game, new PhenomenonRandom(1, 292));
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });

  assert.ok(
    game.events.some((event) => event.action === 'phenomenon'),
  );
  assert.equal(game.attacks.length, 2);
  for (const queuedAttack of game.attacks) {
    assert.deepEqual(queuedAttack.itemModelIds, [207, 292]);
  }

  const choice = battle.botCommand();
  assert.ok(choice);
  assert.doesNotThrow(() => {
    battle.submit(choice.player.userId, choice.command);
  });
});

test('String of Fate attacking phenomenon accepts a human defense', () => {
  const attacker = createPlayer(1, [207]);
  const defender = createPlayer(2, [113]);
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new PhenomenonRandom(1, 292));
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });

  assert.doesNotThrow(() => {
    battle.submit(defender.userId, {});
  });
});

// Black Hole must queue one attack per living enemy and resolve each target
// exactly once, with no skipped first attack.
test('Black Hole resolves one queued attack per living enemy exactly once', () => {
  const attacker = createPlayer(1, [207]);
  const secondPlayer = createPlayer(2, [113]);
  const thirdPlayer = createPlayer(3, [113]);
  const game = createGame([attacker, secondPlayer, thirdPlayer]);
  const battle = new Battle(game, new PhenomenonRandom(1, 292));
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });

  const queuedAttacks = game.attacks.map((attack) => ({ ...attack }));
  assert.equal(queuedAttacks.length, 2);
  assert.deepEqual(
    queuedAttacks.map((attack) => attack.targetPlayerId).sort(),
    [2, 3],
  );
  for (const queuedAttack of queuedAttacks) {
    assert.deepEqual(queuedAttack.itemModelIds, [207, 292]);
  }

  const damagedPlayerIds = [];
  for (const queuedAttack of queuedAttacks) {
    const target = battle.requirePlayer(game.attacks[0].targetPlayerId);
    battle.submit(target.userId, {});
    const damageEvents = game.events.filter(
      (event) => event.action === 'dealDamage',
    );
    assert.equal(damageEvents.length, 1);
    assert.equal(damageEvents[0].damage, 30);
    assert.equal(target.hp, 0);
    damagedPlayerIds.push(target.id);
  }

  assert.deepEqual(damagedPlayerIds.sort(), [2, 3]);
  assert.equal(game.attacks, undefined);
});

test('String of Fate phenomenon defense uses the resolved attack type', () => {
  const attacker = createPlayer(1, [207]);
  const defender = createPlayer(2, [175]);
  defender.hp = 99;
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new PhenomenonRandom(1, 291));
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });

  assert.deepEqual(game.attacks[0].itemModelIds, [207, 291]);
  assert.throws(
    () => battle.submit(defender.userId, { itemIds: [1] }),
    (error) => error?.status === 400,
    'light phenomena attacks must reject ordinary armor defense',
  );
  assert.doesNotThrow(() => {
    battle.submit(defender.userId, {});
  });
  assert.equal(defender.hp, 49);
});

test('String of Fate phenomenon bot defense does not choose mismatched armor', () => {
  const attacker = createPlayer(1, [207]);
  const defender = createPlayer(2, [175]);
  defender.isBot = true;
  defender.hp = 99;
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new PhenomenonRandom(1, 291));
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });

  const choice = battle.botCommand();
  assert.deepEqual(choice.command, {});
  assert.doesNotThrow(() => {
    battle.submit(choice.player.userId, choice.command);
  });
});

test('Gigantic Tub resolves its queued attack once and advances the turn', () => {
  const attacker = createPlayer(1, [207]);
  const defender = createPlayer(2, [113]);
  defender.hp = 99;
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new PhenomenonRandom(1, 291));
  battle.submit(attacker.userId, { itemIds: [1], targetPlayerId: 2 });

  assert.deepEqual(game.attacks[0].itemModelIds, [207, 291]);
  battle.submit(defender.userId, {});
  assert.equal(defender.hp, 49);
  assert.equal(game.attacks, undefined);
  assert.notEqual(game.attackTurnPlayerId, attacker.id);
});

// Official Exchange preserves the stat total and keeps every stat within
// 0..99. HP may be zero.
test('Earth Exchange preserves every valid stat total without exceeding caps', () => {
  for (let totalStats = 0; totalStats <= 297; totalStats++) {
    for (const randomFraction of [0, 0.5, 0.999999]) {
      class ExchangeRandom extends FixtureRandom {
        value() {
          return randomFraction;
        }
      }
      const player = createPlayer(1);
      player.hp = Math.min(99, totalStats);
      player.mp = Math.min(99, totalStats - player.hp);
      player.cp = totalStats - player.hp - player.mp;
      const game = createGame([player, createPlayer(2)]);
      new Battle(game, new ExchangeRandom()).applyItemEffect(
        player, player, getItemDefinition(3),
      );
      assert.equal(player.hp + player.mp + player.cp, totalStats);
      assert.ok(player.hp >= 0 && player.hp <= 99);
      assert.ok(player.mp >= 0 && player.mp <= 99);
      assert.ok(player.cp >= 0 && player.cp <= 99);
    }
  }
});

// Official: 20261106-203010-fwo3, u73. Exchange changed 46/17/25 into
// 0/2/86 and immediately emitted die for the guardian owner.
test('Earth Exchange can set HP to zero and resolves the death', () => {
  class OfficialExchangeRandom extends FixtureRandom {
    value(label) {
      if (label === 'guardianExchangeHp') {
        return 0;
      }
      if (label === 'guardianExchangeMp') {
        // Total 88 gives MP the valid range 0..88; 2.5 lands on 2.
        return 2.5 / 89;
      }
      return super.value(label);
    }
  }
  const owner = createPlayer(1);
  owner.hp = 46;
  owner.mp = 17;
  owner.cp = 25;
  const game = createGame([owner, createPlayer(2)]);
  new Battle(game, new OfficialExchangeRandom()).applyItemEffect(
    owner,
    owner,
    getItemDefinition(3),
  );
  assert.deepEqual(
    {hp: owner.hp, mp: owner.mp, cp: owner.cp},
    {hp: 0, mp: 2, cp: 86},
  );
  assert.equal(owner.hp + owner.mp + owner.cp, 88);
  assert.deepEqual(game.events.map((event) => event.action), [
    'exchange',
    'die',
  ]);
  assert.equal(owner.dead, true);
});

// Official: earth-discard-sacrifice-search2-20261106-205538/round-21/game-26,
// update 71-76. The reflected Full Moon Blade is recalculated against the Moon
// owner, and the remaining AOE hit still resolves from the original attack.
test('a reflected Full Moon Blade damages the Moon owner and keeps the AOE', () => {
  const owner = createPlayer(1);
  owner.guardian = 'moon';
  owner.hp = 70;
  const defender = createPlayer(2, [38]);
  const thirdPlayer = createPlayer(3);
  const game = createGame([owner, defender, thirdPlayer]);
  game.attacks = [
    { playerId: 1, targetPlayerId: 2, guardian: 'moon', itemModelIds: [286, 232] },
    { playerId: 1, targetPlayerId: 3, guardian: 'moon', itemModelIds: [286, 232] },
  ];
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(defender.userId, { itemIds: [1] });
  assert.ok(game.events.some((event) => event.action === 'reflect'));

  battle.submit(owner.userId, {});
  assert.equal(owner.hp, 60, 'the reflected hit damages the original attacker');
  assert.equal(owner.guardian, 'moon', 'a reflected hit does not trigger the guardian leave roll');
  assert.ok(
    game.events.some((event) => event.action === 'nextAttack'),
    'the remaining AOE hit continues after the reflect',
  );
  assert.equal(battle.expectedCommandPlayerId, 3);
});

// Official: earth-discard-sacrifice-search2-20261106-205538/round-2/game-19,
// update 54-59. A bounced Full Moon Blade can land on its Moon owner, who
// defends it, and that damage can make the guardian leave.
test('a bounced Full Moon Blade can damage its owner and remove the guardian', () => {
  class OwnerBounceRandom extends FixtureRandom {
    chance(label) {
      if (label === 'hit') return true;
      if (label === 'guardianLeave') return true;
      return false;
    }
    pick(label, candidates) {
      if (label === 'bounceTarget') return candidates[0];
      return super.pick(label, candidates);
    }
  }

  const owner = createPlayer(1);
  owner.guardian = 'moon';
  owner.hp = 70;
  const defender = createPlayer(2, [21]);
  const game = createGame([owner, defender, createPlayer(3)]);
  game.attacks = [
    { playerId: 1, targetPlayerId: 2, guardian: 'moon', itemModelIds: [286, 232] },
  ];
  const battle = new Battle(game, new OwnerBounceRandom());
  battle.submit(defender.userId, { itemIds: [1] });
  const bounce = game.events.find((event) => event.action === 'bounce');
  assert.equal(bounce.playerId, 1, 'the bounce lands on the Moon owner');

  battle.submit(owner.userId, {});
  assert.equal(owner.hp, 60, 'the owner takes the bounced blade damage');
  assert.ok(game.events.some((event) => event.action === 'removeGuardian'));
  assert.equal(owner.guardian, undefined);
});

// Official: r36-round28-rainbow-reflectmiracle/game-2, update 127-128.
// Super Mirror reflects the other categoryWeapons guardian item.
test('Super Mirror reflects a Diamond Axe guardian attack', () => {
  const owner = createPlayer(1);
  const defender = createPlayer(2, [190]);
  const game = createGame([owner, defender]);
  game.attacks = [
    { playerId: 1, targetPlayerId: 2, guardian: 'earth', itemModelIds: [264] },
  ];
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(defender.userId, { itemIds: [1] });
  assert.ok(game.events.some((event) => event.action === 'reflect'));

  battle.submit(owner.userId, {});
  assert.equal(owner.hp, 25, 'Diamond Axe damage is recalculated against its owner');
});

// Official Exchange draws HP uniformly over its full valid range, then MP
// uniformly over the remaining range. For total 3 every HP value is 1/4.
test('Earth Exchange draws HP uniformly before MP', () => {
  const battle = new Battle(
    createGame([createPlayer(1), createPlayer(2)]),
    new Random(123),
  );
  const hpCounts = [0, 0, 0, 0];
  const sampleCount = 8000;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    hpCounts[battle.spreadStatTotal(3).hp]++;
  }
  for (const [hp, hpCount] of hpCounts.entries()) {
    const share = hpCount / sampleCount;
    assert.ok(
      Math.abs(share - 0.25) < 0.03,
      `HP ${hp} share ${share} should be near 0.25`,
    );
  }

  let hpTotal = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    hpTotal += battle.spreadStatTotal(56).hp;
  }
  const meanHp = hpTotal / sampleCount;
  assert.ok(
    meanHp > 26 && meanHp < 30,
    `total 56 should have a broad HP range, mean ${meanHp}`,
  );
});

// Official: Earth Exchange death is resolved inside the guardian action,
// before the acting player's gift phase.
test('a lethal Earth Exchange dies before the gift phase', () => {
  class ExchangeGuardianRandom extends Random {
    chance(label) {
      if (label === 'guardianAttack') return true;
      if (label === 'guardianSpecial') return false;
      return super.chance(label, 0);
    }
    pick(label, values) {
      if (label === 'guardianItem') {
        return values.find((value) => value.id === 3);
      }
      return super.pick(label, values);
    }
    value(label) {
      if (label === 'guardianExchangeHp' || label === 'guardianExchangeMp') return 0;
      return super.value(label);
    }
  }
  const owner = createPlayer(1);
  owner.guardian = 'earth';
  owner.hp = 1;
  owner.mp = 0;
  owner.cp = 0;
  const game = createGame([owner, createPlayer(2), createPlayer(3)]);
  game.attackTurnPlayerId = 2;
  new Battle(game, new ExchangeGuardianRandom(1)).finishTurn();
  assert.deepEqual(
    game.events.map((event) => event.action),
    ['attackByGuardian', 'exchange', 'die', 'advanceGF'],
  );
  assert.equal(owner.dead, true);
});

// Official: r36-round11-fog-discard/game-2, u11, plus the two-holder rule.
// Only one living Mortar holder is selected, even when another Mortar is
// Dream-disguised as Sun Amulet.
test('Dangerous Pestle selects one of three Mortar holders, including a disguise', () => {
  const pestleUser = createPlayer(1, [94]);
  const firstHolder = createPlayer(2, [209]);
  const secondHolder = createPlayer(3, [209]);
  const disguisedHolder = createPlayer(4, [209]);
  disguisedHolder.items[0].fakeModelId = 208;
  const game = createGame([
    pestleUser,
    firstHolder,
    secondHolder,
    disguisedHolder,
  ]);
  new Battle(game, new FixtureRandom()).submit(pestleUser.userId, {
    itemIds: [1],
  });

  const attractions = game.events.filter(
    (event) => event.action === 'attractDanger',
  );
  assert.equal(attractions.length, 1);
  assert.equal(attractions[0].playerId, disguisedHolder.id);
  assert.equal(attractions[0].item.modelId, 209);
  assert.equal(attractions[0].item.fakeModelId, 208);
  assert.equal(disguisedHolder.dead, true);
  assert.deepEqual(
    disguisedHolder.items.map((item) => item.modelId),
    [0],
    'the consumed Mortar is replaced by a placeholder',
  );
  assert.equal(firstHolder.hp, 40);
  assert.equal(secondHolder.hp, 40);
  assert.ok(firstHolder.items.some((item) => item.modelId === 209));
  assert.ok(secondHolder.items.some((item) => item.modelId === 209));
});

// Official: r36-round14-dream-sell/game-2, u194-196. A full-hand sale can
// choose an ordinary card while two performed miracles survive.
test('a full-hand sale can preserve two performed miracles', () => {
  const seller = createPlayer(1, [4, 192]);
  const buyer = createPlayer(2, [
    113,
    227,
    228,
    ...Array(15).fill(113),
  ]);
  buyer.items[1].used = true;
  buyer.items[2].used = true;
  const game = createGame([seller, buyer]);
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(seller.userId, {
    itemIds: [1, 2],
    targetPlayerId: buyer.id,
  });
  battle.submit(buyer.userId, {});
  const sellEvent = game.events.find((event) => event.action === 'sell');
  assert.equal(sellEvent.overflowItem.modelId, 113);
  assert.equal(buyer.items.length, 18);
  assert.equal(
    buyer.items.filter((item) => item.used === true).length,
    2,
    'both performed miracles survive an ordinary overflow choice',
  );
});

// Official samples keep resolving queued attacks against a target that died
// earlier in the same attack sequence. The local server previously skipped
// every such attack except attackTwice.
test('queued attacks still resolve after their target dies', () => {
  const attacker = createPlayer(1, [93]);
  const dyingTarget = createPlayer(2);
  dyingTarget.hp = 1;
  const thirdPlayer = createPlayer(3, [93]);
  const game = createGame([attacker, dyingTarget, thirdPlayer]);
  game.attacks = [
    { playerId: 1, targetPlayerId: 2, itemModelIds: [93] },
    { playerId: 3, targetPlayerId: 2, itemModelIds: [93] },
  ];
  new Battle(game, new FixtureRandom()).submit(dyingTarget.userId, {});
  const actions = game.events.map((event) => event.action);
  assert.deepEqual(actions.slice(0, 6), [
    'useDefenseItems',
    'dealDamage',
    'die',
    'nextAttack',
    'setTargetPlayer',
    'dealDamage',
  ]);
  assert.equal(
    game.events.filter((event) => event.action === 'dealDamage').length,
    2,
    'both queued attacks deal damage',
  );
  assert.equal(dyingTarget.dead, true);
});

// Official evidence for this exact state is still missing. These tests lock
// the current local fallback and are explicitly not claims of official
// behavior.
test('guardian Buy into 18 performed miracles displaces one (current fallback)', () => {
  const buyer = createPlayer(1, Array(18).fill(214));
  for (const itemSlot of buyer.items) itemSlot.used = true;
  buyer.cp = 20;
  const game = createGame([buyer, createPlayer(2)]);
  game.attacks = [{
    playerId: 1,
    targetPlayerId: 2,
    guardian: 'earth',
    itemModelIds: [5],
    buyingItemModelId: 113,
    buyingItemId: 1,
  }];
  new Battle(game, new FixtureRandom()).confirmPurchase(buyer, { bought: true });
  const setBought = game.events.find((event) => event.action === 'setBought');
  assert.ok(setBought);
  assert.ok(setBought.overflowItem);
  assert.equal(setBought.overflowItem.used, true);
  assert.equal(buyer.items.filter((itemSlot) => itemSlot.modelId > 0).length, 18);
  assert.equal(
    buyer.items.some((itemSlot) => itemSlot.modelId === 113),
    true,
    'the purchased card enters the hand',
  );
});

// Mixed full-hand purchase overflow is extrapolated from the observed sale
// overflow path; no official purchase sample reaches this state.
test('a mixed full-hand purchase can displace a performed miracle (sale analogy)', () => {
  const buyer = createPlayer(1, [214, ...Array(17).fill(113)]);
  buyer.items[0].used = true;
  buyer.cp = 20;
  const game = createGame([buyer, createPlayer(2)]);
  game.attacks = [{
    playerId: 1,
    targetPlayerId: 2,
    guardian: 'earth',
    itemModelIds: [5],
    buyingItemModelId: 113,
    buyingItemId: 1,
  }];
  new Battle(game, new FixtureRandom()).confirmPurchase(buyer, { bought: true });
  const setBought = game.events.find((event) => event.action === 'setBought');
  assert.ok(setBought.overflowItem);
  assert.equal(setBought.overflowItem.used, true);
  assert.equal(buyer.items.length, 18);
});

// Guardian Drop uses the non-performed overflow pool when any ordinary card
// exists, but falls back to all cards when every slot is performed. The latter
// is current local behavior, not an official observation.
test('guardian Drop with only performed cards displaces one (current fallback)', () => {
  const player = createPlayer(1, Array(18).fill(214));
  for (const itemSlot of player.items) itemSlot.used = true;
  const slot = new Battle(
    createGame([player, createPlayer(2)]),
    new FixtureRandom(),
  ).addSlot(player, 146);
  assert.ok(slot.overflowItem);
  assert.equal(slot.overflowItem.used, true);
  assert.equal(player.items.length, 18);
});

test('redraw compacts occupied slot ids', () => {
  const player = createPlayer(1, [6, 11, 113]);
  player.items[1].id = 7;
  player.items[2].id = 9;
  new Battle(createGame([player, createPlayer(2)]), new FixtureRandom())
    .resolveRedraw(player);
  assert.deepEqual(
    player.items.filter((itemSlot) => itemSlot.modelId > 0).map((itemSlot) => itemSlot.id),
    [1, 2, 3],
  );
});

test('Magnetic Storm compacts occupied slot ids and keeps placeholder ids at zero', () => {
  const firstPlayer = createPlayer(1, [6, 11]);
  firstPlayer.items[1].id = 9;
  const secondPlayer = createPlayer(2, [113]);
  secondPlayer.items[0].id = 4;
  const game = createGame([firstPlayer, secondPlayer, createPlayer(3)]);
  new Battle(game, new FixtureRandom()).applyItemEffect(
    firstPlayer,
    firstPlayer,
    getItemDefinition(295),
  );
  for (const player of [firstPlayer, secondPlayer]) {
    const occupiedIds = player.items
      .filter((itemSlot) => itemSlot.modelId > 0)
      .map((itemSlot) => itemSlot.id)
      .sort((firstId, secondId) => firstId - secondId);
    assert.deepEqual(
      occupiedIds,
      occupiedIds.map((unusedValue, index) => index + 1),
    );
    for (const itemSlot of player.items) {
      if (itemSlot.modelId === 0) {
        assert.equal(itemSlot.id, 0);
      }
    }
  }
});

// Official: earth-discard-sacrifice-search round-2/game-11, u129.
test('a lethal devil gift leaves its replacement slot empty', () => {
  class LethalGiftRandom extends FixtureRandom {
    chance(label) {
      return label.startsWith('devilChance:') || super.chance(label);
    }

    pick(label, candidates) {
      if (label.startsWith('devilModel:')) {
        return candidates.find((definition) => definition.id === 241);
      }
      return super.pick(label, candidates);
    }
  }

  const recipient = createPlayer(1, [29]);
  recipient.hp = 14;
  recipient.items.push({ id: 0, modelId: 0 });
  const game = createGame([recipient, createPlayer(2)]);
  game.tiebreakGF = 1;
  new Battle(game, new LethalGiftRandom()).resolveGift(recipient);

  assert.deepEqual(game.events.map((event) => event.action), [
    'gift', 'useDevilItem', 'dealDamage', 'die',
  ]);
  assert.deepEqual(game.events[2], { action: 'dealDamage', damage: 20 });
  assert.equal(recipient.dead, true);
  assert.deepEqual(recipient.items, [
    { id: 1, modelId: 29 }, { id: 0, modelId: 0 },
  ]);
});

// Official: r36-round31-rainbow-reflectmiracle/game-2, u85.
test('a queued percentage attack resolves against an already dead target', () => {
  const attacker = createPlayer(1);
  attacker.items.push({ id: 0, modelId: 0 });
  const defender = createPlayer(2);
  defender.hp = 7;
  const game = createGame([attacker, defender, createPlayer(3)]);
  game.attacks = [
    { playerId: 1, targetPlayerId: 2, itemModelIds: [226], reversed: true },
    { playerId: 3, targetPlayerId: 2, itemModelIds: [226] },
  ];
  new Battle(game, new FixtureRandom()).submit(defender.userId, {});

  assert.deepEqual(game.events.map((event) => event.action), [
    'useDefenseItems', 'dealDamage', 'die', 'nextAttack', 'hit',
    'dealDamage', 'gift', 'advanceGF',
  ]);
  assert.equal(game.attacks, undefined);
  assert.equal(game.dyingPlayerIds, undefined);
  assert.equal(game.attackTurnPlayerId, 3);
});

// Official: r34d-fog-sacrifice/game-1, u50.
test('sacrifice replacements follow the natural disease tick', () => {
  class WorseningRandom extends FixtureRandom {
    chance(label) {
      return label === 'upgradeDisease' || super.chance(label);
    }
  }

  const player = createPlayer(1, [4]);
  player.curses = ['cold'];
  const game = createGame([player, createPlayer(2)]);
  game.tiebreakGF = 1;
  new Battle(game, new WorseningRandom()).submit(player.userId, {
    itemIds: [0, 1],
  });

  assert.deepEqual(game.events.map((event) => event.action), [
    'useAttackItems', 'sacrifice', 'disease', 'upgradeDisease',
    'dealDamage', 'gift', 'advanceGF',
  ]);
  assert.equal(player.hp, 38);
  assert.deepEqual(player.items, [{ id: 1, modelId: 6 }]);
});

// Official: duel-campaign account-02-game-04, u65.
test('unaffordable and declined Buy offers return with the lowest free slot id', () => {
  class LastOfferRandom extends FixtureRandom {
    pick(label, candidates) {
      if (label === 'buyOffer') {
        return candidates.at(-1);
      }
      return super.pick(label, candidates);
    }
  }

  for (const affordable of [false, true]) {
    const buyer = createPlayer(1, [5]);
    buyer.cp = affordable ? 99 : 0;
    const seller = createPlayer(2, [6, 186]);
    seller.items[1].id = 7;
    seller.items[1].fakeModelId = 185;
    const game = createGame([buyer, seller, createPlayer(3)]);
    const battle = new Battle(game, new LastOfferRandom());
    battle.submit(buyer.userId, { itemIds: [1], targetPlayerId: seller.id });
    battle.submit(seller.userId, {});
    const offer = game.events.find((event) => event.action === 'buy');
    assert.equal(offer.item.id, 7);
    assert.equal(offer.item.fakeModelId, 185);
    if (affordable) {
      battle.submit(buyer.userId, { bought: false });
    }
    const returnAction = affordable ? 'setBought' : 'canNotBuy';
    const returned = game.events.find((event) => event.action === returnAction);
    assert.deepEqual(returned.item, { id: 2, modelId: 186 });
    assert.deepEqual(seller.items.find((item) => item.modelId === 186), returned.item);
  }
});

test('Danger can consume either of two attracting items in the same hand', () => {
  const selectionCases = [
    {selectedIndex: 0, consumedId: 2, remainingId: 3},
    {selectedIndex: -1, consumedId: 3, remainingId: 2},
  ];
  for (const {selectedIndex, consumedId, remainingId} of selectionCases) {
    class SelectedDangerRandom extends FixtureRandom {
      pick(label, candidates) {
        if (label === 'dangerItem') {
          return candidates.at(selectedIndex);
        }
        return super.pick(label, candidates);
      }
    }

    const player = createPlayer(1, [94, 209, 209]);
    const game = createGame([player, createPlayer(2)]);
    new Battle(game, new SelectedDangerRandom()).submit(player.userId, {
      itemIds: [1], targetPlayerId: 2,
    });

    const attraction = game.events.find(
      (event) => event.action === 'attractDanger',
    );
    assert.equal(attraction.item.id, consumedId);
    assert.equal(
      player.items.some(
        (item) => item.id === remainingId && item.modelId === 209,
      ),
      true,
    );
  }
});

// Official: research9-magnetic-fullhand9/game-4, u124.
test('game end clears a previous death confusion sentinel', () => {
  const deadPlayer = createPlayer(3);
  deadPlayer.dead = true;
  deadPlayer.hp = 0;
  deadPlayer.confusionCount = -1;
  const player = createPlayer(1, [52]);
  const defender = createPlayer(2);
  defender.hp = 1;
  const game = createGame([player, defender, deadPlayer]);
  const battle = new Battle(game, new FixtureRandom());
  battle.submit(player.userId, { itemIds: [1], targetPlayerId: defender.id });
  assert.equal(deadPlayer.confusionCount, -1);
  battle.submit(defender.userId, {});

  assert.equal(Object.hasOwn(deadPlayer, 'confusionCount'), false);
});

test('resuming a queued attack preserves a completed disease tick', () => {
  const defender = createPlayer(1);
  const game = createGame([defender, createPlayer(2), createPlayer(3)]);
  game.attacks = [{ playerId: 2, targetPlayerId: 1, itemModelIds: [220] }];
  new Battle(game, new FixtureRandom()).submit(defender.userId, {});

  assert.equal(defender.hp, 40);
  assert.equal(defender.curses.includes('heaven'), true);
  assert.equal(game.events.some((event) => event.action === 'disease'), false);
  assert.equal(game.diseasePlayerId, 2);
});

test('devil replacements can interleave across all pending gift recipients', () => {
  class InterleavedGiftRandom extends FixtureRandom {
    recipients = [1, 2, 1, 2];
    recipientIndex = 0;
    modelIndex = 0;
    models = [244, 244, 6, 6];

    pick(label, candidates) {
      if (label === 'giftRecipient') {
        const recipientId = this.recipients[this.recipientIndex];
        return candidates.find((player) => player.id === recipientId);
      }
      if (label.startsWith('devilModel:') || label.startsWith('giftModel:')) {
        const modelId = this.models[this.modelIndex++];
        this.recipientIndex++;
        return candidates.find((definition) => definition.id === modelId);
      }
      if (label === 'devilStat') {
        return 'hp';
      }
      return super.pick(label, candidates);
    }

    chance(label) {
      if (label.startsWith('devilChance:')) {
        return this.models[this.modelIndex] === 244;
      }
      return super.chance(label);
    }
  }

  const first = createPlayer(1);
  const second = createPlayer(2);
  first.items.push({ id: 0, modelId: 0 });
  second.items.push({ id: 0, modelId: 0 });
  const game = createGame([first, second]);
  game.tiebreakGF = 1;
  new Battle(game, new InterleavedGiftRandom()).refillConsumedSlots(first);

  assert.deepEqual(game.events.filter((event) => event.action === 'gift')
    .map((event) => event.playerId), [1, 2, 1, 2]);
  assert.deepEqual(first.items, [{ id: 1, modelId: 6 }]);
  assert.deepEqual(second.items, [{ id: 1, modelId: 6 }]);
  assert.equal(first.hp, 50);
  assert.equal(second.hp, 50);
});

test('sacrifice replacements wait for guardian actions after disease', () => {
  class HealingGuardianRandom extends FixtureRandom {
    chance(label) {
      return label === 'guardianAttack' || super.chance(label);
    }

    pick(label, candidates) {
      if (label === 'guardianItem') {
        return candidates.find((definition) => definition.id === 276);
      }
      return super.pick(label, candidates);
    }
  }

  const player = createPlayer(1, [169]);
  player.curses = ['cold'];
  const guardianOwner = createPlayer(2);
  guardianOwner.guardian = 'neptune';
  const game = createGame([player, guardianOwner, createPlayer(3)]);
  game.tiebreakGF = 1;
  game.diseasePlayerId = 1;
  game.guardianPlayerIds = [2];
  new Battle(game, new HealingGuardianRandom()).submit(player.userId, { itemIds: [0, 1] });

  assert.deepEqual(game.events.map((event) => event.action), [
    'useAttackItems', 'sacrifice', 'disease', 'dealDamage',
    'attackByGuardian', 'boostHP', 'gift', 'advanceGF',
  ]);
  assert.equal(player.hp, 39);
  assert.equal(guardianOwner.hp, 45);
});

test('AOE and hit-rate attacks with no living enemies do not throw and finish cleanly', () => {
  const player = createPlayer(1, [6, 232, 95]); // 6 = Sword, 232 = Mirage (attackEveryEnemy), 95 = Spark Bag (hitRate > 0)
  const deadEnemy = createPlayer(2);
  deadEnemy.dead = true;
  deadEnemy.hp = 0;
  const game = createGame([player, deadEnemy]);

  // Using AOE attack with no living enemies
  const battle1 = new Battle(game, new FixtureRandom());
  assert.doesNotThrow(() => {
    battle1.submit(player.userId, { itemIds: [1, 2] });
  });
  assert.equal(game.isOver, true);

  // Using hit-rate attack with no living enemies
  const hitRateGame = createGame([player, deadEnemy]);
  const battle2 = new Battle(hitRateGame, new FixtureRandom());
  assert.doesNotThrow(() => {
    battle2.submit(player.userId, { itemIds: [3] });
  });
  assert.equal(hitRateGame.isOver, true);
});

test('guardian attacks with no living enemies do not throw and finish safely', () => {
  class AttackGuardianRandom extends FixtureRandom {
    chance(label) {
      return label === 'guardianAttack' || super.chance(label);
    }
  }

  const actingPlayer = createPlayer(1);
  actingPlayer.guardian = 'sun';
  const teammate = createPlayer(2);
  teammate.team = 1;
  actingPlayer.team = 1;
  const deadEnemy = createPlayer(3);
  deadEnemy.dead = true;
  deadEnemy.hp = 0;

  const game = createGame([actingPlayer, teammate, deadEnemy]);
  game.guardianPlayerIds = [1];

  const battle = new Battle(game, new AttackGuardianRandom());
  assert.doesNotThrow(() => {
    battle.submit(actingPlayer.userId, {});
  });
  assert.equal(game.isOver, true);
});

