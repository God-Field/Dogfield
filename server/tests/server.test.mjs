import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.ts';
import { createServer } from '../http/server.ts';
import { RoomService } from '../rooms/service.ts';
import { Battle, startBattle } from '../battle/battle.ts';
import { Random } from '../random.ts';
import { engine, itemCatalog, getItemDefinition } from '../engine.ts';
import { getDreamBucket, getDreamDisguisePool, selectDreamDisguise } from '../battle/dream.ts';
import { HttpError } from '../errors.ts';
const createPlayerFixture = (id, items = []) => ({
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
const createGameFixture = (players) => ({
  players,
  gf: 1,
  attackTurnPlayerId: 1,
  events: [],
  updateCount: 1,
});
const expectHttpError = (operation, expectedStatus) =>
  assert.throws(
    operation,
    (error) => error instanceof HttpError && error.status === expectedStatus,
  );
test('all translations contain the same item rules, with translated names', async () => {
  const languages = [
    'en',
    'es',
    'fr',
    'ja',
    'ko',
    'pt',
    'ru',
    'zh-hans',
    'zh-hant',
  ];
  let english;
  const normalize = (item) =>
    Object.fromEntries(
      Object.entries(item)
        .filter(([fieldName]) => fieldName !== 'name')
        .sort(([firstFieldName], [secondFieldName]) =>
          firstFieldName.localeCompare(secondFieldName),
        ),
    );
  for (const language of languages) {
    const data = JSON.parse(
      await readFile(`public/i18n/${language}.json`, 'utf8'),
    );
    assert.equal(data.items.length, 296);
    assert.ok(
      data.items.every(
        (item) => typeof item.name === 'string' && item.name.length > 0,
      ),
      `${language} item names must be present`,
    );
    assert.ok(data.texts);
    english ??= data.items.map(normalize);
    assert.deepEqual(data.items.map(normalize), english);
  }
});
test('room permissions, identity, ban, entry no-op and start conditions', () => {
  const store = new Store();
  const roomService = new RoomService(store, {
    random: new Random(4),
  });
  const { roomId } = roomService.invoke('create-room', 'u1', {
    mode: 'private',
    password: 'test',
    userName: 'One',
  });
  assert.match(roomId, /^[A-Za-z0-9]{20}$/);
  const payload = {
    mode: 'private',
    roomId,
  };
  const readRoom = () => store.get(roomService.path('private', roomId));
  assert.equal(
    roomService.invoke('create-room', 'u2', {
      mode: 'private',
      password: 'test',
      userName: 'Two',
    }).roomId,
    roomId,
  );
  assert.equal(readRoom().users.length, 1);
  expectHttpError(
    () =>
      roomService.invoke('join-room', 'u2', {
        ...payload,
        userName: 'One',
      }),
    403,
  );
  roomService.invoke('join-room', 'u2', {
    ...payload,
    userName: 'Two',
  });
  expectHttpError(
    () =>
      roomService.invoke('set-room-locked', 'u2', {
        ...payload,
        isLocked: true,
      }),
    403,
  );
  roomService.invoke('set-room-locked', 'u1', {
    ...payload,
    isLocked: true,
  });
  expectHttpError(
    () =>
      roomService.invoke('join-room', 'u3', {
        ...payload,
        userName: 'Three',
      }),
    403,
  );
  for (const [userId, team] of [
    ['u1', 1],
    ['u2', 2],
  ]) {
    roomService.invoke('make-entry', userId, {
      ...payload,
      team,
    });
  }

  roomService.invoke('make-entry', 'u1', {
    ...payload,
    team: 3,
  });
  assert.equal(readRoom().entries[0].team, 3);
  roomService.invoke('start-game', 'u1', payload);
  assert.equal(readRoom().game, undefined);
  for (const userId of ['u1', 'u2']) {
    roomService.invoke('cancel-entry', userId, payload);
    roomService.invoke('make-entry', userId, {
      ...payload,
      team: 0,
    });
  }

  roomService.invoke('start-game', 'u1', payload);
  assert.ok(readRoom().game);
  assert.equal(readRoom().entries, undefined);
  expectHttpError(() => roomService.invoke('start-game', 'u1', payload), 400);
  expectHttpError(() => roomService.invoke('reset-game', 'u1', payload), 403);
  roomService.invoke('kick-user', 'u1', {
    ...payload,
    userId: 'u2',
  });
  assert.equal(readRoom().users.length, 1);
  assert.equal(readRoom().game.players.length, 2);
  roomService.invoke('set-room-locked', 'u1', {
    ...payload,
    isLocked: false,
  });
  expectHttpError(
    () =>
      roomService.invoke('join-room', 'u2', {
        ...payload,
        userName: 'Two',
      }),
    403,
  );
});
test('training rejects lobby actions and starts server-controlled players', () => {
  const roomService = new RoomService(new Store(), {
    random: new Random(1),
  });
  const { roomId } = roomService.invoke('create-room', 'u1', {
    mode: 'training',
    userName: 'One',
  });
  const payload = {
    mode: 'training',
    roomId,
  };
  for (const action of [
    'join-room',
    'leave-room',
    'keep-alive',
    'make-entry',
    'cancel-entry',
    'shuffle-teams',
    'set-tiebreak',
    'set-room-locked',
    'post-message',
    'kick-user',
  ]) {
    expectHttpError(() => roomService.invoke(action, 'u1', payload), 400);
  }

  expectHttpError(
    () =>
      roomService.invoke('submit-command', 'u1', {
        ...payload,
        command: {},
      }),
    403,
  );
  roomService.invoke('start-game', 'u1', {
    ...payload,
    playerCount: 3,
    gf: 50,
  });
  let room = roomService.store.get(roomService.path('training', roomId));
  assert.equal(room.game.players.length, 3);
  const giftEvents = room.game.events.filter(
    (entry) => entry.action === 'gift',
  );
  assert.equal(giftEvents.length, 9, 'the human seat receives visible gifts');
  assert.equal(
    giftEvents.every((entry) =>
      room.game.players.some(
        (player) => player.id === entry.playerId && !player.isBot,
      ),
    ),
    true,
    'official server does not emit gift events for server-controlled seats',
  );
  for (const player of room.game.players) {
    assert.equal(
      player.items.filter((item) => item.modelId > 0).length,
      9,
      'server-controlled seats still receive their initial cards silently',
    );
  }
  const count = room.game.updateCount;
  roomService.invoke('start-game', 'u1', payload);
  assert.equal(
    roomService.store.get(roomService.path('training', roomId)).game
      .updateCount,
    count,
  );
});

test('initial deal never draws devil gifts even during apocalypse', () => {
  const game = startBattle(
    [
      { userId: 'u1', name: 'Player 1' },
      { isBot: true, name: 'Bot 2' },
    ],
    {
      random: new Random(1),
      tiebreakGF: 0,
    },
  );
  const devilEvents = game.events.filter(
    (event) => event.action === 'useDevilItem',
  );
  assert.equal(
    devilEvents.length,
    0,
    'devil items are prohibited from opening hand deal',
  );
  for (const player of game.players) {
    assert.equal(
      player.items.filter((itemSlot) => itemSlot.modelId > 0).length,
      9,
      'every player receives their complete initial hand',
    );
  }
});

test('training submit-command resolves intervening bot turns synchronously in one update', () => {
  const roomService = new RoomService(new Store(), {
    random: new Random(1),
  });
  const { roomId } = roomService.invoke('create-room', 'userOne', {
    mode: 'training',
    userName: 'PlayerOne',
  });
  const roomPayload = {
    mode: 'training',
    roomId,
  };
  roomService.invoke('start-game', 'userOne', {
    ...roomPayload,
    playerCount: 2,
    gf: 50,
  });
  const initialRoom = roomService.store.get(roomService.path('training', roomId));
  const humanPlayer = initialRoom.game.players.find(
    (candidatePlayer) => candidatePlayer.userId === 'userOne',
  );
  assert.ok(humanPlayer);
  const botPlayer = initialRoom.game.players.find(
    (candidatePlayer) => candidatePlayer.id !== humanPlayer.id,
  );
  assert.ok(botPlayer);
  assert.equal(botPlayer.isBot, true);

  // If human is player 1, human attacks bot. In the same submit, bot defends and takes turn.
  const initialUpdateCount = initialRoom.game.updateCount;
  const attackWeapon = humanPlayer.items.find(
    (itemSlot) =>
      getItemDefinition(itemSlot.modelId).category === engine.CategoryWeapons,
  );
  assert.ok(attackWeapon);
  roomService.invoke('submit-command', 'userOne', {
    ...roomPayload,
    command: {
      itemIds: [attackWeapon.id],
      targetPlayerId: botPlayer.id,
    },
  });

  const updatedRoom = roomService.store.get(roomService.path('training', roomId));
  assert.equal(
    updatedRoom.game.updateCount,
    initialUpdateCount + 1,
    'synchronous bot stepping increments updateCount exactly once',
  );
  const actions = updatedRoom.game.events.map((event) => event.action);
  assert.ok(
    actions.includes('useAttackItems'),
    'events contain the human attack',
  );
  assert.ok(
    actions.includes('useDefenseItems'),
    'events contain the bot defense',
  );
});
test('invalid commands are atomic through the room service', () => {
  const store = new Store();
  const roomService = new RoomService(store);
  const { roomId } = roomService.invoke('create-room', 'u1', {
    mode: 'training',
    userName: 'One',
  });
  const payload = {
    mode: 'training',
    roomId,
  };
  const room = store.get(roomService.path('training', roomId));
  room.game = createGameFixture([
    createPlayerFixture(1, [6]),
    createPlayerFixture(2, [113]),
  ]);
  store.set(roomService.path('training', roomId), room);
  const before = structuredClone(
    store.get(roomService.path('training', roomId)),
  );
  for (const command of [
    {},
    {
      itemIds: [999],
    },
    {
      itemIds: [1, 1],
    },
    {
      itemIds: [1],
      targetPlayerId: 999,
    },
    {
      itemIds: [1],
      targetPlayerId: 2,
      bought: true,
    },
  ]) {
    expectHttpError(
      () =>
        roomService.invoke('submit-command', 'u1', {
          ...payload,
          command,
        }),
      400,
    );
    assert.deepEqual(store.get(roomService.path('training', roomId)), before);
  }

  expectHttpError(
    () =>
      roomService.invoke('submit-command', 'u2', {
        ...payload,
        command: {
          itemIds: [1],
          targetPlayerId: 2,
        },
      }),
    403,
  );
});
test('attacks validate with engine and preserve used miracles', () => {
  const game = createGameFixture([
    createPlayerFixture(1, [210, 204]),
    createPlayerFixture(2, [127]),
  ]);
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {
    itemIds: [1],
    targetPlayerId: 2,
  });
  assert.equal(game.players[0].mp, 8);
  assert.equal(
    game.players[0].items.find((itemSlot) => itemSlot.id === 1).used,
    true,
  );
  assert.equal(game.attacks[0].targetPlayerId, 2);
  battle.submit('u2', {
    itemIds: [1],
  });
  assert.equal(game.players[1].hp, 40);
  assert.ok(game.events.some((entry) => entry.action === 'safe'));
  assert.equal(game.attackTurnPlayerId, 2);
});
test('reusing a performed miracle opens a replacement slot and draws a new card', () => {
  const game = createGameFixture([
    createPlayerFixture(1, [214]),
    createPlayerFixture(2),
  ]);
  game.players[0].items[0].used = true;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {
    itemIds: [1],
    targetPlayerId: 2,
  });
  assert.ok(
    game.players[0].items.some(
      (itemSlot) => itemSlot.modelId === 0,
    ),
  );
  battle.submit('u2', {});
  const occupiedSlots = game.players[0].items.filter(
    (itemSlot) => itemSlot.modelId > 0,
  );
  assert.equal(occupiedSlots.length, 2);
  assert.equal(
    occupiedSlots.find((itemSlot) => itemSlot.modelId === 214).used,
    true,
  );
});
test('buy is seller response then buyer confirmation; decline restores the slot', () => {
  const game = createGameFixture([
    createPlayerFixture(1, [5]),
    createPlayerFixture(2, [113]),
  ]);
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {
    itemIds: [1],
    targetPlayerId: 2,
  });
  expectHttpError(
    () =>
      battle.selectCommandItems(
        game.players[1],
        {
          itemIds: [1],
        },
        true,
      ),
    400,
  );
  battle.submit('u2', {});
  assert.equal(game.attacks[0].buyingItemModelId, 113);
  assert.equal((game.players[1].items ?? []).length, 0);
  battle.submit('u1', {
    bought: false,
  });
  assert.ok((game.players[1].items ?? []).some((itemSlot) => itemSlot.modelId === 113));
  assert.equal(game.players[0].cp, 20);
});

