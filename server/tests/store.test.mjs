import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.ts';

const roomPath = 'modes/private/rooms/scheduler';

function createRoom() {
  return {
    users: [{ id: 'owner', name: 'Owner' }],
    game: {
      players: [],
      gf: 1,
      attackTurnPlayerId: 1,
      events: [],
      updateCount: 0,
      serverTurn: {
        diseaseDone: true,
        guardians: [2],
        dyingAttacks: [{ playerId: 3, itemId: 1, modelId: 10 }],
      },
    },
  };
}

test('store writes, reads, subscriptions, and enumeration do not share mutable documents', () => {
  const store = new Store();
  const suppliedRoom = createRoom();
  const expectedRoom = structuredClone(suppliedRoom);
  store.on(roomPath, (publishedRoom) => {
    publishedRoom.users[0].name = 'Changed by subscriber';
  });
  store.set(roomPath, suppliedRoom);

  assert.deepEqual(suppliedRoom, expectedRoom, 'publishing does not strip the caller\'s private state');
  assert.equal(store.get(roomPath).users[0].name, 'Owner');
  suppliedRoom.users[0].name = 'Changed by caller';
  const readSnapshot = store.get(roomPath);
  readSnapshot.users[0].name = 'Changed through read';
  const [, enumeratedRoom] = [...store.roomDocuments()][0];
  enumeratedRoom.users[0].name = 'Changed through enumeration';
  assert.equal(store.get(roomPath).users[0].name, 'Owner');

  const privateSnapshot = store.getGameState(roomPath);
  privateSnapshot.guardians.push(4);
  assert.deepEqual(store.getGameState(roomPath).guardians, [2]);

  store.set('records/owner', { rating: 16 });
  const [, enumeratedRecord] = [...store.recordDocuments()][0];
  enumeratedRecord.rating = 999;
  assert.equal(store.get('records/owner').rating, 16);
});

test('room updates restore private scheduler state without sharing stored objects', () => {
  const store = new Store();
  const publishedRooms = [];
  store.on(roomPath, (room) => publishedRooms.push(structuredClone(room)));
  store.set(roomPath, createRoom());

  const snapshot = store.getRoomForUpdate(roomPath);
  assert.equal(snapshot.game.serverTurn.diseaseDone, true);
  assert.deepEqual(snapshot.game.serverTurn.guardians, [2]);
  snapshot.users[0].name = 'Changed';
  snapshot.game.serverTurn.guardians.push(4);
  snapshot.game.serverTurn.dyingAttacks[0].playerId = 5;

  assert.equal(store.get(roomPath).users[0].name, 'Owner');
  assert.equal(store.get(roomPath).game.serverTurn, undefined);
  assert.equal(publishedRooms[0].game.serverTurn, undefined);
  const independentSnapshot = store.getRoomForUpdate(roomPath);
  assert.deepEqual(independentSnapshot.game.serverTurn.guardians, [2]);
  assert.equal(independentSnapshot.game.serverTurn.dyingAttacks[0].playerId, 3);
  assert.equal(store.getRoomForUpdate('modes/private/rooms/missing'), null);
});

test('private scheduler state survives restart and is cleared when the game resets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dogfield-store-'));
  try {
    const file = join(directory, 'state.json');
    const store = new Store(file);
    const originalRoom = createRoom();
    const expectedScheduler = structuredClone(originalRoom.game.serverTurn);
    store.set(roomPath, originalRoom);
    store.save();

    const restoredStore = new Store(file);
    const restoredRoom = restoredStore.getRoomForUpdate(roomPath);
    assert.deepEqual(restoredRoom.game.serverTurn, expectedScheduler);
    assert.equal(restoredStore.get(roomPath).game.serverTurn, undefined);

    delete restoredRoom.game;
    restoredStore.set(roomPath, restoredRoom);
    restoredStore.save();
    const resetStore = new Store(file);
    assert.equal(resetStore.getGameState(roomPath), undefined);
    assert.equal(resetStore.getRoomForUpdate(roomPath).game, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
