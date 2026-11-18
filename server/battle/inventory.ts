import type { Stat, Player, Slot } from '../types.ts';
import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Battle } from './battle.ts';
import { engine } from '../engine.ts';
import { selectDreamDisguise } from './dream.ts';

export const getOccupiedItemSlots = (player: Player) =>
  (player.items ?? []).filter((slot) => slot.modelId > 0);

export const isPlaceholderSlot = (itemSlot: Slot) => !itemSlot.modelId;

export const findPlaceholderIndex = (player: Player) =>
  player.items.findIndex(isPlaceholderSlot);

export const getPlaceholderSlots = (player: Player) =>
  (player.items ?? []).filter(isPlaceholderSlot);

// Active items precede pending refills. Acquisitions may consume one refill;
// moving an existing item leaves the pending refill count unchanged.
export const insertItemSlot = (
  player: Player,
  item: Slot,
  fillPlaceholder = false,
) => {
  const placeholderIndex = findPlaceholderIndex(player);
  const insertionIndex =
    placeholderIndex < 0 ? player.items.length : placeholderIndex;
  player.items.splice(insertionIndex, fillPlaceholder ? 1 : 0, item);
};

export const clearItemDisguise = (itemSlot: Slot) => {
  delete itemSlot.fakeModelId;
};

export const getSortedOccupiedItemSlots = (player: Player) =>
  getOccupiedItemSlots(player).sort(
    (firstSlot, secondSlot) => firstSlot.id - secondSlot.id,
  );

export const renumberOccupiedItemSlots = (player: Player) => {
  let nextId = 1;
  for (const itemSlot of player.items) {
    itemSlot.id = itemSlot.modelId > 0 ? nextId++ : 0;
  }
};

export type ItemAcquisition = {
  item: Slot;
  overflowItem?: Slot;
};

export interface GiftDraw {
  isDevilGift: boolean;
  definition: ItemDefinition;
  slot: ItemAcquisition;
}

const DEVIL_CHANCE_PERCENT = 25;
const TRICKSTER_REMOVAL_COUNT = 2;

export function takeSlots(
  battle: Battle,
  player: Player,
  selectedSlots: Slot[],
  removePermanently = false,
): void {
  let replacementCount = 0;
  for (const slot of selectedSlots) {
    if (!slot.id) {
      continue;
    }
    const currentSlot = player.items.find((item) => item.id === slot.id);
    if (!currentSlot) {
      continue;
    }
    const keepsUsedMiracle =
      !removePermanently &&
      battle.getItemDefinition(currentSlot.modelId).category === engine.CategoryMiracles;
    if (keepsUsedMiracle) {
      currentSlot.used = true;
      clearItemDisguise(currentSlot);
    }
    player.items.splice(player.items.indexOf(currentSlot), 1);
    if (keepsUsedMiracle) {
      insertItemSlot(player, currentSlot);
    }
    if (!removePermanently) {
      replacementCount++;
    }
  }
  for (let index = 0; index < replacementCount; index++) {
    battle.addPlaceholderSlot(player);
  }
}

export function addSlot(
  battle: Battle,
  player: Player,
  modelId: number,
  fillPlaceholder = true,
): ItemAcquisition {
  const items = getOccupiedItemSlots(player);
  const placeholderIndex = findPlaceholderIndex(player);
  const replacesFullHandPlaceholder =
    player.items.length >= engine.MAX_ITEM_SLOTS && placeholderIndex >= 0;
  let itemId = 1;
  while (items.some((item) => item.id === itemId)) {
    itemId++;
  }
  let overflowItem;
  const hasFullOccupiedHand = items.length >= engine.MAX_ITEM_SLOTS;
  const hasNoSpaceForExtraSlot = !fillPlaceholder &&
    player.items.length >= engine.MAX_ITEM_SLOTS &&
    !replacesFullHandPlaceholder;
  if (hasFullOccupiedHand || hasNoSpaceForExtraSlot) {
    // Performed miracles have the same overflow probability as every other card.
    const overflowCandidates = items.length !== 0 ? items : player.items;
    overflowItem = battle.random.pick(
      'overflowItem',
      overflowCandidates,
    );
    player.items.splice(player.items.indexOf(overflowItem), 1);
    itemId = overflowItem.id;
  }
  const fillsExistingPlaceholder =
    fillPlaceholder || replacesFullHandPlaceholder;
  const item: Slot = {
    id: itemId,
    modelId,
  };
  insertItemSlot(player, item, fillsExistingPlaceholder);
  return {
    item,
    ...(overflowItem
      ? {
          overflowItem,
        }
      : {}),
  };
}

