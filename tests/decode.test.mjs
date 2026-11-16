import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyItemOverride,
  decodeItemModel,
  decodeLobbyState,
  decodePlayerStatus,
} from '../src/domain/decode.ts';
import { ItemCatalog } from '../src/domain/item-catalog.ts';

test('legacy isAI decodes as isBot', () => {
  const player = decodePlayerStatus(new Map([
    ['id', 1],
    ['userId', 'legacy-bot'],
    ['name', 'Legacy Bot'],
    ['team', 0],
    ['isAI', true],
    ['hp', 40],
    ['mp', 10],
    ['cp', 20],
    ['confusionCount', 0],
    ['rating', 0],
    ['ratingGain', 0],
  ]));

  assert.equal(player.isBot, true);
});

test('legacy guardianActionRate decodes as guardianAttackRate', () => {
  const catalog = new ItemCatalog();
  decodeItemModel([
    new Map([
      ['name', 'Legacy Guardian'],
      ['imageName', 'legacy-guardian'],
      ['category', 'guardians'],
      ['guardian', 'mars'],
      ['guardianActionRate', 5],
    ]),
  ], catalog);

  assert.equal(catalog.models[0].guardianAttackRate, 5);
});

test('current guardianAttackRate wins over the legacy field', () => {
  const catalog = new ItemCatalog();
  decodeItemModel([
    new Map([
      ['name', 'Current Guardian'],
      ['imageName', 'current-guardian'],
      ['category', 'guardians'],
      ['guardian', 'mars'],
      ['guardianAttackRate', 3],
      ['guardianActionRate', 5],
    ]),
  ], catalog);

  assert.equal(catalog.models[0].guardianAttackRate, 3);
  applyItemOverride(catalog.models[0], new Map([['guardianActionRate', 4]]));
  assert.equal(catalog.models[0].guardianAttackRate, 4);
});

test('legacy teamsShuffled room flag is decoded', () => {
  const room = decodeLobbyState(new Map([['teamsShuffled', true]]));
  assert.equal(room.teamsShuffled, true);
});
