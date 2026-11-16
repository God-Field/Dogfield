import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Attack, Command, Player } from '../types.ts';
import type { Battle } from './battle.ts';
import { engine } from '../engine.ts';
import { requireValue } from '../errors.ts';

interface DefendedAttack {
  attack: Attack;
  attacker: Player;
  defender: Player;
  itemDefinitions: readonly ItemDefinition[];
  attackElement: ReturnType<typeof engine.getAttackElement>;
  damage: number;
  remainingDamage: number;
}

export function resolveDefenseCommand(
  battle: Battle,
  defender: Player,
  command: Command,
  announce = true,
): void {
  const attack = battle.currentAttack;
  const attacker = battle.requirePlayer(attack.playerId);
  const itemDefinitions = battle.attackDefinitions(attack);
  const initialDefinition = itemDefinitions[0];
  const {
    slots: selectedSlots,
    definitions: defenseDefinitions,
    mpCost: magicPointCost,
  } = battle.selectCommandItems(defender, command, true);
  if (announce) {
    battle.emit(
      'useDefenseItems',
      selectedSlots.length
        ? {
            items: selectedSlots,
          }
        : {},
    );
  }
  battle.applyStatChange(defender, 'mp', -magicPointCost);
  battle.takeSlots(defender, selectedSlots);
  const elementFilterDefinitions = defenseDefinitions.filter(
    (itemDefinition) => itemDefinition.ability === 'filterAtkElement',
  );
  // A Rainbow Curtain filters this defense. If this same attack continues
  // after a reflect or bounce, the filter stays on its wire item list. AOE
  // siblings are separate attack objects and never inherit it.
  const finalAttackDefinitions = [
    ...itemDefinitions,
    ...elementFilterDefinitions,
  ];
  const attackElement = engine.getAttackElement(finalAttackDefinitions);
  const attackCategory = initialDefinition.ability === 'categoryWeapons'
    ? engine.CategoryWeapons
    : initialDefinition.category;
  const response = engine.findDefenseResponse(
    defenseDefinitions,
    attackCategory,
    attackElement,
  );
  if (response) {
    resolveDefenseResponse(
      battle,
      defender,
      attack,
      response,
      elementFilterDefinitions,
    );
    return;
  }
  if (initialDefinition.ability === 'buy') {
    requireValue(selectedSlots.length === 0);
    battle.offerPurchase(attacker, defender);
    if (battle.attack?.guardian && battle.attack.buyingItemModelId) {
      battle.confirmPurchase(attacker, { bought: true });
    }
    return;
  }
  if (initialDefinition.ability === 'sell') {
    const turnProgress = battle.game.serverTurn;
    const restoredItemId = attack.reversed
      ? turnProgress?.sellingItemId
      : undefined;
    battle.resolveSale(
      attacker,
      defender,
      itemDefinitions[1],
      restoredItemId,
    );
    if (turnProgress) {
      delete turnProgress.sellingItemId;
    }
    battle.completeAttack();
    return;
  }
  const defense = defenseDefinitions.reduce(
    (totalDefense, itemDefinition) => totalDefense + itemDefinition.defense,
    0,
  );
  const damage = engine.calculateAttackDamage(
    itemDefinitions,
    attack.atk ?? 0,
  );
  const remainingDamage = Math.max(0, damage - defense);
  resolveDefendedAttack(battle, {
    attack,
    attacker,
    defender,
    itemDefinitions,
    attackElement,
    damage,
    remainingDamage,
  });
  resolveDefenseItemEffects(
    battle,
    defender,
    attacker,
    defenseDefinitions,
    remainingDamage,
  );
  battle.completeAttack();
}

function resolveDefenseResponse(
  battle: Battle,
  defender: Player,
  attack: Attack,
  response: string,
  elementFilters: readonly ItemDefinition[],
): void {
  if (response === 'block') {
    battle.emit('block');
    battle.completeAttack();
    return;
  }
  for (const itemDefinition of elementFilters) {
    attack.itemModelIds.push(itemDefinition.id);
  }
  if (response === 'reflect') {
    battle.emit('reflect');
    [attack.playerId, attack.targetPlayerId] = [
      attack.targetPlayerId!,
      attack.playerId,
    ];
    attack.reversed = !attack.reversed;
    delete attack.guardian;
    if (battle.requirePlayer(attack.targetPlayerId).dead) {
      battle.resolveDefenseCommand(
        battle.requirePlayer(attack.targetPlayerId),
        {},
        false,
      );
    }
    return;
  }
  const target = battle.random.pick('bounceTarget', battle.alive);
  battle.emit('bounce', {
    playerId: target.id,
  });
  attack.playerId = defender.id;
  attack.targetPlayerId = target.id;
  attack.reversed = !attack.reversed;
  delete attack.guardian;
  if (target.id === defender.id) {
    // A self-bounce lands on the defender who bounced it. Resolve the
    // attack immediately; there is no second defense opportunity.
    battle.resolveDefenseCommand(target, {}, false);
  }
}

function resolveDefendedAttack(battle: Battle, incoming: DefendedAttack): void {
  const {
    attack,
    attacker,
    defender,
    itemDefinitions,
    attackElement,
    damage,
    remainingDamage,
  } = incoming;
  const initialDefinition = itemDefinitions[0];
  const dealsDamage = damage > 0
    || initialDefinition.category === engine.CategoryWeapons;
  if (!dealsDamage) {
    battle.applyItemEffect(attacker, defender, initialDefinition, attack);
    return;
  }
  if (remainingDamage === 0) {
    battle.emit('safe');
    return;
  }
  const isDarknessAttack =
    attackElement === engine.ItemElementDarkness;
  battle.applyDamage(defender, remainingDamage, false, isDarknessAttack);
  if (defender.hp > 0 && isDarknessAttack) {
    battle.emit('dealDarkDamage', {
      damage: defender.hp,
    });
    defender.hp = 0;
  }
  if (isDarknessAttack) {
    battle.checkGuardianLeave(defender);
  }
  if (initialDefinition.ability === 'dealSameDamage') {
    battle.applyDamage(attacker, remainingDamage, true);
  }
  if (initialDefinition.ability === 'absorbHP') {
    battle.applyStatBoost(attacker, 'hp', remainingDamage, true);
  }
  for (const itemDefinition of itemDefinitions) {
    if (itemDefinition.ability === 'addCurseOnDamage') {
      battle.addCurse(defender, itemDefinition.curse?.key);
    }
  }
}

function resolveDefenseItemEffects(
  battle: Battle,
  defender: Player,
  attacker: Player,
  defenseDefinitions: readonly ItemDefinition[],
  sufferedDamage: number,
): void {
  for (let index = 0; index < defenseDefinitions.length; index++) {
    const itemDefinition = defenseDefinitions[index];
    if (
      itemDefinition.ability === 'selfCurse' ||
      itemDefinition.ability === 'selfCurseAndRedraw'
    ) {
      battle.emit('selfCurse', {
        index,
      });
      battle.applySelfCurse(defender, itemDefinition.curse?.key);
      if (itemDefinition.ability === 'selfCurseAndRedraw') {
        battle.resolveRedraw(defender);
      }
    }
    if (
      itemDefinition.ability.startsWith('counter') &&
      sufferedDamage > 0
    ) {
      battle.resolveCounterAttack(
        defender,
        attacker,
        itemDefinition,
        index,
        sufferedDamage,
      );
    }
  }
}
