import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Player } from '../types.ts';
import type { Battle } from './battle.ts';
import { engine } from '../engine.ts';

// The creator confirmed these uniform catalog draws on Twitter (November 2026).
// Only obtainable cards participate; Discard and Sacrifice are commands, not gifts.
export function getEarthItemPool(battle: Battle): ItemDefinition[] {
  return battle.catalog.filter((definition) => {
    const isEarthCategory = definition.category === engine.CategoryTrade
      || definition.category === engine.CategoryWeapons
      || definition.category === engine.CategoryArmor
      || definition.category === engine.CategorySundries;
    return definition.giftRate > 0 && isEarthCategory;
  });
}

export function getMoonItemPool(battle: Battle): ItemDefinition[] {
  return battle.catalog.filter((definition) => {
    const isExcludedResponse = definition.ability === 'blockWeapon'
      || definition.ability === 'bounceMiracle';
    return definition.category === engine.CategoryMiracles && !isExcludedResponse;
  });
}

export function getEarthDropPool(battle: Battle): ItemDefinition[] {
  return getEarthItemPool(battle).filter(
    (definition) => !definition.isItemTargetingCommand(),
  );
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
    const earthItems = getEarthItemPool(battle);
    const chosenDefinition = battle.pickFromPool('guardianItem', earthItems);
    if (chosenDefinition === null) {
      return null;
    }
    if (!chosenDefinition.isItemTargetingCommand()) {
      const dropDefinition = requireGuardianDefinition(
        battle,
        'Earth Drop guardian card',
        (itemDefinition) =>
          itemDefinition.guardian?.key === 'earth' &&
          itemDefinition.ability === 'addItem',
      );
      return [dropDefinition, chosenDefinition];
    }
    if (chosenDefinition.ability === 'sell') {
      return [
        chosenDefinition,
        battle.random.pick(
          'guardianSaleItem',
          earthItems,
          (itemDefinition) => itemDefinition.giftRate,
        ),
      ];
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
    const chosenDefinition = battle.random.pick('guardianItem', getMoonItemPool(battle));
    const needsFullMoonBlade = chosenDefinition.ability === 'doubleAtk'
      || chosenDefinition.ability === 'attackEveryEnemy';
    return needsFullMoonBlade
      ? [fullMoonBlade, chosenDefinition]
      : [chosenDefinition];
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
