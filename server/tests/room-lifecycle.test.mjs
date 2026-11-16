import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RoomService,
  USER_COUNT_REFRESH_INTERVAL_MS,
  TRAINING_COUNT_ACTIVITY_WINDOW_MS,
  PRIVATE_COUNT_ACTIVITY_WINDOW_MS,
  DUEL_COUNT_ACTIVITY_WINDOW_MS,
} from '../rooms/service.ts';
import { Store } from '../store.ts';
import { Random } from '../random.ts';
import { HttpError } from '../errors.ts';

const expectHttpError = (operation, expectedStatus) =>
  assert.throws(
    operation,
    (error) => error instanceof HttpError && error.status === expectedStatus,
  );

test('leaving a room publishes only newly generated battle events', () => {
  const maintenanceAction = 'leave-room';
  const store = new Store();
  const rooms = new RoomService(store, { random: new Random(1) });
  const now = Date.now();
  const staleTimestamp = new Date(now - 300 * 1000).toISOString();
  const roomId = `event-batch-${maintenanceAction}`;
  const roomPath = rooms.path('private', roomId);
  const previousEvents = [
    { action: 'gift', playerId: 1, item: { id: 1, modelId: 6 } },
    { action: 'advanceGF', playerId: 1 },
  ];
  store.rooms.set(roomPath, { owner: 'user-1', banned: [] });
  store.set(roomPath, {
    users: [
      { id: 'user-1', name: 'First', updatedAt: staleTimestamp },
      { id: 'user-2', name: 'Second', updatedAt: new Date(now).toISOString() },
    ],
    entries: [
      { userId: 'user-1', team: 0 },
      { userId: 'user-2', team: 0 },
    ],
    game: {
      players: [1, 2].map((playerId) => ({
        id: playerId,
        userId: `user-${playerId}`,
        name: `Player ${playerId}`,
        hp: 40,
        mp: 10,
        cp: 20,
        items: [{ id: 1, modelId: 6 }],
      })),
      gf: 2,
      attackTurnPlayerId: 1,
      events: previousEvents,
      updateCount: 2,
      updatedAt: staleTimestamp,
    },
  });

  rooms.invoke('leave-room', 'user-1', { mode: 'private', roomId });

  const updatedGame = store.get(roomPath).game;
  assert.equal(updatedGame.updateCount, 3);
  assert.deepEqual(updatedGame.events, [
    { action: 'useAttackItems', items: [{ id: 1, modelId: 6 }] },
    { action: 'setTargetPlayer', playerId: 2 },
  ]);
  assert.equal(updatedGame.players[0].isBot, true);
  assert.equal(updatedGame.attacks[0].targetPlayerId, 2);

  const updatedRoom = store.get(roomPath);
  assert.deepEqual(updatedRoom.users.map((user) => user.id), ['user-2']);
  assert.deepEqual(updatedRoom.entries, [{ userId: 'user-2', team: 0 }]);
  assert.deepEqual(store.rooms.get(roomPath), { owner: 'user-2', banned: [] });

  rooms.invoke('join-room', 'user-1', {
    mode: 'private',
    roomId,
    userName: 'First',
  });
  const rejoinedRoom = store.get(roomPath);
  assert.ok(rejoinedRoom.users.some((user) => user.id === 'user-1'));
  assert.equal(rejoinedRoom.game.players[0].isBot, undefined);
});
function createPrivateRoom(rooms, password = 'reusable') {
  return {
    mode: 'private',
    ...rooms.invoke('create-room', 'owner', {
      mode: 'private',
      userName: 'Owner',
      password,
    }),
  };
}

