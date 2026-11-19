import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Command, Player, Slot } from '../types.ts';
import type { Battle } from './battle.ts';
import { requireValue } from '../errors.ts';
import {
  clearItemDisguise,
  getOccupiedItemSlots,
  insertItemSlot,
} from './inventory.ts';

function restoreOfferedItem(seller: Player, item: Slot): void {
  clearItemDisguise(item);
  let restoredId = 1;
  while (getOccupiedItemSlots(seller).some((slot) => slot.id === restoredId)) {
    restoredId++;
  }
  item.id = restoredId;
  insertItemSlot(seller, item);
}

function transferPrice(
  battle: Battle,
  buyer: Player,
  seller: Player,
  price: number,
): void {
  battle.applyStatChange(buyer, 'cp', -price);
  battle.applyStatChange(seller, 'cp', price);
}

export function offerPurchase(battle: Battle, buyer: Player, seller: Player): void {
  const available = getOccupiedItemSlots(seller).filter(
    (itemSlot) => !itemSlot.used,
  );
  if (!available.length) {
    battle.emit('safe');
    battle.completeAttack();
    return;
  }
  const item = battle.random.pick('buyOffer', available);
  battle.emit('buy', {
    item,
  });
  battle.takeSlots(seller, [item], true);
  if (
    buyer.id === seller.id ||
    buyer.cp < battle.getItemDefinition(item.modelId).price
  ) {
    restoreOfferedItem(seller, item);
    battle.emit('canNotBuy', {
      item,
    });
    battle.completeAttack();
    return;
  }
  battle.currentAttack.buyingItemModelId = item.modelId;
  const turnProgress = (battle.game.serverTurn ??= {});
  turnProgress.buyingItemId = item.id;
}

export function confirmPurchase(battle: Battle, buyer: Player, command: Command): void {
  requireValue(
    typeof command.bought === 'boolean' && !command.itemIds?.length,
  );
  const attack = battle.currentAttack;
  const seller = battle.requirePlayer(attack.targetPlayerId);
  const definition = battle.getItemDefinition(attack.buyingItemModelId!);
  const bought = command.bought && buyer.cp >= definition.price;
  const turnProgress = battle.game.serverTurn;
  const offeredItemId = turnProgress?.buyingItemId;
  let slot;
  if (bought) {
    transferPrice(battle, buyer, seller, definition.price);
    slot = battle.addSlot(buyer, definition.id, false);
  } else {
    requireValue(offeredItemId !== undefined);
    const restoredItem: Slot = {
      id: offeredItemId,
      modelId: definition.id,
    };
    restoreOfferedItem(seller, restoredItem);
    slot = { item: restoredItem };
  }
  if (turnProgress) {
    delete turnProgress.buyingItemId;
  }
  battle.emit('setBought', {
    ...slot,
    bought,
  });
  battle.completeAttack();
}

export function resolveSale(
  battle: Battle,
  seller: Player,
  buyer: Player,
  definition: ItemDefinition,
  restoredItemId?: number,
): void {
  transferPrice(battle, buyer, seller, definition.price);
  let slot;
  const hasRestoredId = restoredItemId !== undefined
    && !buyer.items.some((itemSlot) => itemSlot.id === restoredItemId);
  if (hasRestoredId) {
    const item: Slot = {
      id: restoredItemId,
      modelId: definition.id,
    };
    // A reflected sale returns an existing card to the seller. It must not
    // consume the pending refill for the consumed Sell card; the seller still
    // receives that end-of-turn gift.
    insertItemSlot(buyer, item);
    slot = { item };
  } else {
    slot = battle.addSlot(buyer, definition.id, false);
  }
  battle.emit('sell', slot);
}

