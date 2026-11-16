import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SmallStatValue, TrainingStatDisplay} from '../src/ui/stat-widgets.ts';
import {TurnController} from '../src/battle/turn-controller.ts';
import {PlayerStatusPanel} from '../src/battle/player-panels.ts';
import {STARTING_CP, STARTING_HP, STARTING_MP} from '../src/domain/constants.ts';

test('player combat counter updates preserve right-aligned stat values', () => {
  const player = Object.create(PlayerStatusPanel.prototype);
  const labels = ['hpLabel', 'mpLabel', 'cpLabel'];
  for (const property of labels) {
    const element = {style: {textAlign: 'right'}, textContent: ''};
    player[property] = new SmallStatValue(element);
  }

  player.setCombatCounters(STARTING_HP, STARTING_MP, STARTING_CP);
  player.changeMpDisplay(-5);

  assert.deepEqual(labels.map(property => player[property].domElement.textContent), ['40', '5', '20']);
  for (const property of labels) {
    assert.equal(player[property].domElement.style.textAlign, 'right');
  }
});

test('training stat values stay numeric and render after transfers', () => {
  const rendered = {hp: '', mp: '', cp: ''};
  const makeLabel = name => ({
    setText(value) {
      rendered[name] = value;
    },
  });
  const display = Object.create(TrainingStatDisplay.prototype);
  display.hpLabel = makeLabel('hp');
  display.mpLabel = makeLabel('mp');
  display.cpLabel = makeLabel('cp');
  display.hp = STARTING_HP;
  display.mp = STARTING_MP;
  display.cp = STARTING_CP;

  display.adjustHpAndMp(10);
  display.adjustHpAndCp(-5);

  assert.deepEqual({hp: display.hp, mp: display.mp, cp: display.cp}, {hp: 35, mp: 20, cp: 15});
  assert.deepEqual(rendered, {hp: '35', mp: '20', cp: '15'});
});

test('player combat counters drive arithmetic and update their labels', () => {
  const rendered = {hp: '', mp: '', cp: ''};
  const makeLabel = name => ({
    setText(value) {
      rendered[name] = value;
    },
  });
  const player = Object.create(PlayerStatusPanel.prototype);
  player.hpLabel = makeLabel('hp');
  player.mpLabel = makeLabel('mp');
  player.cpLabel = makeLabel('cp');

  player.setCombatCounters(STARTING_HP, STARTING_MP, STARTING_CP);
  player.changeMpDisplay(-5);
  player.changeCpDisplay(7);

  assert.deepEqual({hp: player.hp, mp: player.mp, cp: player.cp}, {hp: 40, mp: 5, cp: 27});
  assert.deepEqual(rendered, {hp: '40', mp: '5', cp: '27'});
});

for (const startingCoins of [[10, 20, 30], [40, 50, 60]]) {
  test(`collect everybody's CP synchronizes counters and later updates (${startingCoins})`, async () => {
    const players = startingCoins.map(coinPoints => {
      const player = Object.create(PlayerStatusPanel.prototype);
      for (const property of ['hpLabel', 'mpLabel', 'cpLabel']) {
        player[property] = new SmallStatValue({style: {}, textContent: ''});
      }
      player.setCombatCounters(40, 30, coinPoints);
      return player;
    });
    const recipient = players[1];
    const controller = Object.create(TurnController.prototype);
    controller.page = {
      playerRoster: {
        getAlivePlayerStats: () => players,
        requirePlayer(playerId) {
          assert.equal(playerId, 2);
          return recipient;
        },
      },
    };

    await controller.handleCollectCPOfEverybody({playerId: 2});

    const expectedTotal = Math.min(99, startingCoins.reduce((total, coins) => total + coins, 0));
    assert.deepEqual(players.map(player => player.cp), [0, expectedTotal, 0]);
    assert.deepEqual(players.map(player => player.cpLabel.getText()), ['0', String(expectedTotal), '0']);

    players[0].changeMpDisplay(-5);
    players[2].changeCpDisplay(7);
    recipient.changeCpDisplay(-10);

    assert.deepEqual(players.map(player => player.cp), [0, expectedTotal - 10, 7]);
    assert.deepEqual(players.map(player => player.cpLabel.getText()), ['0', String(expectedTotal - 10), '7']);
    assert.deepEqual(players.map(player => player.hp), [40, 40, 40]);
  });
}