test('stale room membership persists without connection tracking or count activity', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const now = Date.now();

  for (const mode of ['training', 'private', 'duel']) {
    const roomPath = rooms.path(mode, `stale-${mode}`);
    const staleTimestamp = new Date(now - 600000).toISOString();
    store.set(roomPath, {
      users: [{ id: 'owner', name: 'Owner', updatedAt: staleTimestamp }],
      userCount: 1,
      updatedAt: staleTimestamp,
      game: {
        players: [
          { id: 1, userId: 'owner', name: 'Owner', hp: 40, mp: 10, cp: 20, items: [] },
          { id: 2, name: 'Bot', isBot: true, hp: 40, mp: 10, cp: 20, items: [] },
        ],
        gf: 1,
        attackTurnPlayerId: 2,
        events: [],
        updateCount: 1,
        updatedAt: staleTimestamp,
      },
    });
  }

  rooms.publishUserCounts(now);

  for (const mode of ['training', 'private', 'duel']) {
    const room = store.get(rooms.path(mode, `stale-${mode}`));
    assert.equal(room.users.length, 1);
    assert.equal(room.userCount, 1);
    assert.equal(room.game.updateCount, 1);
    assert.equal(room.game.players[0].isBot, undefined);
  }
  assert.equal(store.get('status/user_count').training, 0);
  assert.equal(store.get('status/user_count').private, 0);
  assert.equal(store.get('status/user_count').duel, 0);
});

test('advancing an accountless bot never assigns a temporary user identity', () => {
  const store = new Store();
  const rooms = new RoomService(store, { random: new Random(1) });
  const path = rooms.path('training', 'accountless');
  store.set(path, {
    users: [],
    game: {
      players: [
        {
          id: 1,
          name: 'Bot',
          isBot: true,
          confusionCount: 1,
          hp: 40,
          mp: 10,
          cp: 20,
          items: [{ id: 1, modelId: 3 }],
        },
        { id: 2, userId: 'owner', name: 'Owner', hp: 40, mp: 10, cp: 20, items: [] },
      ],
      gf: 1,
      attackTurnPlayerId: 1,
      events: [],
      updateCount: 1,
    },
  });

  rooms.advanceBotTurns();

  const game = store.get(path).game;
  assert.equal(game.updateCount, 2);
  assert.ok(game.events.some((event) => event.action === 'exchange'));
  assert.equal(Object.hasOwn(game.players[0], 'userId'), false);
});

