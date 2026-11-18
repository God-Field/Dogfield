import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../battle/battle.ts';
import { Random } from '../random.ts';
import { botTargetProbabilities } from '../battle/bot-policy.ts';
import { getEarthItemPool, getMoonItemPool } from '../battle/guardians.ts';

const createGame = () => ({
  players: [], gf: 1, attackTurnPlayerId: 1, events: [], updateCount: 1,
});

class FixedDrawRandom extends Random {
  constructor(fraction) {
    super(0);
    this.fraction = fraction;
    this.labels = [];
  }

  value(label) {
    this.labels.push(label);
    return this.fraction;
  }
}

test('Earth makes one uniform catalog draw, using the same drawn card for Drop', () => {
  const battle = new Battle(createGame());
  const pool = getEarthItemPool(battle);
  assert.equal(pool.length, 207);
  assert.equal(pool.some((definition) => ['discard', 'sacrifice'].includes(definition.ability)), false);
  let dropCount = 0;
  for (const [itemIndex, definition] of pool.entries()) {
    const random = new FixedDrawRandom((itemIndex + 0.5) / pool.length);
    battle.random = random;
    const action = battle.selectGuardianAction({ guardian: 'earth' });
    if (definition.isItemTargetingCommand()) {
      assert.equal(action[0].id, definition.id);
    } else {
      dropCount++;
      assert.equal(action[0].ability, 'addItem');
      assert.equal(action[1].id, definition.id);
    }
    const expectedLabels = definition.ability === 'sell'
      ? ['guardianItem', 'guardianSaleItem'] : ['guardianItem'];
    assert.deepEqual(random.labels, expectedLabels);
  }
  assert.equal(dropCount, 82);
});

test('Moon draws uniformly from 28 miracles and combines only Aura or Mirage with the blade', () => {
  const battle = new Battle(createGame());
  const pool = getMoonItemPool(battle);
  assert.equal(pool.length, 28);
  assert.equal(pool.some((definition) => ['blockWeapon', 'bounceMiracle'].includes(definition.ability)), false);
  let bladeCount = 0;
  for (const [itemIndex, definition] of pool.entries()) {
    const random = new FixedDrawRandom((itemIndex + 0.5) / pool.length);
    battle.random = random;
    const action = battle.selectGuardianAction({ guardian: 'moon' });
    const needsBlade = ['doubleAtk', 'attackEveryEnemy'].includes(definition.ability);
    if (needsBlade) {
      bladeCount++;
      assert.equal(action[0].ability, 'categoryWeapons');
      assert.equal(action[1].id, definition.id);
    } else {
      assert.deepEqual(action.map((item) => item.id), [definition.id]);
    }
    assert.deepEqual(random.labels, ['guardianItem']);
  }
  assert.equal(bladeCount, 2);
});

test('guardian eligibility is independent of artwork names', () => {
  const battle = new Battle(createGame());
  const renamedCatalog = battle.catalog.models.map((definition) => Object.assign(
    Object.create(Object.getPrototypeOf(definition)), definition, { imageName: 'same-artwork-name' },
  ));
  Object.defineProperty(battle, 'catalog', { value: renamedCatalog });
  assert.equal(getEarthItemPool(battle).length, 207);
  assert.equal(getMoonItemPool(battle).length, 28);
});

test('every occupied slot has an equal overflow interval, including performed miracles', () => {
  for (const fillPlaceholder of [true, false]) {
    for (let selectedIndex = 0; selectedIndex < 18; selectedIndex++) {
      const player = {
        id: 1, hp: 40, mp: 10, cp: 20,
        items: Array.from({ length: 18 }, (unusedValue, slotIndex) => ({
          id: slotIndex + 1, modelId: slotIndex < 6 ? 211 : 113, used: slotIndex < 6,
        })),
      };
      const random = new FixedDrawRandom((selectedIndex + 0.5) / 18);
      const battle = new Battle(createGame(), random);
      const result = battle.addSlot(player, 146, fillPlaceholder);
      assert.equal(result.overflowItem.id, selectedIndex + 1);
      assert.equal(result.overflowItem.used, selectedIndex < 6);
      assert.equal(player.items.length, 18);
      assert.deepEqual(random.labels, ['overflowItem']);
    }
  }
});

test('bot purchases do not consult the random generator', () => {
  const random = new Random(0);
  random.chance = () => {
    throw new Error('Purchase acceptance must not roll');
  };
  const battle = new Battle(createGame(), random);
  assert.equal(battle.chooseBotBuyDecision(113), true);
  assert.equal(battle.chooseBotBuyDecision(148), false);
});

test('bot targeting uses the actor strength and all living players to prefer the opposite group', () => {
  const actor = { id: 1, hp: 80, mp: 10, cp: 10 };
  const targets = [
    { id: 2, hp: 10, mp: 10, cp: 10 },
    { id: 3, hp: 20, mp: 10, cp: 10 },
    { id: 4, hp: 90, mp: 10, cp: 10 },
  ];
  const players = [actor, ...targets];
  const base = botTargetProbabilities(targets.map((target) => target.hp), '');
  const upper = botTargetProbabilities(targets.map((target) => target.hp), '', {
    actor, players, targets,
  });
  assert.ok(Math.abs((upper[0] / base[0]) / (upper[2] / base[2]) - 3) < 1e-12);
  actor.hp = 1;
  const lower = botTargetProbabilities(targets.map((target) => target.hp), '', {
    actor, players, targets,
  });
  assert.ok(Math.abs((lower[2] / base[2]) / (lower[0] / base[0]) - 3) < 1e-12);
  const withDeadPlayer = botTargetProbabilities(targets.map((target) => target.hp), '', {
    actor, players: [...players, { id: 5, hp: 99, mp: 99, cp: 99, dead: true }], targets,
  });
  assert.deepEqual(withDeadPlayer, lower);
  assert.ok(Math.abs(lower.reduce((total, probability) => total + probability, 0) - 1) < 1e-12);
});

test('bot strength estimation includes MP and currency with less weight than HP', () => {
  const actor = { id: 1, hp: 30, mp: 0, cp: 0 };
  const targets = [
    { id: 2, hp: 1, mp: 0, cp: 0 },
    { id: 3, hp: 45, mp: 0, cp: 0 },
  ];
  const probabilities = () => botTargetProbabilities([1, 45], '', {
    actor, players: [actor, ...targets], targets,
  });
  const before = probabilities();
  targets[0].mp = 99;
  assert.ok(probabilities()[0] < before[0]);
  targets[0].mp = 0;
  targets[0].cp = 99;
  assert.notDeepEqual(probabilities(), before);
});

test('the running battle passes the acting bot status into target selection', () => {
  const actor = { id: 1, hp: 80, mp: 10, cp: 10, items: [] };
  const enemies = [
    { id: 2, hp: 10, mp: 10, cp: 10, items: [] },
    { id: 3, hp: 90, mp: 10, cp: 10, items: [] },
  ];
  const game = { ...createGame(), players: [actor, ...enemies] };
  const battle = new Battle(game, new FixedDrawRandom(0.6));
  assert.equal(battle.chooseBotTarget(enemies), 2);
  actor.hp = 1;
  assert.equal(battle.chooseBotTarget(enemies), 3);
});
