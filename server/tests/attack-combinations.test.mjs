import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../battle/battle.ts';
import { Random } from '../random.ts';

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

const attack = (
  attackerItems,
  defenderItems,
  { extraPlayers = [], attackerMp = 10 } = {},
) => {
  const attacker = createPlayer(1, attackerItems);
  attacker.mp = attackerMp;
  const defender = createPlayer(2, defenderItems);
  const players = [attacker, defender, ...extraPlayers];
  const game = createGame(players);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', {
    itemIds: attackerItems.map((unusedValue, index) => index + 1),
    targetPlayerId: 2,
  });
  return { attacker, defender, game, battle };
};

const canDefendWith = (battle, defender, armorModelId) => {
  try {
    battle.selectCommandItems(
      defender,
      { itemIds: [defender.items.find((item) => item.modelId === armorModelId).id] },
      true,
    );
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error)) {
      throw error;
    }
    return false;
  }
};

test('regular attack is non-elemental and uses its logged damage', () => {
  const { defender, battle } = attack([10], [113]);
  assert.equal(canDefendWith(battle, defender, 113), true);
  battle.submit('u2', {});
  assert.equal(defender.hp, 38, 'Whip deals 2 damage');
});

test('regular attack plus a plain plus-card stays non-elemental', () => {
  const { defender, battle } = attack([27, 22], [113]);
  assert.equal(canDefendWith(battle, defender, 113), true);
  battle.submit('u2', {});
  assert.equal(defender.hp, 28, 'Ghost Sword + Warrior Bow deals 12');
});

test('regular attack plus a typed plus-card stays non-elemental', () => {
  const typedPlusCases = [
    { items: [30, 68], damage: 10, label: 'Hell Scissors + Leaf Shuriken' },
    { items: [19, 84], damage: 10, label: 'Kusarigama + Paleolithic Javelin' },
    { items: [20, 87], damage: 10, label: 'Plate of Strike + Abyss Dart' },
  ];
  for (const testCase of typedPlusCases) {
    const { defender, battle } = attack(testCase.items, [113]);
    assert.equal(
      canDefendWith(battle, defender, 113),
      true,
      `${testCase.label} should remain non-elemental`,
    );
    battle.submit('u2', {});
    assert.equal(
      defender.hp,
      40 - testCase.damage,
      `${testCase.label} damage`,
    );
  }
});

test('regular attack plus setElement becomes the set element', () => {
  const { defender, battle } = attack([44, 66], [113]);
  assert.equal(
    canDefendWith(battle, defender, 113),
    false,
    'fire cannot be defended by non-element armor',
  );
  battle.submit('u2', {});
  assert.equal(defender.hp, 26, 'Direct Smash Axe + Wand of Ignition deals 14');
});

test('typed attack plus a plain plus-card becomes non-elemental', () => {
  const { defender, battle } = attack([65, 150], [113]);
  assert.equal(canDefendWith(battle, defender, 113), true);
  battle.submit('u2', {});
  assert.equal(defender.hp, 28, 'Ouch Knife + Ogre Helm deals 12');
});

test('light attack plus a typed plus-card keeps the typed element', () => {
  const { defender, battle } = attack([85, 78], [113]);
  assert.equal(
    canDefendWith(battle, defender, 113),
    false,
    'fire cannot be defended by non-element armor',
  );
  battle.submit('u2', {});
  assert.equal(defender.hp, 31, 'Justice Lance + Fire Crossbow deals 9');
});

test('different typed elements become non-elemental', () => {
  const { defender, battle } = attack([77, 74], [113]);
  assert.equal(canDefendWith(battle, defender, 113), true);
  battle.submit('u2', {});
  assert.equal(defender.hp, 33, 'Flaming Roll + Mature Rubber Bow deals 7');
});

