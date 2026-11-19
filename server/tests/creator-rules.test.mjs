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

test('bot targeting uses the lobby mean to decide which direction to aim', () => {
  const actor = { id: 1, hp: 80, mp: 10, cp: 10 };
  const targets = [
    { id: 2, hp: 10, mp: 10, cp: 10 },
    { id: 3, hp: 20, mp: 10, cp: 10 },
    { id: 4, hp: 90, mp: 10, cp: 10 },
  ];
  const players = [actor, ...targets];
  const upper = botTargetProbabilities(targets.map((target) => target.hp), '', {
    actor, players, targets,
  });
  assert.ok(upper[0] > 0);
  assert.ok(upper[1] > 0);
  assert.equal(upper[2], 0);
  actor.hp = 1;
  const lower = botTargetProbabilities(targets.map((target) => target.hp), '', {
    actor, players, targets,
  });
  assert.ok(lower.every((probability) => probability > 0));
  const withDeadPlayer = botTargetProbabilities(targets.map((target) => target.hp), '', {
    actor, players: [...players, { id: 5, hp: 99, mp: 99, cp: 99, dead: true }], targets,
  });
  assert.deepEqual(withDeadPlayer, lower);
  assert.ok(Math.abs(lower.reduce((total, probability) => total + probability, 0) - 1) < 1e-12);
});

test('bot strength scoring uses all three statuses with HP weighted highest', () => {
  const actor = { id: 1, hp: 33, mp: 0, cp: 0 };
  const targets = [
    { id: 2, hp: 30, mp: 0, cp: 0 },
    { id: 3, hp: 66, mp: 0, cp: 0 },
    { id: 4, hp: 6, mp: 0, cp: 0 },
  ];
  const probabilities = () => botTargetProbabilities([30, 66, 6], '', {
    actor, players: [actor, ...targets], targets,
  });
  const before = probabilities();
  assert.equal(before[0], 0);
  assert.equal(before[1], 1);
  targets[0].cp = 99;
  const afterCurrency = probabilities();
  assert.ok(afterCurrency[0] > 0);
  assert.equal(afterCurrency[2], 0);
  targets[0].cp = 0;
  targets[0].mp = 99;
  const afterMp = probabilities();
  assert.ok(afterMp[0] > 0);
  assert.equal(afterMp[2], 0);
  targets[0].mp = 0;
  targets[0].cp = 99;
  assert.equal(botTargetProbabilities([30, 66, 6], '', {
    actor,
    players: [actor, ...targets, { id: 5, hp: 99, mp: 99, cp: 99, dead: true }],
    targets,
  })[0], afterCurrency[0]);
});

test('a guardian can change the direction of an attack', () => {
  const actor = { id: 1, hp: 45, mp: 10, cp: 20 };
  const weaker = { id: 2, hp: 20, mp: 10, cp: 20, guardian: undefined };
  const stronger = { id: 3, hp: 40, mp: 10, cp: 20 };
  const targets = [weaker, stronger];
  const probabilities = () => botTargetProbabilities([20, 40], '', {
    actor, players: [actor, ...targets], targets,
  });
  assert.ok(probabilities().every((probability) => probability > 0));
  weaker.guardian = 'earth';
  assert.deepEqual(probabilities(), [1, 0]);
});

test('a bot exactly at the mean can target stronger or tied enemies', () => {
  const actor = { id: 1, hp: 40, mp: 10, cp: 20 };
  const targets = [
    { ...actor, id: 2, hp: 30 },
    { ...actor, id: 3 },
    { ...actor, id: 4, hp: 50 },
  ];
  const probabilities = botTargetProbabilities(targets.map(({ hp }) => hp), '', {
    actor, players: [actor, ...targets], targets,
  });
  assert.equal(probabilities[0], 0);
  assert.ok(probabilities[1] > 0);
  assert.ok(probabilities[2] > 0);
  const tied = targets.map((target) => ({ ...actor, id: target.id }));
  assert.deepEqual(botTargetProbabilities(tied.map(({ hp }) => hp), '', {
    actor, players: [actor, ...tied], targets: tied,
  }), [1 / 3, 1 / 3, 1 / 3]);
});

test('one boundary draw can admit identical opponents while aiming down', () => {
  const actor = { id: 1, hp: 40, mp: 10, cp: 20 };
  const targets = [
    { ...actor, id: 2, hp: 10 },
    { ...actor, id: 3 },
    { ...actor, id: 4 },
    { ...actor, id: 5, hp: 38, mp: 13 },
    { ...actor, id: 6, hp: 50 },
  ];
  let draws = 0;
  const probabilities = (allowTies) => botTargetProbabilities(targets.map(({ hp }) => hp), '', {
    actor, players: [actor, ...targets], targets,
    drawExactTieBoundary: () => {
      draws++;
      return allowTies;
    },
  });
  assert.deepEqual(probabilities(false), [1, 0, 0, 0, 0]);
  const admitted = probabilities(true);
  assert.ok(admitted.slice(0, 3).every((probability) => probability > 0));
  assert.deepEqual(admitted.slice(3), [0, 0]);
  assert.equal(draws, 2);
});

test('the running battle passes the acting bot status into target selection', () => {
  const actor = { id: 1, hp: 95, mp: 10, cp: 10, items: [] };
  const enemies = [
    { id: 2, hp: 10, mp: 10, cp: 10, items: [] },
    { id: 3, hp: 90, mp: 10, cp: 10, items: [] },
  ];
  const game = { ...createGame(), players: [actor, ...enemies] };
  const battle = new Battle(game, new FixedDrawRandom(0.6));
  assert.ok(enemies.some(({ id }) => id === battle.chooseBotTarget(enemies)));
  actor.hp = 80;
  assert.equal(battle.chooseBotTarget(enemies), 3);
  actor.hp = 5;
  const weakActorTargets = botTargetProbabilities(enemies.map(({ hp }) => hp), '', {
    actor, players: [actor, ...enemies], targets: enemies,
  });
  assert.ok(weakActorTargets.every((probability) => probability > 0));
});
