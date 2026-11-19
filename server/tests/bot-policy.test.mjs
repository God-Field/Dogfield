import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../battle/battle.ts';
import { getItemDefinition } from '../engine.ts';
import { Random } from '../random.ts';
import {
  botShouldAcceptBuy,
  botTargetProbabilities,
} from '../battle/bot-policy.ts';

const createPlayer = (id, items = []) => ({
  id,
  userId: `u${id}`,
  name: `Player ${id}`,
  hp: 40,
  mp: 50,
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

const createPendingAttack = (attackerItems, defenderItems, seed = 1) => {
  const attacker = createPlayer(1, attackerItems);
  const defender = createPlayer(2, defenderItems);
  const game = createGame([attacker, defender]);
  const battle = new Battle(game, new Random(seed));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  return { attacker, defender, game, battle };
};

test('bots forgive when no legal defense item exists', () => {
  const { defender, battle } = createPendingAttack([6], [211]);
  defender.isBot = true;
  defender.mp = 0;
  assert.deepEqual(battle.botCommand().command, {});
});

test('bots leave trade attacks unanswered', () => {
  const { defender, battle } = createPendingAttack([5], [123, 135]);
  defender.isBot = true;
  assert.deepEqual(battle.botCommand().command, {});
});

test('bots use armor combinations against a strong attack', () => {
  let forgiveCount = 0;
  let bestDefenseCount = 0;
  const sampleCount = 300;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const { defender, battle } = createPendingAttack(
      [54],
      [123, 135],
      seed,
    );
    defender.isBot = true;
    const command = battle.botCommand().command;
    if (!command.itemIds?.length) {
      forgiveCount++;
      continue;
    }
    assert.equal(
      command.itemIds.every((itemId) => itemId === 1 || itemId === 2),
      true,
      'only the legal armor slots are selected',
    );
    if (command.itemIds.length === 2) {
      bestDefenseCount++;
    }
  }
  const forgiveRate = forgiveCount / sampleCount;
  assert.ok(
    forgiveRate > 0.01 && forgiveRate < 0.12,
    `expected occasional forgiveness against a strong attack, got ${forgiveRate}`,
  );
  assert.ok(
    bestDefenseCount > 100,
    'multi-item armor combinations are reachable',
  );
});

test('confused bots use the same conditional defense policy', () => {
  let forgiveCount = 0;
  const sampleCount = 300;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const { defender, battle } = createPendingAttack(
      [54],
      [123, 135],
      seed,
    );
    defender.isBot = true;
    defender.confusionCount = 3;
    const command = battle.botCommand().command;
    if (!command.itemIds?.length) {
      forgiveCount++;
    }
  }
  const forgiveRate = forgiveCount / sampleCount;
  assert.ok(
    forgiveRate > 0.01 && forgiveRate < 0.12,
    `confused bots should use the calm policy, got ${forgiveRate}`,
  );
});

test('bot Buy decisions follow card roles and price limits', () => {
  const battle = new Battle(createGame([createPlayer(1), createPlayer(2)]), new Random(1));
  const offers = [
    { modelId: 113, accepted: true },
    { modelId: 149, accepted: true },
    { modelId: 165, accepted: true },
    { modelId: 169, accepted: true },
    { modelId: 175, accepted: true },
    { modelId: 148, accepted: false },
    { modelId: 93, accepted: false },
    { modelId: 200, accepted: true },
    { modelId: 198, accepted: false },
    { modelId: 203, accepted: false },
    { modelId: 209, accepted: false },
    { modelId: 55, accepted: false },
    { modelId: 56, accepted: true },
    { modelId: 39, accepted: true },
    { modelId: 168, accepted: false },
    { modelId: 178, accepted: false },
  ];
  for (const offer of offers) {
    for (let seed = 1; seed <= 10; seed++) {
      battle.random = new Random(seed);
      assert.equal(battle.chooseBotBuyDecision(offer.modelId), offer.accepted);
    }
  }
});