test('advanceBotTurns isolates room failures and continues advancing subsequent rooms', () => {
  const store = new Store();
  const rooms = new RoomService(store);

  // Room 1: corrupted state that throws on battle access
  const path1 = 'modes/free/rooms/broken-room';
  store.set(path1, {
    owner: 'owner1',
    users: ['owner1'],
    game: {
      players: null,
      gf: 1,
      attackTurnPlayerId: 1,
      events: [],
      updateCount: 1,
    },
  });

  // Room 2: valid room with a bot taking a turn
  const path2 = 'modes/free/rooms/valid-room';
  store.set(path2, {
    owner: 'owner2',
    users: ['owner2'],
    game: {
      players: [
        {
          id: 1,
          name: 'Bot',
          isBot: true,
          confusionCount: 1,
          hp: 40,
          mp: 10,
          cp: 20,
          items: [{ id: 1, modelId: 3 }],
        },
        { id: 2, userId: 'owner2', name: 'Owner', hp: 40, mp: 10, cp: 20, items: [] },
      ],
      gf: 1,
      attackTurnPlayerId: 1,
      events: [],
      updateCount: 1,
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => {
      rooms.advanceBotTurns();
    });
  } finally {
    console.error = originalConsoleError;
  }

  const validGame = store.get(path2).game;
  assert.equal(validGame.updateCount, 2);
});

test('the last departure leaves an empty room, chat, password and metadata', () => {
  for (const lastAction of ['leave-room', 'kick-user']) {
    const store = new Store();
    const rooms = new RoomService(store);
    const payload = createPrivateRoom(rooms);
    const path = rooms.path(payload.mode, payload.roomId);
    rooms.invoke('join-room', 'visitor', {
      ...payload,
      userName: 'Visitor',
    });
    rooms.invoke('post-message', 'owner', { ...payload, text: 'Old chat' });
    store.set(`${path}/messages/team1`, { text: 'Old team chat' });
    store.set(`${path}-other/messages/all`, { text: 'Another room' });
    rooms.invoke('set-tiebreak', 'owner', { ...payload, gf: 50 });
    rooms.invoke('kick-user', 'owner', { ...payload, userId: 'visitor' });
    rooms.invoke(lastAction, 'owner', { ...payload, userId: 'owner' });

    assert.equal(store.get(path).users.length, 0);
    assert.equal(store.get(path).userCount, 0);
    assert.equal(store.get(path).password, 'reusable');
    assert.equal(store.get(`${path}/messages/all`).text, 'Old chat');
    assert.equal(store.get(`${path}/messages/team1`).text, 'Old team chat');
    assert.ok(store.rooms.get(path));
    assert.deepEqual(store.get(`${path}-other/messages/all`), {
      text: 'Another room',
    });
    rooms.publishUserCounts();
    assert.equal(store.get('status/user_count').private, 0);

    const resolution = rooms.invoke('create-room', 'newcomer', {
      mode: 'private',
      userName: 'Newcomer',
      password: 'reusable',
    });
    assert.equal(resolution.roomId, payload.roomId);

    rooms.invoke('join-room', 'newcomer', {
      mode: 'private',
      roomId: resolution.roomId,
      userName: 'Newcomer',
    });
    const newPath = rooms.path(payload.mode, resolution.roomId);
    assert.equal(store.get(newPath).users[0].id, 'newcomer');
    assert.equal(store.rooms.get(newPath).owner, 'newcomer');
    rooms.invoke('set-room-locked', 'newcomer', {
      mode: 'private',
      roomId: resolution.roomId,
      isLocked: true,
    });
    assert.equal(store.get(newPath).isLocked, true);
  }
});

test('the last departure during a match leaves the room and game in place', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  rooms.invoke('join-room', 'visitor', {
    ...payload,
    userName: 'Visitor',
  });
  for (const userId of ['owner', 'visitor']) {
    rooms.invoke('make-entry', userId, { ...payload, team: 0 });
  }
  rooms.invoke('set-tiebreak', 'owner', { ...payload, gf: 50 });
  rooms.invoke('start-game', 'owner', payload);
  assert.ok(store.get(path).game);
  rooms.invoke('leave-room', 'owner', payload);
  assert.equal(store.rooms.get(path).owner, 'visitor');
  assert.equal(
    store
      .get(path)
      .game.players.find((player) => player.userId === 'owner').isBot,
    true,
  );
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').private, 1);

  rooms.invoke('leave-room', 'visitor', payload);
  assert.equal(store.get(path).users.length, 0);
  assert.equal(store.get(path).userCount, 0);
  assert.ok(store.rooms.get(path));
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').private, 0);
  rooms.advanceBotTurns();
  assert.ok(store.get(path));

  const resolution = rooms.invoke('create-room', 'newcomer', {
    mode: 'private',
    userName: 'Newcomer',
    password: 'reusable',
  });
  assert.equal(resolution.roomId, payload.roomId);
});

test('user counts exclude expired training and private rooms', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const privatePayload = createPrivateRoom(rooms);
  const privatePath = rooms.path(privatePayload.mode, privatePayload.roomId);
  rooms.invoke('join-room', 'visitor', {
    ...privatePayload,
    userName: 'Visitor',
  });
  const agedPrivateRoom = structuredClone(store.get(privatePath));
  for (const user of agedPrivateRoom.users) {
    user.updatedAt = new Date(0).toISOString();
  }
  agedPrivateRoom.updatedAt = new Date(0).toISOString();
  store.set(privatePath, agedPrivateRoom);
  const training = rooms.invoke('create-room', 'trainer', {
    mode: 'training',
    userName: 'Trainer',
  });
  const trainingPath = rooms.path('training', training.roomId);
  const trainingRoom = structuredClone(store.get(trainingPath));
  trainingRoom.updatedAt = new Date(0).toISOString();
  store.set(trainingPath, trainingRoom);
  rooms.invoke('create-room', 'dueler', {
    mode: 'duel',
    userName: 'Dueler',
  });

  rooms.publishUserCounts();
  assert.deepEqual(store.get('status/user_count'), {
    training: 0,
    private: 0,
    duel: 1,
  });
});

