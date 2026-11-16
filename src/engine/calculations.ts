import {ItemDefinition} from '../domain/models';
import {ItemElement, ItemElementDarkness, ItemElementLight, CategoryMiracles} from '../domain/enums';
import {first} from '../shared/collections';

export function combineElements(left: ItemElement | null, right: ItemElement | null): ItemElement | null {
  if (left === right) return left;
  if (left === null || right === null || left === ItemElementDarkness || right === ItemElementDarkness) return null;
  if (left === ItemElementLight) return right;
  if (right === ItemElementLight) return left;
  return null;
}

export function getSharedElement(items: readonly ItemDefinition[]): ItemElement | null {
  let element = first(items).element;
  for (const item of items.slice(1)) element = combineElements(element, item.element);
  return element;
}

export function getAttackElement(items: readonly ItemDefinition[]): ItemElement | null {
  let element = first(items).element;
  for (const item of items.slice(1)) {
    switch (item.ability) {
      case 'filterAtkElement':
        element = null;
        break;
      case 'setElement':
        element = item.element;
        break;
      case 'cutCost': break;
      default: element = combineElements(element, item.element);
    }
  }
  return element;
}

export function calculateMpCost(items: readonly ItemDefinition[]): number {
  if (!items.length || ['discard', 'sacrifice', 'sell', 'addItem'].includes(items[0].ability)) return 0;
  let cost = 0;
  for (const [index, item] of items.entries()) {
    if (item.category === CategoryMiracles && items[index + 1]?.ability !== 'cutCost') cost += item.cost;
  }
  return cost;
}

export function calculateAttackDamage(items: readonly ItemDefinition[], overrideAttack: number): number {
  let attack = overrideAttack > 0 ? overrideAttack : first(items).attack;
  for (const item of items.slice(1)) {
    if (item.ability === 'doubleAtk') attack *= 2;
    else if (item.ability !== 'cutCost') attack += item.attack;
  }
  return attack;
}