test('light plus-card substitutes for a typed attack', () => {
  const { defender, battle } = attack([69, 217], [113]);
  assert.equal(
    canDefendWith(battle, defender, 113),
    false,
    'stone cannot be defended by non-element armor',
  );
  battle.submit('u2', {});
  assert.equal(defender.hp, 28, 'Sword Ware + Meteor deals 12');
});

test('Mirage makes a regular attack hit every enemy with combined damage', () => {
  const thirdPlayer = createPlayer(3, [113]);
  const { defender, game, battle } = attack([54, 22, 232], [113], {
    extraPlayers: [thirdPlayer],
  });
  let guard = 0;
  while (battle.attack && guard++ < 10) {
    const actor = battle.findPlayer(battle.expectedCommandPlayerId);
    battle.submit(actor.userId, {});
  }
  assert.equal(game.attacks, undefined);
  assert.equal(defender.hp, 20);
  assert.equal(thirdPlayer.hp, 20);
});

test('Aura doubles a regular attack', () => {
  const { defender, battle } = attack([10, 231], [113]);
  battle.submit('u2', {});
  assert.equal(defender.hp, 36, 'Whip + Aura deals 4');
});

test('light attack cannot be defended by any armor', () => {
  const { defender, battle } = attack([106], [113]);
  assert.equal(canDefendWith(battle, defender, 113), false);
  battle.submit('u2', {});
  assert.equal(defender.hp, 34, 'Light Orb deals 6');
});

test('darkness damage sets HP to zero when it lands', () => {
  const { defender, battle } = attack([92], [113]);
  assert.equal(canDefendWith(battle, defender, 113), true);
  battle.submit('u2', {});
  assert.equal(defender.hp, 0);
  assert.equal(defender.dead, true);
});

test('same typed plus-card retains the typed element (sparse evidence)', () => {
  const lightCase = attack([70, 63], [113]);
  assert.equal(canDefendWith(lightCase.battle, lightCase.defender, 113), false);
  lightCase.battle.submit('u2', {});
  assert.equal(lightCase.defender.hp, 37, 'Flash Dagger + Piece of Brightness');

  const fireCase = attack([89, 66], [113]);
  assert.equal(canDefendWith(fireCase.battle, fireCase.defender, 113), false);
  fireCase.battle.submit('u2', {});
  assert.equal(fireCase.defender.hp, 30, "Fire Dragon's Horn + Wand of Ignition");
});

test('water typed base plus water setElement stays water', () => {
  const fireDefense = attack([90, 83], [119]);
  assert.equal(
    canDefendWith(fireDefense.battle, fireDefense.defender, 119),
    true,
    'a water attack is defendable by fire armor',
  );
  fireDefense.battle.submit('u2', {itemIds: [1]});
  assert.equal(fireDefense.defender.hp, 29, "Water Dragon's Horn + Wand of Mystic Water deals 11 after DEF2");

  const woodDefense = attack([90, 83], [116]);
  assert.equal(
    canDefendWith(woodDefense.battle, woodDefense.defender, 116),
    false,
    'wood armor cannot defend a water attack',
  );
});

test('darkness typed base plus darkness plus stays darkness', () => {
  const darknessCase = attack([76, 87], [118]);
  assert.equal(
    canDefendWith(darknessCase.battle, darknessCase.defender, 118),
    true,
    'darkness attacks can be defended',
  );
  darknessCase.battle.submit('u2', {itemIds: [1]});
  assert.equal(darknessCase.defender.hp, 0, 'Cobra + Abyss Dart still sets HP to zero');
  assert.ok(
    darknessCase.game.events.some((event) => event.action === 'dealDarkDamage'),
  );
});

