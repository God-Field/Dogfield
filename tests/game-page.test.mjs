import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GamePageController } from '../src/battle/game-page.ts';

test('same-update snapshots refresh player bot decorations', () => {
  const gamePage = Object.create(GamePageController.prototype);
  gamePage.updateCount = 7;
  let updatedPlayers = null;
  gamePage.playerRoster = {
    updatePlayerStats(players) {
      updatedPlayers = players;
    },
  };
  const players = [{id: 1, isBot: true}];

  gamePage.applyUpdate({
    updateCount: 7,
    players,
  });

  assert.equal(updatedPlayers, players);
});
