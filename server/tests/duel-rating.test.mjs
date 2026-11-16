import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store.ts';
import {
  DUEL_RATING_DIFFERENCE_LIMIT,
  applyDuelRatingGains,
} from '../rooms/duel.ts';
import { RoomService } from '../rooms/service.ts';
import { Random } from '../random.ts';

const createDuelGame = ({
  winnerRating,
  loserRating,
  winnerIsBot = false,
  loserIsBot = false,
}) => ({
  players: [
    {
      id: 1,
      userId: 'winner',
      name: 'Winner',
      rating: winnerRating,
      dead: false,
      isBot: winnerIsBot,
    },
    {
      id: 2,
      userId: 'loser',
      name: 'Loser',
      rating: loserRating,
      dead: true,
      isBot: loserIsBot,
    },
  ],
});

const recordDuel = (game, records = {}) => {
  const store = new Store();
  for (const [userId, rating] of Object.entries(records)) {
    store.set(`records/${userId}`, { rating, gameCount: 1 });
  }
  const roomService = new RoomService(store, {
    random: new Random(1),
  });
  roomService.recordDuel(game);
  return roomService;
};

const observedRatingRows = [
  { winnerRating: -173, loserRating: 0, winnerGain: 18 },
  { winnerRating: -160, loserRating: -18, winnerGain: 18 },
  { winnerRating: -125, loserRating: 0, winnerGain: 17 },
  { winnerRating: -115, loserRating: 0, winnerGain: 17 },
  { winnerRating: -148, loserRating: -34, winnerGain: 17 },
  { winnerRating: -155, loserRating: -46, winnerGain: 17 },
  { winnerRating: -99, loserRating: 0, winnerGain: 17 },
  { winnerRating: -104, loserRating: -17, winnerGain: 17 },
  { winnerRating: 0, loserRating: 78, winnerGain: 17 },
  { winnerRating: -75, loserRating: 0, winnerGain: 17 },
  { winnerRating: -16, loserRating: 58, winnerGain: 17 },
  { winnerRating: -57, loserRating: 0, winnerGain: 17 },
  { winnerRating: -27, loserRating: 17, winnerGain: 17 },
  { winnerRating: -53, loserRating: -14, winnerGain: 16 },
  { winnerRating: -38, loserRating: 0, winnerGain: 16 },
  { winnerRating: -64, loserRating: -31, winnerGain: 16 },
  { winnerRating: -5, loserRating: 16, winnerGain: 16 },
  { winnerRating: -33, loserRating: -15, winnerGain: 16 },
  { winnerRating: -32, loserRating: -29, winnerGain: 16 },
  { winnerRating: 0, loserRating: 0, winnerGain: 16 },
  { winnerRating: 18, loserRating: 0, winnerGain: 16 },
  { winnerRating: 27, loserRating: 0, winnerGain: 16 },
  { winnerRating: 19, loserRating: -16, winnerGain: 16 },
  { winnerRating: 22, loserRating: -17, winnerGain: 16 },
  { winnerRating: 5, loserRating: -48, winnerGain: 15 },
  { winnerRating: 21, loserRating: -33, winnerGain: 15 },
  { winnerRating: 40, loserRating: -14, winnerGain: 15 },
  { winnerRating: 62, loserRating: 0, winnerGain: 15 },
  { winnerRating: 62, loserRating: -14, winnerGain: 15 },
  { winnerRating: 98, loserRating: 0, winnerGain: 15 },
  { winnerRating: 123, loserRating: 0, winnerGain: 15 },
  { winnerRating: 98, loserRating: -29, winnerGain: 15 },
  { winnerRating: 141, loserRating: 0, winnerGain: 14 },
  { winnerRating: 144, loserRating: 1, winnerGain: 14 },
  { winnerRating: 144, loserRating: 0, winnerGain: 14 },
  { winnerRating: 121, loserRating: -29, winnerGain: 14 },
  { winnerRating: 132, loserRating: -32, winnerGain: 14 },
  { winnerRating: 151, loserRating: -15, winnerGain: 14 },
  { winnerRating: 167, loserRating: 0, winnerGain: 14 },
  { winnerRating: 168, loserRating: -14, winnerGain: 14 },
  { winnerRating: 187, loserRating: 0, winnerGain: 14 },
];

test('duel rating reproduces every observed official game', () => {
  for (const row of observedRatingRows) {
    const game = createDuelGame(row);
    recordDuel(game);
    assert.equal(
      game.players[0].ratingGain,
      row.winnerGain,
      `winner ${row.winnerRating} vs loser ${row.loserRating}`,
    );
    assert.equal(
      game.players[1].ratingGain,
      -row.winnerGain,
      `loser ${row.loserRating} vs winner ${row.winnerRating}`,
    );
  }
});

