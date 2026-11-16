import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Player } from '../types.ts';
import type { Battle } from './battle.ts';
import { engine } from '../engine.ts';

// Observed probabilities; see the known approximations in docs/ARCHITECTURE.md.
const EARTH_DROP_PERCENT = 42;
const MOON_FULL_MOON_PERCENT = 8;

export function getEarthDropPool(battle: Battle): ItemDefinition[] {
  return battle.catalog.filter((itemDefinition) => {
    if (itemDefinition.giftRate <= 0) {
      return false;
    }
    if (itemDefinition.category === engine.CategoryArmor) {
      return true;
    }
    return itemDefinition.category === engine.CategorySundries
      && !itemDefinition.isItemTargetingCommand();
  });
}

export function pickEarthDropItem(battle: Battle): ItemDefinition | null {
  return battle.pickFromPool('guardianDropItem', battle.getEarthDropPool());
}

export function selectGuardianAction(
  battle: Battle,
  player: Player,
): ItemDefinition[] | null {
  // en.json renders guardianAttackRate as 100 * rate / 20 percent. Each
  // ordinary guardian's five item rates total 20, so the raw rate is an
  // equivalent weight for its 10-30% action distribution.
  if (player.guardian === 'earth') {
    const dropDefinition = requireGuardianDefinition(
      battle,
      'Earth Drop guardian card',
      (itemDefinition) =>
        itemDefinition.guardian?.key === 'earth' &&
        itemDefinition.ability === 'addItem',
    );
    if (battle.random.chance('guardianSpecial', EARTH_DROP_PERCENT)) {
      const droppedItem = battle.pickEarthDropItem();
      return droppedItem === null
        ? [dropDefinition]
        : [dropDefinition, droppedItem];
    }
    const earthItems = battle.catalog.filter((itemDefinition) => {
      const isEarthCategory =
        itemDefinition.category === engine.CategoryTrade
        || itemDefinition.category === engine.CategoryWeapons
        || itemDefinition.category === engine.CategorySundries;
      return itemDefinition.giftRate > 0 &&
        isEarthCategory &&
        itemDefinition.isItemTargetingCommand();
    });
    if (earthItems.length === 0) {
      return [dropDefinition];
    }
    const chosenDefinition = battle.random.pick(
      'guardianItem',
      earthItems,
      (itemDefinition) => itemDefinition.guardianAttackRate || 1,
    );
    if (chosenDefinition.ability === 'sell') {
      const saleItems = battle.catalog.filter(
        (itemDefinition) =>
          itemDefinition.giftRate > 0
          && (itemDefinition.category === engine.CategoryTrade
            || itemDefinition.category === engine.CategoryWeapons
            || itemDefinition.category === engine.CategoryArmor
            || itemDefinition.category === engine.CategorySundries),
      );
      if (saleItems.length !== 0) {
        return [
          chosenDefinition,
          battle.random.pick(
            'guardianSaleItem',
            saleItems,
            (itemDefinition) => itemDefinition.giftRate,
          ),
        ];
      }
    }
    return [chosenDefinition];
  }
  if (player.guardian === 'moon') {
    const fullMoonBlade = requireGuardianDefinition(
      battle,
      'Full Moon Blade guardian card',
      (itemDefinition) =>
        itemDefinition.guardian?.key === 'moon' &&
        itemDefinition.ability === 'categoryWeapons',
    );
    const plusMiracles = battle.catalog.filter(
      (itemDefinition) =>
        itemDefinition.category === engine.CategoryMiracles
        && (itemDefinition.ability === 'doubleAtk'
          || itemDefinition.ability === 'attackEveryEnemy'),
    );
    if (
      plusMiracles.length !== 0 &&
      battle.random.chance('moonFullMoon', MOON_FULL_MOON_PERCENT)
    ) {
      return [
        fullMoonBlade,
        battle.random.pick('guardianItem', plusMiracles),
      ];
    }
    const moonItems = battle.catalog.filter(
      (itemDefinition) =>
        itemDefinition.category === engine.CategoryMiracles
        && itemDefinition.isItemTargetingCommand(),
    );
    if (moonItems.length === 0) {
      return [fullMoonBlade];
    }
    return [
      battle.random.pick(
        'guardianItem',
        moonItems,
        (itemDefinition) => itemDefinition.guardianAttackRate || 1,
      ),
    ];
  }
  const guardianItems = battle.catalog.filter(
    (itemDefinition) =>
      itemDefinition.category === engine.CategoryGuardians
      && itemDefinition.guardian?.key === player.guardian,
  );
  if (guardianItems.length === 0) {
    return null;
  }
  return [
    battle.random.pick(
      'guardianItem',
      guardianItems,
      (itemDefinition) => itemDefinition.guardianAttackRate || 1,
    ),
  ];
}

function requireGuardianDefinition(
  battle: Battle,
  description: string,
  predicate: (definition: ItemDefinition) => boolean,
): ItemDefinition {
  const definition = battle.catalog.find(predicate);
  if (!definition) {
    throw new Error(`Missing catalog item: ${description}`);
  }
  return definition;
}
