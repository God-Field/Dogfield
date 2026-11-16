import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../rooms/service.ts';
import { Store } from '../store.ts';
import { HttpError } from '../errors.ts';

const expectHttpError = (operation, expectedStatus) =>
  assert.throws(
    operation,
    (error) => error instanceof HttpError && error.status === expectedStatus,
  );

const createPrivateRoom = (rooms, password = 'protocol-edge') => ({
  mode: 'private',
  ...rooms.invoke('create-room', 'owner', {
    mode: 'private',
    userName: 'Owner',
    password,
  }),
});

const join = (rooms, payload, userId, userName) => {
  rooms.invoke('join-room', userId, {
    ...payload,
    userName,
  });
};

const enter = (rooms, payload, userId, team = 0) => {
  rooms.invoke('make-entry', userId, {
    ...payload,
    team,
  });
};

test('wrong scalar field types are rejected with 400', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);

  const cases = [
    () =>
      rooms.invoke('make-entry', 'owner', {
        ...payload,
        team: '1',
      }),
    () =>
      rooms.invoke('make-entry', 'owner', {
        ...payload,
        team: 3.4,
      }),
    () =>
      rooms.invoke('set-room-locked', 'owner', {
        ...payload,
        isLocked: 1,
      }),
    () =>
      rooms.invoke('submit-command', 'owner', {
        ...payload,
        command: 'attack',
      }),
    () =>
      rooms.invoke('set-tiebreak', 'owner', {
        ...payload,
        gf: 2.5,
      }),
    () =>
      rooms.invoke('start-game', 'owner', {
        ...payload,
        mode: 'training',
        playerCount: '2',
      }),
  ];

  for (const operation of cases) {
    assert.throws(
      operation,
      (error) =>
        error instanceof HttpError &&
        error.status === 400 &&
        error.message === '400 Bad Request\n',
    );
  }

  expectHttpError(
    () =>
      rooms.invoke('post-message', 'owner', {
        ...payload,
        text: 'hello',
        team: 5,
      }),
    400,
  );
});

test('chat preserves message text while matching official whitespace and length validation', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const messagePath = `${rooms.path(payload.mode, payload.roomId)}/messages/all`;
  const preservedText = 'alpha  beta\tline\n<b>&\u0000';

  rooms.invoke('post-message', 'owner', {
    ...payload,
    text: preservedText,
  });
  assert.equal(store.get(messagePath).text, preservedText);

  const zeroWidthPrefix = '\u200bmessage';
  rooms.invoke('post-message', 'owner', {
    ...payload,
    text: zeroWidthPrefix,
  });
  assert.equal(store.get(messagePath).text, zeroWidthPrefix);

  const fiftyCodePoints = '😀'.repeat(50);
  rooms.invoke('post-message', 'owner', {
    ...payload,
    text: fiftyCodePoints,
  });
  assert.equal(store.get(messagePath).text, fiftyCodePoints);

  const rejectedTexts = [
    '',
    ' leading',
    'trailing ',
    '\tleading',
    'trailing\n',
    '\u00a0leading',
    'trailing\u2003',
    '\u0085leading',
    'x'.repeat(51),
    '😀'.repeat(51),
    'e\u0301'.repeat(26),
  ];
  for (const text of rejectedTexts) {
    expectHttpError(
      () => rooms.invoke('post-message', 'owner', { ...payload, text }),
      400,
    );
  }
});

test('absent team, tiebreak, and lock fields use zero-value semantics', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  join(rooms, payload, 'visitor', 'Visitor');

  enter(rooms, payload, 'owner');
  assert.equal(store.get(path).entries[0].team, 0, 'missing team is zero');

  enter(rooms, payload, 'visitor', 3);
  rooms.invoke('set-tiebreak', 'owner', { ...payload, gf: 50 });
  rooms.invoke('set-tiebreak', 'owner', { ...payload, gf: 0 });
  assert.equal(store.get(path).tiebreakGF, undefined, 'gf 0 clears');
  rooms.invoke('set-tiebreak', 'owner', { ...payload, gf: 50 });
  rooms.invoke('set-tiebreak', 'owner', payload);
  assert.equal(store.get(path).tiebreakGF, undefined, 'missing gf clears');

  rooms.invoke('set-room-locked', 'owner', {
    ...payload,
    isLocked: true,
  });
  assert.equal(store.get(path).isLocked, true);
  rooms.invoke('set-room-locked', 'owner', {
    ...payload,
    isLocked: null,
  });
  assert.equal(store.get(path).isLocked, undefined, 'null lock is removed');
});