test('self-Buy restores the offered card and gifts the used Buy slot', () => {
  const buyer = createPlayerFixture(1, [5, 113]);
  const enemy = createPlayerFixture(2, [6]);
  const game = createGameFixture([buyer, enemy]);
  const battle = new Battle(game, new Random(1));

  battle.submit('u1', {itemIds: [1], targetPlayerId: buyer.id});

  assert.ok(
    game.events.some((event) => event.action === 'canNotBuy'),
    'self-Buy cannot purchase from the same hand',
  );
  assert.ok(
    game.events.some(
      (event) => event.action === 'gift' && event.playerId === buyer.id,
    ),
    'the used Buy card receives its end-of-turn gift',
  );
  assert.ok(
    buyer.items.some((itemSlot) => itemSlot.modelId === 113),
    'the offered card returns to the hand',
  );
  assert.equal(
    buyer.items.some((itemSlot) => itemSlot.modelId === 0),
    false,
    'the Buy slot is filled after the turn',
  );
});
test('a confused human buyer chooses whether to accept the offer', () => {
  const createPendingBuy = () => {
    const buyer = createPlayerFixture(1, [5]);
    const seller = createPlayerFixture(2, [113]);
    const game = createGameFixture([buyer, seller]);
    const battle = new Battle(game, new Random(1));
    battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
    battle.submit('u2', {});
    assert.equal(game.attacks[0].buyingItemModelId, 113);
    buyer.confusionCount = 3;
    return {battle, buyer, seller, game};
  };

  const accepted = createPendingBuy();
  assert.equal(
    accepted.battle.botCommand(),
    null,
    'the server waits for a confused human buyer instead of rolling for them',
  );
  accepted.battle.submit('u1', {bought: true});
  assert.ok(
    accepted.game.events.some(
      (event) => event.action === 'setBought' && event.bought === true,
    ),
    'the submitted acceptance is used',
  );
  assert.equal(
    accepted.buyer.cp,
    20 - getItemDefinition(113).price,
    'the buyer pays the price',
  );
  assert.ok(
    accepted.buyer.items.some((itemSlot) => itemSlot.modelId === 113),
    'the accepted item moves to the buyer',
  );

  const declined = createPendingBuy();
  declined.battle.submit('u1', {bought: false});
  const setBought = declined.game.events.find(
    (event) => event.action === 'setBought',
  );
  assert.ok(setBought, 'the submitted rejection is used');
  assert.equal(
    setBought.bought,
    undefined,
    'the official wire omits the false bought flag',
  );
  assert.equal(declined.buyer.cp, 20, 'the buyer pays nothing');
  assert.ok(
    declined.seller.items.some((itemSlot) => itemSlot.modelId === 113),
    'the declined item returns to the seller',
  );
  assert.ok(
    !declined.buyer.items.some((itemSlot) => itemSlot.modelId === 113),
    'the declined item is not transferred',
  );
});
test('the server resolves a confused human attack turn', () => {
  const playerOne = createPlayerFixture(1, [6]);
  const playerTwo = createPlayerFixture(2, [6]);
  playerOne.confusionCount = 3;
  const game = createGameFixture([playerOne, playerTwo]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(3));

  const choice = battle.botCommand();
  assert.ok(choice, 'a confused human attack is resolved without a submission');
  assert.equal(choice.player, playerOne);
  assert.deepEqual(choice.command.itemIds, [1]);
});

test('a confused human still chooses their own defense', () => {
  const attacker = createPlayerFixture(1, [6]);
  const defender = createPlayerFixture(2, [178, 135]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(3));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  defender.confusionCount = 3;

  assert.equal(
    battle.botCommand(),
    null,
    'a confused human defense is not auto-resolved',
  );
});

test('confused bots use the normal Buy acceptance curve', () => {
  const buyer = createPlayerFixture(1, [5]);
  const seller = createPlayerFixture(2, [113]);
  const game = createGameFixture([buyer, seller]);
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  battle.submit('u2', {});
  assert.equal(game.attacks[0].buyingItemModelId, 113);

  buyer.isBot = true;
  buyer.confusionCount = 3;
  let acceptedCount = 0;
  const sampleCount = 2000;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const choice = battle.botCommand();
    assert.ok(choice);
    if (choice.command.bought === true) {
      acceptedCount++;
    }
  }
  const acceptanceRate = acceptedCount / sampleCount;
  assert.ok(
    acceptanceRate > 0.97,
    `cheap armor should be accepted, got ${acceptanceRate}`,
  );
});
test('buy emits canNotBuy when the buyer cannot afford the offer', () => {
  const buyer = createPlayerFixture(1, [5]);
  buyer.cp = 0;
  const seller = createPlayerFixture(2, [113]);
  const game = createGameFixture([buyer, seller]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  battle.submit('u2', {});
  assert.ok(
    game.events.some((event) => event.action === 'buy'),
    'the seller still offers an item',
  );
  assert.ok(
    game.events.some((event) => event.action === 'canNotBuy'),
    'an unaffordable purchase resolves as canNotBuy (client poor)',
  );
});

test('a buy offer clears a refused item dream disguise', () => {
  const createDreamedSeller = () => {
    const seller = createPlayerFixture(2, [113]);
    seller.curses = ['dream'];
    seller.items[0].fakeModelId = 123;
    return seller;
  };

  const poorBuyer = createPlayerFixture(1, [5]);
  poorBuyer.cp = 0;
  const refusedSeller = createDreamedSeller();
  const refusedGame = createGameFixture([poorBuyer, refusedSeller]);
  refusedGame.attackTurnPlayerId = 1;
  const refusedBattle = new Battle(refusedGame, new Random(1));
  refusedBattle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  refusedBattle.submit('u2', {});
  const offer = refusedGame.events.find((event) => event.action === 'buy');
  assert.equal(
    offer.item.fakeModelId,
    123,
    'the buy animation still receives the disguised card',
  );
  const refusal = refusedGame.events.find(
    (event) => event.action === 'canNotBuy',
  );
  assert.equal(refusal.item.fakeModelId, undefined);
  assert.equal(refusedSeller.items[0].fakeModelId, undefined);

  const buyer = createPlayerFixture(1, [5]);
  const declinedSeller = createDreamedSeller();
  const declinedGame = createGameFixture([buyer, declinedSeller]);
  declinedGame.attackTurnPlayerId = 1;
  const declinedBattle = new Battle(declinedGame, new Random(1));
  declinedBattle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  declinedBattle.submit('u2', {});
  declinedBattle.submit('u1', {bought: false});
  const returned = declinedSeller.items.find((item) => item.modelId === 113);
  assert.ok(returned);
  assert.equal(returned.fakeModelId, undefined);
  assert.equal(
    declinedGame.events.find((event) => event.action === 'setBought').item
      .fakeModelId,
    undefined,
  );
});

test('normal Sell transfers the selected inventory item', () => {
  const seller = createPlayerFixture(1, [4, 113]);
  const buyer = createPlayerFixture(2, [6]);
  const game = createGameFixture([seller, buyer]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [1, 2], targetPlayerId: 2});
  battle.submit('u2', {});
  assert.equal(seller.items.some((item) => item.modelId === 113), false);
  assert.equal(buyer.items.some((item) => item.modelId === 113), true);
});

test('selling a Dream-disguised item transfers its true model', () => {
  const seller = createPlayerFixture(1, [4, 21]);
  seller.items[1].fakeModelId = 38;
  const buyer = createPlayerFixture(2, [6]);
  const game = createGameFixture([seller, buyer]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [1, 2], targetPlayerId: 2});
  battle.submit('u2', {});
  assert.equal(
    seller.items.some((itemSlot) => itemSlot.modelId === 21),
    false,
    'the true card leaves the seller',
  );
  const bought = buyer.items.find((itemSlot) => itemSlot.modelId === 21);
  assert.ok(bought, 'the buyer receives the true model');
  assert.equal(bought.fakeModelId, undefined, 'the disguise is stripped');
  const saleEvent = game.events.find((event) => event.action === 'sell');
  assert.equal(saleEvent.item.modelId, 21);
  assert.equal(saleEvent.item.fakeModelId, undefined);
});

test('buy on a seller with no buyable items emits safe', () => {
  for (const sellerItems of [[], [214]]) {
    const buyer = createPlayerFixture(1, [5]);
    const seller = createPlayerFixture(2, sellerItems);
    if (sellerItems.length !== 0) {
      seller.items[0].used = true;
    }
    const game = createGameFixture([buyer, seller]);
    game.attackTurnPlayerId = 1;
    const battle = new Battle(game, new Random(1));
    battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
    battle.submit('u2', {});
    assert.ok(
      !game.events.some((event) => event.action === 'buy'),
      'no offer is emitted when the seller has nothing buyable',
    );
    assert.ok(
      game.events.some((event) => event.action === 'safe'),
      'an empty buyable pool resolves as safe',
    );
    assert.ok(
      !game.events.some((event) => event.action === 'canNotBuy'),
      'safe is not reported as an unaffordable purchase',
    );
    assert.ok(
      !game.events.some((event) => event.action === 'setBought'),
      'no purchase is confirmed',
    );
    assert.equal(
      (seller.items ?? []).length,
      sellerItems.length,
      'the seller inventory is unchanged',
    );
  }
});

test('buy does not offer performed miracles', () => {
  const game = createGameFixture([
    createPlayerFixture(1, [5]),
    createPlayerFixture(2, [214]),
  ]);
  game.players[1].items[0].used = true;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {
    itemIds: [1],
    targetPlayerId: 2,
  });
  battle.submit('u2', {});
  assert.ok(!game.events.some((entry) => entry.action === 'buy'));
  assert.ok(game.events.some((entry) => entry.action === 'safe'));
  assert.equal(game.players[1].items[0].modelId, 214);
  assert.equal(game.players[1].items[0].used, true);
});
test('AOE ignores requested target and resolves each enemy in turn', () => {
  const players = [
    createPlayerFixture(1, [6, 232]),
    createPlayerFixture(2, []),
    createPlayerFixture(3, []),
    createPlayerFixture(4, []),
  ];
  players[0].team = players[1].team = 1;
  players[2].team = players[3].team = 2;
  const game = createGameFixture(players);
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {
    itemIds: [1, 2],
    targetPlayerId: 1,
  });
  assert.deepEqual(
    game.attacks.map((attack) => attack.targetPlayerId),
    [3, 4],
  );
  battle.submit('u3', {});
  assert.ok(game.events.some((entry) => entry.action === 'nextAttack'));
  battle.submit('u4', {});
  assert.equal(game.gf, 2);
  assert.equal(players[2].hp, 39);
  assert.equal(players[3].hp, 39);
});
test('HTTP identities, subscriptions, empty success, auth errors and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'godfield-server-'));
  const file = join(directory, 'state.json');
  const { server, store } = await createServer({
    store: new Store(file),
    botInterval: 0,
  });
  await server.listen({
    port: 0,
    host: '127.0.0.1',
  });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const account = await (
      await fetch(base + '/api/auth', {
        method: 'POST',
      })
    ).json();
    const headers = {
      Authorization: `Bearer ${account.token}`,
      'Content-Type': 'application/json',
    };
    const response = await fetch(base + '/api/functions/create-room', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'private',
        userName: 'Local',
        password: 'secret',
      }),
    });
    const { roomId } = await response.json();
    assert.ok(roomId);
    const path = `modes/private/rooms/${roomId}`;
    const abort = new AbortController();
    const stream = await fetch(
      base + `/api/watch?path=${path}&token=${account.token}`,
      {
        signal: abort.signal,
      },
    );
    const reader = stream.body.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /"Local"/,
    );
    abort.abort();
    const success = await fetch(base + '/api/functions/make-entry', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'private',
        roomId,
        team: 0,
      }),
    });
    assert.equal(success.status, 200);
    assert.equal(await success.text(), '');
    const unauthenticatedResponse = await fetch(
      base + '/api/functions/keep-alive',
      {
        method: 'POST',
        body: '{}',
      },
    );
    assert.equal(unauthenticatedResponse.status, 403);
    assert.equal(await unauthenticatedResponse.text(), '403 Forbidden\n');
    assert.deepEqual(new Store(file).get(path), store.get(path));
    const foreign = await fetch(base + '/api/functions/update-account', {
      method: 'POST',
      headers: {
        ...headers,
        Origin: 'https://example.com',
      },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
  } finally {
    await server.close();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
test('duel matches two local users and exposes default tiebreak', () => {
  const store = new Store();
  const roomService = new RoomService(store, {
    random: new Random(7),
  });
  const firstRoom = roomService.invoke('create-room', 'a', {
    mode: 'duel',
    userName: 'A',
  });
  const secondRoom = roomService.invoke('create-room', 'b', {
    mode: 'duel',
    userName: 'B',
  });
  assert.equal(firstRoom.roomId, secondRoom.roomId);
  const room = store.get(roomService.path('duel', firstRoom.roomId));
  assert.equal(room.game.tiebreakGF, 150);
  assert.equal(room.game.players.length, 2);
});

test('duel mode rejects private lobby actions with 400 Bad Request', () => {
  const store = new Store();
  const roomService = new RoomService(store, {
    random: new Random(7),
  });
  const firstRoom = roomService.invoke('create-room', 'a', {
    mode: 'duel',
    userName: 'A',
  });
  const secondRoom = roomService.invoke('create-room', 'b', {
    mode: 'duel',
    userName: 'B',
  });
  const disallowedActions = [
    'make-entry',
    'cancel-entry',
    'shuffle-teams',
    'set-tiebreak',
    'set-room-locked',
    'post-message',
    'start-game',
    'keep-alive',
  ];
  for (const action of disallowedActions) {
    assert.throws(
      () => {
        roomService.invoke(action, 'a', {
          mode: 'duel',
          roomId: firstRoom.roomId,
        });
      },
      (error) => error.status === 400,
    );
  }
  const rejoinResult = roomService.invoke('join-room', 'a', {
    mode: 'duel',
    roomId: firstRoom.roomId,
    userName: 'A',
  });
  assert.equal(rejoinResult, null);
});
test('authenticated room reads and subscriptions work before joining and while absent', async () => {
  const { server, store, rooms } = await createServer({
    botInterval: 0,
  });
  await server.listen({
    port: 0,
    host: '127.0.0.1',
  });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const abort = new AbortController();
  try {
    const account = async () =>
      await (
        await fetch(base + '/api/auth', {
          method: 'POST',
        })
      ).json();
    const owner = await account();
    const visitor = await account();
    const headers = {
      Authorization: `Bearer ${visitor.token}`,
      'Content-Type': 'application/json',
    };
    const { roomId } = rooms.invoke('create-room', owner.uid, {
      mode: 'private',
      userName: 'Owner',
      password: 'read-before-join',
    });
    const payload = {
      mode: 'private',
      roomId,
    };
    const path = `modes/private/rooms/${roomId}`;
    const response = await fetch(
      `${base}/api/doc?path=${encodeURIComponent(path)}`,
      {
        headers,
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), store.get(path));
    const stream = await fetch(
      `${base}/api/watch?path=${encodeURIComponent(path)}&token=${visitor.token}`,
      {
        signal: abort.signal,
      },
    );
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    async function snapshot() {
      while (true) {
        while (!buffered.includes('\n\n')) {
          const { value, done } = await reader.read();
          assert.equal(done, false, 'room subscription closed');
          buffered += decoder.decode(value, {
            stream: true,
          });
        }
        const end = buffered.indexOf('\n\n');
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (frame.startsWith('data: ')) {
          return JSON.parse(frame.slice('data: '.length));
        }
      }
    }
    assert.equal((await snapshot()).users.length, 1);
    assert.equal(
      store.get(path).users.some((user) => user.id === visitor.uid),
      false,
      'reading must not join',
    );
    const post = async (action, extra = {}) =>
      fetch(`${base}/api/functions/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...payload,
          ...extra,
        }),
      });
    for (const action of ['keep-alive', 'make-entry', 'post-message']) {
      assert.equal(
        (
          await post(action, {
            team: 0,
            text: 'not a member',
          })
        ).status,
        403,
      );
    }
    for (const audience of ['all', 'team1']) {
      assert.equal(
        (
          await fetch(
            `${base}/api/doc?path=${encodeURIComponent(`${path}/messages/${audience}`)}`,
            {
              headers,
            },
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (await fetch(`${base}/api/doc?path=${encodeURIComponent(path)}`)).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/api/watch?path=${encodeURIComponent(path)}`))
        .status,
      403,
    );
    assert.equal(
      (
        await post('join-room', {
          userName: 'Visitor',
        })
      ).status,
      200,
    );
    assert.equal((await snapshot()).users.length, 2);
    assert.equal((await post('leave-room')).status, 200);
    assert.equal((await snapshot()).users.length, 1);
    rooms.invoke('set-room-locked', owner.uid, {
      ...payload,
      isLocked: true,
    });
    assert.equal(
      (await snapshot()).isLocked,
      true,
      'absent readers keep receiving room snapshots',
    );
    assert.equal(
      (
        await post('join-room', {
          userName: 'Visitor',
        })
      ).status,
      403,
      'reading a locked room does not grant entry',
    );
    assert.equal(
      (
        await fetch(`${base}/api/doc?path=${encodeURIComponent(path)}`, {
          headers,
        })
      ).status,
      200,
    );
    rooms.invoke('set-room-locked', owner.uid, {
      ...payload,
      isLocked: false,
    });
    await snapshot();
    assert.equal(
      (
        await post('join-room', {
          userName: 'Visitor',
        })
      ).status,
      200,
    );
    await snapshot();
    rooms.invoke('kick-user', owner.uid, {
      ...payload,
      userId: visitor.uid,
    });
    assert.equal((await snapshot()).users.length, 1);
    assert.equal(
      (
        await post('join-room', {
          userName: 'Visitor',
        })
      ).status,
      403,
      'reading does not clear a kick ban',
    );
    assert.equal(
      (
        await fetch(`${base}/api/doc?path=${encodeURIComponent(path)}`, {
          headers,
        })
      ).status,
      200,
    );
  } finally {
    abort.abort();
    await server.close();
  }
});

