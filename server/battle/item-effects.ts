import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Attack, Player } from '../types.ts';
import type { Battle } from './battle.ts';
import { engine } from '../engine.ts';
import { selectDreamDisguise } from './dream.ts';
import {
  clearItemDisguise,
  getOccupiedItemSlots,
  getSortedOccupiedItemSlots,
  renumberOccupiedItemSlots,
} from './inventory.ts';

const guardianNames = engine.allGuardians.map((value) => value.key);
const TEAR_HEAL_PERCENT = 50;
const BROOM_REMOVAL_COUNT = 3;
const SOAP_REMOVAL_COUNT = 2;

export function applyItemEffect(
  battle: Battle,
  attacker: Player,
  target: Player,
  definition: ItemDefinition,
  attack: Partial<Attack> = {},
): boolean | void {
  const amount = definition.abilityValue;
  switch (definition.ability) {
    case 'exchange': {
      const totalStats = target.hp + target.mp + target.cp;
      const hasCommandValues =
        typeof attack.mp === 'number' && typeof attack.cp === 'number';
      if (hasCommandValues) {
        const nextMp = attack.mp!;
        const nextCp = attack.cp!;
        Object.assign(target, {
          hp: totalStats - nextMp - nextCp,
          mp: nextMp,
          cp: nextCp,
        });
      } else {
        // Guardian Exchange preserves the stat total and randomly spreads it
        // across HP, MP, and CP. HP may be zero.
        Object.assign(target, battle.spreadStatTotal(totalStats));
      }
      battle.emit('exchange', {
        hp: target.hp,
        mp: target.mp,
        cp: target.cp,
      });
      battle.resolveDeaths(false);
      break;
    }
    case 'boostHP':
      battle.applyStatBoost(target, 'hp', amount);
      break;
    case 'boostMP':
      battle.applyStatBoost(target, 'mp', amount);
      break;
    case 'boostCP':
      battle.applyStatBoost(target, 'cp', amount);
      break;
    case 'boostCPToEnemy':
      battle.applyStatBoost(target, 'cp', amount);
      break;
    case 'boostMPAndAddCurse':
      battle.applyStatBoost(target, 'mp', amount);
      battle.addCurse(target, definition.curse?.key);
      break;
    case 'boostHPOrDealDamage':
      if (battle.random.chance('tear', TEAR_HEAL_PERCENT)) {
        battle.applyStatBoost(target, 'hp', amount);
      } else {
        battle.applyDamage(target, amount);
      }
      break;
    case 'removeAllCurses':
      battle.removeCurses(target, true);
      break;
    case 'removeMildCurses':
      battle.removeCurses(target, false);
      break;
    case 'addCurse':
      battle.addCurse(target, definition.curse?.key, true);
      break;
    case 'setGuardian':
      target.guardian = battle.random.pick('guardian', guardianNames);
      battle.emit('setGuardian', {
        guardian: target.guardian,
      });
      break;
    case 'removeItems':
    case 'removeUsedMiracles': {
      const isUsedMiracleRemoval = definition.ability === 'removeUsedMiracles';
      const eligibleItems = getOccupiedItemSlots(target).filter(
        (itemSlot) => Boolean(itemSlot.used) === isUsedMiracleRemoval,
      );
      const items = eligibleItems.length
        ? battle.random
            .shuffle(
              definition.ability,
              eligibleItems,
            )
            .slice(
              0,
              isUsedMiracleRemoval
                ? SOAP_REMOVAL_COUNT
                : BROOM_REMOVAL_COUNT,
            )
        : [];
      battle.emit(
        items.length ? definition.ability : 'safe',
        items.length
          ? {
              items,
            }
          : {},
      );
      battle.takeSlots(target, items, true);
      break;
    }
    case 'counterBoost2xMP':
      battle.applyStatBoost(target, 'mp', attack.mp!);
      break;
    case 'counterCurse':
      if (
        definition.curse?.key
        && target.curses?.includes(definition.curse.key)
      ) {
        battle.emit('safe');
        break;
      }
      battle.addCurse(target, definition.curse?.key);
      break;
    case 'counterTakeCP':
    case 'takeCP': {
      const requestedCoinPoints = attack.cp ?? amount ?? 0;
      battle.emit('takeCP', {
        cp: requestedCoinPoints,
      });
      battle.applyStatChange(target, 'cp', -requestedCoinPoints);
      battle.applyStatChange(attacker, 'cp', requestedCoinPoints);
      break;
    }
    case 'boostCPOfEverybody':
      battle.emit('boostCPOfEverybody', {
        cp: amount,
      });
      for (const player of battle.alive) {
        battle.applyStatChange(player, 'cp', amount);
      }
      break;
    case 'addItem': {
      const preselectedGiftId = attack.itemModelIds?.[1];
      const giftDefinition =
        preselectedGiftId != null && preselectedGiftId !== definition.id
          ? battle.getItemDefinition(preselectedGiftId)
          : battle.pickEarthDropItem();
      if (giftDefinition === null) {
        battle.emit('safe');
        break;
      }
      battle.emit('addItem', battle.addSlot(attacker, giftDefinition.id));
      break;
    }
    case 'callPhenomenon':
      return battle.resolvePhenomenon(attacker, definition);
    case 'setCurseOfEverybody':
      battle.emit('setCurseOfEverybody', {
        curse: definition.curse!.key,
      });
      for (const player of battle.alive) {
        battle.applyCurse(player, definition.curse!.key);
      }
      break;
    case 'confuseEverybody':
      battle.emit('confuseEverybody');
      for (const player of battle.alive) {
        player.confusionCount =
          (player.confusionCount ?? 0) + engine.CONFUSION_TURNS;
      }
      break;
    case 'setHPOfEverybody':
      battle.emit('setHPOfEverybody', {
        hp: amount,
      });
      for (const player of battle.alive) {
        player.hp = amount;
      }
      break;
    case 'collectCPOfEverybody': {
      const recipient = battle.random.pick(
        'goldMountainRecipient',
        battle.alive,
      );
      const coinPoints = battle.alive.reduce(
        (accumulatedCoinPoints, player) => accumulatedCoinPoints + player.cp,
        0,
      );
      for (const player of battle.alive) {
        player.cp = 0;
      }
      battle.applyStatChange(recipient, 'cp', coinPoints);
      battle.emit('collectCPOfEverybody', {
        playerId: recipient.id,
      });
      break;
    }
    case 'shuffleItemsOfEverybody': {
      // The storm shuffles card values across every living slot, including
      // pre-existing placeholders. Empty slots can therefore be filled or
      // move to another hand; the total card count is unchanged.
      const shuffledModelIds = battle.random
        .shuffle(
          'shuffleItems',
          battle.alive.flatMap((player) => getOccupiedItemSlots(player)),
        )
        .map((itemSlot) => itemSlot.modelId);
      const shuffledSlots = battle.random.shuffle(
        'shuffleSlotOrder',
        battle.alive.flatMap((player) => player.items),
      );
      for (const [slotIndex, itemSlot] of shuffledSlots.entries()) {
        const modelId = shuffledModelIds[slotIndex];
        itemSlot.modelId = modelId ?? 0;
        clearItemDisguise(itemSlot);
        itemSlot.used = false;
      }
      for (const player of battle.alive) {
        renumberOccupiedItemSlots(player);
        if (player.curses?.includes('dream') === true) {
          for (const itemSlot of getOccupiedItemSlots(player)) {
            const fakeModelId = selectDreamDisguise(
              battle.random,
              battle.getItemDefinition(itemSlot.modelId),
            );
            if (fakeModelId === undefined) {
              clearItemDisguise(itemSlot);
            } else {
              itemSlot.fakeModelId = fakeModelId;
            }
          }
        }
        battle.emit('replaceItems', {
          playerId: player.id,
          items: getSortedOccupiedItemSlots(player),
        });
      }
      break;
    }
    case 'setGuardianOfEverybody': {
      // Each shuffled pass assigns every guardian at most once. If a lobby
      // ever has more players than guardian names, start a fresh shuffled
      // pass instead of handing out undefined entries.
      let shuffledGuardians: string[] = [];
      let guardianCursor = 0;
      const values = battle.alive.map((player) => {
        if (guardianCursor >= shuffledGuardians.length) {
          shuffledGuardians = battle.random.shuffle(
            'solarEclipseGuardians',
            guardianNames,
          );
          guardianCursor = 0;
        }
        const guardian = shuffledGuardians[guardianCursor];
        guardianCursor++;
        player.guardian = guardian;
        return guardian;
      });
      battle.emit('setGuardianOfEverybody', {
        guardians: values,
      });
      break;
    }
    default: {
      if (definition.attack > 0) {
        battle.applyDamage(target, definition.attack);
      } else {
        throw new Error(
          `Unresolved ability ${definition.ability} (${definition.id})`,
        );
      }
    }
  }
}