test('team chat writes only for the matching live game team', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  join(rooms, payload, 'one', 'One');
  join(rooms, payload, 'two', 'Two');
  join(rooms, payload, 'three', 'Three');

  rooms.invoke('post-message', 'one', {
    ...payload,
    text: 'lobby',
    team: 1,
  });
  assert.equal(store.get(`${path}/messages/team1`), null, 'no lobby team chat');

  enter(rooms, payload, 'one', 1);
  enter(rooms, payload, 'two', 1);
  enter(rooms, payload, 'three', 2);
  rooms.invoke('start-game', 'owner', payload);

  rooms.invoke('post-message', 'one', {
    ...payload,
    text: 'team one',
    team: 1,
  });
  assert.equal(store.get(`${path}/messages/team1`).text, 'team one');

  rooms.invoke('post-message', 'three', {
    ...payload,
    text: 'cross team',
    team: 1,
  });
  assert.equal(
    store.get(`${path}/messages/team1`).text,
    'team one',
    'cross-team posts do not write',
  );

  rooms.invoke('post-message', 'one', {
    ...payload,
    text: 'wrong team',
    team: 2,
  });
  assert.equal(store.get(`${path}/messages/team2`), null);

  rooms.invoke('post-message', 'one', {
    ...payload,
    text: 'all chat',
  });
  assert.equal(store.get(`${path}/messages/all`).text, 'all chat');

  const finishedRoom = store.getRoomForUpdate(path);
  finishedRoom.game.isOver = true;
  store.set(path, finishedRoom);
  rooms.invoke('post-message', 'one', {
    ...payload,
    text: 'after over',
    team: 1,
  });
  assert.equal(store.get(`${path}/messages/team1`).text, 'after over');

  rooms.invoke('reset-game', 'owner', payload);
  rooms.invoke('post-message', 'one', {
    ...payload,
    text: 'after reset',
    team: 1,
  });
  assert.equal(
    store.get(`${path}/messages/team1`).text,
    'after over',
    'a reset room does not update the old team document',
  );
});

test('stored rooms keep zero fake model ids omitted on load', () => {
  const store = new Store();
  const path = 'modes/private/rooms/legacy-items';
  store.set(path, {
    users: [{ id: 'u1', name: 'One' }],
    game: {
      gf: 1,
      attackTurnPlayerId: 1,
      updateCount: 1,
      isOver: false,
      players: [{
        id: 1,
        userId: 'u1',
        name: 'One',
        hp: 40,
        mp: 10,
        cp: 20,
        items: [
          { id: 1, modelId: 6 },
          { id: 0, modelId: 0 },
        ],
      }],
      events: [
        { action: 'gift', item: { id: 2, modelId: 113 } },
        {
          action: 'replaceItems',
          items: [{ id: 3, modelId: 135 }],
        },
        {
          action: 'pray',
          overflowItem: { id: 4, modelId: 119 },
        },
      ],
    },
  });

  new RoomService(store);
  const room = store.get(path);
  assert.deepEqual(
    room.game.players[0].items.map((itemSlot) => itemSlot.fakeModelId),
    [undefined, undefined],
  );
  assert.equal(room.game.events[0].item.fakeModelId, undefined);
  assert.equal(room.game.events[1].items[0].fakeModelId, undefined);
  assert.equal(room.game.events[2].overflowItem.fakeModelId, undefined);
});

test('deniedUserIds is published and empty kick targets are a no-op', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  join(rooms, payload, 'member', 'Member');
  join(rooms, payload, 'banned', 'Banned');

  rooms.invoke('kick-user', 'owner', {
    ...payload,
    userId: 'banned',
  });
  assert.deepEqual(store.get(path).deniedUserIds, ['banned']);
  expectHttpError(
    () =>
      rooms.invoke('join-room', 'banned', {
        ...payload,
        userName: 'Banned',
      }),
    403,
  );

  rooms.invoke('kick-user', 'owner', {
    ...payload,
    userId: '',
  });
  assert.deepEqual(
    store.get(path).deniedUserIds,
    ['banned'],
    'an empty kick target is ignored',
  );
});