test('dream buckets match the observed live-game transformation groups', () => {
  const expectedBuckets = new Map([
    [6, 'weapons:attack:none:none:none:none'],
    [11, 'weapons:attack:defense:none:none:none'],
    [77, 'weapons:attack:defense:fire:none:none'],
    [108, 'weapons:group-attack:defense:wood:none:none'],
    [46, 'weapons:attack:spiritual:none:cutCost:none'],
    [95, 'weapons:group-attack:none:none:none:none'],
    [21, 'weapons:attack:weapon-response:none:none:none'],
    [38, 'weapons:attack:weapon-response:none:none:none'],
    [39, 'weapons:attack:miracle-response:none:none:none'],
    [42, 'weapons:attack:miracle-response:none:none:none'],
    [34, 'weapons:plus-attack:miracle-response:none:none:none'],
    [56, 'weapons:plus-attack:miracle-response:none:none:none'],
    [9, 'weapons:plus-attack:none:none:none:none'],
    [66, 'weapons:plus-attack:none:none:none:none'],
    [113, 'armor:defense:none:none:none:none'],
    [186, 'armor:defense:none:none:none:none'],
    [187, 'armor:defense:none:none:none:none'],
    [119, 'armor:defense:none:fire:none:none'],
    [181, 'armor:defense:none:fire:none:none'],
    [115, 'armor:defense:none:water:none:none'],
    [182, 'armor:defense:none:water:none:none'],
    [116, 'armor:defense:none:wood:none:none'],
    [178, 'armor:defense:none:wood:none:none'],
    [117, 'armor:defense:none:stone:none:none'],
    [184, 'armor:defense:none:stone:none:none'],
    [148, 'armor:defense:none:light:none:none'],
    [185, 'armor:defense:none:light:none:none'],
    [114, 'armor:defense:miracle-response:none:none:none'],
    [189, 'armor:defense:special-response:none:filterAtkElement:none'],
    [190, 'armor:defense:special-response:none:reflectAnything:none'],
    [124, 'armor:defense:plus-attack:none:none:none'],
    [143, 'armor:defense:spiritual:none:cutCost:none'],
    [191, 'sundries:utility:none:none:none:none'],
    [203, 'sundries:utility:plus-attack:none:none:none'],
    [204, 'sundries:utility:spiritual:none:cutCost:none'],
    [207, 'sundries:utility:none:none:none:none'],
    [208, 'sundries:utility:passive:none:none:none'],
    [209, 'sundries:utility:passive:none:none:none'],
  ]);
  for (const [modelId, bucket] of expectedBuckets) {
    assert.equal(
      getDreamBucket(getItemDefinition(modelId)),
      bucket,
      `model ${modelId} ${getItemDefinition(modelId).name}`,
    );
  }
  for (const modelId of [3, 222, 226, 239]) {
    assert.equal(
      getDreamBucket(getItemDefinition(modelId)),
      null,
      `model ${modelId} ${getItemDefinition(modelId).name} is never disguised`,
    );
  }
});

test('dream disguise pools stay inside the true model bucket', () => {
  const plainWeaponPool = getDreamDisguisePool(getItemDefinition(6));
  assert.ok(plainWeaponPool.length > 0);
  assert.equal(
    plainWeaponPool.some((definition) => definition.id === 46),
    false,
    'always-confirmed cards are not disguise candidates',
  );
  assert.ok(plainWeaponPool.some((definition) => definition.id === 14));
  for (const definition of plainWeaponPool) {
    assert.equal(definition.giftRate > 0, true);
    assert.equal(getDreamBucket(definition), 'weapons:attack:none:none:none:none');
  }
  assert.equal(
    plainWeaponPool.some((definition) => definition.id === 11),
    false,
    'defense weapons are a different bucket',
  );
  assert.equal(
    plainWeaponPool.some((definition) => definition.id === 9),
    false,
    'plus weapons are a different bucket',
  );
  assert.deepEqual(getDreamDisguisePool(getItemDefinition(222)), []);
});

test('every undisguised item slot omits its fake model id', () => {
  const player = createPlayerFixture(1, [6]);
  const battle = new Battle(createGameFixture([player]), new Random(1));
  assert.equal(
    player.items[0].fakeModelId,
    undefined,
    'fixture and loaded slots are not given an explicit zero',
  );

  const added = battle.addSlot(player, 113).item;
  assert.equal(
    added.fakeModelId,
    undefined,
    'a newly added item omits the zero',
  );

  battle.addPlaceholderSlot(player);
  assert.equal(
    player.items.at(-1).fakeModelId,
    undefined,
    'a placeholder omits the zero',
  );

  battle.resolveRedraw(player);
  assert.equal(
    player.items
      .filter((itemSlot) => itemSlot.modelId > 0)
      .every((itemSlot) => itemSlot.fakeModelId === undefined),
    true,
    'redrawn items omit the zero when Dream is inactive',
  );
});

test('dream disguises gifted cards but not other acquisitions', () => {
  const player = createPlayerFixture(1, [5]);
  const battle = new Battle(createGameFixture([player]), new Random(7));
  battle.addCurse(player, 'dream');
  assert.equal(
    player.items[0].fakeModelId,
    undefined,
    'an item already in hand is not dreamed when the curse lands',
  );

  const directlyAdded = battle.addSlot(player, 6).item;
  assert.equal(
    directlyAdded.fakeModelId,
    undefined,
    'adding a slot is not a gift and must not apply Dream',
  );

  class GiftWeaponRandom extends Random {
    pick(label, values, weight) {
      if (label.startsWith('giftModel')) return values.find((value) => value.id === 6);
      return super.pick(label, values, weight);
    }
  }
  const giftBattle = new Battle(
    createGameFixture([player]),
    new GiftWeaponRandom(7),
  );
  giftBattle.resolveGift(player);
  const gifted = player.items.at(-1);
  assert.equal(gifted.modelId, 6);
  assert.ok(Number.isInteger(gifted.fakeModelId));
  assert.equal(
    getDreamBucket(getItemDefinition(gifted.fakeModelId)),
    getDreamBucket(getItemDefinition(6)),
  );
});

test('singleton dream gifts omit the fake model id', () => {
  class SingletonGiftRandom extends Random {
    pick(label, values, weight) {
      if (label.startsWith('giftModel')) {
        return values.find((value) => value.id === 46);
      }
      return super.pick(label, values, weight);
    }
  }
  const player = createPlayerFixture(1, []);
  player.curses = ['dream'];
  const battle = new Battle(
    createGameFixture([player]),
    new SingletonGiftRandom(5),
  );
  battle.resolveGift(player);
  const gifted = player.items.at(-1);
  assert.equal(gifted.modelId, 46);
  assert.equal(
    gifted.fakeModelId,
    undefined,
    'the live service omits the zero, not the real model id',
  );
});

test('redraw disguises rebuilt items while dream is active', () => {
  const player = createPlayerFixture(1, [6, 11, 95, 113, 119, 191, 208, 222, 3, 226]);
  player.curses = ['dream'];
  const battle = new Battle(createGameFixture([player]), new Random(11));
  battle.resolveRedraw(player);
  let disguised = 0;
  for (const item of player.items) {
    const definition = getItemDefinition(item.modelId);
    const bucket = getDreamBucket(definition);
    const hasAlternative = getDreamDisguisePool(definition).length > 1;
    if (bucket === null || !hasAlternative) {
      assert.equal(
        item.fakeModelId,
        undefined,
        'undisguised Dream cards omit the zero',
      );
      continue;
    }
    assert.ok(Number.isInteger(item.fakeModelId));
    assert.equal(getDreamBucket(getItemDefinition(item.fakeModelId)), bucket);
    disguised++;
  }
  assert.ok(disguised > 0);
  const redrawEvent = battle.game.events.find(
    (event) => event.action === 'replaceItems',
  );
  assert.equal(
    redrawEvent.items.every(
      (itemSlot, index) =>
        index === 0 || itemSlot.id > redrawEvent.items[index - 1].id,
    ),
    true,
    'redraw replaceItems lists slots in ascending order',
  );
});

test('dream bucket sizes exactly cover the 204 giftable items', () => {
  const expectedSizes = new Map([
    ['weapons:attack:none:none:none:none', 54],
    ['weapons:plus-attack:none:none:none:none', 19],
    ['weapons:group-attack:none:none:none:none', 17],
    ['weapons:attack:defense:none:none:none', 6],
    ['weapons:attack:defense:fire:none:none', 1],
    ['weapons:group-attack:defense:wood:none:none', 1],
    ['weapons:attack:spiritual:none:cutCost:none', 1],
    ['weapons:attack:miracle-response:none:none:none', 4],
    ['weapons:attack:weapon-response:none:none:none', 2],
    ['weapons:plus-attack:miracle-response:none:none:none', 2],
    ['armor:defense:none:none:none:none', 18],
    ['armor:defense:none:fire:none:none', 10],
    ['armor:defense:none:water:none:none', 9],
    ['armor:defense:none:wood:none:none', 9],
    ['armor:defense:none:stone:none:none', 8],
    ['armor:defense:none:light:none:none', 3],
    ['armor:defense:miracle-response:none:none:none', 12],
    ['armor:defense:special-response:none:filterAtkElement:none', 1],
    ['armor:defense:special-response:none:reflectAnything:none', 1],
    ['armor:defense:plus-attack:none:none:none', 4],
    ['armor:defense:spiritual:none:cutCost:none', 3],
    ['sundries:utility:none:none:none:none', 15],
    ['sundries:utility:passive:none:none:none', 2],
    ['sundries:utility:plus-attack:none:none:none', 1],
    ['sundries:utility:spiritual:none:cutCost:none', 1],
  ]);
  const bucketSizes = new Map();
  let total = 0;
  for (const definition of itemCatalog.models) {
    const bucket = getDreamBucket(definition);
    if (bucket === null || definition.giftRate <= 0) continue;
    total++;
    bucketSizes.set(bucket, (bucketSizes.get(bucket) ?? 0) + 1);
  }
  assert.equal(total, 204);
  assert.deepEqual(bucketSizes, expectedSizes);
});

