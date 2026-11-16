import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {MODEL_IDS} from '../tools/live-games/policy.mjs';

const localeDirectory = 'public/i18n';
const localeFiles = fs.readdirSync(localeDirectory).filter(file => file.endsWith('.json'));
const englishData = JSON.parse(fs.readFileSync(path.join(localeDirectory, 'en.json'), 'utf8'));
const englishTextKeys = Object.keys(englishData.texts.abilities).sort();

test('all locale ability keys match English', () => {
  for (const localeFile of localeFiles) {
    const localeData = JSON.parse(fs.readFileSync(path.join(localeDirectory, localeFile), 'utf8'));
    const abilityKeys = Object.keys(localeData.texts.abilities).sort();

    assert.deepEqual(abilityKeys, englishTextKeys, `${localeFile} ability keys differ from English`);
  }
});

test('locale item catalogs match English except for translated names', () => {
  for (const localeFile of localeFiles) {
    const localeData = JSON.parse(fs.readFileSync(path.join(localeDirectory, localeFile), 'utf8'));

    assert.equal(localeData.items.length, englishData.items.length, `${localeFile} item count differs from English`);
    for (let itemIndex = 0; itemIndex < englishData.items.length; itemIndex += 1) {
      const englishItem = {...englishData.items[itemIndex]};
      const localizedItem = {...localeData.items[itemIndex]};
      delete englishItem.name;
      delete localizedItem.name;

      assert.deepEqual(localizedItem, englishItem, `${localeFile} item ${itemIndex} metadata differs from English`);
    }
  }
});

test('live policy model IDs point to their documented English catalog items', () => {
  const expectedImageNames = {
    dangerousPestle: 'dangerous-pestle',
    rainbowCurtain: 'rainbow-curtain',
    guardianPot: 'guardian-pot',
    nocturnalBroom: 'nocturnal-broom',
    goddessSoap: 'goddess-s-soap',
    stringOfFate: 'string-of-fate',
    dangerousMortar: 'dangerous-mortar',
    release: 'release',
  };

  for (const [modelName, modelId] of Object.entries(MODEL_IDS)) {
    assert.equal(englishData.items[modelId - 1].imageName, expectedImageNames[modelName], `${modelName} model ID changed`);
  }
});