test('bot commands always pass the shared command validator', () => {
  // This hand reproduced an invalid empty prayer fallback while the player
  // still held Final Tusk, which the shared validator rejects.
  const player = createPlayer(1, [
    208, 217, 228, 115, 116, 176, 117,
    213, 161, 219, 158, 180, 137, 29,
  ]);
  player.isBot = true;
  const game = createGame([player, createPlayer(2)]);
  game.attackTurnPlayerId = 1;
  for (let seed = 1; seed <= 200; seed++) {
    const candidateGame = structuredClone(game);
    const battle = new Battle(candidateGame, new Random(seed));
    const choice = battle.botCommand();
    assert.ok(choice, `seed ${seed} returned no command`);
    assert.doesNotThrow(
      () => battle.selectCommandItems(choice.player, choice.command, false),
      `seed ${seed} returned invalid command ${JSON.stringify(choice.command)}`,
    );
  }
});

test('bots strongly prefer healing at low HP', () => {
  let healCount = 0;
  const sampleCount = 200;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const player = createPlayer(1, [6, 191]);
    player.hp = 8;
    player.isBot = true;
    const game = createGame([player, createPlayer(2)]);
    game.attackTurnPlayerId = 1;
    const battle = new Battle(game, new Random(seed));
    const choice = battle.botCommand();
    assert.equal(choice.player, player);
    if (choice.command.itemIds?.[0] === 2) {
      healCount++;
    }
  }
  const healRate = healCount / sampleCount;
  assert.ok(healRate > 0.85, `expected healing at HP 8, got ${healRate}`);
});

const createRankedEnemies = (count) =>
  Array.from({ length: count }, (unusedValue, index) => {
    const enemy = createPlayer(index + 2);
    enemy.hp = 10 + index * 3;
    return enemy;
  });

const sampleTargetShares = (enemies, definition, sampleCount = 2000) => {
  const counts = new Map(enemies.map((enemy) => [enemy.id, 0]));
  const probabilities = botTargetProbabilities(
    enemies.map((enemy) => enemy.hp),
    definition?.ability ?? '',
  );
  for (let seed = 1; seed <= sampleCount; seed++) {
    const targetPlayerId = new Random(seed).pick(
      'botTarget',
      enemies.map((enemy, rank) => ({ enemy, weight: probabilities[rank] })),
      (candidate) => candidate.weight,
    ).enemy.id;
    counts.set(targetPlayerId, counts.get(targetPlayerId) + 1);
  }
  return {
    weakest: counts.get(enemies[0].id) / sampleCount,
    strongest: counts.get(enemies.at(-1).id) / sampleCount,
    middle: counts.get(enemies[Math.floor(enemies.length / 2)].id) / sampleCount,
  };
};

test('plain bot attacks use the small endpoint focus', () => {
  const enemies = createRankedEnemies(8);
  const shares = sampleTargetShares(enemies, undefined, 4000);
  assert.ok(
    shares.weakest > 0.17 && shares.weakest < 0.24,
    `plain attacks should have a small weakest focus, got ${shares.weakest}`,
  );
  assert.ok(
    shares.strongest > 0.17 && shares.strongest < 0.24,
    `plain attacks should have a small strongest focus, got ${shares.strongest}`,
  );
  assert.ok(
    shares.middle > 0.07 && shares.middle < 0.13,
    `plain attacks should leave the middle near uniform, got ${shares.middle}`,
  );
});

test('bot targeting prefers healthier targets for drain and status cards', () => {
  const enemies = createRankedEnemies(8);
  const absorbShares = sampleTargetShares(
    enemies,
    getItemDefinition(27),
  );
  assert.ok(
    absorbShares.weakest > 0.11 && absorbShares.weakest < 0.2,
    `absorbHP should retain a small weakest rate, got ${absorbShares.weakest}`,
  );
  assert.ok(
    absorbShares.strongest > 0.20 && absorbShares.strongest < 0.28,
    `absorbHP should prefer the strongest, got ${absorbShares.strongest}`,
  );

  const otherShares = sampleTargetShares(
    enemies,
    getItemDefinition(205),
  );
  assert.ok(
    otherShares.weakest > 0.14 && otherShares.weakest < 0.22,
    `other targeted abilities should have a mild weakest rate, got ${otherShares.weakest}`,
  );
  assert.ok(
    otherShares.strongest > 0.22 && otherShares.strongest < 0.32,
    `other targeted abilities should prefer the strongest, got ${otherShares.strongest}`,
  );
});

