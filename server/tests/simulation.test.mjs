import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle, startBattle } from '../battle/battle.ts';
import { Random } from '../random.ts';
import { itemCatalog, getItemDefinition } from '../engine.ts';
import { HttpError } from '../errors.ts';
test('complete seeded local games, including Apocalypse and guardians', () => {
  let completed = 0;
  let decisions = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const random = new Random(seed);
    const users = Array.from(
      {
        length: (seed % 7) + 2,
      },
      (unusedValue, index) => ({
        userId: `bot${index}`,
        name: `Bot ${index}`,
        isBot: true,
      }),
    );
    const game = startBattle(users, {
      random,
      tiebreakGF: seed % 2 ? 1 : 50,
    });
    for (let step = 0; step < 500 && !game.isOver; step++) {
      const battle = new Battle(game, random);
      const choice = battle.botCommand();
      assert.ok(choice, `seed ${seed} step ${step}`);
      try {
        battle.submit(choice.player.userId, choice.command);
      } catch (error) {
        throw new Error(
          `seed ${seed} step ${step}: ${JSON.stringify(choice.command)}\n${error.stack}`,
        );
      }
      decisions++;
      for (const player of game.players) {
        for (const stat of ['hp', 'mp', 'cp']) {
          assert.ok(
            Number.isFinite(player[stat]) &&
              player[stat] >= 0 &&
              player[stat] <= 99,
            `seed ${seed} ${stat}`,
          );
        }
      }
      assert.equal(
        new Set(game.players.map((player) => player.id)).size,
        users.length,
      );
      for (const player of game.players) {
        const items = player.items ?? [];
        const slots = items.filter((itemSlot) => itemSlot.modelId);
        assert.equal(
          new Set(slots.map((itemSlot) => itemSlot.id)).size,
          slots.length,
        );
        assert.ok(items.length <= 18);
      }
    }
    if (game.isOver) {
      completed++;
    }
  }

  assert.equal(completed, 24);
  assert.ok(decisions > 100);
});
test('String of Fate bot seeds complete without a placeholder crash', () => {
  // Seed 128 reproduced `No element` before the String of Fate fix; seed 846
  // is the reported failure from the bot throughput run.
  for (const seed of [128, 846]) {
    const random = new Random(seed);
    const users = Array.from(
      {
        length: (seed % 7) + 2,
      },
      (unusedValue, index) => ({
        userId: `bot${index}`,
        name: `Bot ${index}`,
        isBot: true,
      }),
    );
    const game = startBattle(users, {
      random,
      tiebreakGF: seed % 2 ? 1 : 50,
    });
    let decisions = 0;
    for (let step = 0; step < 500 && !game.isOver; step++) {
      const battle = new Battle(game, random);
      const choice = battle.botCommand();
      assert.ok(choice, `seed ${seed} step ${step}`);
      try {
        battle.submit(choice.player.userId, choice.command);
      } catch (error) {
        throw new Error(
          `seed ${seed} step ${step}: ${JSON.stringify(choice.command)}\n${error.stack}`,
        );
      }
      decisions++;
    }
    assert.equal(game.isOver, true, `seed ${seed} completed`);
    assert.ok(decisions > 0, `seed ${seed} made decisions`);
  }
});
test('every selectable catalog item can resolve through the authoritative action path', () => {
  const player = (id, items) => ({
    id,
    userId: `u${id}`,
    name: `P${id}`,
    hp: 99,
    mp: 99,
    cp: 99,
    items: items.map((modelId, index) => ({
      id: index + 1,
      modelId,
    })),
  });
  const excluded = new Set(['discard', 'sacrifice', 'sell']);
  let checked = 0;
  for (const itemDefinition of itemCatalog.models.filter(
    (candidateItemDefinition) =>
      candidateItemDefinition.isItemTargetingCommand() &&
      !excluded.has(candidateItemDefinition.ability),
  )) {
    const random = new Random(87);
    const game = {
      players: [player(1, [itemDefinition.id]), player(2, [113])],
      gf: 1,
      attackTurnPlayerId: 1,
      updateCount: 1,
      events: [],
    };
    const battle = new Battle(game, random);
    const command = {
      itemIds: [1],
      ...(itemDefinition.isDirectTargetCommand()
        ? {
            targetPlayerId: 2,
          }
        : {}),
      ...(itemDefinition.ability === 'exchange'
        ? {
            mp: 99,
            cp: 99,
          }
        : {}),
    };
    try {
      battle.submit('u1', command);
      for (
        let index = 0;
        index < 20 && battle.attack && !game.isOver;
        index++
      ) {
        const pendingAttack = battle.attack;
        battle.submit(
          pendingAttack.buyingItemModelId
            ? 'u1'
            : battle.requirePlayer(pendingAttack.targetPlayerId).userId,
          pendingAttack.buyingItemModelId
            ? {
                bought: false,
              }
            : {},
        );
      }
    } catch (error) {
      throw new Error(
        `item ${itemDefinition.id} ${itemDefinition.name}: ${error.stack}`,
      );
    }
    checked++;
  }

  assert.ok(checked > 100);
});
