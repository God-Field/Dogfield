/**
 * Proposed regression tests for the Magical Stick + MP-cost audit.
 *
 * Run with the rest of the server suite through tests/run.mjs.
 */
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
  items: items.map((modelId, index) => ({ id: index + 1, modelId })),
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
  const game = createGame([attacker, defender, ...extraPlayers]);
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', {
    itemIds: attackerItems.map((unusedValue, index) => index + 1),
    targetPlayerId: 2,
  });
  return { attacker, defender, game, battle };
};

const finishMirage = (battle) => {
  let guard = 0;
  while (battle.attack && guard++ < 10) {
    battle.submit(
      battle.findPlayer(battle.expectedCommandPlayerId).userId,
      {},
    );
  }
};

// Official: cw50 u26 (Stick + Aura, MP 10). Cost 6, base 8, Aura 16.
test('Magical Stick pays Aura before doubling', () => {
  const { defender, battle } = attack([58, 231], [], { attackerMp: 10 });
  assert.equal(battle.currentAttack.atk, 8);
  battle.submit('u2', {});
  assert.equal(defender.hp, 24, '16 damage');
  assert.equal(battle.findPlayer(1).mp, 0);
});

// Official: earth-exchange-2 game-4 u22 (Stick + Mirage, MP 7).
// Cost 5, base 4, one base per target; the official sample had seven targets,
// this test uses three for brevity.
test('Magical Stick pays Mirage before doubling and keeps one base per target', () => {
  const extraPlayers = [createPlayer(3), createPlayer(4)];
  const { defender, game, battle } = attack([58, 232], [], {
    attackerMp: 7,
    extraPlayers,
  });
  assert.equal(game.attacks.length, 3);
  for (const queuedAttack of game.attacks) {
    assert.equal(queuedAttack.atk, 4);
  }
  finishMirage(battle);
  assert.equal(defender.hp, 36);
  assert.equal(extraPlayers[0].hp, 36);
  assert.equal(extraPlayers[1].hp, 36);
});

// No official sample. Composition of the verified Aura and Mirage rules.
test('Magical Stick + Mirage + Aura applies both costs before Aura doubles', () => {
  const extraPlayer = createPlayer(3);
  const { defender, game, battle } = attack([58, 232, 231], [], {
    attackerMp: 20,
    extraPlayers: [extraPlayer],
  });
  // cost 11 -> base 18 -> Aura 36 per target
  assert.equal(game.attacks.length, 2);
  for (const queuedAttack of game.attacks) {
    assert.equal(queuedAttack.atk, 18);
  }
  finishMirage(battle);
  assert.equal(defender.hp, 4);
  assert.equal(extraPlayer.hp, 4);
});

// No stick + cutCost official sample; 574 clean general cutCost samples.
test('cutCost frees the Magical Stick Aura/Mirage cost', () => {
  const aura = attack([58, 231, 204], [], { attackerMp: 10 });
  aura.battle.submit('u2', {});
  assert.equal(aura.defender.hp, 0, 'Aura: (2*10)*2 = 40');

  const mirageExtra = createPlayer(3);
  const mirage = attack([58, 232, 204], [], {
    attackerMp: 10,
    extraPlayers: [mirageExtra],
  });
  finishMirage(mirage.battle);
  assert.equal(mirage.defender.hp, 20);
  assert.equal(mirageExtra.hp, 20);
});