test('private global counts use room activity and count repeated memberships', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const firstPayload = createPrivateRoom(rooms, 'first-room');
  const secondPayload = createPrivateRoom(rooms, 'second-room');
  const roomPaths = [
    rooms.path(firstPayload.mode, firstPayload.roomId),
    rooms.path(secondPayload.mode, secondPayload.roomId),
  ];
  for (const payload of [firstPayload, secondPayload]) {
    rooms.invoke('join-room', 'visitor', {
      ...payload,
      userName: 'Visitor',
    });
  }

  const now = Date.now();
  for (const roomPath of roomPaths) {
    const room = structuredClone(store.get(roomPath));
    for (const user of room.users) {
      user.updatedAt = new Date(0).toISOString();
    }
    room.updatedAt = new Date(now - PRIVATE_COUNT_ACTIVITY_WINDOW_MS + 1).toISOString();
    store.set(roomPath, room);
  }

  rooms.publishUserCounts(now);
  assert.equal(store.get('status/user_count').private, 4);

  const expiredRoom = structuredClone(store.get(roomPaths[0]));
  expiredRoom.updatedAt = new Date(
    now - PRIVATE_COUNT_ACTIVITY_WINDOW_MS,
  ).toISOString();
  store.set(roomPaths[0], expiredRoom);
  rooms.publishUserCounts(now);
  assert.equal(store.get('status/user_count').private, 2);
});

test('duel global counts expire with room activity and deduplicate active users', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const now = Date.now();
  const activeRoomPath = rooms.path('duel', 'active-duel');
  const recentRoomPath = rooms.path('duel', 'recent-duel');
  store.set(activeRoomPath, {
    users: [
      { id: 'first-player', name: 'First' },
      { id: 'shared-player', name: 'Shared' },
    ],
    updatedAt: new Date(now - DUEL_COUNT_ACTIVITY_WINDOW_MS + 1).toISOString(),
  });
  store.set(recentRoomPath, {
    users: [
      { id: 'shared-player', name: 'Shared' },
      { id: 'second-player', name: 'Second' },
    ],
    updatedAt: new Date(now).toISOString(),
  });

  rooms.publishUserCounts(now);
  assert.equal(store.get('status/user_count').duel, 3);

  const expiredRoom = structuredClone(store.get(activeRoomPath));
  expiredRoom.updatedAt = new Date(
    now - DUEL_COUNT_ACTIVITY_WINDOW_MS,
  ).toISOString();
  store.set(activeRoomPath, expiredRoom);
  rooms.publishUserCounts(now);
  assert.equal(store.get('status/user_count').duel, 2);
});

test('training global counts expire with room activity while membership persists', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const { roomId } = rooms.invoke('create-room', 'trainer', {
    mode: 'training',
    userName: 'Trainer',
  });
  const path = rooms.path('training', roomId);
  const roomTimestamp = store.get(path).updatedAt;
  const expiredAt = Date.parse(roomTimestamp) + TRAINING_COUNT_ACTIVITY_WINDOW_MS;

  rooms.publishUserCounts(expiredAt - 1);
  assert.equal(store.get('status/user_count').training, 1);

  rooms.publishUserCounts(expiredAt);
  assert.equal(store.get('status/user_count').training, 0);
  assert.equal(store.get(path).userCount, 1);
  assert.equal(store.get(path).users.length, 1);
  assert.equal(store.get(path).updatedAt, roomTimestamp, 'count maintenance does not renew activity');

  rooms.invoke('start-game', 'trainer', { mode: 'training', roomId, playerCount: 2 });
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').training, 1);
  assert.equal(store.get(path).game.players.length, 2, 'the bot does not add a counted human');
});