test('special cross-role cards form singleton buckets', () => {
  const singletonBuckets = new Map([
    [46, 'weapons:attack:spiritual:none:cutCost:none'],
    [77, 'weapons:attack:defense:fire:none:none'],
    [108, 'weapons:group-attack:defense:wood:none:none'],
    [189, 'armor:defense:special-response:none:filterAtkElement:none'],
    [190, 'armor:defense:special-response:none:reflectAnything:none'],
    [203, 'sundries:utility:plus-attack:none:none:none'],
    [204, 'sundries:utility:spiritual:none:cutCost:none'],
  ]);
  for (const [modelId, bucket] of singletonBuckets) {
    const definition = getItemDefinition(modelId);
    assert.equal(getDreamBucket(definition), bucket);
    assert.deepEqual(
      getDreamDisguisePool(definition).map((candidate) => candidate.id),
      [modelId],
    );
    assert.equal(selectDreamDisguise(new Random(1), definition), undefined);
  }
});

test('dream pools use observed broad groups and exclude confirmed cards', () => {
  const bucket = (modelId) => getDreamBucket(getItemDefinition(modelId));
  assert.equal(bucket(21), bucket(38), 'weapon reaction types share a group');
  assert.equal(bucket(195), bucket(199), 'stat and cleanse sundries share a group');
  assert.equal(bucket(209), bucket(208), 'passive sundries share a group');
  assert.equal(bucket(16), bucket(14), 'normal weapons share a group');
  assert.equal(bucket(16), bucket(80), 'normal weapon elements share a group');
  assert.equal(bucket(9), bucket(12), 'plus weapons share a group');
  assert.equal(bucket(9), bucket(63), 'plus weapons share a group across elements');

  assert.ok(
    getDreamDisguisePool(getItemDefinition(195)).some(
      (definition) => definition.id === 199,
    ),
    'a stat card can be shown as a cleanse card',
  );
  assert.ok(
    getDreamDisguisePool(getItemDefinition(16)).some(
      (definition) => definition.id === 14,
    ),
    'a normal weapon can be shown as Saw Boom Boom',
  );
  assert.equal(
    getDreamDisguisePool(getItemDefinition(6)).some(
      (definition) => definition.id === 46,
    ),
    false,
    'Spiritual Staff is never a fake',
  );
  assert.equal(
    getDreamDisguisePool(getItemDefinition(11)).some(
      (definition) => definition.id === 77,
    ),
    false,
    'Flaming Roll is never a fake',
  );
  assert.equal(
    getDreamDisguisePool(getItemDefinition(208)).some(
      (definition) => definition.id === 203 || definition.id === 204,
    ),
    false,
    'always-confirmed sundries are never fakes',
  );

  const singletonKeys = new Map([
    [46, 'weapons:attack:spiritual:none:cutCost:none'],
    [77, 'weapons:attack:defense:fire:none:none'],
    [108, 'weapons:group-attack:defense:wood:none:none'],
    [189, 'armor:defense:special-response:none:filterAtkElement:none'],
    [190, 'armor:defense:special-response:none:reflectAnything:none'],
    [203, 'sundries:utility:plus-attack:none:none:none'],
    [204, 'sundries:utility:spiritual:none:cutCost:none'],
  ]);
  for (const [modelId, bucketKey] of singletonKeys) {
    assert.equal(bucket(modelId), bucketKey);
    assert.deepEqual(
      getDreamDisguisePool(getItemDefinition(modelId)).map(
        (definition) => definition.id,
      ),
      [modelId],
    );
  }
  for (const modelId of [3, 222, 226, 239]) {
    assert.equal(bucket(modelId), null);
    assert.deepEqual(getDreamDisguisePool(getItemDefinition(modelId)), []);
  }
});

test('redraw preserves consumed shield slots', () => {
  const player = createPlayerFixture(1, [6, 178, 135]);
  player.curses = ['dream'];
  const battle = new Battle(createGameFixture([player]), new Random(11));
  battle.takeSlots(player, [player.items[1], player.items[2]]);
  assert.equal(player.items.filter(item => !item.modelId).length, 2);
  battle.resolveRedraw(player);
  assert.equal(player.items.filter(item => !item.modelId).length, 2);
  assert.equal(player.items.filter(item => item.modelId > 0).length, 1);
});

test('clearing dream undreams items without a replaceItems event', () => {
  const player = createPlayerFixture(1, [6, 11, 191]);
  player.curses = ['dream'];
  for (const item of player.items) item.fakeModelId = 7;
  player.items.push({id: 0, modelId: 0});
  const game = createGameFixture([player, createPlayerFixture(2, [6])]);
  const battle = new Battle(game, new Random(5));
  battle.removeCurses(player, true);
  assert.equal(player.curses.length, 0);
  for (const item of player.items) assert.equal(item.fakeModelId, undefined);
  assert.equal(
    game.events.some(event => event.action === 'replaceItems'),
    false,
    'the live service does not emit replaceItems merely for undreaming',
  );

  battle.finishTurn();
  const giftEvent = game.events.find(
    (event) => event.action === 'gift' && event.playerId === player.id,
  );
  assert.ok(giftEvent, 'the pending slot still receives its gift');
  assert.equal(giftEvent.item.fakeModelId, undefined);
  assert.equal(
    player.items.some((itemSlot) => itemSlot.modelId === 0),
    false,
    'clearing Dream preserves and fills the pending slot',
  );
});

test('counterattacks target only the original attacker', () => {
  const playerOne = createPlayerFixture(1, [186]);
  const playerTwo = createPlayerFixture(2, [6]);
  const playerThree = createPlayerFixture(3, [6]);
  const game = createGameFixture([playerOne, playerTwo, playerThree]);
  game.attacks = [{playerId: 2, itemModelIds: [6], targetPlayerId: 1}];
  const battle = new Battle(game, new Random(9));
  battle.resolveCounterAttack(playerOne, playerTwo, getItemDefinition(186), 0, 10);
  assert.equal(game.attacks.length, 2);
  assert.deepEqual(game.attacks[1], {
    playerId: 1,
    itemModelIds: [186],
    targetPlayerId: 2,
  });
  assert.equal(game.attacks.some(attack => attack.targetPlayerId === 3), false);
});

test('percentage counter rings hit every enemy', () => {
  const playerOne = createPlayerFixture(1, [181]);
  const playerTwo = createPlayerFixture(2, [6]);
  const playerThree = createPlayerFixture(3, [6]);
  const game = createGameFixture([playerOne, playerTwo, playerThree]);
  game.attacks = [];
  const battle = new Battle(game, new Random(9));
  battle.resolveCounterAttack(playerOne, playerTwo, getItemDefinition(181), 0, 3);
  assert.equal(game.attacks.length, 2);
  assert.deepEqual(
    game.attacks.map(attack => attack.targetPlayerId).sort(),
    [2, 3],
  );
  for (const attack of game.attacks) {
    assert.equal(attack.itemModelIds[0], 181);
    assert.equal(attack.atk, 3);
  }
});

test('Venus Ring cascades CP loss into MP then HP', () => {
  const attacker = createPlayerFixture(1, [188]);
  const target = createPlayerFixture(2, [6]);
  target.cp = 5;
  target.mp = 2;
  target.hp = 40;
  const game = createGameFixture([attacker, target]);
  const battle = new Battle(game, new Random(3));
  battle.applyItemEffect(attacker, target, getItemDefinition(188), {cp: 8});
  assert.equal(target.cp, 0);
  assert.equal(target.mp, 0);
  assert.equal(target.hp, 39);
  assert.equal(attacker.cp, 28);
  const takeCP = game.events.find(event => event.action === 'takeCP');
  assert.equal(takeCP.cp, 8);
});

// Official: run-20261110-170946-xykh-g19, u24. The Venus Ring levied 68
// from a target holding 8/34/2 (44 total), and the ring user was credited
// the full 68.
test('Venus Ring credits the full levy beyond the target total', () => {
  const attacker = createPlayerFixture(1, [188]);
  const target = createPlayerFixture(2, [6]);
  attacker.cp = 0;
  target.hp = 8;
  target.mp = 34;
  target.cp = 2;
  const targetTotalBefore = target.hp + target.mp + target.cp;
  const game = createGameFixture([attacker, target]);
  const battle = new Battle(game, new Random(3));
  battle.applyItemEffect(attacker, target, getItemDefinition(188), {cp: 68});

  const targetTotalAfter = target.hp + target.mp + target.cp;
  assert.equal(targetTotalBefore, 44);
  assert.equal(targetTotalAfter, 0);
  assert.equal(attacker.cp, 68);
  assert.ok(
    attacker.cp > targetTotalBefore,
    'the ring user receives more than the target possessed',
  );
  const takeCP = game.events.find(event => event.action === 'takeCP');
  assert.equal(takeCP.cp, 68);
});

test('Sell cascades CP loss into MP then HP', () => {
  const seller = createPlayerFixture(1, [4, 57]);
  const buyer = createPlayerFixture(2, [6]);
  buyer.cp = 5;
  buyer.mp = 10;
  buyer.hp = 14;
  const game = createGameFixture([seller, buyer]);
  const battle = new Battle(game, new Random(4));
  battle.resolveSale(seller, buyer, getItemDefinition(57));
  assert.equal(buyer.cp, 0);
  assert.equal(buyer.mp, 0);
  assert.equal(buyer.hp, 0);
  assert.equal(seller.cp, 50);
  assert.equal(
    buyer.items.some(item => item.modelId === 57),
    true,
  );
  assert.ok(game.events.some(event => event.action === 'sell'));
});

test('Reflected Sell preserves the pending gift placeholder and tail invariant', () => {
  for (const placeholderCount of [0, 1, 3]) {
    const seller = createPlayerFixture(1, [190]);
    const buyer = createPlayerFixture(2, [10]);
    for (let placeholderIndex = 0; placeholderIndex < placeholderCount; placeholderIndex++) {
      buyer.items.push({ id: 0, modelId: 0 });
    }
    const game = createGameFixture([seller, buyer]);
    const battle = new Battle(game, new Random(4));
    battle.resolveSale(seller, buyer, getItemDefinition(57), 7);
    assert.deepEqual(buyer.items, [
      { id: 1, modelId: 10 },
      { id: 7, modelId: 57 },
      ...Array.from({ length: placeholderCount }, () => ({ id: 0, modelId: 0 })),
    ]);
    assert.deepEqual(game.events.find((event) => event.action === 'sell').item, {
      id: 7, modelId: 57,
    });
    // The pending refill remains available for the seller's end-of-turn gift.
    battle.addSlot(buyer, 91);
    assert.deepEqual(buyer.items, [
      { id: 1, modelId: 10 },
      { id: 7, modelId: 57 },
      { id: 2, modelId: 91 },
      ...Array.from({ length: Math.max(0, placeholderCount - 1) }, () => ({ id: 0, modelId: 0 })),
    ]);
  }
});

test('moving a performed miracle and acquiring an extra item preserve pending refills', () => {
  const player = createPlayerFixture(1, [6, 211, 113]);
  player.items[1].fakeModelId = 6;
  player.items.push({ id: 0, modelId: 0 });
  const battle = new Battle(createGameFixture([player]), new Random(4));
  battle.takeSlots(player, [player.items[1]]);
  assert.deepEqual(player.items, [
    { id: 1, modelId: 6 },
    { id: 3, modelId: 113 },
    { id: 2, modelId: 211, used: true },
    { id: 0, modelId: 0 },
    { id: 0, modelId: 0 },
  ]);
  battle.addSlot(player, 91, false, true);
  assert.deepEqual(player.items, [
    { id: 1, modelId: 6 },
    { id: 3, modelId: 113 },
    { id: 2, modelId: 211, used: true },
    { id: 4, modelId: 91 },
    { id: 0, modelId: 0 },
    { id: 0, modelId: 0 },
  ]);
});

test('HP is clamped between zero and 99', () => {
  const player = createPlayerFixture(1, [6]);
  const game = createGameFixture([player]);
  const battle = new Battle(game, new Random(5));
  battle.applyDamage(player, 999);
  assert.equal(player.hp, 0);
  battle.applyStatBoost(player, 'hp', 999);
  assert.equal(player.hp, 99);
});