test('start is owner-only and ownership transfers to the first remaining user', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  join(rooms, payload, 'visitor', 'Visitor');
  join(rooms, payload, 'third', 'Third');
  enter(rooms, payload, 'owner');
  enter(rooms, payload, 'visitor');

  expectHttpError(
    () => rooms.invoke('start-game', 'visitor', payload),
    403,
  );
  rooms.invoke('start-game', 'owner', payload);

  const resetPayload = createPrivateRoom(rooms, 'restart');
  const resetPath = rooms.path(resetPayload.mode, resetPayload.roomId);
  join(rooms, resetPayload, 'visitor', 'Visitor');
  enter(rooms, resetPayload, 'owner');
  enter(rooms, resetPayload, 'visitor');
  rooms.invoke('start-game', 'owner', resetPayload);
  const finishedRoom = store.getRoomForUpdate(resetPath);
  finishedRoom.game.isOver = true;
  store.set(resetPath, finishedRoom);

  expectHttpError(
    () => rooms.invoke('reset-game', 'visitor', resetPayload),
    403,
  );
  rooms.invoke('reset-game', 'owner', resetPayload);
  assert.equal(store.get(resetPath).game, undefined);
  enter(rooms, resetPayload, 'owner');
  enter(rooms, resetPayload, 'visitor');
  expectHttpError(
    () => rooms.invoke('start-game', 'visitor', resetPayload),
    403,
  );
  rooms.invoke('start-game', 'owner', resetPayload);
  assert.equal(store.get(resetPath).game.updateCount, 1);
  expectHttpError(
    () => rooms.invoke('reset-game', 'owner', resetPayload),
    403,
  );

  const transferPayload = createPrivateRoom(rooms, 'transfer');
  join(rooms, transferPayload, 'first', 'First');
  join(rooms, transferPayload, 'second', 'Second');
  enter(rooms, transferPayload, 'owner');
  enter(rooms, transferPayload, 'first');
  rooms.invoke('leave-room', 'owner', transferPayload);
  enter(rooms, transferPayload, 'second');
  expectHttpError(
    () => rooms.invoke('start-game', 'second', transferPayload),
    403,
  );
  rooms.invoke('start-game', 'first', transferPayload);
});

test('internal battle progress is stored but not published', () => {
  const store = new Store();
  const path = 'modes/training/rooms/internal-progress';
  store.set(path, {
    users: [],
    isLocked: false,
    entries: [],
    tiebreakGF: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    game: {
      players: [],
      gf: 1,
      attackTurnPlayerId: 1,
      events: [],
      updateCount: 1,
      serverTurn: {turnDeaths: []},
    },
  });

  assert.equal(store.get(path).game.serverTurn, undefined);
  assert.deepEqual(store.getGameState(path), {turnDeaths: []});

  store.delete(path);
  assert.equal(store.getGameState(path), undefined);
});

test('wire documents omit serverTurn, omitted isBot on humans, and expose room tiebreakGF', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const { roomId } = rooms.invoke('create-room', 'wireUser', {
    mode: 'training',
    userName: 'WireUser',
  });
  rooms.invoke('start-game', 'wireUser', {
    mode: 'training',
    roomId,
    playerCount: 2,
    gf: 50,
  });
  const room = store.get(rooms.path('training', roomId));
  assert.equal(room.tiebreakGF, 50, 'tiebreakGF is on room document');
  assert.equal(room.users[0].updatedAt, undefined, 'training user omits updatedAt');

  const human = room.game.players.find((player) => player.userId === 'wireUser');
  assert.equal(human.isBot, undefined, 'isBot is omitted on humans');

  const bot = room.game.players.find((player) => player.id !== human.id);
  assert.equal(bot.isBot, true, 'isBot is present on bots');
  assert.equal(room.game.serverTurn, undefined, 'serverTurn is not on wire game');
});