test('a bot above the lobby mean targets only players below the shared boundary', () => {
  const actor = createPlayer(1);
  Object.assign(actor, { hp: 70, mp: 10, cp: 10 });
  const loneLowerTarget = createPlayer(2);
  Object.assign(loneLowerTarget, { hp: 10, mp: 10, cp: 10 });
  const upperTarget = createPlayer(3);
  Object.assign(upperTarget, { hp: 80, mp: 10, cp: 10 });
  const otherUpperTarget = createPlayer(4);
  Object.assign(otherUpperTarget, { hp: 55, mp: 10, cp: 10 });
  const targets = [loneLowerTarget, otherUpperTarget, upperTarget];
  const probabilities = botTargetProbabilities(
    targets.map((target) => target.hp),
    '',
    {
      actor,
      players: [actor, ...targets],
      targets,
    },
  );

  assert.ok(probabilities[0] > 0);
  assert.equal(probabilities[1], 0);
  assert.equal(probabilities[2], 0);
});

test('with three living players the top strength group targets the other group', () => {
  const actor = createPlayer(1);
  Object.assign(actor, { hp: 30, mp: 10, cp: 10 });
  const weakest = createPlayer(2);
  Object.assign(weakest, { hp: 10, mp: 10, cp: 10 });
  const strongest = createPlayer(3);
  Object.assign(strongest, { hp: 50, mp: 10, cp: 10 });
  const targets = [weakest, strongest];
  const probabilities = botTargetProbabilities(
    targets.map((target) => target.hp),
    '',
    { actor, players: [actor, ...targets], targets },
  );

  assert.equal(probabilities[0], 0);
  assert.equal(probabilities[1], 1);
});

test('bot targeting picks a legal enemy when its estimated opposite group has none', () => {
  const actor = createPlayer(1);
  Object.assign(actor, { hp: 70, mp: 10, cp: 10, team: 1 });
  const teammate = createPlayer(2);
  Object.assign(teammate, { hp: 10, mp: 10, cp: 10, team: 1 });
  const sameGroupEnemy = createPlayer(3);
  Object.assign(sameGroupEnemy, { hp: 80, mp: 10, cp: 10, team: 2 });
  const game = createGame([actor, teammate, sameGroupEnemy]);
  const battle = new Battle(game, new Random(1));

  assert.equal(battle.chooseBotTarget([sameGroupEnemy]), sameGroupEnemy.id);
  const missingActorBattle = new Battle(createGame([sameGroupEnemy]), new Random(1));
  assert.equal(missingActorBattle.chooseBotTarget([sameGroupEnemy]), undefined);
});

test('bot Buy targets a uniform living enemy', () => {
  class NoPrayerRandom extends Random {
    chance(label, percent) {
      if (label === 'botPrayer') return false;
      return super.chance(label, percent);
    }
  }
  const player = createPlayer(1, [5]);
  player.isBot = true;
  const enemies = createRankedEnemies(4);
  const game = createGame([player, ...enemies]);
  game.attackTurnPlayerId = 1;
  const counts = new Map(enemies.map((enemy) => [enemy.id, 0]));
  const sampleCount = 2000;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const choice = new Battle(game, new NoPrayerRandom(seed)).botCommand();
    const targetPlayerId = choice.command.targetPlayerId;
    assert.ok(counts.has(targetPlayerId), 'Buy must target a living enemy');
    counts.set(targetPlayerId, counts.get(targetPlayerId) + 1);
  }
  for (const enemy of enemies) {
    const share = counts.get(enemy.id) / sampleCount;
    assert.ok(
      share > 0.2 && share < 0.3,
      `Buy should be uniform, got ${share} for player ${enemy.id}`,
    );
  }
});