test('MP and CP clamp to zero and 99 while damage stays unclamped', () => {
  const player = createPlayerFixture(1, [6]);
  const game = createGameFixture([player]);
  const battle = new Battle(game, new Random(6));
  player.mp = 95;
  player.cp = 95;
  battle.applyStatBoost(player, 'mp', 50);
  battle.applyStatBoost(player, 'cp', 50);
  assert.equal(player.mp, 99);
  assert.equal(player.cp, 99);
  player.mp = 5;
  player.cp = 5;
  battle.applyStatBoost(player, 'mp', -3);
  battle.applyStatBoost(player, 'cp', -3);
  assert.equal(player.mp, 2);
  assert.equal(player.cp, 2);

  player.hp = 99;
  battle.applyDamage(player, 150);
  assert.equal(player.hp, 0);
  const damageEvent = game.events.find(event => event.action === 'dealDamage');
  assert.equal(damageEvent.damage, 150, 'damage itself is not clamped');
});

test('disease upgrades follow incoming level rules', () => {
  const runDisease = (existingCurse, incomingCurse) => {
    const player = createPlayerFixture(1, [6]);
    player.curses = existingCurse === null ? [] : [existingCurse];
    const game = createGameFixture([player]);
    const battle = new Battle(game, new Random(7));
    battle.applyDisease(player, incomingCurse);
    return {player, game};
  };

  const coldToCold = runDisease('cold', 'cold');
  assert.equal(coldToCold.player.curses.includes('fever'), true);
  assert.equal(
    coldToCold.game.events.some(event => event.action === 'upgradeDisease'),
    true,
  );

  const coldToFever = runDisease('cold', 'fever');
  assert.equal(coldToFever.player.curses.includes('fever'), true);
  assert.equal(coldToFever.player.curses.includes('hell'), false);
  assert.equal(
    coldToFever.game.events.some(event => event.action === 'addCurse'),
    true,
  );

  const feverToCold = runDisease('fever', 'cold');
  assert.equal(feverToCold.player.curses.includes('hell'), true);

  const hellToFever = runDisease('hell', 'fever');
  assert.equal(hellToFever.player.curses.includes('heaven'), true);

  const heavenToCold = runDisease('heaven', 'cold');
  assert.equal(heavenToCold.player.hp, 0);
  assert.equal(
    heavenToCold.game.events.some(event => event.action === 'upgradeHeaven'),
    true,
  );
});

test('natural disease worsening happens after disease and before damage', () => {
  const player = createPlayerFixture(1, [6]);
  player.curses = ['cold'];
  player.hp = 40;
  const game = createGameFixture([player]);
  game.attackTurnPlayerId = 1;
  game.diseasePlayerId = 1;
  class WorsenRandom extends Random {
    chance(label, percent) {
      if (label === 'upgradeDisease') return true;
      return super.chance(label, percent);
    }
  }
  const battle = new Battle(game, new WorsenRandom(8));
  battle.finishTurn({gift: false});
  const actions = game.events.map(event => event.action);
  assert.deepEqual(actions.slice(0, 3), [
    'disease',
    'upgradeDisease',
    'dealDamage',
  ]);
  assert.equal(player.curses.includes('fever'), true);
  assert.equal(player.hp, 38);
});

test('bounce can select the defending player', () => {
  const attacker = createPlayerFixture(1, []);
  const defender = createPlayerFixture(2, [114]);
  const game = createGameFixture([attacker, defender]);
  game.attacks = [{playerId: 1, itemModelIds: [222], targetPlayerId: 2}];
  class LastRandom extends Random {
    value() {
      return 0.999999;
    }
  }
  const battle = new Battle(game, new LastRandom(3));
  battle.resolveDefenseCommand(defender, {itemIds: [1]});
  const bounce = game.events.find(event => event.action === 'bounce');
  assert.ok(bounce);
  assert.equal(bounce.playerId, 2, 'the defender is a legal bounce target');
});