test('Mirage and Aura erase a typed base to non-elemental (sparse evidence)', () => {
  const thirdPlayer = createPlayer(3, [113]);
  const mirageCase = attack([89, 232], [113], { extraPlayers: [thirdPlayer] });
  assert.equal(
    canDefendWith(mirageCase.battle, mirageCase.defender, 113),
    true,
    'Mirage plus a typed weapon is non-elemental',
  );
  let mirageGuard = 0;
  while (mirageCase.battle.attack && mirageGuard++ < 8) {
    const actor = mirageCase.battle.findPlayer(
      mirageCase.battle.expectedCommandPlayerId,
    );
    mirageCase.battle.submit(actor.userId, {});
  }
  assert.equal(mirageCase.defender.hp, 32);
  assert.equal(thirdPlayer.hp, 32);

  const auraCase = attack([77, 231], [113]);
  assert.equal(
    canDefendWith(auraCase.battle, auraCase.defender, 113),
    true,
    'Aura plus a typed weapon is non-elemental',
  );
  auraCase.battle.submit('u2', {});
  assert.equal(auraCase.defender.hp, 32, 'Flaming Roll + Aura deals 8');
});

// Official: r36-round26-dream-sell/game-2, update 94. Saw Boom Boom has ATK 3
// and attackTwice; two Aura make each hit 3 * 2 * 2 = 12.
test('two Aura cards stack multiplicatively on every hit', () => {
  const { defender, battle } = attack([14, 231, 231], [], {
    attackerMp: 20,
  });
  let guard = 0;
  while (battle.attack && guard++ < 10) {
    const actor = battle.findPlayer(battle.expectedCommandPlayerId);
    battle.submit(actor.userId, {});
  }
  assert.equal(defender.hp, 16, 'two hits of 12 damage each');
});

// Official: r35-round6-multi-plus/game-2, update 10. Five enemies produced
// ten target resolutions, with a separately shuffled order per Mirage. This
// test uses three enemies for brevity.
test('two Mirage cards repeat the full AOE cycle with independent order', () => {
  const extraPlayers = [createPlayer(3), createPlayer(4)];
  const { defender, game, battle } = attack([10, 232, 232], [], {
    extraPlayers,
  });
  assert.equal(game.attacks.length, 6, 'two passes over three enemies');
  const targetCounts = new Map();
  for (const queuedAttack of game.attacks) {
    targetCounts.set(
      queuedAttack.targetPlayerId,
      (targetCounts.get(queuedAttack.targetPlayerId) ?? 0) + 1,
    );
  }
  assert.deepEqual([...targetCounts.values()], [2, 2, 2]);

  let guard = 0;
  while (battle.attack && guard++ < 10) {
    const actor = battle.findPlayer(battle.expectedCommandPlayerId);
    battle.submit(actor.userId, {});
  }
  assert.equal(defender.hp, 36, 'Whip deals 2 damage in each pass');
  for (const extraPlayer of extraPlayers) {
    assert.equal(extraPlayer.hp, 36);
  }
});

// Official: broom-long3/game-0, update 84. Three Rainbow Curtains are
// consumed, but only one element filter applies and no response occurs.
test('stacked Rainbow Curtains apply one filter and no extra response', () => {
  const attacker = createPlayer(1, [229]);
  const defender = createPlayer(2, [189, 189, 189]);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', { itemIds: [1, 2, 3] });
  const actions = game.events.map((event) => event.action);
  for (const forbidden of ['block', 'bounce', 'reflect']) {
    assert.equal(actions.includes(forbidden), false);
  }
  const defense = game.events.find(
    (event) => event.action === 'useDefenseItems',
  );
  assert.equal(
    defense.items.length,
    3,
    'all three Rainbow Curtains are selected',
  );
  assert.equal(defender.hp, 25, 'Magma deals its normal 15 damage');
});