test('bot Exchange uses the official deterministic fill rule', () => {
  class NoPrayerRandom extends Random {
    chance(label, percent) {
      if (label === 'botPrayer') return false;
      return super.chance(label, percent);
    }
  }
  const cases = [
    { stats: [20, 20, 20], expected: { mp: 30, cp: 0 } },
    { stats: [30, 30, 40], expected: { mp: 35, cp: 15 } },
    { stats: [10, 10, 10], expected: { mp: 0, cp: 0 } },
  ];
  for (const testCase of cases) {
    const player = createPlayer(1, [3]);
    player.isBot = true;
    [player.hp, player.mp, player.cp] = testCase.stats;
    const game = createGame([player, createPlayer(2)]);
    game.attackTurnPlayerId = 1;
    const choice = new Battle(game, new NoPrayerRandom(1)).botCommand();
    assert.ok(choice);
    assert.equal(choice.command.mp, testCase.expected.mp);
    assert.equal(choice.command.cp, testCase.expected.cp);
  }
});

test('calm bot Exchange changes HP priority at the Apocalypse boundary', () => {
  const cases = [
    { total: 52, gf: 49, expected: [30, 22, 0] },
    { total: 52, gf: 50, expected: [50, 2, 0] },
    { total: 52, gf: 51, expected: [50, 2, 0] },
    { total: 46, gf: 50, expected: [46, 0, 0] },
    { total: 74, gf: 50, expected: [50, 24, 0] },
    { total: 86, gf: 50, expected: [50, 30, 6] },
    { total: 92, gf: 50, expected: [50, 30, 12] },
    { total: 95, gf: 50, expected: [50, 30, 15] },
    { total: 100, gf: 50, expected: [50, 35, 15] },
    { total: 297, gf: 50, expected: [99, 99, 99] },
  ];
  for (const testCase of cases) {
    const player = createPlayer(1, [3]);
    player.isBot = true;
    player.hp = Math.min(testCase.total, 99);
    player.mp = Math.min(testCase.total - player.hp, 99);
    player.cp = testCase.total - player.hp - player.mp;
    const game = createGame([player, createPlayer(2)]);
    game.gf = testCase.gf;
    game.tiebreakGF = 50;
    const battle = new Battle(game, new Random(1));
    const command = battle.buildBotAttackCommand(player, player.items[0], getItemDefinition(3), [game.players[1]]);
    assert.ok(command);
    battle.submit(player.userId, command);
    const exchange = game.events.find((event) => event.action === 'exchange');
    assert.ok(exchange);
    assert.deepEqual([exchange.hp ?? 0, exchange.mp ?? 0, exchange.cp ?? 0], testCase.expected);
  }
});

test('bot Sell chooses the highest-price partner and never itself', () => {
  class SellRandom extends Random {
    pick(label, values, weight) {
      if (label === 'botAttackItem') {
        return values.find((itemSlot) => itemSlot.modelId === 4);
      }
      return super.pick(label, values, weight);
    }
  }
  const seller = createPlayer(1, [4, 6, 93]);
  seller.isBot = true;
  const weakEnemy = createPlayer(2);
  weakEnemy.hp = 5;
  const strongEnemy = createPlayer(3);
  strongEnemy.hp = 40;
  const game = createGame([seller, weakEnemy, strongEnemy]);
  game.attackTurnPlayerId = 1;
  const choice = new Battle(game, new SellRandom(1)).botCommand();
  assert.ok(choice);
  assert.deepEqual(choice.command.itemIds, [1, 3]);
  assert.notEqual(choice.command.targetPlayerId, seller.id);
});

test('bot Sell weights the target by HP rank and never itself', () => {
  class SellRandom extends Random {
    pick(label, values, weight) {
      if (label === 'botAttackItem') {
        return values.find((itemSlot) => itemSlot.modelId === 4);
      }
      return super.pick(label, values, weight);
    }
  }
  const seller = createPlayer(1, [4, 6, 93]);
  seller.isBot = true;
  const enemies = createRankedEnemies(4);
  const game = createGame([seller, ...enemies]);
  game.attackTurnPlayerId = 1;
  const counts = new Map(enemies.map((enemy) => [enemy.id, 0]));
  const sampleCount = 3000;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const choice = new Battle(game, new SellRandom(seed)).botCommand();
    const targetPlayerId = choice.command.targetPlayerId;
    assert.notEqual(targetPlayerId, seller.id);
    assert.ok(counts.has(targetPlayerId));
    counts.set(targetPlayerId, counts.get(targetPlayerId) + 1);
  }
  const shares = enemies.map((enemy) => counts.get(enemy.id) / sampleCount);
  assert.ok(
    shares[0] > 0.06 && shares[0] < 0.15,
    `weakest Sell target should be about 10%, got ${shares[0]}`,
  );
  assert.ok(
    shares[3] > 0.34 && shares[3] < 0.46,
    `strongest Sell target should be about 40%, got ${shares[3]}`,
  );
  for (let index = 1; index < shares.length; index++) {
    assert.ok(
      shares[index] > shares[index - 1],
      'Sell target weight should increase with HP rank',
    );
  }
});