test('Rainbow Curtain filters Darkness and prevents the dark-type kill', () => {
  // Official: run-20261105-150707-3v9s-g3 update 2.
  // <Darkness> 212 vs Rainbow Curtain 189 -> dealDamage 5, no dark finish.
  const attacker = createPlayerFixture(1, [212]);
  const defender = createPlayerFixture(2, [189]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  const pendingAttack = game.attacks[0];
  battle.submit('u2', { itemIds: [1] });
  assert.deepEqual(
    pendingAttack.itemModelIds,
    [212],
    'the pending attack does not retain the filter card',
  );
  const defense = game.events.find(
    (event) => event.action === 'useDefenseItems',
  );
  assert.deepEqual(
    defense?.items?.map((item) => item.modelId),
    [189],
    'the defender used Rainbow Curtain',
  );
  const damage = game.events.find((event) => event.action === 'dealDamage');
  assert.equal(damage?.damage, 5, 'Darkness deals its normal damage');
  assert.equal(defender.hp, 35);
  assert.notEqual(defender.dead, true);
  assert.equal(
    game.events.some((event) => event.action === 'dealDarkDamage'),
    false,
    'the filtered attack does not trigger the dark kill',
  );
  assert.equal(
    game.events.some((event) => event.action === 'die'),
    false,
  );
});

test('Darkness without an element filter still kills after damage', () => {
  const attacker = createPlayerFixture(1, [212]);
  const defender = createPlayerFixture(2, [6]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', {});
  assert.equal(defender.hp, 0);
  assert.equal(defender.dead, true);
  assert.equal(
    game.events.some((event) => event.action === 'dealDarkDamage'),
    true,
  );
});

test('Rainbow Curtain filters a dark weapon and prevents the dark kill', () => {
  // Official: dream-run-20261106-021703-8pxt-g0 update 11.
  // Shadow Hand 96 vs Rainbow Curtain 189 -> dealDamage, no dark finish.
  class AlwaysHitRandom extends Random {
    chance(label, percent) {
      if (label === 'hit') return true;
      return super.chance(label, percent);
    }
  }
  const attacker = createPlayerFixture(1, [96]);
  const defender = createPlayerFixture(2, [189]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new AlwaysHitRandom(2));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  const openingEvents = [...game.events];
  const pendingAttack = game.attacks[0];
  battle.submit('u2', { itemIds: [1] });
  assert.equal(
    openingEvents.some((event) => event.action === 'hit'),
    true,
  );
  assert.deepEqual(pendingAttack.itemModelIds, [96]);
  assert.equal(
    game.events.find((event) => event.action === 'dealDamage')?.damage,
    2,
  );
  assert.equal(defender.hp, 38);
  assert.notEqual(defender.dead, true);
  assert.equal(
    game.events.some((event) => event.action === 'dealDarkDamage'),
    false,
  );
  assert.equal(
    game.events.some((event) => event.action === 'die'),
    false,
  );
});

test('a dark weapon still kills without an element filter', () => {
  class AlwaysHitRandom extends Random {
    chance(label, percent) {
      if (label === 'hit') return true;
      return super.chance(label, percent);
    }
  }
  const attacker = createPlayerFixture(1, [96]);
  const defender = createPlayerFixture(2, [6]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new AlwaysHitRandom(2));
  battle.submit('u1', { itemIds: [1], targetPlayerId: 2 });
  battle.submit('u2', {});
  assert.equal(defender.hp, 0);
  assert.equal(defender.dead, true);
  assert.equal(
    game.events.some((event) => event.action === 'dealDarkDamage'),
    true,
  );
});

test('a self-bounced attack applies immediately without another defense', () => {
  const attacker = createPlayerFixture(1, [151, 215]);
  const defender = createPlayerFixture(2, [151]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  game.attacks = [{ playerId: 1, itemModelIds: [215], targetPlayerId: 2 }];
  class SelfBounceRandom extends Random {
    pick(label, values, weight) {
      if (label === 'bounceTarget') {
        const self = values.find((value) => value.id === 1);
        if (self !== undefined) {
          return self;
        }
      }
      return super.pick(label, values, weight);
    }
  }
  const battle = new Battle(game, new SelfBounceRandom(5));
  battle.resolveDefenseCommand(defender, { itemIds: [1] });
  battle.resolveDefenseCommand(attacker, { itemIds: [1] });
  const bounceIndices = game.events
    .map((event, index) => (event.action === 'bounce' ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(bounceIndices.length, 2, 'the attack bounced twice');
  const afterSecondBounce = game.events
    .slice(bounceIndices[1] + 1)
    .map((event) => event.action);
  assert.equal(
    afterSecondBounce.includes('useDefenseItems'),
    false,
    'the self-bounced attack does not enter another defense prompt',
  );
  assert.equal(
    afterSecondBounce.includes('dealDamage'),
    true,
    'the self-bounced attack applies immediately',
  );
  assert.equal(attacker.hp, 30, 'Flame deals 10 damage to the self-bounced attacker');
  assert.equal(game.attacks, undefined, 'the attack sequence is complete');
});

test('Dreaming Hat redraws the hand, replaces the shield, and dreams the result', () => {
  const attacker = createPlayerFixture(1, [6]);
  const defender = createPlayerFixture(2, [178, 135, 6]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(4));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  battle.submit('u2', {itemIds: [1]});
  assert.ok(defender.curses.includes('dream'));
  assert.equal(
    defender.items.filter(item => !item.modelId).length,
    0,
    'the consumed shield slot is replaced by a gift',
  );
  assert.equal(defender.items.length, 3);
  for (const item of defender.items) {
    const definition = getItemDefinition(item.modelId);
    const hasAlternative = getDreamDisguisePool(definition).length > 1;
    if (!hasAlternative) {
      assert.equal(
        item.fakeModelId,
        undefined,
        `model ${item.modelId} stays undisguised and omits the zero`,
      );
      continue;
    }
    assert.ok(Number.isInteger(item.fakeModelId), `model ${item.modelId} is dreamed`);
    assert.equal(
      getDreamBucket(getItemDefinition(item.fakeModelId)),
      getDreamBucket(definition),
    );
  }
  const shieldSlot = defender.items.find(item => item.id === 1);
  assert.ok(shieldSlot, 'the original shield slot id is reused');
  assert.notEqual(shieldSlot.modelId, 178, 'the consumed shield is gone');
});

test('a replacement card for a reused miracle is dreamed', () => {
  const playerOne = createPlayerFixture(1, [214]);
  const playerTwo = createPlayerFixture(2);
  playerOne.curses = ['dream'];
  playerOne.items[0].used = true;
  const game = createGameFixture([playerOne, playerTwo]);
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  battle.submit('u2', {});
  const replacement = playerOne.items.find(item => item.modelId !== 214 && item.modelId > 0);
  assert.ok(replacement, 'the performed miracle draws a replacement card');
  assert.ok(Number.isInteger(replacement.fakeModelId));
  assert.equal(
    getDreamBucket(getItemDefinition(replacement.fakeModelId)),
    getDreamBucket(getItemDefinition(replacement.modelId)),
  );
});

test('dream shows the real card half the time and a compatible fake otherwise', () => {
  const definition = getItemDefinition(6);
  class RealDreamRandom extends Random {
    chance() {
      return true;
    }
    pick() {
      throw new Error('the real-card branch must not pick a disguise');
    }
  }
  class FakeDreamRandom extends Random {
    chance() {
      return false;
    }
    pick(unusedLabel, candidates) {
      return candidates.find((candidate) => candidate.id !== definition.id);
    }
  }

  assert.equal(
    selectDreamDisguise(new RealDreamRandom(1), definition),
    definition.id,
  );

  const fakeModelId = selectDreamDisguise(new FakeDreamRandom(1), definition);
  assert.ok(Number.isInteger(fakeModelId));
  assert.notEqual(fakeModelId, definition.id, 'the fake branch shows a different card');
  assert.equal(
    getDreamBucket(getItemDefinition(fakeModelId)),
    getDreamBucket(definition),
  );

  assert.equal(
    selectDreamDisguise(new RealDreamRandom(1), getItemDefinition(222)),
    undefined,
    'non-dreamable categories are never disguised',
  );

  const singleton = getItemDefinition(46);
  assert.equal(
    getDreamDisguisePool(singleton).length,
    1,
    'a singleton bucket contains only the card itself',
  );
  assert.equal(
    selectDreamDisguise(new FakeDreamRandom(1), singleton),
    undefined,
    'always-confirmed cards stay undisguised',
  );

  const random = new Random(123);
  let realCount = 0;
  const sampleCount = 4000;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    if (selectDreamDisguise(random, definition) === definition.id) {
      realCount++;
    }
  }
  const realRatio = realCount / sampleCount;
  assert.ok(
    realRatio > 0.45 && realRatio < 0.55,
    `expected about 50% real cards, got ${realRatio}`,
  );
});

test('bots sometimes use Thump-thump Tear on themselves', () => {
  class NoPrayerRandom extends Random {
    chance(label, percent) {
      if (label === 'botPrayer') return false;
      return super.chance(label, percent);
    }
  }
  const playerOne = createPlayerFixture(1, [202]);
  const playerTwo = createPlayerFixture(2, [6]);
  playerOne.isBot = true;
  playerTwo.isBot = true;
  const game = createGameFixture([playerOne, playerTwo]);
  game.attackTurnPlayerId = 1;

  let selfCount = 0;
  const sampleCount = 2000;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const battle = new Battle(game, new NoPrayerRandom(seed));
    const choice = battle.botCommand();
    assert.ok(choice);
    if (choice.command.targetPlayerId === 1) {
      selfCount++;
    }
  }
  const selfRate = selfCount / sampleCount;
  assert.ok(
    selfRate > 0.04 && selfRate < 0.1,
    `expected about 7% Tear self-targeting with two living players, got ${selfRate}`,
  );

  let selfBattle = null;
  let selfChoice = null;
  for (let seed = 1; seed <= 50; seed++) {
    const battle = new Battle(game, new NoPrayerRandom(seed));
    const choice = battle.botCommand();
    if (choice.command.targetPlayerId === 1) {
      selfBattle = battle;
      selfChoice = choice;
      break;
    }
  }
  assert.ok(selfBattle && selfChoice, 'a self-targeting Tear seed is reachable');

  selfBattle.submit(selfChoice.player.userId, selfChoice.command);
  const setTargetPlayer = game.events.find(
    (event) => event.action === 'setTargetPlayer',
  );
  assert.ok(setTargetPlayer);
  assert.equal(setTargetPlayer.playerId, 1);
});

test('filterAtkElement allows a following non-element weapon response', () => {
  class BounceToAttackerRandom extends Random {
    pick(label, values, weight) {
      if (label === 'bounceTarget') {
        return values.find((candidate) => candidate.id === 1);
      }
      return super.pick(label, values, weight);
    }
  }

  const createRainbowGame = () => {
    const attacker = createPlayerFixture(1, [59]);
    const defender = createPlayerFixture(2, [189, 21]);
    const game = createGameFixture([attacker, defender]);
    game.attackTurnPlayerId = 1;
    const battle = new Battle(game, new BounceToAttackerRandom(3));
    battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
    return {game, battle};
  };

  const allowed = createRainbowGame();
  allowed.battle.submit('u2', {itemIds: [1, 2]});
  assert.ok(
    allowed.game.events.some((event) => event.action === 'bounce'),
    'Rainbow Curtain then Bouncing Sword matches the live service',
  );
  assert.deepEqual(
    allowed.game.attacks[0].itemModelIds,
    [59, 189],
    'the Rainbow filter remains attached to the bounced attack',
  );
  allowed.battle.submit('u1', {});
  assert.equal(
    allowed.game.events.filter((event) => event.action === 'gift').length,
    3,
    'the weapon, Rainbow Curtain, and Bouncing Sword slots are refilled',
  );
  assert.equal(
    allowed.game.players.some((player) =>
      player.items.some((itemSlot) => itemSlot.modelId === 0),
    ),
    false,
    'all three used slots are filled after the bounced attack',
  );

  const reversed = createRainbowGame();
  assert.throws(
    () => reversed.battle.submit('u2', {itemIds: [2, 1]}),
    'a response cannot precede the filter',
  );
});

test('dream does not disguise bought or sold items', () => {
  const buyer = createPlayerFixture(1, [5]);
  buyer.curses = ['dream'];
  const seller = createPlayerFixture(2, [113]);
  const buyGame = createGameFixture([buyer, seller]);
  buyGame.attackTurnPlayerId = 1;
  const buyBattle = new Battle(buyGame, new Random(1));
  buyBattle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  buyBattle.submit('u2', {});
  buyBattle.submit('u1', {bought: true});
  const purchased = buyer.items.find((item) => item.modelId === 113);
  assert.ok(purchased);
  assert.equal(
    purchased.fakeModelId,
    undefined,
    'a bought card is not a gift and must not be dreamed',
  );

  const sellSeller = createPlayerFixture(1, [4, 113]);
  const sellBuyer = createPlayerFixture(2, [5]);
  sellBuyer.curses = ['dream'];
  const sellGame = createGameFixture([sellSeller, sellBuyer]);
  sellGame.attackTurnPlayerId = 1;
  const sellBattle = new Battle(sellGame, new Random(1));
  sellBattle.submit('u1', {itemIds: [1, 2], targetPlayerId: 2});
  sellBattle.submit('u2', {});
  const sold = sellBuyer.items.find((item) => item.modelId === 113);
  assert.ok(sold);
  assert.equal(
    sold.fakeModelId,
    undefined,
    'a sold card is not a gift and must not be dreamed',
  );
});

test('performed miracles cannot be sold or swept away', () => {
  const seller = createPlayerFixture(1, [4, 214]);
  seller.items[1].used = true;
  const buyer = createPlayerFixture(2, [5]);
  const sellGame = createGameFixture([seller, buyer]);
  sellGame.attackTurnPlayerId = 1;
  const sellBattle = new Battle(sellGame, new Random(1));
  assert.throws(
    () => sellBattle.submit('u1', {itemIds: [1, 2], targetPlayerId: 2}),
    'Sell must reject performed miracles',
  );
  assert.equal(seller.items[1].used, true);
  assert.equal(buyer.items.some((item) => item.modelId === 214), false);

  const broomUser = createPlayerFixture(1, [205]);
  const target = createPlayerFixture(2, [214, 6, 113, 119]);
  target.items[0].used = true;
  const broomGame = createGameFixture([broomUser, target]);
  broomGame.attackTurnPlayerId = 1;
  const broomBattle = new Battle(broomGame, new Random(1));
  broomBattle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  broomBattle.submit('u2', {});
  assert.equal(
    target.items.find((item) => item.modelId === 214).used,
    true,
    'Nocturnal Broom must leave performed miracles alone',
  );
});

test('reusing a performed miracle as defense also draws a new card', () => {
  const attacker = createPlayerFixture(1, [6]);
  const defender = createPlayerFixture(2, [233, 6, 113]);
  defender.items[0].used = true;
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  battle.submit('u2', {itemIds: [1]});
  const performed = defender.items.find((item) => item.modelId === 233);
  assert.ok(performed);
  assert.equal(performed.used, true);
  assert.equal(
    defender.items.filter((item) => item.modelId > 0).length,
    4,
    'the performed miracle stays and a replacement card is drawn',
  );
});

test('Dangerous Pestle is a defendable attack and keeps plus damage', () => {
  class EnemyDangerRandom extends Random {
    pick(label, values, weight) {
      if (label === 'dangerTarget') {
        return values.find((value) => value.id === 2);
      }
      return super.pick(label, values, weight);
    }
  }
  const attacker = createPlayerFixture(1, [94, 74]);
  const defender = createPlayerFixture(2, [160]);
  const game = createGameFixture([attacker, defender]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new EnemyDangerRandom(1));
  battle.submit('u1', {itemIds: [1, 2]});
  assert.deepEqual(
    game.attacks[0].itemModelIds,
    [94, 74],
    'plus cards travel with the Pestle attack',
  );
  assert.equal(game.attacks[0].targetPlayerId, 2);
  const setTargetPlayer = game.events.find(
    (event) => event.action === 'setTargetPlayer',
  );
  assert.equal(setTargetPlayer.playerId, 2);
  assert.equal(defender.hp, 40, 'the attack must wait for defense');
  battle.submit('u2', {itemIds: [1]});
  assert.equal(
    defender.hp,
    15,
    '33 Pestle + plus damage minus 8 Terra Armor defense',
  );
});

test('Exchange strips an enemy target and converts the user', () => {
  const playerOne = createPlayerFixture(1, [3]);
  const playerTwo = createPlayerFixture(2, [6]);
  const game = createGameFixture([playerOne, playerTwo]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {
    itemIds: [1],
    targetPlayerId: 2,
    mp: 5,
    cp: 10,
  });
  assert.equal(playerOne.hp, 55);
  assert.equal(playerOne.mp, 5);
  assert.equal(playerOne.cp, 10);
  assert.equal(playerTwo.hp, 40, 'the targeted player is not changed');
  assert.equal(playerTwo.mp, 10);
  assert.equal(playerTwo.cp, 20);
  assert.equal(
    game.events.some((event) => event.action === 'setTargetPlayer'),
    false,
    'Exchange does not create an enemy target',
  );
  const exchange = game.events.find(
    (event) => event.action === 'exchange',
  );
  assert.equal(exchange.hp, 55);
  assert.equal(exchange.mp, 5);
  assert.equal(exchange.cp, 10);
});

test('discarding the entire hand does not grant a replacement gift', () => {
  const discardUser = createPlayerFixture(1, [178, 200, 193, 3, 5]);
  const enemy = createPlayerFixture(2, [6]);
  const game = createGameFixture([discardUser, enemy]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [0, 1, 2, 3, 4, 5]});
  assert.equal(
    (discardUser.items ?? []).length,
    0,
    'the whole hand is removed by Discard',
  );
  assert.equal(
    game.events.some((event) => event.action === 'discard'),
    true,
  );
  assert.equal(
    game.events.some(
      (event) => event.action === 'gift' && event.playerId === discardUser.id,
    ),
    false,
    'the official server does not gift a replacement for a full-hand discard',
  );
});

test('Discard works while the user is Fogged', () => {
  const discardUser = createPlayerFixture(1, [113]);
  discardUser.curses = ['fog'];
  const enemy = createPlayerFixture(2, [6]);
  const game = createGameFixture([discardUser, enemy]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [0, 1]});
  assert.equal(
    (discardUser.items ?? []).some((itemSlot) => itemSlot.modelId === 113),
    false,
    'Fog does not block Discard',
  );
  assert.ok(game.events.some((event) => event.action === 'discard'));
});

test('Discard works while the user is Dreamed and keeps remaining disguises', () => {
  const discardUser = createPlayerFixture(1, [113, 6]);
  discardUser.curses = ['dream'];
  discardUser.items[1].fakeModelId = 7;
  const enemy = createPlayerFixture(2, [6]);
  const game = createGameFixture([discardUser, enemy]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [0, 1]});
  assert.equal(
    discardUser.items.some((itemSlot) => itemSlot.modelId === 113),
    false,
    'Dream does not block Discard',
  );
  const remainingWeapon = discardUser.items.find(
    (itemSlot) => itemSlot.modelId === 6,
  );
  assert.ok(remainingWeapon, 'unselected cards stay in hand');
  assert.equal(
    remainingWeapon.fakeModelId,
    7,
    'the remaining card keeps its Dream disguise',
  );
  assert.ok(game.events.some((event) => event.action === 'discard'));
});

test('Goddess Soap removes exactly two performed miracles', () => {
  const soapUser = createPlayerFixture(1, [206]);
  const target = createPlayerFixture(2, [214, 215, 216, 217]);
  for (const itemSlot of target.items) {
    itemSlot.used = true;
  }
  const game = createGameFixture([soapUser, target]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new Random(1));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  battle.submit('u2', {});
  const remainingUsed = target.items.filter((itemSlot) => itemSlot.used);
  assert.equal(remainingUsed.length, 2);
  const removal = game.events.find(
    (event) => event.action === 'removeUsedMiracles',
  );
  assert.equal(removal.items.length, 2);
});

test('Goddess Soap skips the shuffle when no miracle has been performed', () => {
  const soapUser = createPlayerFixture(1, [206]);
  const target = createPlayerFixture(2, [214, 215, 216]);
  const game = createGameFixture([soapUser, target]);
  game.attackTurnPlayerId = 1;
  class NoEmptyMiracleShuffleRandom extends Random {
    shuffle(label, values) {
      assert.notEqual(
        label,
        'removeUsedMiracles',
        'no performed miracles are available to shuffle',
      );
      return super.shuffle(label, values);
    }
  }
  const battle = new Battle(game, new NoEmptyMiracleShuffleRandom(1));
  battle.submit('u1', {itemIds: [1], targetPlayerId: 2});
  battle.submit('u2', {});
  assert.equal(
    game.events.some((event) => event.action === 'safe'),
    true,
    'official logs emit safe when no performed miracle can be removed',
  );
});

test('gifts are drawn after guardian attacks resolve', () => {
  class AlwaysGuardianRandom extends Random {
    chance(label, percent) {
      if (label === 'guardianAttack') {
        return true;
      }
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'guardianItem') {
        const fullMoonBlade = values.find((value) => value.id === 286);
        if (fullMoonBlade !== undefined) {
          return fullMoonBlade;
        }
      }
      return super.pick(label, values, weight);
    }
  }
  const actingPlayer = createPlayerFixture(1, [6]);
  actingPlayer.items.push({id: 0, modelId: 0});
  const guardianOwner = createPlayerFixture(2, [6]);
  guardianOwner.guardian = 'moon';
  const game = createGameFixture([actingPlayer, guardianOwner]);
  game.attackTurnPlayerId = 1;
  const battle = new Battle(game, new AlwaysGuardianRandom(1));
  battle.finishTurn();
  assert.equal(
    game.events.some((event) => event.action === 'attackByGuardian'),
    true,
  );
  assert.equal(
    game.events.some((event) => event.action === 'gift'),
    false,
    'the replacement gift waits for the guardian attack to resolve',
  );
  const guardianEvents = game.events.map((event) => event.action);
  battle.submit('u1', {});
  const allActions = [
    ...guardianEvents,
    ...game.events.map((event) => event.action),
  ];
  assert.equal(
    allActions.includes('gift'),
    true,
    'the replacement gift is drawn after the guardian attack resolves',
  );
  assert.ok(
    allActions.lastIndexOf('gift') > allActions.indexOf('attackByGuardian'),
    'gift follows attackByGuardian',
  );
});