// Official client validation: availableMp < calculateMpCost -> 'miracles'.
test('Magical Stick with insufficient MP is rejected', () => {
  assert.throws(
    () => attack([58, 232], [], { attackerMp: 4 }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => attack([58, 231], [], { attackerMp: 5 }),
    (error) => error.status === 400,
  );
});

// Official: 64 MP-0 samples omit attack.atk; 8 more resolve as zero.
test('Magical Stick at MP 0 omits the zero attack override and resolves safe', () => {
  const { defender, battle } = attack([58], [], { attackerMp: 0 });
  assert.equal(
    Object.hasOwn(battle.currentAttack, 'atk'),
    false,
    'official omits atk when the computed override is zero',
  );
  battle.submit('u2', {});
  assert.equal(defender.hp, 40);
});

test('Magical Stick at MP 0 accepts armor defense against another player', () => {
  const { defender, game, battle } = attack([58], [113], {
    attackerMp: 0,
  });

  assert.equal(battle.currentAttack.targetPlayerId, defender.id);
  assert.equal(Object.hasOwn(battle.currentAttack, 'atk'), false);
  assert.doesNotThrow(() => {
    battle.submit('u2', { itemIds: [1] });
  });

  const defenseEvent = game.events.find(
    (event) => event.action === 'useDefenseItems',
  );
  assert.deepEqual(
    defenseEvent.items.map((slot) => slot.modelId),
    [113],
  );
  assert.ok(game.events.some((event) => event.action === 'safe'));
  assert.equal(defender.hp, 40);
  assert.equal(defender.items.some((slot) => slot.modelId === 113), false);
});

class EarthMagicalStickRandom extends Random {
  chance(label, percent) {
    if (label === 'guardianAttack') {
      return true;
    }
    if (label === 'guardianSpecial') {
      return false;
    }
    return super.chance(label, percent);
  }

  pick(label, values, weight) {
    if (label === 'guardianItem') {
      const magicalStick = values.find((definition) => definition.id === 58);
      assert.ok(magicalStick, 'Earth can select Magical Stick');
      return magicalStick;
    }
    if (label === 'guardianTarget') {
      return values.find((player) => player.id === 1);
    }
    if (label === 'bounceTarget') {
      return values.find((player) => player.id === 2);
    }
    return super.pick(label, values, weight);
  }
}

const guardianStickCases = [
  { ownerMP: 6, defenseItems: [], description: 'positive MP without defense' },
  { ownerMP: 0, defenseItems: [], description: 'zero MP without defense' },
  { ownerMP: 0, defenseItems: [113], description: 'zero MP with armor defense' },
];

for (let playerCount = 2; playerCount <= 9; playerCount++) {
  for (const scenario of guardianStickCases) {
    test(`Earth Magical Stick: ${scenario.description}, ${playerCount} players`, () => {
      const defender = createPlayer(1, scenario.defenseItems);
      defender.mp = 17;
      const players = [defender];
      for (let playerId = 2; playerId <= playerCount; playerId++) {
        players.push(createPlayer(playerId, [6]));
      }
      const guardianOwner = players.at(-1);
      guardianOwner.guardian = 'earth';
      guardianOwner.mp = scenario.ownerMP;
      const game = createGame(players);
      game.guardianPlayerIds = [guardianOwner.id];
      const battle = new Battle(game, new EarthMagicalStickRandom(3));

      battle.finishTurn({ gift: false });

      const guardianEvent = game.events.find(
        (event) => event.action === 'attackByGuardian',
      );
      assert.deepEqual(guardianEvent, {
        action: 'attackByGuardian',
        attack: {
          playerId: guardianOwner.id,
          guardian: 'earth',
          itemModelIds: [58],
        },
      });
      const expectedAttack = {
        ...guardianEvent.attack,
        targetPlayerId: defender.id,
      };
      if (scenario.ownerMP > 0) {
        expectedAttack.atk = scenario.ownerMP * 2;
      }
      assert.deepEqual(battle.currentAttack, expectedAttack);
      assert.equal(battle.expectedCommandPlayerId, defender.id);
      assert.equal(guardianOwner.mp, 0);
      assert.equal(defender.mp, 17, 'conversion consumes the guardian owner MP');
      assert.deepEqual(guardianOwner.items, [{ id: 1, modelId: 6 }]);
      assert.deepEqual(game.events.map((event) => event.action), [
        'attackByGuardian',
        'setTargetPlayer',
      ]);

      battle.submit(defender.userId, {
        itemIds: scenario.defenseItems.map((unusedValue, index) => index + 1),
      });

      assert.equal(defender.hp, 40 - scenario.ownerMP * 2);
      assert.equal(guardianOwner.mp, 0);
      assert.equal(battle.attack, undefined, 'guardian attack finishes normally');
      const defenseEvent = game.events.find(
        (event) => event.action === 'useDefenseItems',
      );
      assert.ok(defenseEvent);
      assert.deepEqual(
        (defenseEvent.items ?? []).map((slot) => slot.modelId),
        scenario.defenseItems,
      );
      if (scenario.ownerMP === 0) {
        assert.ok(game.events.some((event) => event.action === 'safe'));
        assert.equal(game.events.some((event) => event.action === 'dealDamage'), false);
      } else {
        const damageEvent = game.events.find(
          (event) => event.action === 'dealDamage',
        );
        assert.equal(damageEvent.damage, scenario.ownerMP * 2);
      }
      assert.ok(game.events.some((event) => event.action === 'advanceGF'));
      assert.equal(Object.hasOwn(guardianEvent.attack, 'atk'), false);
    });
  }
}

const stickRedirects = [
  { modelId: 190, action: 'reflect' },
  { modelId: 21, action: 'bounce' },
];

for (const attackSource of ['player', 'guardian']) {
  for (const redirect of stickRedirects) {
    for (const ownerMP of [0, 6]) {
      test(`${attackSource} Magical Stick preserves ${ownerMP} MP conversion through ${redirect.action} and reload`, () => {
        const defender = createPlayer(1, [redirect.modelId]);
        defender.mp = 17;
        const attackOwner = createPlayer(2, attackSource === 'player' ? [58] : []);
        attackOwner.mp = ownerMP;
        const game = createGame([defender, attackOwner]);
        if (attackSource === 'guardian') {
          attackOwner.guardian = 'earth';
          game.guardianPlayerIds = [attackOwner.id];
        } else {
          game.attackTurnPlayerId = attackOwner.id;
        }
        let battle = new Battle(game, new EarthMagicalStickRandom(3));
        if (attackSource === 'guardian') {
          battle.finishTurn({ gift: false });
        } else {
          battle.submit(attackOwner.userId, {
            itemIds: [1],
            targetPlayerId: defender.id,
          });
        }
        assert.equal(attackOwner.mp, 0);
        assert.equal(battle.currentAttack.atk ?? 0, ownerMP * 2);

        battle.submit(defender.userId, { itemIds: [1] });

        assert.ok(game.events.some((event) => event.action === redirect.action));
        assert.equal(battle.currentAttack.playerId, defender.id);
        assert.equal(battle.currentAttack.targetPlayerId, attackOwner.id);
        assert.equal(battle.currentAttack.guardian, undefined);
        assert.equal(battle.currentAttack.atk ?? 0, ownerMP * 2);
        assert.equal(Object.hasOwn(battle.currentAttack, 'atk'), ownerMP !== 0);
        assert.equal(defender.mp, 17, 'redirect does not convert the new attacker MP');

        battle = new Battle(structuredClone(game), new EarthMagicalStickRandom(3));
        battle.submit(attackOwner.userId, {});

        assert.equal(battle.requirePlayer(attackOwner.id).hp, 40 - ownerMP * 2);
        assert.equal(battle.requirePlayer(attackOwner.id).mp, 0);
        assert.equal(battle.requirePlayer(defender.id).mp, 17);
        assert.equal(battle.attack, undefined);
        assert.ok(battle.game.events.some((event) => event.action === 'advanceGF'));
      });
    }
  }
}

// Official ordering evidence: Dragon Claws + Aura + Wand = 15*2+5.
test('Aura doubles only the cards before it', () => {
  const first = attack([58, 231, 31], [], { attackerMp: 10 });
  first.battle.submit('u2', {});
  assert.equal(first.defender.hp, 16, '(8*2)+8 = 24 damage');

  const second = attack([58, 31, 231], [], { attackerMp: 10 });
  second.battle.submit('u2', {});
  assert.equal(second.defender.hp, 8, '(8+8)*2 = 32 damage');
});