test('bot chooses its target after accounting for a follow-up miracle MP cost', () => {
  class FollowUpRandom extends Random {
    chance(label, percent) {
      if (label === 'botAttackExtraItem') return percent === 12;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'botAttackItem') return values.find(({ modelId }) => modelId === 16);
      return super.pick(label, values, weight);
    }
  }
  const actor = createPlayer(1, [16, 217]);
  Object.assign(actor, { isBot: true, mp: 16 });
  const enemies = [2, 3, 4].map((id) => createPlayer(id));
  for (const enemy of enemies) Object.assign(enemy, { hp: 37, mp: 10 });
  enemies[2].hp = 44;
  const choice = new Battle(createGame([actor, ...enemies]), new FollowUpRandom(1)).botCommand();
  assert.deepEqual(choice.command.itemIds, [1, 2]);
  assert.ok([enemies[0].id, enemies[1].id].includes(choice.command.targetPlayerId));
  assert.equal(actor.mp, 16);
});

test('bot Tear self-targets more often when few players are alive', () => {
  class NoPrayerRandom extends Random {
    chance(label, percent) {
      if (label === 'botPrayer') return false;
      return super.chance(label, percent);
    }
  }
  const sampleSelfRate = (enemyCount) => {
    const player = createPlayer(1, [202]);
    player.isBot = true;
    const enemies = createRankedEnemies(enemyCount);
    const game = createGame([player, ...enemies]);
    game.attackTurnPlayerId = 1;
    let selfCount = 0;
    const sampleCount = 2000;
    for (let seed = 1; seed <= sampleCount; seed++) {
      const choice = new Battle(game, new NoPrayerRandom(seed)).botCommand();
      if (choice.command.targetPlayerId === player.id) {
        selfCount++;
      }
    }
    return selfCount / sampleCount;
  };

  const closeSelfRate = sampleSelfRate(2);
  assert.ok(
    closeSelfRate > 0.04 && closeSelfRate < 0.1,
    `Tear should self-target about 7% with few living players, got ${closeSelfRate}`,
  );

  const farSelfRate = sampleSelfRate(6);
  assert.ok(
    farSelfRate > 0.01 && farSelfRate < 0.06,
    `Tear should self-target about 3% with many living players, got ${farSelfRate}`,
  );
});

test('confused Exchange omits the redundant self target', () => {
  const player = createPlayer(1, [3]);
  player.isBot = true;
  player.confusionCount = 1;
  const game = createGame([player, ...createRankedEnemies(2)]);
  game.attackTurnPlayerId = 1;
  const choice = new Battle(game, new Random(1)).botCommand();
  assert.ok(choice);
  assert.equal(Object.hasOwn(choice.command, 'targetPlayerId'), false);
});

test('confused Exchange preserves totals and caps and resolves zero HP death', () => {
  class ExchangeRandom extends Random {
    constructor(fraction) {
      super(1);
      this.fraction = fraction;
    }

    value(label) {
      if (label === 'confusionExchangeHp' || label === 'confusionExchangeMp') {
        return this.fraction;
      }
      assert.ok(!label.startsWith('guardianExchange'));
      return super.value(label);
    }
  }

  for (const totalStats of [8, 88, 110, 198, 250, 297]) {
    for (const randomFraction of [0, 0.5, 0.999999]) {
      const player = createPlayer(1, [3]);
      player.hp = Math.min(99, totalStats);
      player.mp = Math.min(99, totalStats - player.hp);
      player.cp = totalStats - player.hp - player.mp;
      player.isBot = true;
      player.confusionCount = 1;
      const game = createGame([player, createPlayer(2)]);
      const battle = new Battle(game, new ExchangeRandom(randomFraction));
      const choice = battle.botCommand();
      assert.ok(choice);
      assert.deepEqual(choice.command.itemIds, [1]);
      battle.submit(player.userId, choice.command);

      const exchange = game.events.find((event) => event.action === 'exchange');
      assert.ok(exchange);
      const actualStats = [exchange.hp ?? 0, exchange.mp ?? 0, exchange.cp ?? 0];
      assert.equal(actualStats.reduce((total, stat) => total + stat, 0), totalStats);
      assert.ok(actualStats.every((stat) => stat >= 0 && stat <= 99));
      if (actualStats[0] === 0) {
        assert.equal(player.dead, true);
        assert.ok(game.events.some((event) => event.action === 'die'));
      }
    }
  }
});