test('starting an existing training game preserves its document and expired activity', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const { roomId } = rooms.invoke('create-room', 'trainer', {
    mode: 'training',
    userName: 'Trainer',
  });
  const payload = { mode: 'training', roomId, playerCount: 2 };
  const path = rooms.path('training', roomId);
  rooms.invoke('start-game', 'trainer', payload);
  const room = store.get(path);
  room.updatedAt = new Date(0).toISOString();
  store.set(path, room);
  let updates = 0;
  store.on(path, () => {
    updates++;
  });

  assert.equal(rooms.invoke('start-game', 'trainer', payload), null);
  assert.deepEqual(store.get(path), room);
  assert.equal(updates, 0);
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').training, 0);
});

test('recent training rooms count separately when they belong to the same account', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const roomPaths = [];
  for (let roomIndex = 0; roomIndex < 3; roomIndex++) {
    const { roomId } = rooms.invoke('create-room', 'trainer', {
      mode: 'training',
      userName: 'Trainer',
    });
    roomPaths.push(rooms.path('training', roomId));
  }
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').training, 3);

  const expiredRoom = store.get(roomPaths[0]);
  expiredRoom.updatedAt = new Date(0).toISOString();
  store.set(roomPaths[0], expiredRoom);
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').training, 2);
  assert.equal(store.get(roomPaths[0]).userCount, 1);
});

test('user count refresh runs on the minute interval', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const startedAt = rooms.lastUserCountPublishAt;
  createPrivateRoom(rooms);
  assert.deepEqual(store.get('status/user_count'), {
    training: 0,
    private: 0,
    duel: 0,
  });

  assert.equal(
    rooms.refreshUserCounts(
      startedAt + USER_COUNT_REFRESH_INTERVAL_MS - 1,
    ),
    false,
  );
  assert.equal(store.get('status/user_count').private, 0);
  assert.equal(
    rooms.refreshUserCounts(startedAt + USER_COUNT_REFRESH_INTERVAL_MS),
    true,
  );
  assert.equal(store.get('status/user_count').private, 1);
});

test('membership activity timestamps are recorded only for private rooms', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const privatePayload = createPrivateRoom(rooms);
  const privatePath = rooms.path(privatePayload.mode, privatePayload.roomId);
  assert.ok(store.get(privatePath).users[0].updatedAt);
  rooms.invoke('join-room', 'visitor', {
    ...privatePayload,
    userName: 'Visitor',
  });
  assert.ok(store.get(privatePath).users[1].updatedAt);

  const training = rooms.invoke('create-room', 'trainer', {
    mode: 'training',
    userName: 'Trainer',
  });
  const trainingPath = rooms.path('training', training.roomId);
  assert.equal(store.get(trainingPath).users[0].updatedAt, undefined);
  rooms.invoke('start-game', 'trainer', {
    mode: 'training',
    roomId: training.roomId,
    playerCount: 2,
    gf: null,
  });
  assert.equal(store.get(trainingPath).users[0].updatedAt, undefined);

  const duelA = rooms.invoke('create-room', 'duel-a', {
    mode: 'duel',
    userName: 'Duel A',
  });
  const duelB = rooms.invoke('create-room', 'duel-b', {
    mode: 'duel',
    userName: 'Duel B',
  });
  assert.equal(duelB.roomId, duelA.roomId);
  const duelRoom = store.get(rooms.path('duel', duelA.roomId));
  assert.ok(duelRoom.game);
  assert.equal(
    duelRoom.users.every((user) => user.updatedAt === undefined),
    true,
  );
});