test('duel rating uses the linear formula at every band boundary', () => {
  const boundaryCases = [
    { difference: -200, winnerGain: 14 },
    { difference: -132, winnerGain: 14 },
    { difference: -131, winnerGain: 15 },
    { difference: -44, winnerGain: 15 },
    { difference: -43, winnerGain: 16 },
    { difference: 43, winnerGain: 16 },
    { difference: 44, winnerGain: 17 },
    { difference: 131, winnerGain: 17 },
    { difference: 132, winnerGain: 18 },
    { difference: 200, winnerGain: 18 },
  ];
  for (const boundaryCase of boundaryCases) {
    const game = createDuelGame({
      winnerRating: 0,
      loserRating: boundaryCase.difference,
    });
    applyDuelRatingGains(game);
    assert.equal(
      game.players[0].ratingGain,
      boundaryCase.winnerGain,
      `difference ${boundaryCase.difference}`,
    );
    assert.equal(
      game.players[1].ratingGain,
      -boundaryCase.winnerGain,
      `loser difference ${boundaryCase.difference}`,
    );
  }
});

test('duel rating clamps differences outside the matchmaking band', () => {
  for (const ratingDifference of [-1000, 1000]) {
    const game = createDuelGame({
      winnerRating: 0,
      loserRating: ratingDifference,
    });
    applyDuelRatingGains(game);
    const expectedGain = ratingDifference < 0 ? 14 : 18;
    assert.equal(game.players[0].ratingGain, expectedGain);
    assert.equal(game.players[1].ratingGain, -expectedGain);
  }
});

test('duel matchmaking allows pairs at the band edges', () => {
  for (const [firstRating, secondRating] of [
    [0, DUEL_RATING_DIFFERENCE_LIMIT],
    [-DUEL_RATING_DIFFERENCE_LIMIT, 0],
  ]) {
    const store = new Store();
    store.set('records/first', { rating: firstRating, gameCount: 1 });
    store.set('records/second', { rating: secondRating, gameCount: 1 });
    const roomService = new RoomService(store, {
      random: new Random(1),
    });
    const firstRoom = roomService.invoke('create-room', 'first', {
      mode: 'duel',
      userName: 'First',
    });
    const secondRoom = roomService.invoke('create-room', 'second', {
      mode: 'duel',
      userName: 'Second',
    });
    assert.equal(firstRoom.roomId, secondRoom.roomId);
  }
});

test('duel matchmaking rejects pairs outside the band', () => {
  for (const [firstRating, secondRating] of [
    [0, DUEL_RATING_DIFFERENCE_LIMIT + 1],
    [-(DUEL_RATING_DIFFERENCE_LIMIT + 1), 0],
  ]) {
    const store = new Store();
    store.set('records/first', { rating: firstRating, gameCount: 1 });
    store.set('records/second', { rating: secondRating, gameCount: 1 });
    const roomService = new RoomService(store, {
      random: new Random(1),
    });
    const firstRoom = roomService.invoke('create-room', 'first', {
      mode: 'duel',
      userName: 'First',
    });
    const secondRoom = roomService.invoke('create-room', 'second', {
      mode: 'duel',
      userName: 'Second',
    });
    assert.notEqual(firstRoom.roomId, secondRoom.roomId);
  }
});

test('duel records store the relative rating without the display offset', () => {
  const game = createDuelGame({
    winnerRating: 0,
    loserRating: 78,
  });
  const roomService = recordDuel(game);
  assert.equal(
    roomService.store.get('records/loser').rating,
    -17,
    'a first-game loss stores the relative value, not 1483',
  );
  assert.equal(roomService.store.get('records/winner').rating, 17);
  assert.equal(roomService.store.get('records/loser').gameCount, 1);
});

test('an auto-played winning seat leaves both ratings unchanged', () => {
  const game = createDuelGame({
    winnerRating: -198,
    loserRating: -63,
    winnerIsBot: true,
  });
  const roomService = recordDuel(game, {
    winner: -198,
    loser: -63,
  });
  assert.equal(game.players[0].ratingGain, 0);
  assert.equal(game.players[1].ratingGain, 0);
  assert.equal(roomService.store.get('records/winner').rating, -198);
  assert.equal(roomService.store.get('records/loser').rating, -63);
  assert.equal(
    roomService.store.get('records/loser').gameCount,
    2,
    'the void game is still counted',
  );
});

test('an auto-played losing seat still applies the normal formula', () => {
  const game = createDuelGame({
    winnerRating: 0,
    loserRating: 0,
    loserIsBot: true,
  });
  recordDuel(game);
  assert.equal(game.players[0].ratingGain, 16);
  assert.equal(game.players[1].ratingGain, -16);
});