test('confused Exchange gives every ordered partition equal probability', () => {
  const outcomes = new Map();
  // Total 2 has six ordered partitions. This grid integrates both random
  // draws exactly: each HP bucket and conditional MP bucket divides six.
  for (let hpTicket = 0; hpTicket < 6; hpTicket++) {
    for (let mpTicket = 0; mpTicket < 6; mpTicket++) {
      class PartitionRandom extends Random {
        value(label) {
          if (label === 'confusionExchangeHp') {
            return (hpTicket + 0.5) / 6;
          }
          if (label === 'confusionExchangeMp') {
            return (mpTicket + 0.5) / 6;
          }
          return super.value(label);
        }
      }
      const player = createPlayer(1, [3]);
      Object.assign(player, { hp: 2, mp: 0, cp: 0, confusionCount: 1 });
      const game = createGame([player, createPlayer(2)]);
      const battle = new Battle(game, new PartitionRandom(1));
      const choice = battle.botCommand();
      assert.ok(choice);
      const mp = choice.command.mp;
      const cp = choice.command.cp;
      const key = [2 - mp - cp, mp, cp].join('/');
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
  }
  assert.deepEqual(
    [...outcomes.entries()].sort(),
    ['0/0/2', '0/1/1', '0/2/0', '1/0/1', '1/1/0', '2/0/0'].map(
      (partition) => [partition, 6],
    ),
  );
});

test('confused Exchange selects the weighted HP buckets for every valid total', () => {
  let hpFraction = 0;
  let mpFraction = 0;
  class PartitionRandom extends Random {
    value(label) {
      if (label === 'confusionExchangeHp') {
        return hpFraction;
      }
      if (label === 'confusionExchangeMp') {
        return mpFraction;
      }
      return super.value(label);
    }
  }

  for (let total = 0; total <= 297; total++) {
    const partitionsByHp = new Map();
    let partitionCount = 0;
    // Enumerate valid triples independently of the allocator's weight formula.
    for (let hp = 0; hp <= 99; hp++) {
      const mpOptions = [];
      for (let mp = 0; mp <= 99; mp++) {
        const cp = total - hp - mp;
        if (cp >= 0 && cp <= 99) {
          mpOptions.push(mp);
          partitionCount++;
        }
      }
      if (mpOptions.length > 0) {
        partitionsByHp.set(hp, mpOptions);
      }
    }
    const player = createPlayer(1, [3]);
    player.hp = Math.min(99, total);
    player.mp = Math.min(99, total - player.hp);
    player.cp = total - player.hp - player.mp;
    player.confusionCount = 1;
    const battle = new Battle(createGame([player, createPlayer(2)]), new PartitionRandom(1));
    let precedingCount = 0;
    for (const [hp, mpOptions] of partitionsByHp) {
      for (const edge of [0, 1]) {
        const offset = edge === 0 ? 0.25 : mpOptions.length - 0.25;
        hpFraction = (precedingCount + offset) / partitionCount;
        mpFraction = edge === 0 ? 0 : 0.999999;
        const command = battle.botCommand().command;
        const mp = mpOptions[edge === 0 ? 0 : mpOptions.length - 1];
        assert.deepEqual(
          [total - command.mp - command.cp, command.mp, command.cp],
          [hp, mp, total - hp - mp],
        );
      }
      precedingCount += mpOptions.length;
    }
  }
});

test('normal bots never target teammates', () => {
  const player = createPlayer(1, [6]);
  player.isBot = true;
  player.team = 1;
  const teammate = createPlayer(2, [6]);
  teammate.team = 1;
  const enemy = createPlayer(3, [6]);
  enemy.team = 2;
  const game = createGame([player, teammate, enemy]);
  game.attackTurnPlayerId = 1;
  for (let seed = 1; seed <= 200; seed++) {
    const choice = new Battle(game, new Random(seed)).botCommand();
    assert.equal(choice.command.targetPlayerId, enemy.id);
  }
});

test('bot HP boosts target the lowest-HP teammate below the bot HP', () => {
  const bot = createPlayer(1, [191]);
  bot.isBot = true;
  bot.team = 1;
  bot.hp = 35;
  const healthierTeammate = createPlayer(2);
  healthierTeammate.team = 1;
  healthierTeammate.hp = 24;
  const lowestHpTeammate = createPlayer(3);
  lowestHpTeammate.team = 1;
  lowestHpTeammate.hp = 18;
  const enemy = createPlayer(4);
  enemy.team = 2;
  enemy.hp = 1;
  const game = createGame([
    bot,
    healthierTeammate,
    lowestHpTeammate,
    enemy,
  ]);
  const battle = new Battle(game, new Random(1));

  const command = battle.buildBotAttackCommand(
    bot,
    bot.items[0],
    getItemDefinition(191),
    [enemy],
  );

  assert.equal(command.targetPlayerId, lowestHpTeammate.id);
});

test('bot HP boosts stay self-targeted when no teammate has lower HP', () => {
  const bot = createPlayer(1, [191]);
  bot.isBot = true;
  bot.team = 1;
  bot.hp = 20;
  const teammate = createPlayer(2);
  teammate.team = 1;
  teammate.hp = 20;
  const enemy = createPlayer(3);
  enemy.team = 2;
  enemy.hp = 5;
  const game = createGame([bot, teammate, enemy]);
  const battle = new Battle(game, new Random(1));

  const command = battle.buildBotAttackCommand(
    bot,
    bot.items[0],
    getItemDefinition(191),
    [enemy],
  );

  assert.equal(command.targetPlayerId, undefined);
});

test('bot MP boosts choose a living teammate', () => {
  const bot = createPlayer(1, [196]);
  bot.isBot = true;
  bot.team = 1;
  const firstTeammate = createPlayer(2);
  firstTeammate.team = 1;
  const secondTeammate = createPlayer(3);
  secondTeammate.team = 1;
  const enemy = createPlayer(4);
  enemy.team = 2;
  const game = createGame([bot, firstTeammate, secondTeammate, enemy]);
  const battle = new Battle(game, new Random(1));

  const command = battle.buildBotAttackCommand(
    bot,
    bot.items[0],
    getItemDefinition(196),
    [enemy],
  );

  assert.ok(
    [firstTeammate.id, secondTeammate.id].includes(command.targetPlayerId),
  );
});

test('bot curse removal targets a teammate with a removable curse', () => {
  const bot = createPlayer(1, [200]);
  bot.isBot = true;
  bot.team = 1;
  bot.curses = ['dream'];
  const teammate = createPlayer(2);
  teammate.team = 1;
  teammate.curses = ['fever'];
  const enemy = createPlayer(3);
  enemy.team = 2;
  enemy.curses = ['fog'];
  const game = createGame([bot, teammate, enemy]);
  const battle = new Battle(game, new Random(1));

  const command = battle.buildBotAttackCommand(
    bot,
    bot.items[0],
    getItemDefinition(200),
    [enemy],
  );

  assert.equal(command.targetPlayerId, teammate.id);
});

test('unarmed bots treat prayer as a real weighted option', () => {
  let prayerCount = 0;
  const sampleCount = 400;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const player = createPlayer(1, [191, 192]);
    player.isBot = true;
    const game = createGame([player, createPlayer(2)]);
    game.attackTurnPlayerId = 1;
    const choice = new Battle(game, new Random(seed)).botCommand();
    if (!choice.command.itemIds?.length) {
      prayerCount++;
    }
  }
  const prayerRate = prayerCount / sampleCount;
  assert.ok(
    prayerRate > 0.08 && prayerRate < 0.25,
    `expected the official unarmed prayer rate near 14%, got ${prayerRate}`,
  );
});