export function applyDreamDisguise(
  battle: Battle,
  player: Player,
  item: Slot,
): void {
  if (!player.curses?.includes('dream')) {
    return;
  }
  const fakeModelId = selectDreamDisguise(
    battle.random,
    battle.getItemDefinition(item.modelId),
  );
  if (fakeModelId === undefined) {
    clearItemDisguise(item);
    return;
  }
  item.fakeModelId = fakeModelId;
}

export function addPlaceholderSlot(player: Player): boolean {
  if (player.items.length < engine.MAX_ITEM_SLOTS) {
    player.items.push({
      id: 0,
      modelId: 0,
    });
    return true;
  }
  return false;
}

export function drawGift(
  battle: Battle,
  player: Player,
  allowDevil = true,
): GiftDraw | null {
  if (player.dead) {
    return null;
  }
  let isDevilGift =
    allowDevil &&
    battle.apocalypse &&
    battle.random.chance(
      `devilChance:${player.id}`,
      DEVIL_CHANCE_PERCENT,
    );
  const drawDefinition = (devilGift: boolean) =>
    battle.pickFromPool(
      devilGift ? `devilModel:${player.id}` : `giftModel:${player.id}`,
      battle.catalog.filter(
        (itemDefinition) =>
          (devilGift
            ? itemDefinition.appearanceRate > 0
            : itemDefinition.giftRate > 0),
      ),
      (itemDefinition) =>
        devilGift
          ? itemDefinition.appearanceRate
          : itemDefinition.giftRate,
    );
  let definition = drawDefinition(isDevilGift);
  if (definition === null && isDevilGift) {
    isDevilGift = false;
    definition = drawDefinition(false);
  }
  if (definition === null) {
    return null;
  }
  const slot = battle.addSlot(player, definition.id);
  battle.applyDreamDisguise(player, slot.item);
  return {isDevilGift, definition, slot};
}

export function deliverGift(battle: Battle, player: Player, gift: GiftDraw): void {
  const {isDevilGift, definition, slot} = gift;
  if (!player.isBot) {
    battle.emit('gift', {
      playerId: player.id,
      item: slot.item,
    });
  }
  if (isDevilGift) {
    battle.emit('useDevilItem', {
      playerId: player.id,
      item: slot.item,
    });
    battle.takeSlots(player, [slot.item]);
    if (definition.ability === 'dealDamage') {
      battle.applyDamage(player, definition.abilityValue);
    } else if (definition.ability === 'boostSomething') {
      battle.applyStatBoost(
        player,
        battle.random.pick<Stat>('devilStat', ['hp', 'mp', 'cp']),
        definition.abilityValue,
      );
    } else {
      const items = battle.random
        .shuffle('devilItems', getOccupiedItemSlots(player))
        .slice(0, TRICKSTER_REMOVAL_COUNT);
      battle.emit('removeSomething', {
        items,
      });
      battle.takeSlots(player, items, true);
    }
    battle.resolveDeaths(false);
  }
}

export function resolveGift(
  battle: Battle,
  player: Player,
  allowDevil = true,
): void {
  while (!player.dead) {
    const gift = battle.drawGift(player, allowDevil);
    if (gift === null) {
      return;
    }
    battle.deliverGift(player, gift);
    if (!gift.isDevilGift) {
      return;
    }
  }
}

export function refillConsumedSlots(battle: Battle, actingPlayer: Player): void {
  const giftOrder = [
    actingPlayer,
    ...battle.turnOrderAfter(actingPlayer.id).filter(
      (candidatePlayer) => candidatePlayer !== actingPlayer,
    ),
  ];
  while (true) {
    const recipients = giftOrder.flatMap((player) => {
      if (player.dead) {
        return [];
      }
      const emptySlots = getPlaceholderSlots(player);
      return emptySlots.map(() => player);
    });
    if (recipients.length === 0) {
      return;
    }
    const hasMultipleRecipients = recipients.some(
      (player) => player !== recipients[0],
    );
    const player = hasMultipleRecipients
      ? battle.random.pick('giftRecipient', recipients)
      : recipients[0];
    const gift = battle.drawGift(player);
    if (gift === null) {
      return;
    }
    battle.deliverGift(player, gift);
  }
}