test('Earth and Moon guardians conjure cards without consuming the hand', () => {
  class GuardianItemRandom extends Random {
    constructor(
      seed,
      itemModelId,
      useDrop = false,
      useFullMoon = false,
      plusModelId = 232,
      dropModelId = 154,
    ) {
      super(seed);
      this.itemModelId = itemModelId;
      this.useDrop = useDrop;
      this.useFullMoon = useFullMoon;
      this.plusModelId = plusModelId;
      this.dropModelId = dropModelId;
    }
    chance(label, percent) {
      if (label === 'guardianAttack') return true;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'guardianItem') {
        let chosenModelId = this.itemModelId;
        if (this.useDrop) {
          chosenModelId = this.dropModelId;
        }
        if (this.useFullMoon) {
          chosenModelId = this.plusModelId;
        }
        const chosen = values.find((value) => value.id === chosenModelId);
        if (chosen !== undefined) return chosen;
      }
      if (label === 'guardianDropItem') {
        const chosen = values.find((value) => value.id === this.dropModelId);
        if (chosen !== undefined) return chosen;
      }
      return super.pick(label, values, weight);
    }
  }

  const earthOwner = createPlayerFixture(1, [6]);
  const earthEnemy = createPlayerFixture(2, [6]);
  earthOwner.guardian = 'earth';
  const earthGame = createGameFixture([earthOwner, earthEnemy]);
  earthGame.attackTurnPlayerId = 2;
  const earthBattle = new Battle(earthGame, new GuardianItemRandom(1, 77));
  earthBattle.finishTurn({ gift: false });
  assert.deepEqual(earthGame.attacks?.[0]?.itemModelIds, [77]);
  assert.equal(
    earthOwner.items.some((itemSlot) => itemSlot.modelId === 77),
    false,
    'the guardian does not take the card from the owner hand',
  );

  const dropOwner = createPlayerFixture(1, [6]);
  const dropEnemy = createPlayerFixture(2, [6]);
  dropOwner.guardian = 'earth';
  const dropGame = createGameFixture([dropOwner, dropEnemy]);
  dropGame.attackTurnPlayerId = 2;
  const dropBattle = new Battle(dropGame, new GuardianItemRandom(2, 285, true));
  dropBattle.finishTurn({ gift: false });
  const guardianEvent = dropGame.events.find(
    (event) => event.action === 'attackByGuardian',
  );
  assert.deepEqual(
    guardianEvent?.attack?.itemModelIds,
    [285, 154],
    'Drop carries the preselected gift as its second attack item',
  );
  assert.equal(
    Object.hasOwn(guardianEvent?.attack ?? {}, 'items'),
    false,
    'the raw attack does not include a decoded items summary',
  );
  const dropEvent = dropGame.events.find(
    (event) => event.action === 'addItem',
  );
  assert.equal(dropEvent?.item?.modelId, 154);
  assert.equal(
    Object.hasOwn(dropEvent ?? {}, 'playerId'),
    false,
    'the raw addItem event omits the owner id',
  );

  const moonOwner = createPlayerFixture(1, [6]);
  const moonEnemy = createPlayerFixture(2, [6]);
  moonOwner.guardian = 'moon';
  const moonGame = createGameFixture([moonOwner, moonEnemy]);
  moonGame.attackTurnPlayerId = 2;
  const moonBattle = new Battle(moonGame, new GuardianItemRandom(3, 215));
  moonBattle.finishTurn({ gift: false });
  assert.deepEqual(moonGame.attacks?.[0]?.itemModelIds, [215]);
  assert.equal(
    moonOwner.items.some((itemSlot) => itemSlot.modelId === 215),
    false,
    'the guardian does not take the miracle from the owner hand',
  );

  const bladeOwner = createPlayerFixture(1, [6]);
  const bladeEnemy = createPlayerFixture(2, [6]);
  const bladeThird = createPlayerFixture(3, [6]);
  bladeOwner.guardian = 'moon';
  const bladeGame = createGameFixture([bladeOwner, bladeEnemy, bladeThird]);
  bladeGame.attackTurnPlayerId = 2;
  const bladeBattle = new Battle(
    bladeGame,
    new GuardianItemRandom(4, 286, false, true, 232),
  );
  bladeBattle.finishTurn({ gift: false });
  assert.deepEqual(bladeGame.attacks?.[0]?.itemModelIds, [286, 232]);
  assert.equal(
    bladeGame.attacks?.length,
    2,
    'Full Moon Blade + Mirage attacks every enemy',
  );
});

test('Moon guardian uses Full Moon Blade after Apocalypse', () => {
  class FullMoonRandom extends Random {
    chance(label, percent) {
      if (label === 'guardianAttack') return true;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'guardianItem') {
        const mirage = values.find((value) => value.id === 232);
        if (mirage !== undefined) return mirage;
      }
      return super.pick(label, values, weight);
    }
  }
  const owner = createPlayerFixture(1, [6]);
  owner.guardian = 'moon';
  const enemy = createPlayerFixture(2, [6]);
  const thirdPlayer = createPlayerFixture(3, [6]);
  const game = createGameFixture([owner, enemy, thirdPlayer]);
  game.gf = 1;
  game.tiebreakGF = 1;
  game.attackTurnPlayerId = 2;
  const battle = new Battle(game, new FullMoonRandom(1));
  battle.finishTurn({gift: false});
  assert.deepEqual(game.attacks?.[0]?.itemModelIds, [286, 232]);
  assert.equal(game.attacks?.length, 2, 'Mirage targets every enemy');
});

test('Earth Drop conjures armor or a non-targeting sundry', () => {
  const owner = createPlayerFixture(1, [6]);
  owner.guardian = 'earth';
  const game = createGameFixture([owner]);
  const battle = new Battle(game, new Random(9));
  const pool = battle.getEarthDropPool();
  assert.equal(pool.length, 82, '78 armor cards plus 4 non-targeting sundries');
  const allowedSundries = new Set([203, 204, 208, 209]);
  for (const definition of pool) {
    const allowed =
      definition.category.key === 'armor'
      || allowedSundries.has(definition.id);
    assert.equal(
      allowed,
      true,
      `Drop pool contains ${definition.name}`,
    );
  }
  for (let index = 0; index < 300; index++) {
    battle.applyItemEffect(owner, owner, getItemDefinition(285));
  }
  const addedItems = game.events
    .filter((event) => event.action === 'addItem')
    .map((event) => event.item);
  assert.equal(addedItems.length, 300);
  for (const item of addedItems) {
    const definition = getItemDefinition(item.modelId);
    const allowed =
      definition.category.key === 'armor'
      || allowedSundries.has(item.modelId);
    assert.equal(
      allowed,
      true,
      `Drop created ${definition.name}`,
    );
    assert.notEqual(definition.category.key, 'weapons');
    assert.notEqual(definition.category.key, 'trade');
  }
});

test('Earth guardian does not conjure Discard or Sacrifice', () => {
  let inspectedGuardianPool = false;
  class EarthItemRandom extends Random {
    chance(label, percent) {
      if (label === 'guardianAttack') return true;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'guardianItem') {
        inspectedGuardianPool = true;
        assert.equal(
          values.some(
            (definition) =>
              definition.ability === 'discard'
              || definition.ability === 'sacrifice',
          ),
          false,
          'Discard and Sacrifice must be outside the Earth conjure pool',
        );
        assert.equal(
          values.some((definition) => !(definition.giftRate > 0)),
          false,
          'Earth guardian items must be giftable catalog cards',
        );
        return values[0];
      }
      return super.pick(label, values, weight);
    }
  }

  const owner = createPlayerFixture(1, [6]);
  const target = createPlayerFixture(2, [113]);
  owner.guardian = 'earth';
  const game = createGameFixture([owner, target]);
  game.attackTurnPlayerId = 2;
  const battle = new Battle(game, new EarthItemRandom(1));
  battle.finishTurn({gift: false});
  assert.equal(inspectedGuardianPool, true);
});

test('Earth guardian Buy and Sell resolve through the trade flow', () => {
  class EarthTradeRandom extends Random {
    constructor(seed, itemModelId, saleModelId = 113) {
      super(seed);
      this.itemModelId = itemModelId;
      this.saleModelId = saleModelId;
    }
    chance(label, percent) {
      if (label === 'guardianAttack') return true;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'guardianItem') {
        const chosen = values.find((value) => value.id === this.itemModelId);
        if (chosen !== undefined) return chosen;
      }
      if (label === 'guardianSaleItem') {
        const chosen = values.find((value) => value.id === this.saleModelId);
        if (chosen !== undefined) return chosen;
      }
      return super.pick(label, values, weight);
    }
  }

  const buyerOwner = createPlayerFixture(1, [6]);
  const buyerSeller = createPlayerFixture(2, [113]);
  buyerOwner.guardian = 'earth';
  const buyGame = createGameFixture([buyerOwner, buyerSeller]);
  buyGame.attackTurnPlayerId = 2;
  const buyBattle = new Battle(buyGame, new EarthTradeRandom(1, 5));
  buyBattle.finishTurn({ gift: false });
  assert.deepEqual(buyGame.attacks?.[0]?.itemModelIds, [5]);
  buyBattle.submit('u2', {});
  assert.ok(
    buyGame.events.some((event) => event.action === 'buy'),
    'Earth Buy should offer an item',
  );
  assert.ok(
    buyGame.events.some(
      (event) => event.action === 'setBought' && event.bought === true,
    ),
    'guardian Earth should auto-confirm its Buy',
  );
  assert.ok(
    buyerOwner.items.some((itemSlot) => itemSlot.modelId === 113),
    'the purchased item moves to the guardian owner',
  );

  const sellOwner = createPlayerFixture(1, [6]);
  const sellBuyer = createPlayerFixture(2, [113]);
  sellOwner.guardian = 'earth';
  const sellGame = createGameFixture([sellOwner, sellBuyer]);
  sellGame.attackTurnPlayerId = 2;
  const sellBattle = new Battle(sellGame, new EarthTradeRandom(2, 4, 113));
  sellBattle.finishTurn({ gift: false });
  assert.equal(sellGame.attacks?.[0]?.itemModelIds.length, 2);
  sellBattle.submit('u2', {});
  assert.ok(
    sellGame.events.some((event) => event.action === 'sell'),
    'Earth Sell should transfer its conjured item',
  );
  assert.ok(
    sellBuyer.items.some((itemSlot) => itemSlot.modelId === 113),
    'the sold item moves to the target',
  );
  assert.equal(sellOwner.cp, 21, 'the guardian owner receives the sale price');
});

test('Earth Exchange is a random self-exchange that preserves the stat total', () => {
  class ExchangeRandom extends Random {
    chance(label, percent) {
      if (label === 'guardianAttack') return true;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'guardianItem') {
        const exchange = values.find((value) => value.id === 3);
        if (exchange !== undefined) {
          return exchange;
        }
      }
      return super.pick(label, values, weight);
    }
  }
  const earthOwner = createPlayerFixture(1, [6]);
  const enemy = createPlayerFixture(2, [6]);
  earthOwner.hp = 94;
  earthOwner.mp = 51;
  earthOwner.cp = 20;
  earthOwner.guardian = 'earth';
  const game = createGameFixture([earthOwner, enemy]);
  game.attackTurnPlayerId = 2;
  const battle = new Battle(game, new ExchangeRandom(7));
  battle.finishTurn({gift: false});
  const exchangeEvent = game.events.find((event) => event.action === 'exchange');
  const guardianEvent = game.events.find(
    (event) => event.action === 'attackByGuardian',
  );
  assert.deepEqual(guardianEvent?.attack?.itemModelIds, [3]);
  assert.equal(
    game.events.some((event) => event.action === 'setTargetPlayer'),
    false,
    'guardian Exchange does not target an enemy',
  );
  assert.ok(exchangeEvent, 'guardian Exchange emits an exchange event');
  assert.equal(exchangeEvent.hp ?? 0, earthOwner.hp, 'HP may be zero');
  assert.equal(exchangeEvent.mp ?? 0, earthOwner.mp, 'MP may be zero');
  assert.equal(exchangeEvent.cp ?? 0, earthOwner.cp, 'CP may be zero');
  assert.equal(
    earthOwner.hp + earthOwner.mp + earthOwner.cp,
    94 + 51 + 20,
    'guardian Exchange preserves the stat total',
  );
});