class ActiveDefenseRandom extends Random {
  chance(label) {
    return label !== 'botDefenseForgive';
  }

  pick(label, candidates) {
    return candidates[0];
  }
}

test('bots stop adding defense cards once the incoming damage is covered', () => {
  const { defender, game } = createPendingAttack([6], [123, 135]);
  const battle = new Battle(game, new ActiveDefenseRandom());
  const command = battle.chooseBotDefense(defender);
  assert.deepEqual(command.itemIds, [1]);
  assert.doesNotThrow(() => battle.selectCommandItems(defender, command, true));
});

test('bots can unlock a response by leading with an element filter', () => {
  const { defender, game } = createPendingAttack([63], [189, 21]);
  const battle = new Battle(game, new ActiveDefenseRandom());
  const command = battle.chooseBotDefense(defender);
  assert.deepEqual(command.itemIds, [1, 2]);
  assert.doesNotThrow(() => battle.selectCommandItems(defender, command, true));
});

test('Flash prevents bot defense follow-ups', () => {
  const { defender, game } = createPendingAttack([54], [123, 135]);
  defender.curses = ['flash'];
  const battle = new Battle(game, new ActiveDefenseRandom());
  const command = battle.chooseBotDefense(defender);
  assert.equal(command.itemIds.length, 1);
  assert.doesNotThrow(() => battle.selectCommandItems(defender, command, true));
});