test('private entry and keep-alive actions refresh only the acting member', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  rooms.invoke('join-room', 'visitor', {
    ...payload,
    userName: 'Visitor',
  });
  const stale = new Date(0).toISOString();
  const ageMembers = () => {
    const room = structuredClone(store.get(path));
    for (const user of room.users) {
      user.updatedAt = stale;
    }
    store.set(path, room);
  };
  const member = (userId) =>
    store.get(path).users.find((user) => user.id === userId);

  ageMembers();
  rooms.invoke('make-entry', 'owner', { ...payload, team: 0 });
  assert.notEqual(member('owner').updatedAt, stale);
  assert.equal(member('visitor').updatedAt, stale);

  const roomActivityAfterEntry = store.get(path).updatedAt;
  rooms.invoke('make-entry', 'owner', { ...payload, team: 1 });
  assert.equal(store.get(path).updatedAt, roomActivityAfterEntry);

  rooms.invoke('post-message', 'owner', {
    ...payload,
    text: 'Chat updates a separate document',
  });
  assert.equal(store.get(path).updatedAt, roomActivityAfterEntry);

  ageMembers();
  rooms.invoke('cancel-entry', 'owner', payload);
  assert.notEqual(member('owner').updatedAt, stale);
  assert.equal(member('visitor').updatedAt, stale);

  ageMembers();
  const roomActivityBeforeKeepAlive = store.get(path).updatedAt;
  rooms.invoke('keep-alive', 'owner', payload);
  assert.notEqual(member('owner').updatedAt, stale);
  assert.equal(member('visitor').updatedAt, stale);
  assert.equal(store.get(path).updatedAt, roomActivityBeforeKeepAlive);

  ageMembers();
  const roomBeforeTiebreak = structuredClone(store.get(path));
  roomBeforeTiebreak.updatedAt = stale;
  store.set(path, roomBeforeTiebreak);
  rooms.invoke('set-tiebreak', 'owner', { ...payload, gf: 50 });
  assert.notEqual(store.get(path).updatedAt, stale);

  const roomBeforeLock = structuredClone(store.get(path));
  roomBeforeLock.updatedAt = stale;
  store.set(path, roomBeforeLock);
  rooms.invoke('set-room-locked', 'owner', {
    ...payload,
    isLocked: true,
  });
  assert.notEqual(store.get(path).updatedAt, stale);
  const roomActivityAfterLock = store.get(path).updatedAt;
  rooms.invoke('set-room-locked', 'owner', {
    ...payload,
    isLocked: true,
  });
  assert.equal(store.get(path).updatedAt, roomActivityAfterLock);
  rooms.invoke('post-message', 'owner', {
    ...payload,
    text: 'No activity update',
  });
  assert.equal(store.get(path).updatedAt, roomActivityAfterLock);
  assert.equal(member('owner').updatedAt, stale);
  assert.equal(member('visitor').updatedAt, stale);
});