test('guardian Exchange spreads the total across every stat, including zero HP', () => {
  const seenSpreads = new Set();
  const largestCounts = {hp: 0, mp: 0, cp: 0};
  let sawZeroHp = false;
  for (let seed = 1; seed <= 50; seed++) {
    const game = createGameFixture([createPlayerFixture(1, [6])]);
    const battle = new Battle(game, new Random(seed));
    const spread = battle.spreadStatTotal(10);
    assert.equal(spread.hp + spread.mp + spread.cp, 10);
    assert.ok(spread.hp >= 0, 'HP may receive zero');
    assert.ok(spread.mp >= 0 && spread.mp <= 99);
    assert.ok(spread.cp >= 0 && spread.cp <= 99);
    if (spread.hp === 0) {
      sawZeroHp = true;
    }
    seenSpreads.add(`${spread.hp}/${spread.mp}/${spread.cp}`);
    const largestStat = Object.entries(spread)
      .sort((left, right) => right[1] - left[1])[0][0];
    largestCounts[largestStat]++;
  }
  assert.ok(sawZeroHp, 'some seeds give HP the minimum of zero');
  assert.ok(
    seenSpreads.size > 1,
    'different seeds produce different random spreads',
  );
  assert.ok(
    largestCounts.hp > 0 && largestCounts.mp > 0 && largestCounts.cp > 0,
    'different stats can receive the largest share',
  );

  const averages = {hp: 0, mp: 0, cp: 0};
  const sampleCount = 600;
  for (let seed = 1; seed <= sampleCount; seed++) {
    const game = createGameFixture([createPlayerFixture(1, [6])]);
    const battle = new Battle(game, new Random(seed));
    const spread = battle.spreadStatTotal(30);
    averages.hp += spread.hp;
    averages.mp += spread.mp;
    averages.cp += spread.cp;
  }
  for (const stat of ['hp', 'mp', 'cp']) {
    averages[stat] /= sampleCount;
  }
  assert.ok(
    Math.abs(averages.hp - 15) < 2,
    `HP should average about half the total, got ${averages.hp}`,
  );
  assert.ok(
    averages.hp > averages.mp && averages.hp > averages.cp,
    'the asymmetric rule favors HP over MP and CP',
  );

  for (let totalStats = 1; totalStats <= 297; totalStats++) {
    const game = createGameFixture([createPlayerFixture(1, [6])]);
    const battle = new Battle(game, new Random(totalStats));
    const spread = battle.spreadStatTotal(totalStats);
    assert.equal(
      spread.hp + spread.mp + spread.cp,
      totalStats,
      'the total is preserved',
    );
    assert.ok(spread.hp >= 0, 'HP may receive zero');
    assert.ok(spread.mp >= 0 && spread.mp <= 99);
    assert.ok(spread.cp >= 0 && spread.cp <= 99);
  }
});

test('guardian Earth Buy emits canNotBuy when the owner is poor', () => {
  class PoorEarthBuyRandom extends Random {
    chance(label, percent) {
      if (label === 'guardianAttack') return true;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'guardianItem') {
        const buy = values.find((value) => value.id === 5);
        if (buy !== undefined) return buy;
      }
      return super.pick(label, values, weight);
    }
  }
  const owner = createPlayerFixture(1, [6]);
  const seller = createPlayerFixture(2, [113]);
  owner.guardian = 'earth';
  owner.cp = 0;
  const game = createGameFixture([owner, seller]);
  game.attackTurnPlayerId = 2;
  const battle = new Battle(game, new PoorEarthBuyRandom(1));
  battle.finishTurn({ gift: false });
  battle.submit('u2', {});
  assert.ok(
    game.events.some((event) => event.action === 'canNotBuy'),
    'an unaffordable guardian Buy resolves as canNotBuy (client poor)',
  );
  assert.equal(
    game.events.some((event) => event.action === 'setBought'),
    false,
    'no purchase is confirmed without enough money',
  );
});

test('Sun Amulet revives after Apocalypse', () => {
  const player = createPlayerFixture(1, [208]);
  const enemy = createPlayerFixture(2, [6]);
  const game = createGameFixture([player, enemy]);
  game.gf = 1;
  game.tiebreakGF = 1;
  const battle = new Battle(game, new Random(1));
  player.hp = 0;
  battle.resolveDeaths();
  assert.notEqual(player.dead, true, 'the amulet prevents death');
  assert.equal(
    player.items.some((itemSlot) => itemSlot.modelId === 208),
    false,
    'the amulet is consumed',
  );
  assert.equal(player.hp, 10, 'revive restores 10 HP');
  const reviveEvent = game.events.find(
    (event) => event.action === 'revive',
  );
  assert.equal(reviveEvent.item.modelId, 208);

  battle.finishTurn();
  const reviveEventIndex = game.events.findIndex(
    (event) => event.action === 'revive',
  );
  const giftEventIndex = game.events.findIndex(
    (event) => event.action === 'gift' && event.playerId === player.id,
  );
  assert.ok(giftEventIndex > reviveEventIndex, 'the revived slot is refilled');
  assert.equal(
    player.items.some((itemSlot) => itemSlot.modelId === 0),
    false,
    'the replacement gift fills the amulet slot',
  );
});

test('Trickster removes two cards and Charity Fairy boosts one stat', () => {
  class DevilRandom extends Random {
    constructor(seed, devilId, stat) {
      super(seed);
      this.devilId = devilId;
      this.stat = stat;
      this.devilsRemaining = 1;
    }
    chance(label, percent) {
      if (label.startsWith('devilChance') && this.devilsRemaining > 0) {
        this.devilsRemaining--;
        return true;
      }
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label.startsWith('devilModel')) {
        return values.find((value) => value.id === this.devilId);
      }
      if (label === 'devilStat') return this.stat;
      if (label === 'devilItems') return [...values];
      return super.pick(label, values, weight);
    }
  }

  const tricksterPlayer = createPlayerFixture(1, [214, 6, 113]);
  tricksterPlayer.items[0].used = true;
  const tricksterGame = createGameFixture([tricksterPlayer]);
  tricksterGame.gf = 1;
  tricksterGame.tiebreakGF = 1;
  const tricksterBattle = new Battle(
    tricksterGame,
    new DevilRandom(1, 243, 'hp'),
  );
  tricksterBattle.resolveGift(tricksterPlayer);
  const tricksterEvent = tricksterGame.events.find(
    (event) => event.action === 'removeSomething',
  );
  assert.ok(tricksterEvent);
  assert.equal(tricksterEvent.items.length, 2);
  assert.equal(
    tricksterEvent.items.some((itemSlot) => itemSlot.used === true),
    true,
    'Trickster can remove a performed miracle',
  );

  const charityPlayer = createPlayerFixture(1, [6]);
  const charityGame = createGameFixture([charityPlayer]);
  charityGame.gf = 1;
  charityGame.tiebreakGF = 1;
  const charityBattle = new Battle(
    charityGame,
    new DevilRandom(2, 244, 'hp'),
  );
  charityBattle.resolveGift(charityPlayer);
  assert.equal(charityPlayer.hp, 50);
});

test('Magnetic Storm shuffles every living card and re-applies Dream', () => {
  class StormRandom extends Random {
    shuffle(label, values) {
      if (label === 'shuffleItems') return [...values];
      if (label === 'shuffleSlotOrder') return [...values];
      return super.shuffle(label, values);
    }
    chance(label, percent) {
      if (label === 'dreamReal') return false;
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label === 'dreamItem') return values[0];
      return super.pick(label, values, weight);
    }
  }

  const playerOne = createPlayerFixture(1, [214, 6, 113]);
  const playerTwo = createPlayerFixture(2, [7, 10]);
  const deadPlayer = createPlayerFixture(3, [16, 17]);
  deadPlayer.dead = true;
  deadPlayer.items[0].used = true;
  deadPlayer.items[0].fakeModelId = 0;
  deadPlayer.items[1].fakeModelId = 7;
  const deadItemsBefore = structuredClone(deadPlayer.items);
  playerOne.curses = ['dream'];
  playerOne.items[0].used = true;
  playerOne.items[1].fakeModelId = 7;
  playerOne.items.push({id: 4, modelId: 0});
  const game = createGameFixture([playerOne, playerTwo, deadPlayer]);
  const battle = new Battle(game, new StormRandom(1));
  battle.applyItemEffect(
    playerOne,
    playerOne,
    getItemDefinition(295),
  );

  const occupied = [...playerOne.items, ...playerTwo.items].filter(
    (itemSlot) => itemSlot.modelId > 0,
  );
  assert.deepEqual(
    occupied.map((itemSlot) => itemSlot.modelId).sort((left, right) => left - right),
    [6, 7, 10, 113, 214],
    'every living card is included, including performed miracles',
  );
  assert.equal(
    occupied.every((itemSlot) => itemSlot.used === false),
    true,
    'performed state is cleared',
  );
  const placeholders = [...playerOne.items, ...playerTwo.items].filter(
    (itemSlot) => itemSlot.modelId === 0,
  );
  assert.equal(
    placeholders.length,
    1,
    'the storm preserves the total number of empty slots',
  );
  assert.equal(
    playerOne.items.find((itemSlot) => itemSlot.id === 4).modelId,
    7,
    'a pre-existing empty slot can be filled',
  );
  assert.equal(
    playerTwo.items.at(-1).modelId,
    0,
    'the empty slot can move to another hand',
  );
  const replaceItems = game.events.filter(
    (event) => event.action === 'replaceItems',
  );
  assert.equal(
    replaceItems.every((event) =>
      event.items.every((itemSlot) => itemSlot.modelId > 0)),
    true,
    'replaceItems emits only occupied cards',
  );
  assert.equal(
    replaceItems.every((event) =>
      event.items.every(
        (itemSlot, index) =>
          index === 0 || itemSlot.id > event.items[index - 1].id,
      )),
    true,
    'replaceItems lists slots in ascending order',
  );
  assert.equal(
    replaceItems.some((event) => event.playerId === deadPlayer.id),
    false,
    'dead players do not receive replaceItems',
  );
  assert.deepEqual(
    deadPlayer.items,
    deadItemsBefore,
    'dead players and their performed/disguised state are untouched',
  );
  assert.equal(
    playerTwo.items.filter((itemSlot) => itemSlot.fakeModelId > 0).length,
    0,
    'non-Dream holders do not keep disguises',
  );
  assert.equal(
    playerTwo.items.every((itemSlot) => itemSlot.fakeModelId === undefined),
    true,
    'non-Dream holders omit the zero',
  );
  const dreamFakes = playerOne.items.filter(
    (itemSlot) =>
      itemSlot.modelId > 0
      && getDreamDisguisePool(getItemDefinition(itemSlot.modelId)).length > 1,
  );
  assert.ok(dreamFakes.length > 0);
  for (const itemSlot of dreamFakes) {
    assert.ok(Number.isInteger(itemSlot.fakeModelId));
    assert.notEqual(itemSlot.fakeModelId, itemSlot.modelId);
  }
});

test('Dreaming Hat redraw leaves performed miracles untouched', () => {
  const player = createPlayerFixture(1, [214, 6, 113]);
  const battle = new Battle(createGameFixture([player]), new Random(1));
  player.items[0].used = true;
  const before = {
    id: player.items[0].id,
    modelId: player.items[0].modelId,
    used: player.items[0].used,
  };
  battle.resolveRedraw(player);
  assert.deepEqual(
    {
      id: player.items.find((itemSlot) => itemSlot.id === before.id).id,
      modelId: player.items.find((itemSlot) => itemSlot.id === before.id).modelId,
      used: player.items.find((itemSlot) => itemSlot.id === before.id).used,
    },
    before,
  );
  assert.notEqual(player.items.find((itemSlot) => itemSlot.id === 2).modelId, 6);
  assert.notEqual(player.items.find((itemSlot) => itemSlot.id === 3).modelId, 113);
});

test('death clears positive confusion and preserves a negative counter', () => {
  const dying = createPlayerFixture(1, [6]);
  const dead = createPlayerFixture(2, [6]);
  dying.hp = 0;
  dying.confusionCount = 3;
  dead.hp = 0;
  dead.dead = true;
  dead.confusionCount = -1;
  const game = createGameFixture([dying, dead]);
  const battle = new Battle(game, new Random(1));
  battle.resolveDeaths(false);
  assert.equal(dying.dead, true);
  assert.equal(dying.confusionCount, 0, 'positive confusion is cleared on death');
  assert.equal(dead.confusionCount, -1, 'the dead-state negative value is kept');
});
test('confused bots choose random targets, including themselves', () => {
  const targets = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const playerOne = createPlayerFixture(1, [6]);
    const playerTwo = createPlayerFixture(2, [6]);
    playerOne.isBot = true;
    playerTwo.isBot = true;
    playerOne.confusionCount = 3;
    const game = createGameFixture([playerOne, playerTwo]);
    game.attackTurnPlayerId = 1;
    const battle = new Battle(game, new Random(seed));
    const choice = battle.botCommand();
    assert.ok(choice);
    targets.add(choice.command.targetPlayerId);
  }
  assert.ok(targets.has(1), 'a confused bot can target itself');
  assert.ok(targets.has(2), 'a confused bot can target its enemy');
});

test('Trickster can remove two performed miracles', () => {
  class TwoMiracleDevilRandom extends Random {
    constructor(seed) {
      super(seed);
      this.devilsRemaining = 1;
    }
    chance(label, percent) {
      if (label.startsWith('devilChance') && this.devilsRemaining > 0) {
        this.devilsRemaining--;
        return true;
      }
      return super.chance(label, percent);
    }
    pick(label, values, weight) {
      if (label.startsWith('devilModel')) {
        return values.find((value) => value.id === 243);
      }
      if (label === 'devilStat') return 'hp';
      return super.pick(label, values, weight);
    }
    shuffle(label, values) {
      if (label === 'devilItems') {
        return [...values].sort(
          (first, second) => Number(second.used) - Number(first.used),
        );
      }
      return super.shuffle(label, values);
    }
  }

  const player = createPlayerFixture(1, [214, 215, 6]);
  player.items[0].used = true;
  player.items[1].used = true;
  const game = createGameFixture([player]);
  game.gf = 1;
  game.tiebreakGF = 1;
  new Battle(game, new TwoMiracleDevilRandom(1)).resolveGift(player);
  const removal = game.events.find(
    (event) => event.action === 'removeSomething',
  );
  assert.equal(removal.items.length, 2);
  assert.equal(
    removal.items.every((itemSlot) => itemSlot.used === true),
    true,
    'both removed cards are performed miracles',
  );
  assert.equal(
    player.items.some((itemSlot) => itemSlot.used === true),
    false,
    'both performed miracles leave the hand',
  );
});