test('bots never reuse a performed miracle as a defense', () => {
  const { defender, game } = createPendingAttack([211], [234]);
  defender.items[0].used = true;
  const battle = new Battle(game, new ActiveDefenseRandom());
  assert.deepEqual(battle.chooseBotDefense(defender), {});
});

test('normal and confused bot openings never reuse a performed miracle', () => {
  for (const confused of [false, true]) {
    const player = createPlayer(1, [211, 6]);
    player.isBot = true;
    player.items[0].used = true;
    if (confused) {
      player.confusionCount = 2;
    }
    const game = createGame([player, createPlayer(2)]);
    for (let seed = 1; seed <= 100; seed++) {
      const battle = new Battle(structuredClone(game), new Random(seed));
      const choice = battle.botCommand();
      assert.deepEqual(choice.command.itemIds, [2]);
      assert.doesNotThrow(() => battle.selectCommandItems(choice.player, choice.command, false));
    }
  }
});

test('prayer competes only with affordable legal openings', () => {
  class PrayerProbeRandom extends Random {
    prayerPercent = null;

    chance(label, percent) {
      if (label === 'botPrayer') {
        this.prayerPercent = percent;
        return false;
      }
      return super.chance(label, percent);
    }
  }

  const prayerChances = [];
  for (const models of [[191], [191, 211]]) {
    const player = createPlayer(1, models);
    player.mp = 0;
    player.isBot = true;
    const random = new PrayerProbeRandom(1);
    const battle = new Battle(createGame([player, createPlayer(2)]), random);
    const choice = battle.botCommand();
    assert.ok(choice);
    prayerChances.push(random.prayerPercent);
  }
  assert.ok(prayerChances[0] > 0);
  assert.equal(prayerChances[0], prayerChances[1]);
});

test('purchase rules generalize by item properties and never draw random values', () => {
  const weapon = { ...getItemDefinition(6), id: 9001, price: 10 };
  assert.equal(botShouldAcceptBuy(weapon), false);
  assert.equal(botShouldAcceptBuy({ ...weapon, isPlusAttack: true }), true);
  const armor = { ...getItemDefinition(113), id: 9002, price: 15, defense: 8 };
  assert.equal(botShouldAcceptBuy(armor), false);
  assert.equal(botShouldAcceptBuy({ ...armor, defense: 9 }), true);

  class NoPurchaseRollRandom extends Random {
    value(label) {
      throw new Error(`Unexpected random purchase draw: ${label}`);
    }
  }
  const battle = new Battle(createGame([createPlayer(1), createPlayer(2)]), new NoPurchaseRollRandom(1));
  assert.equal(battle.chooseBotBuyDecision(56), true);
  assert.equal(battle.chooseBotBuyDecision(55), false);
});
