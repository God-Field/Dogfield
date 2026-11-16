import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../battle/battle.ts';
import { Random } from '../random.ts';
import { engine, getItemDefinition } from '../engine.ts';

const createPlayer = (id, modelIds = [], overrides = {}) => ({
  id,
  userId: `u${id}`,
  name: `Player ${id}`,
  hp: 40,
  mp: 10,
  cp: 20,
  ...overrides,
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

class PhenomenonRandom extends Random {
  constructor(modelId, seed = 3) {
    super(seed);
    this.modelId = modelId;
  }

  pick(label, values, weight) {
    if (label === 'phenomenon') {
      return values.find((value) => value.id === this.modelId) ?? values[0];
    }
    return super.pick(label, values, weight);
  }
}

class AlwaysHitRandom extends Random {
  chance(label) {
    return label === 'hit';
  }
}

class HiddenSelectionRandom extends Random {
  chance(label) {
    return label === 'guardianAttack' || label === 'hit';
  }

  pick(label, values, weight) {
    if (label === 'guardianItem') {
      return values[0];
    }
    return super.pick(label, values, weight);
  }
}

test('Saw Boom Boom plus Mirage attacks each enemy twice', () => {
  const attacker = createPlayer(1, [14, 232]);
  const defenders = [2, 3, 4].map((id) => createPlayer(id));
  const game = createGame([attacker, ...defenders]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1, 2], targetPlayerId: 2 });

  assert.equal(game.attacks.length, 6, 'three enemies × two strikes');
  const targets = game.attacks.map((attack) => attack.targetPlayerId);
  for (let index = 0; index < targets.length; index += 2) {
    assert.equal(targets[index], targets[index + 1], 'each target is paired');
  }
  assert.equal(new Set(targets).size, 3);
});

test('Warm Current heals only the caster and emits one playerless boost', () => {
  const players = [
    createPlayer(1, [], { hp: 10 }),
    createPlayer(2, [], { hp: 10 }),
    createPlayer(3, [], { hp: 10 }),
  ];
  const game = createGame(players);
  const battle = new Battle(game, new PhenomenonRandom(293));
  battle.resolvePhenomenon(players[0]);

  assert.deepEqual(game.events.map((event) => event.action), [
    'phenomenon',
    'boostHP',
  ]);
  assert.equal(game.events[1].hp, 50);
  assert.equal(Object.hasOwn(game.events[1], 'playerId'), false);
  assert.deepEqual(players.map((player) => player.hp), [60, 10, 10]);
});

test('Gold Mountain credits a randomly selected living recipient', () => {
  class GoldRandom extends PhenomenonRandom {
    pick(label, values, weight) {
      if (label === 'goldMountainRecipient') {
        return values.find((value) => value.id === 2) ?? values[0];
      }
      return super.pick(label, values, weight);
    }
  }

  const players = [
    createPlayer(1, [], { cp: 10 }),
    createPlayer(2, [], { cp: 20 }),
    createPlayer(3, [], { cp: 30 }),
  ];
  const game = createGame(players);
  const battle = new Battle(game, new GoldRandom(294));
  battle.resolvePhenomenon(players[0]);

  const event = game.events.find(
    (candidate) => candidate.action === 'collectCPOfEverybody',
  );
  assert.equal(event.playerId, 2);
  assert.deepEqual(players.map((player) => player.cp), [0, 60, 0]);
});

test('Solar Eclipse assigns distinct guardians to every living player', () => {
  class DuplicateGuardianRandom extends PhenomenonRandom {
    pick(label, values, weight) {
      if (label === 'guardian') {
        return values[0];
      }
      return super.pick(label, values, weight);
    }
  }

  const players = Array.from({ length: 9 }, (unused, index) =>
    createPlayer(index + 1));
  const game = createGame(players);
  const battle = new Battle(game, new DuplicateGuardianRandom(296));
  battle.resolvePhenomenon(players[0]);

  const event = game.events.find(
    (candidate) => candidate.action === 'setGuardianOfEverybody',
  );
  assert.equal(event.guardians.length, players.length);
  assert.equal(new Set(event.guardians).size, players.length);
});

test('Solar Eclipse starts a new guardian pass after exhausting the catalog', () => {
  const guardianCount = engine.allGuardians.length;
  const players = Array.from(
    { length: guardianCount + 2 },
    (unused, index) => createPlayer(index + 1),
  );
  const game = createGame(players);
  const battle = new Battle(game, new PhenomenonRandom(296));
  battle.resolvePhenomenon(players[0]);

  const event = game.events.find(
    (candidate) => candidate.action === 'setGuardianOfEverybody',
  );
  assert.equal(event.guardians.length, players.length);
  assert.equal(event.guardians.filter(Boolean).length, players.length);
  for (let start = 0; start < players.length; start += guardianCount) {
    const block = event.guardians.slice(start, start + guardianCount);
    assert.equal(new Set(block).size, block.length);
  }
});

