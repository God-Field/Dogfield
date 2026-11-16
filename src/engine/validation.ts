import {CategoryArmor, CategoryMiracles, CategoryWeapons} from '../domain/enums';
import type {Category, ItemElement} from '../domain/enums';
import type {ItemDefinition} from '../domain/models';
import {first, last} from '../shared/collections';
import {calculateMpCost, getAttackElement} from './calculations';

/** Commands that remove an item instead of applying it to a new target. */
export const removalActions: ReadonlySet<string> = new Set(['discard', 'sacrifice', 'sell']);

export type CommandMode = 'normal' | 'defense';

export interface IncomingAttackContext {

  items: readonly ItemDefinition[];

  hasAttackValue: boolean;
}

export interface CommandSelectionContext {
  mode: CommandMode;

  hasFlashCurse: boolean;

  incomingAttack?: IncomingAttackContext;

  candidateHasSelectionOverlay?: boolean;
}

const filterCommand = 'filterAtkElement';
const nonTargetActions = new Set(['revive', 'attractDanger']);

export function hasAttackValue(
  items: readonly ItemDefinition[],
  attackOverride = 0,
): boolean {
  if (items.length === 0) return false;
  const firstAttack = items[0];
  // Weapon attacks still open a defense phase when their computed ATK is zero.
  return attackOverride > 0
    || firstAttack.attack > 0
    || firstAttack.category === CategoryWeapons;
}

export function canApplyCommand(
  selected: readonly ItemDefinition[],
  candidate: ItemDefinition,
  context: CommandSelectionContext,
): boolean {
  if (context.mode === 'defense') {
    if (context.hasFlashCurse && selected.length !== 0) return false;
    if (selected.length !== 0 && last(selected).category === CategoryMiracles && candidate.ability === 'cutCost') return true;
    const incomingAttack = context.incomingAttack;
    if (!incomingAttack) throw new Error('Missing incoming attack context');
    const attacks = incomingAttack.items;
    const firstAttack = first(attacks);
    const category = firstAttack.ability === 'categoryWeapons' ? CategoryWeapons : firstAttack.category;
    const element = selected.length !== 0 && first(selected).ability === filterCommand
      ? null
      : attacks.length === 0 ? null : getAttackElement(attacks);
    const candidateResponse = candidate.getWeaponResponseAction(
      category,
      element,
    );
    if (candidateResponse !== null) {
      return selected.length === 0 || last(selected).ability === filterCommand;
    }
    const selectedHasResponse = selected.some(
      (item) => item.getWeaponResponseAction(category, element) !== null,
    );
    if (selectedHasResponse) {
      return false;
    }
    if (!incomingAttack.hasAttackValue || !(candidate.defense > 0 || candidate.category === CategoryArmor)) return false;
    if (candidate.ability === filterCommand) {
      return selected.length === 0 || last(selected).ability === filterCommand;
    }
    return candidate.matchesCommandElement(element);
  }

  if (selected.length === 0) return candidate.isItemTargetingCommand();
  const initial = first(selected);
  switch (initial.ability) {
    case 'discard':
    case 'sacrifice':
      return candidate.category !== CategoryWeapons && !nonTargetActions.has(candidate.ability);
    case 'sell':
      return selected.length === 1
        && !context.candidateHasSelectionOverlay
        && candidate.ability !== 'discard'
        && candidate.ability !== 'sacrifice';
  }
  if (last(selected).category === CategoryMiracles && candidate.ability === 'cutCost') return true;
  return candidate.isPlusAttack && initial.category === CategoryWeapons && initial.hitRate === 0;
}

export function findDefenseResponse(
  selected: readonly ItemDefinition[],
  attackCategory: Category,
  attackElement: ItemElement | null,
): string | null {
  for (const item of selected) {
    const response = item.getWeaponResponseAction(attackCategory, attackElement);
    if (response !== null) {
      return response;
    }
  }
  return null;
}

export function getCommandDiscardMode(
  hasActionControl: boolean,
  selected: readonly ItemDefinition[],
): boolean {
  return hasActionControl
    && selected.length !== 0
    && !removalActions.has(first(selected).ability)
    && selected.some(item => item.category === CategoryMiracles);
}

export function isDiscardOrSaleCommand(
  selected: readonly ItemDefinition[],
  candidate: ItemDefinition,
  context: CommandSelectionContext,
): boolean {
  const trial = selected.slice();
  while (!canApplyCommand(trial, candidate, context)) {
    if (trial.length === 0) return false;
    if (trial.length === 1 && removalActions.has(first(trial).ability)) return false;
    trial.pop();
  }
  return true;
}

export interface ItemActionValidation {
  models: readonly ItemDefinition[];
  availableMp: number;
  mode: CommandMode;
  hasSpecialItemCommand: boolean;
}

export function validateItemAction(input: ItemActionValidation): string | null {
  if (input.availableMp < calculateMpCost(input.models)) return 'miracles';
  if (input.mode === 'normal') {
    if (input.models.length === 0) {
      if (input.hasSpecialItemCommand) return 'pray';
    } else {
      const action = input.models[0].ability;
      if ((action === 'discard' || action === 'sacrifice') && input.models.length < 2) return action;
      if (action === 'sell' && input.models.length !== 2) return 'sell';
    }
  }
  return null;
}
