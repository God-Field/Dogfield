import type {AttackCommand, BattleEvent, GameState, ItemDefinition, ItemSlot, PlayerStatus} from '../domain/models';
import {defaultItemCatalog, type ItemCatalog} from '../domain/item-catalog';
import {calculateAttackDamage, calculateMpCost, getAttackElement, getSharedElement} from './calculations';
import {
  canApplyCommand,
  getCommandDiscardMode,
  hasAttackValue,
  isDiscardOrSaleCommand,
  validateItemAction,
  type CommandMode,
  type CommandSelectionContext,
  type IncomingAttackContext,
} from './validation';

export interface BattleSnapshot {
  players: readonly PlayerStatus[];
  gf: number;
  tiebreakGF: number | null;
  attackTurnPlayerId: number;
  attack: AttackCommand | null;
  isOver: boolean;
  events: readonly BattleEvent[];
  updateCount: number;
}

export interface BattleEngineOptions {
  players?: readonly PlayerStatus[];
  gf?: number;
  tiebreakGF?: number | null;
  attackTurnPlayerId?: number;
  attack?: AttackCommand | null;
  isOver?: boolean;
  events?: readonly BattleEvent[];
  updateCount?: number;
}

export interface ItemActionOptions {
  availableMp: number;
  mode?: CommandMode;
  hasSpecialItemCommand?: boolean;
  itemIds?: readonly number[];
}

export type ItemActionPlan =
  | {
      ok: true;
      models: readonly ItemDefinition[];
      itemIds: readonly number[];
      mpCost: number;
      commandType: string | null;
    }
  | {ok: false; alert: string};

export interface AttackSummary {
  damage: number;
  mpCost: number;
  element: ReturnType<typeof getAttackElement>;
  sharedElement: ReturnType<typeof getSharedElement>;
}

function createSnapshot(options: BattleEngineOptions): BattleSnapshot {
  return {
    players: options.players ?? [],
    gf: options.gf ?? 0,
    tiebreakGF: options.tiebreakGF ?? null,
    attackTurnPlayerId: options.attackTurnPlayerId ?? 0,
    attack: options.attack ?? null,
    isOver: options.isOver ?? false,
    events: options.events ?? [],
    updateCount: options.updateCount ?? 0,
  };
}

function snapshotFromGame(game: GameState): BattleSnapshot {
  return {
    players: game.players,
    gf: game.gf,
    tiebreakGF: game.tiebreakGF,
    attackTurnPlayerId: game.attackTurnPlayerId,
    attack: game.attack,
    isOver: game.isOver,
    events: game.events,
    updateCount: game.updateCount,
  };
}

function mergeSnapshot(snapshot: BattleSnapshot, options: BattleEngineOptions): BattleSnapshot {
  return {
    players: options.players ?? snapshot.players,
    gf: options.gf ?? snapshot.gf,
    tiebreakGF: options.tiebreakGF === undefined ? snapshot.tiebreakGF : options.tiebreakGF,
    attackTurnPlayerId: options.attackTurnPlayerId ?? snapshot.attackTurnPlayerId,
    attack: options.attack === undefined ? snapshot.attack : options.attack,
    isOver: options.isOver ?? snapshot.isOver,
    events: options.events ?? snapshot.events,
    updateCount: options.updateCount ?? snapshot.updateCount,
  };
}

/**
 * Headless battle façade.
 *
 * It owns the decoded item catalog and the current game snapshot, and exposes
 * calculations, selection validation, and command planning without creating a
 * single DOM element. The browser client uses the same modules through its
 * existing UI wrappers.
 */
export class BattleEngine {
  readonly catalog: ItemCatalog;
  private snapshot: BattleSnapshot;

  constructor(options: BattleEngineOptions = {}, catalog: ItemCatalog = defaultItemCatalog) {
    this.catalog = catalog;
    this.snapshot = createSnapshot(options);
  }

  static fromGameState(game: GameState, catalog: ItemCatalog = defaultItemCatalog): BattleEngine {
    return new BattleEngine({}, catalog).applyGameState(game);
  }

  get state(): BattleSnapshot {
    return this.snapshot;
  }

  get players(): readonly PlayerStatus[] {
    return this.snapshot.players;
  }

  get isOver(): boolean {
    return this.snapshot.isOver;
  }

  applyGameState(game: GameState): this {
    this.snapshot = snapshotFromGame(game);
    return this;
  }

  applyOptions(options: BattleEngineOptions): this {
    this.snapshot = mergeSnapshot(this.snapshot, options);
    return this;
  }

  playerById(id: number): PlayerStatus | null {
    return this.snapshot.players.find(player => player.id === id) ?? null;
  }

  currentTurnPlayer(): PlayerStatus | null {
    return this.playerById(this.snapshot.attackTurnPlayerId);
  }

  summarizeAttack(models: readonly ItemDefinition[], overrideAttack = 0): AttackSummary {
    if (models.length === 0) return {damage: 0, mpCost: 0, element: null, sharedElement: null};
    return {
      damage: calculateAttackDamage(models, overrideAttack),
      mpCost: calculateMpCost(models),
      element: getAttackElement(models),
      sharedElement: getSharedElement(models),
    };
  }

  canApplyCommand(
    selected: readonly ItemDefinition[],
    candidate: ItemDefinition,
    context: CommandSelectionContext,
  ): boolean {
    return canApplyCommand(selected, candidate, context);
  }

  getCommandDiscardMode(hasActionControl: boolean, selected: readonly ItemDefinition[]): boolean {
    return getCommandDiscardMode(hasActionControl, selected);
  }

  isDiscardOrSaleCommand(
    selected: readonly ItemDefinition[],
    candidate: ItemDefinition,
    context: CommandSelectionContext,
  ): boolean {
    return isDiscardOrSaleCommand(selected, candidate, context);
  }

  planItemAction(models: readonly ItemDefinition[], options: ItemActionOptions): ItemActionPlan {
    const alert = validateItemAction({
      models,
      availableMp: options.availableMp,
      mode: options.mode ?? 'normal',
      hasSpecialItemCommand: options.hasSpecialItemCommand ?? false,
    });
    if (alert !== null) return {ok: false, alert};
    return {
      ok: true,
      models,
      itemIds: options.itemIds ?? models.map(model => model.id),
      mpCost: calculateMpCost(models),
      commandType: models[0]?.ability ?? null,
    };
  }

  planSelectedSlots(slots: readonly ItemSlot[], options: ItemActionOptions): ItemActionPlan {
    const models = slots.map(slot => slot.getItemModel(this.catalog));
    return this.planItemAction(models, {...options, itemIds: slots.map(slot => slot.id)});
  }

  incomingAttackContext(
    items: readonly ItemDefinition[],
    attackOverride = 0,
  ): IncomingAttackContext {
    return {items, hasAttackValue: hasAttackValue(items, attackOverride)};
  }
}

export function createCommandPayload(input: {
  itemIds?: readonly number[];
  mp?: number;
  cp?: number;
  targetPlayerId?: number;
  bought?: boolean;
}): Map<string, unknown> {
  const command = new Map<string, unknown>();
  if (input.itemIds && input.itemIds.length !== 0) command.set('itemIds', [...input.itemIds]);
  if (input.mp !== undefined) command.set('mp', input.mp);
  if (input.cp !== undefined) command.set('cp', input.cp);
  if (input.targetPlayerId !== undefined) command.set('targetPlayerId', input.targetPlayerId);
  if (input.bought !== undefined) command.set('bought', input.bought);
  return command;
}
