import type { FlashItem, FlashVersion } from './catalog.ts';

/** Constants.ATK_MAX in the official Flash client. */
export const FLASH_ATTACK_MAX = 9999;
const maximumDiscardSellOrAddItemPieces = 2;
const magicalAttackDamageMultiplier = 2;
const weaponBonusMultiplier = 2;

export interface FlashPiece {
  item: FlashItem;
  illusionItem?: FlashItem;
  abilityIndex?: number;
  costMP: number;
}

export interface FlashAttack {
  pieces: FlashPiece[];
  kind: string;
  extra: string;
  attribute: string;
  value: number;
  hitRate: number;
  type: string;
}

/** Ports of game/Attribute, AttackCommand, DefenseCommand and Command in the SWF. */
export function sumAttribute(first: string, second: string): string {
  if (!first || !second) {
    return '';
  }
  if (first === 'LIGHT') {
    return second === 'DARK' ? '' : second;
  }
  return first === second || (second === 'LIGHT' && first !== 'DARK') ? first : '';
}

export function canDefend(attack: string, defense: string): boolean {
  if (!attack || attack === 'DARK') {
    return true;
  }
  if (attack === 'LIGHT') {
    return defense === 'DARK';
  }
  const opposite: Record<string, string> = { FIRE: 'WATER', WATER: 'FIRE', TREE: 'SOIL', SOIL: 'TREE' };
  return defense === 'LIGHT' || defense === opposite[attack];
}

export function canAddAttack(selected: readonly FlashPiece[], candidate: FlashPiece, version: FlashVersion = '2013'): boolean {
  const item = candidate.illusionItem ?? candidate.item;
  const first = selected[0]?.illusionItem ?? selected[0]?.item;
  if (!first) {
    return item.type !== 'PROTECTOR' && !(['MAGIC', 'SUNDRY'].includes(item.type) && !item.attackKind);
  }
  if (first.attackKind === 'DISCARD' || first.attackKind === 'SELL' || first.attackKind === 'ADD_ITEM') {
    const unlimitedDiscard = version === '2013' && first.attackKind === 'DISCARD';
    const tooManyCards = !unlimitedDiscard && selected.length >= maximumDiscardSellOrAddItemPieces;
    return !tooManyCards && item.type !== 'FIXED' && candidate.abilityIndex === undefined;
  }
  if (['INCREASE_ATK', 'DOUBLE_ATK', 'WIDE_ATK', 'ADD_ATTRIBUTE'].includes(item.attackExtra)) {
    return first.type === 'WEAPON' && first.hitRate === 0;
  }
  const last = selected.at(-1)!;
  return item.attackExtra === 'MAGIC_FREE' && (last.illusionItem ?? last.item).type === 'MAGIC';
}

export function setCosts(pieces: FlashPiece[], removal = false, availableMp?: number): number {
  for (const piece of pieces) {
    piece.costMP = !removal && piece.item.type === 'MAGIC' ? piece.item.subValue : 0;
  }
  for (let pieceIndex = 1; pieceIndex < pieces.length; pieceIndex++) {
    const piece = pieces[pieceIndex]!;
    const previous = pieces[pieceIndex - 1]!;
    if (piece.item.attackExtra === 'MAGIC_FREE' && previous.item.type === 'MAGIC') {
      previous.costMP = 0;
    }
  }
  let total = pieces.reduce((sum, piece) => sum + piece.costMP, 0);
  if (!removal && pieces[0]?.item.attackExtra === 'MAGICAL' && availableMp !== undefined) {
    pieces[0].costMP = Math.max(0, availableMp - total);
    total += pieces[0].costMP;
  }
  return total;
}

export function attackOf(pieces: FlashPiece[]): FlashAttack {
  const first = pieces[0]!.item;
  let value = first.attackExtra === 'MAGICAL' ? pieces[0]!.costMP * magicalAttackDamageMultiplier : first.value;
  let kind = first.attackKind;
  let attribute = first.attribute;
  let hitRate = first.hitRate;
  if (kind === 'SELL') {
    const sold = pieces[1]!.item;
    kind = sold.type === 'CREATURE' ? sold.attackKind : kind;
    value = sold.type === 'CREATURE' ? sold.value : sold.price;
  }
  if (first.type === 'WEAPON' && first.hitRate === 0) {
    for (const piece of pieces.slice(1)) {
      const item = piece.item;
      if (['INCREASE_ATK', 'ADD_ATTRIBUTE'].includes(item.attackExtra)) {
        value += ['WEAPON', 'MAGIC'].includes(item.type) ? item.value : item.subValue;
      } else if (item.attackExtra === 'DOUBLE_ATK') {
        value = Math.min(FLASH_ATTACK_MAX, value * weaponBonusMultiplier);
      }
      if (item.attackExtra === 'ADD_ATTRIBUTE') {
        attribute = item.attribute;
      } else if (item.attackExtra !== 'MAGIC_FREE') {
        attribute = sumAttribute(attribute, item.attribute);
      }
    }
  }
  if (kind === 'ATK') {
    for (const piece of pieces) {
      if (piece.item.attackExtra === 'WIDE_ATK') {
        hitRate += piece.item.hitRate;
      }
    }
  }
  return { pieces, kind, extra: first.attackExtra, attribute, value, hitRate, type: first.type };
}

export function defenseKind(item: FlashItem, attack: FlashAttack, attributeRemoved: boolean): string {
  if (!item.defenseKind && !item.defenseExtra) {
    return '';
  }
  if (item.defenseExtra === 'REFLECT_ANY') {
    return 'SOLO';
  }
  if (attack.type === 'MAGIC' && ['BLOCK_MAGIC', 'FLICK_MAGIC', 'REFLECT_MAGIC'].includes(item.defenseExtra)) {
    return 'SOLO';
  }
  if (attack.kind !== 'ATK' || attack.type === 'TRADE') {
    return '';
  }
  if (item.defenseExtra === 'REMOVE_ATTRIBUTE') {
    return 'SUPPORT';
  }
  const untypedWeapon = (!attack.attribute || attributeRemoved) && attack.type !== 'MAGIC';
  if (untypedWeapon && ['BLOCK_WEAPON', 'FLICK_WEAPON', 'REFLECT_WEAPON'].includes(item.defenseExtra)) {
    return 'SOLO';
  }
  return attributeRemoved || canDefend(attack.attribute, item.attribute) ? item.defenseKind : '';
}

export function canAddDefense(selected: readonly FlashPiece[], candidate: FlashPiece, attack: FlashAttack, glory: boolean, attributeRemoved = false): boolean {
  if (glory && selected.length) {
    return false;
  }
  const last = selected.at(-1);
  const item = candidate.illusionItem ?? candidate.item;
  if (last && (last.illusionItem ?? last.item).type === 'MAGIC' && item.attackExtra === 'MAGIC_FREE') {
    return true;
  }
  // The SWF validates the complete defense against its final attribute state.
  // An element stripping card later in the wire selection therefore permits earlier
  // armor whose attribute would not defend the original attack.
  const removed = attributeRemoved || selected.some((piece) => (piece.illusionItem ?? piece.item).defenseExtra === 'REMOVE_ATTRIBUTE')
    || candidate.item.defenseExtra === 'REMOVE_ATTRIBUTE';
  const kind = defenseKind(item, attack, removed);
  if (!kind) {
    return false;
  }
  return selected.every((piece) => {
    const currentKind = defenseKind(piece.illusionItem ?? piece.item, attack, removed);
    return kind === 'SUPPORT' || (kind === 'SOLO' ? currentKind === 'SUPPORT' : currentKind !== 'SOLO');
  });
}