// Official observation: Mirage determines the strike count, but Pestle picks
// independently from all living players before each strike, allowing repeats.
for (const scenario of [
  {
    name: 'allows repeated targets and the attacker',
    items: [94, 232],
    targetIds: [2, 2, 1],
    startingHp: [99, 99, 99, 99],
    expectedHp: [69, 39, 99, 99],
    expectedPools: [[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4]],
  },
  {
    name: 'excludes players killed by an earlier strike',
    items: [94, 232],
    targetIds: [2, 3, 4],
    startingHp: [40, 30, 40, 40],
    expectedHp: [40, 0, 10, 10],
    expectedPools: [[1, 2, 3, 4], [1, 3, 4], [1, 3, 4]],
  },
  {
    name: 'rerolls every strike across two Mirage cards',
    items: [94, 232, 232],
    targetIds: [2, 3, 4, 2, 3, 4],
    startingHp: [99, 99, 99, 99],
    expectedHp: [99, 39, 39, 39],
    expectedPools: Array.from({ length: 6 }, () => [1, 2, 3, 4]),
  },
]) {
  test(`Dangerous Pestle plus Mirage ${scenario.name}`, () => {
    const targetPools = [];
    class PestleRandom extends Random {
      pick(label, candidates) {
        if (label === 'dangerTarget') {
          const targetId = scenario.targetIds[targetPools.length];
          targetPools.push(candidates.map((candidate) => candidate.id));
          const target = candidates.find((candidate) => candidate.id === targetId);
          assert.ok(target, `player ${targetId} must be available`);
          return target;
        }
        return super.pick(label, candidates);
      }
    }
    const players = [
      createPlayer(1, scenario.items),
      createPlayer(2),
      createPlayer(3),
      createPlayer(4),
    ];
    for (const [playerIndex, player] of players.entries()) {
      player.hp = scenario.startingHp[playerIndex];
    }
    const game = createGame(players);
    const battle = new Battle(game, new PestleRandom(3));
    const events = [];
    battle.submit('u1', {
      itemIds: scenario.items.map((unusedValue, itemIndex) => itemIndex + 1),
    });
    events.push(...game.events);
    let defenseCount = 0;
    while (battle.attack && defenseCount < scenario.targetIds.length) {
      const actor = battle.findPlayer(battle.expectedCommandPlayerId);
      battle.submit(actor.userId, {});
      events.push(...game.events);
      defenseCount++;
    }

    assert.equal(battle.attack, undefined, 'every queued strike finishes');
    assert.deepEqual(targetPools, scenario.expectedPools);
    assert.deepEqual(players.map((player) => player.hp), scenario.expectedHp);
    assert.deepEqual(
      events.filter((event) => event.action === 'setTargetPlayer')
        .map((event) => event.playerId),
      scenario.targetIds,
    );
    assert.equal(
      events.filter((event) => event.action === 'danger').length,
      scenario.targetIds.length,
      'each strike activates Pestle',
    );
    assert.equal(events.some((event) => event.action === 'attractDanger'), false);
  });
}

test('Dangerous Pestle plus Mirage continues after a Mortar absorbs a strike', () => {
  const targetPools = [];
  class PestleRandom extends Random {
    pick(label, candidates) {
      if (label === 'dangerTarget') {
        targetPools.push(candidates.map((candidate) => candidate.id));
        return candidates.find((candidate) => candidate.id === 3);
      }
      return super.pick(label, candidates);
    }
  }
  const attacker = createPlayer(1, [94, 232]);
  const mortarHolder = createPlayer(2, [209]);
  const defender = createPlayer(3);
  const game = createGame([attacker, mortarHolder, defender]);
  const battle = new Battle(game, new PestleRandom(3));
  battle.submit('u1', { itemIds: [1, 2] });

  assert.equal(mortarHolder.dead, true);
  assert.equal(game.attacks.length, 1, 'Mortar absorbs only the first strike');
  assert.equal(battle.expectedCommandPlayerId, defender.id);
  assert.deepEqual(targetPools, [[1, 3]]);
  assert.equal(
    game.events.filter((event) => event.action === 'danger').length,
    2,
  );
  assert.equal(
    game.events.filter((event) => event.action === 'attractDanger').length,
    1,
  );
  battle.submit('u3', {});
  assert.equal(defender.hp, 10);
  assert.equal(battle.attack, undefined);
});