test('private command submissions refresh the acting member timestamp', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  rooms.invoke('join-room', 'visitor', {
    ...payload,
    userName: 'Visitor',
  });
  const stale = new Date(0).toISOString();
  const fixture = {
    players: [
      {
        id: 1,
        userId: 'owner',
        name: 'Owner',
        hp: 40,
        mp: 10,
        cp: 20,
        items: [{ id: 1, modelId: 6 }],
      },
      {
        id: 2,
        userId: 'visitor',
        name: 'Visitor',
        hp: 40,
        mp: 10,
        cp: 20,
        items: [{ id: 1, modelId: 113 }],
      },
    ],
    gf: 1,
    attackTurnPlayerId: 1,
    events: [],
    updateCount: 1,
  };
  const privateRoom = structuredClone(store.get(path));
  privateRoom.game = fixture;
  for (const user of privateRoom.users) {
    user.updatedAt = stale;
  }
  store.set(path, privateRoom);

  rooms.invoke('submit-command', 'owner', {
    ...payload,
    command: { itemIds: [1], targetPlayerId: 2 },
  });
  const privateMembers = store.get(path).users;
  assert.notEqual(
    privateMembers.find((user) => user.id === 'owner').updatedAt,
    stale,
  );
  assert.equal(
    privateMembers.find((user) => user.id === 'visitor').updatedAt,
    stale,
  );

  const training = rooms.invoke('create-room', 'trainer', {
    mode: 'training',
    userName: 'Trainer',
  });
  const trainingPath = rooms.path('training', training.roomId);
  const trainingRoom = structuredClone(store.get(trainingPath));
  trainingRoom.game = {
    ...structuredClone(fixture),
    players: [
      {
        ...structuredClone(fixture.players[0]),
        userId: 'trainer',
        name: 'Trainer',
      },
      {
        ...structuredClone(fixture.players[1]),
        userId: 'bot',
        name: 'Bot',
        isBot: true,
      },
    ],
  };
  trainingRoom.updatedAt = new Date(0).toISOString();
  store.set(trainingPath, trainingRoom);
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').training, 0);
  expectHttpError(() => rooms.invoke('submit-command', 'trainer', {
    mode: 'training',
    roomId: training.roomId,
    command: { itemIds: [999], targetPlayerId: 2 },
  }), 400);
  assert.equal(store.get(trainingPath).updatedAt, trainingRoom.updatedAt);
  rooms.invoke('submit-command', 'trainer', {
    mode: 'training',
    roomId: training.roomId,
    command: { itemIds: [1], targetPlayerId: 2 },
  });
  assert.equal(store.get(trainingPath).users[0].updatedAt, undefined);
  rooms.publishUserCounts();
  assert.equal(store.get('status/user_count').training, 1);
});
test('startup retains persisted empty rooms and refreshes the counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'godfield-room-cleanup-'));
  try {
    const file = join(directory, 'state.json');
    const store = new Store(file);
    for (const mode of ['training', 'private', 'duel']) {
      const path = `modes/${mode}/rooms/empty`;
      store.set(path, {
        users: [],
        userCount: 3,
        isLocked: true,
        entries: [{ userId: 'lost', team: 1 }],
        tiebreakGF: 50,
        password: 'kept',
      });
      store.set(`${path}/messages/all`, { text: 'Stale chat' });
      store.rooms.set(path, {
        owner: 'lost',
        banned: ['kicked'],
      });
    }
    store.set('modes/private/rooms/active', {
      users: [{
        id: 'present',
        name: 'Present',
        updatedAt: new Date().toISOString(),
      }],
      updatedAt: new Date().toISOString(),
    });
    store.rooms.set('modes/private/rooms/active', {
      owner: 'present',
      banned: [],
    });
    store.save();

    new RoomService(new Store(file));
    const restored = new Store(file);
    for (const mode of ['training', 'private', 'duel']) {
      const path = `modes/${mode}/rooms/empty`;
      assert.ok(restored.get(path));
      assert.deepEqual(restored.get(`${path}/messages/all`), {
        text: 'Stale chat',
      });
      assert.ok(restored.rooms.get(path));
    }
    assert.ok(restored.get('modes/private/rooms/active'));
    assert.equal([...restored.roomDocuments()].length, 4);
    assert.deepEqual(restored.get('status/user_count'), {
      training: 0,
      private: 1,
      duel: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('leave-room succeeds without changing the room for callers who are not members', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  rooms.invoke('join-room', 'visitor', {
    ...payload,
    userName: 'Visitor',
  });

  const occupiedRoom = structuredClone(store.get(path));
  const occupiedMetadata = structuredClone(store.rooms.get(path));
  assert.equal(rooms.invoke('leave-room', 'stranger', payload), null);
  assert.deepEqual(store.get(path), occupiedRoom);
  assert.deepEqual(store.rooms.get(path), occupiedMetadata);

  rooms.invoke('leave-room', 'owner', payload);
  rooms.invoke('leave-room', 'visitor', payload);
  assert.equal(store.get(path).users.length, 0);
  assert.ok(store.rooms.get(path));
  assert.equal(rooms.invoke('leave-room', 'stranger', payload), null);
  assert.equal(store.get(path).users.length, 0);
});

test('a kick ban survives after the room empties', () => {
  const store = new Store();
  const rooms = new RoomService(store);
  const payload = createPrivateRoom(rooms);
  const path = rooms.path(payload.mode, payload.roomId);
  rooms.invoke('join-room', 'member', {
    ...payload,
    userName: 'Member',
  });
  rooms.invoke('join-room', 'banned', {
    ...payload,
    userName: 'Banned',
  });
  rooms.invoke('kick-user', 'owner', { ...payload, userId: 'banned' });
  expectHttpError(
    () =>
      rooms.invoke('join-room', 'banned', {
        ...payload,
        userName: 'Banned',
      }),
    403,
  );

  rooms.invoke('leave-room', 'owner', payload);
  expectHttpError(
    () =>
      rooms.invoke('join-room', 'banned', {
        ...payload,
        userName: 'Banned',
      }),
    403,
  );
  rooms.invoke('leave-room', 'member', payload);
  assert.equal(store.get(path).users.length, 0);
  assert.ok(store.rooms.get(path));
  expectHttpError(
    () =>
      rooms.invoke('join-room', 'banned', {
        ...payload,
        userName: 'Banned',
      }),
    403,
  );

  const replacement = rooms.invoke('create-room', 'banned', {
    mode: 'private',
    userName: 'Banned',
    password: 'reusable',
  });
  assert.equal(replacement.roomId, payload.roomId);
  expectHttpError(
    () =>
      rooms.invoke('join-room', 'banned', {
        mode: 'private',
        roomId: replacement.roomId,
        userName: 'Banned',
      }),
    403,
  );
});

test('leaving an active game immediately delegates expected turn to bot play', () => {
  const store = new Store();
  const rooms = new RoomService(store, {
    random: new Random(1),
  });
  const roomPayload = createPrivateRoom(rooms, 'privateMatch');
  rooms.invoke('join-room', 'secondUser', {
    ...roomPayload,
    userName: 'SecondUser',
  });
  rooms.invoke('make-entry', 'owner', {
    ...roomPayload,
    team: 0,
  });
  rooms.invoke('make-entry', 'secondUser', {
    ...roomPayload,
    team: 0,
  });
  rooms.invoke('start-game', 'owner', roomPayload);

  const roomPath = rooms.path('private', roomPayload.roomId);
  const initialRoom = store.get(roomPath);
  const initialUpdateCount = initialRoom.game.updateCount;
  const activeUserId = initialRoom.game.attackTurnPlayerId === 1 ? 'owner' : 'secondUser';

  // Active player leaves during their turn
  rooms.invoke('leave-room', activeUserId, roomPayload);

  const updatedRoom = store.get(roomPath);
  assert.ok(
    updatedRoom.game.updateCount > initialUpdateCount,
    'leaving during an active turn immediately steps the bot',
  );
  assert.equal(
    updatedRoom.game.players.find((player) => player.userId === activeUserId)
      .isBot,
    true,
    'the departing active seat is delegated to bot play',
  );
});

test('the last active player leaving does not step bots into an empty room', () => {
  const store = new Store();
  const rooms = new RoomService(store, {
    random: new Random(1),
  });
  const roomPayload = createPrivateRoom(rooms, 'emptyDeparture');
  rooms.invoke('join-room', 'secondUser', {
    ...roomPayload,
    userName: 'SecondUser',
  });
  rooms.invoke('make-entry', 'owner', {
    ...roomPayload,
    team: 0,
  });
  rooms.invoke('make-entry', 'secondUser', {
    ...roomPayload,
    team: 0,
  });
  rooms.invoke('start-game', 'owner', roomPayload);

  const roomPath = rooms.path('private', roomPayload.roomId);
  const roomAfterStart = store.get(roomPath);
  const activeUserId = roomAfterStart.game.attackTurnPlayerId === 1 ? 'owner' : 'secondUser';
  const inactiveUserId = activeUserId === 'owner' ? 'secondUser' : 'owner';

  // First inactive player leaves (1 player remains)
  rooms.invoke('leave-room', inactiveUserId, roomPayload);
  const roomWithOneUser = store.get(roomPath);
  const updateCountBeforeLastLeave = roomWithOneUser.game.updateCount;

  // Active player (now the last remaining user) leaves during their turn
  rooms.invoke('leave-room', activeUserId, roomPayload);

  const emptyRoom = store.get(roomPath);
  assert.equal(emptyRoom.users.length, 0);
  assert.equal(
    emptyRoom.game.updateCount,
    updateCountBeforeLastLeave,
    'leaving an empty room preserves game state without stepping bots',
  );
  assert.equal(
    emptyRoom.game.players.find((player) => player.userId === activeUserId).isBot,
    true,
    'the departing player is still delegated to bot play',
  );
});