test('Rainbow Curtain filters the current defense without changing the attack', () => {
  const attacker = createPlayer(1, [229]);
  const defender = createPlayer(2, [189, 113]);
  const extraDefender = createPlayer(3);
  const game = createGame([attacker, defender, extraDefender]);
  const battle = new Battle(game, new AlwaysHitRandom(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', { itemIds: [1, 2] });

  const nextAttack = game.events.find(
    (event) => event.action === 'nextAttack',
  );
  assert.deepEqual(nextAttack.attack.itemModelIds, [229]);
  assert.deepEqual(game.attacks[0].itemModelIds, [229]);
});

test('Earth Drop addItem events omit the extra player id', () => {
  const player = createPlayer(1);
  const game = createGame([player]);
  const battle = new Battle(game, new Random(3));
  battle.applyItemEffect(
    player,
    player,
    getItemDefinition(285),
    { itemModelIds: [285, 129] },
  );

  const event = game.events.find((candidate) => candidate.action === 'addItem');
  assert.equal(event.item.modelId, 129);
  assert.equal(Object.hasOwn(event, 'playerId'), false);
});

test('guardian attacks do not include an items summary in the wire attack', () => {
  const turnPlayer = createPlayer(1);
  const guardianOwner = createPlayer(2);
  guardianOwner.guardian = 'mars';
  const game = createGame([turnPlayer, guardianOwner]);
  const battle = new Battle(game, new HiddenSelectionRandom(3));
  battle.finishTurn();

  const guardianEvent = game.events.find(
    (candidate) => candidate.action === 'attackByGuardian',
  );
  assert.equal(Object.hasOwn(guardianEvent.attack, 'items'), false);
  assert.equal(Object.hasOwn(game.attacks[0], 'items'), false);
});

test('every held Ascension Bow is consumed and leaves a placeholder', () => {
  const attacker = createPlayer(1, [10]);
  const defender = createPlayer(2, [112, 112], { hp: 1 });
  const thirdPlayer = createPlayer(3, [], { hp: 99 });
  const game = createGame([attacker, defender, thirdPlayer]);
  const battle = new Battle(game, new AlwaysHitRandom(3));
  const actions = [];
  const runCommand = (userId, command) => {
    battle.submit(userId, command);
    actions.push(...game.events.map((event) => event.action));
  };

  runCommand('u1', { itemIds: [1], targetPlayerId: 2 });
  runCommand('u2', {});
  let guard = 0;
  while (battle.attack && guard++ < 20) {
    const actor = battle.findPlayer(battle.expectedCommandPlayerId);
    runCommand(actor.userId, {});
  }

  assert.equal(
    actions.filter((action) => action === 'attackDyingly').length,
    2,
    'both held bows fire',
  );
  assert.deepEqual(
    defender.items.map((item) => item.modelId),
    [0, 0],
    'consumed bows leave placeholders',
  );
  assert.equal(game.dyingPlayerIds, undefined);
});

test('dyingPlayerIds keeps non-bow deaths while a bow chain resolves', () => {
  const attacker = createPlayer(1, [229]);
  const bowHolder = createPlayer(2, [112], { hp: 1 });
  const otherVictim = createPlayer(3, [], { hp: 1 });
  const survivor = createPlayer(4, [], { hp: 99 });
  const game = createGame([attacker, bowHolder, otherVictim, survivor]);
  const battle = new Battle(game, new AlwaysHitRandom(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });

  let guard = 0;
  let sawBowChain = false;
  while (battle.attack && guard++ < 20) {
    if (game.attacks.some((attack) => attack.itemModelIds.includes(112))) {
      sawBowChain = true;
      break;
    }
    const actor = battle.findPlayer(battle.expectedCommandPlayerId);
    battle.submit(actor.userId, {});
  }

  assert.equal(sawBowChain, true);
  assert.ok(game.dyingPlayerIds.includes(bowHolder.id));
  assert.ok(game.dyingPlayerIds.includes(otherVictim.id));
});

test('a bow with no living target still fires and allows the game to end', () => {
  const attacker = createPlayer(1, [53], { hp: 1 });
  const defender = createPlayer(2, [112], { hp: 1 });
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new AlwaysHitRandom(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', {});

  const actions = game.events.map((event) => event.action);
  assert.ok(actions.includes('attackDyingly'));
  assert.equal(actions.at(-1), 'endGame');
  assert.equal(game.isOver, true);
  assert.equal(game.dyingPlayerIds, undefined);
  assert.deepEqual(
    defender.items.map((item) => item.modelId),
    [0],
  );
});

test('inactive miracle-response armor stacks as ordinary armor against weapons', () => {
  const attacker = createPlayer(1, [6]);
  const defender = createPlayer(2, [145, 171]);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new AlwaysHitRandom(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', { itemIds: [1, 2] });

  assert.equal(defender.hp, 40);
  assert.equal(
    game.events.some((event) =>
      ['block', 'reflect', 'bounce'].includes(event.action)),
    false,
  );
  assert.ok(game.events.some((event) => event.action === 'safe'));
});

test('active miracle responses cannot follow ordinary defenses', () => {
  const cases = [
    { attack: [229, 163], defense: [127, 167] },
    { attack: [225], defense: [169, 177] },
    { attack: [226], defense: [138, 125] },
    { attack: [230], defense: [181, 174] },
    { attack: [212], defense: [135, 151] },
    { attack: [212], defense: [37, 114, 123] },
    { attack: [212], defense: [130, 125, 185] },
    { attack: [215], defense: [115, 114] },
    { attack: [212], defense: [172, 149, 171] },
    { attack: [213], defense: [148, 164] },
    { attack: [226], defense: [148, 156] },
    { attack: [226], defense: [148, 125] },
    { attack: [215, 189], defense: [113, 167] },
    { attack: [215], defense: [189, 113, 167] },
  ];

  for (const testCase of cases) {
    const attacker = createPlayer(1);
    const defender = createPlayer(2, testCase.defense);
    const game = createGame([attacker, defender]);
    game.attacks = [{
      playerId: attacker.id,
      targetPlayerId: defender.id,
      itemModelIds: testCase.attack,
    }];
    const battle = new Battle(game, new AlwaysHitRandom(3));
    const itemIds = defender.items.map((item) => item.id);
    const originalItems = structuredClone(defender.items);

    assert.throws(
      () => battle.submit('u2', { itemIds }),
      (error) => error.status === 400,
      `attack ${testCase.attack}, defense ${testCase.defense}`,
    );
    assert.deepEqual(defender.items, originalItems);
    assert.equal(defender.hp, 40);

    const responseIndex = testCase.defense.findIndex((modelId) =>
      ['bounceMiracle', 'reflectMiracle', 'blockMiracle'].includes(
        getItemDefinition(modelId).ability,
      ),
    );
    const prefix = itemIds.slice(0, responseIndex);
    const candidates = battle.botDefenseCandidates(defender, prefix);
    assert.equal(
      candidates.some((candidate) =>
        candidate.command.itemIds.at(-1) === itemIds[responseIndex]),
      false,
      'bot follow-ups exclude the same illegal response',
    );
  }
});

test('a leading reaction armor still reacts', () => {
  const attacker = createPlayer(1, [229]);
  const defender = createPlayer(2, [171]);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new AlwaysHitRandom(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', { itemIds: [1] });

  assert.equal(defender.hp, 40);
  assert.ok(game.events.some((event) => event.action === 'block'));
});

test('a reflected attack keeps the Rainbow Curtain filter', () => {
  const attacker = createPlayer(1, [16]);
  const defender = createPlayer(2, [189, 38]);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', { itemIds: [1, 2] });

  assert.equal(game.attacks[0].reversed, true);
  assert.deepEqual(game.attacks[0].itemModelIds, [16, 189]);
});

test('a reflected sell preserves the offered slot id and the pending gift', () => {
  const seller = createPlayer(1, [4, 73, 16, 16, 16], {cp: 50});
  const buyer = createPlayer(2, [190]);
  const game = createGame([seller, buyer]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1, 2], targetPlayerId: 2 });
  battle.submit('u2', { itemIds: [1] });
  battle.submit('u1', {});

  const sale = game.events.find((event) => event.action === 'sell');
  assert.equal(sale.item.id, 2);
  assert.ok(
    seller.items.some((item) => item.id === 2 && item.modelId === 73),
  );
  assert.ok(
    game.events.some(
      (event) => event.action === 'gift' && event.playerId === 1,
    ),
    'the seller still receives the end-of-turn gift after a reflected sale',
  );
  assert.equal(seller.items.length, 5);
  assert.ok(!seller.items.some((itemSlot) => !itemSlot.modelId));
});

test('a confused death after a non-attack play keeps the negative marker', () => {
  const player = createPlayer(1, [3], {
    hp: 40,
    mp: 10,
    cp: 20,
    confusionCount: 3,
  });
  const game = createGame([player, createPlayer(2)]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1], mp: 50, cp: 20 });

  assert.equal(player.dead, true);
  assert.equal(game.isOver, true);
  assert.equal(player.confusionCount, -1);
});

test('a confused death inside an attack clears the counter', () => {
  const attacker = createPlayer(1, [16]);
  const defender = createPlayer(2, [], { hp: 1, confusionCount: 3 });
  const game = createGame([attacker, defender, createPlayer(3)]);
  const battle = new Battle(game, new AlwaysHitRandom(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', {});

  assert.equal(defender.dead, true);
  assert.equal(defender.confusionCount ?? 0, 0);
});

test('the update that empties a hand keeps an empty array', () => {
  const player = createPlayer(1, [113]);
  const game = createGame([player, createPlayer(2)]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [0, 1] });

  assert.deepEqual(player.items, []);
});

test('a pre-existing empty hand normalizes to null on the next submit', () => {
  const defender = createPlayer(1);
  const attacker = createPlayer(2, [16]);
  const game = createGame([defender, attacker, createPlayer(3)]);
  game.attackTurnPlayerId = 2;
  game.attacks = [
    {
      playerId: 2,
      itemModelIds: [16],
      targetPlayerId: 1,
    },
  ];
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', {});

  assert.equal(defender.items, null);
});
