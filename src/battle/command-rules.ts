import { roomAction } from '../services/protocol';
import { submitItemActionCommand } from './submit-command';
import { createTrainingStatControls } from './training-stat-controls';
import { calculateMpCost } from '../engine/calculations';
import {
  canApplyCommand as canApplyModelCommand,
  getCommandDiscardMode as getModelDiscardMode,
  isDiscardOrSaleCommand as isDiscardOrSaleModelCommand,
  type CommandSelectionContext,
} from '../engine/validation';
import { GamePageController } from './game-page';
import { Side, SideLeft, SideRight, CategoryArmor, CategoryMiracles, CategoryWeapons, CurseFlash, CurseFog } from '../domain/enums';
import { ItemDefinition } from '../domain/models';
import { getApplication } from '../app/runtime';
import { RoomController } from '../rooms/room-controller';
import { first, last, removeAt } from '../shared/collections';
import { assertPresent, indexError, invalidState, randomIndex } from '../shared/values';
import { sounds, playSound } from '../services/audio';
import { runScheduledCallback } from '../ui/elements';
import { createCommandButton, createForgiveCommandPanel, createAttackPreviewPanel, createPurchaseConfirmationDialog, showCommandAlert } from './action-panels';
import { createCombatCounterDetails } from './item-details';
import type { ItemCommand } from './item-commands';
import type { PlayerStatusPanel } from './player-panels';

export const isAttackEveryEnemyCommand = (command: { ability: string }): boolean => command.ability === 'attackEveryEnemy';
const itemDefinitionOf = (item: ItemCommand): ItemDefinition => item.getItemModel();

export class CommandRules {
  submitButton: ReturnType<typeof createCommandButton> | null = null;
  exchangeControls: ReturnType<typeof createTrainingStatControls> | null = null;
  purchaseConfirmation: ReturnType<typeof createPurchaseConfirmationDialog> | null = null;
  targetPlayer: PlayerStatusPanel | null = null;
  isDefending = false;
  constructor(
    public page: GamePageController,
    public selectedItems: ItemCommand[],
  ) {}
  setItemActionControl(side: Side | null): void {
    this.submitButton?.dispose(0);
    this.submitButton = null;
    if (side === null) return;
    const button = createCommandButton(side);
    button.setActionHandler(submitItemActionCommand(this));
    this.submitButton = button;
    this.page.domElement.append(button.domElement);
  }
  setCommandTargetControl(player: PlayerStatusPanel | null): void {
    this.exchangeControls?.dispose(0);
    this.exchangeControls = null;
    if (player !== null) {
      const controls = createTrainingStatControls(player);
      this.exchangeControls = controls;
      this.page.domElement.append(controls.domElement);
    }
  }
  setPlayerTargetControl(side: Side | null): void {
    this.purchaseConfirmation?.dispose(0);
    this.purchaseConfirmation = null;
    if (side !== null) {
      const controls = createPurchaseConfirmationDialog(true, side);
      this.purchaseConfirmation = controls;
      this.page.domElement.append(controls.domElement);
    }
  }
  private selectionContext(item: ItemCommand): CommandSelectionContext {
    if (this.isDefending) {
      const attackPreview = this.page.board.getGuardianForCurrentPlayer();
      return {
        mode: 'defense',
        hasFlashCurse: this.page.playerRoster.findPlayerStatById(getApplication().userId)!.curseIcons.has(CurseFlash),
        incomingAttack: { items: attackPreview.items, hasAttackValue: attackPreview.hasAttackValue() },
      };
    }
    return { mode: 'normal', hasFlashCurse: false, candidateHasSelectionOverlay: item.selectionOverlay !== null };
  }
  getCommandDiscardMode(): boolean {
    return getModelDiscardMode(this.submitButton !== null, this.selectedItems.map(itemDefinitionOf));
  }
  isDiscardOrSaleCommand(item: ItemCommand): boolean {
    return isDiscardOrSaleModelCommand(this.selectedItems.map(itemDefinitionOf), itemDefinitionOf(item), this.selectionContext(item));
  }
  canApplyCommand(selected: ItemCommand[], item: ItemCommand): boolean {
    return canApplyModelCommand(selected.map(itemDefinitionOf), itemDefinitionOf(item), this.selectionContext(item));
  }
  selectExchangeItem(item: ItemCommand): void {
    const page = this.page, board = page.board, primary = board.isReversed ? SideRight : SideLeft, side = this.isDefending ? (primary === SideLeft ? SideRight : SideLeft) : primary, selected = this.selectedItems;
    while (!this.canApplyCommand(selected, item)) {
      if (selected.length === 0) return indexError(selected, -1);
      selected.pop()!.setItemCommandHighlight(false);
      const views = board.getPlayerSideItemList(side);
      if (views.length === 0) return indexError(views, -1);
      views.pop()!.dispose();
    }
    selected.push(item);
    item.setItemCommandHighlight(true);
    board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(itemDefinitionOf(item), 0, false, 0, null, item.fakeItemModel !== null, 0, 0));
    board.animatePlayerSideItemsDefault(side);
    this.renderCommandPanels();
    page.itemPanel.renderSelectedCommand();
    if (this.isDefending || selected.length !== 1) return;
    const self = page.playerRoster.findPlayerStatById(getApplication().userId);
    assertPresent(self);
    const initial = itemDefinitionOf(first(selected));
    this.setCommandTargetControl(initial.ability === 'exchange' ? self : null);
    if (initial.isDirectTargetCommand()) {
      if (this.targetPlayer === null || !this.targetPlayer.isOpponentStatusPanel(self)) {
        const opponents = page.playerRoster.getOpponentPlayerStats(self), index = randomIndex(opponents.length);
        if (!(index >= 0 && index < opponents.length)) return indexError(opponents, index);
        this.resolveActiveTarget(opponents[index]);
      }
    } else if (this.targetPlayer !== null && this.targetPlayer.isOpponentStatusPanel(self)) this.resolveActiveTarget(null);
  }
  updateSelectedItemCommand(item: ItemCommand): void {
    const selected = this.selectedItems, index = selected.indexOf(item), page = this.page, board = page.board, primary = board.isReversed ? SideRight : SideLeft, side = this.isDefending ? (primary === SideLeft ? SideRight : SideLeft) : primary;
    if (!this.isDefending && index === 0) {
      while (selected.length !== 0) {
        selected.pop()!.setItemCommandHighlight(false);
        const views = board.getPlayerSideItemList(side);
        if (views.length === 0) return indexError(views, -1);
        views.pop()!.dispose();
      }
    } else {
      const retained: ItemCommand[] = [], count = selected.length;
      for (const candidate of selected) {
        if (candidate !== item && this.canApplyCommand(retained, candidate)) retained.push(candidate);
        if (selected.length !== count) invalidState(selected);
      }
      for (let position = selected.length - 1; position >= index; position--) {
        if (!(position >= 0 && position < selected.length)) return indexError(selected, position);
        if (!retained.includes(selected[position])) {
          removeAt(selected, position).setItemCommandHighlight(false);
          removeAt(board.getPlayerSideItemList(side), position).dispose(0);
        }
      }
    }
    board.animatePlayerSideItemsDefault(side);
    this.renderCommandPanels();
    page.itemPanel.renderSelectedCommand();
    if (selected.length === 0) this.setCommandTargetControl(null);
  }
  renderCommandPanels(): void {
    const page = this.page, board = page.board, primary = board.isReversed ? SideRight : SideLeft;
    if (this.isDefending) {
      const attacks = board.getPlayerSideGuardianList(primary), mp = board.getGuardianForCurrentPlayer().attackOverride, cp = board.getGuardianForCurrentPlayer().hitRateOverride;
      const filtered = this.selectedItems.length !== 0 && itemDefinitionOf(first(this.selectedItems)).ability === 'filterAtkElement';
      board.setPlayerSideOverlay(primary, createAttackPreviewPanel(attacks, filtered, mp, cp));
      const opposite = primary === SideLeft ? SideRight : SideLeft;
      board.setPlayerSideOverlay(opposite, createForgiveCommandPanel(board.getPlayerSideGuardianList(opposite)));
    } else {
      const attacks = board.getPlayerSideGuardianList(primary);
      let damage = 0;
      if (attacks.length !== 0 && first(attacks).ability === 'atkBy2xMP') {
        const remaining = page.playerRoster.findPlayerStatById(getApplication().userId)!.mp - calculateMpCost(attacks);
        damage = remaining > 0 ? 2 * remaining : 0;
      }
      board.setPlayerSideOverlay(primary, createAttackPreviewPanel(attacks, false, damage, 0));
    }
  }
  resolveActiveTarget(player: PlayerStatusPanel | null): void {
    if (this.targetPlayer === player) return;
    const page = this.page, self = page.playerRoster.findPlayerStatById(getApplication().userId)!;
    if (self.curseIcons.has(CurseFog) && player !== null && player.isOpponentStatusPanel(self) && page.playerRoster.getOpponentPlayerStats(self).length >= 2) {
      playSound(sounds.fog);
    } else {
      playSound(sounds.targetPlayer);
    }
    this.targetPlayer = player;
    const board = page.board, primary = board.isReversed ? SideRight : SideLeft, opposite = primary === SideLeft ? SideRight : SideLeft;
    if (player === null) {
      board.setPlayerBoardBadgeWithoutAnimation(opposite, null);
      board.setTargetDirectionIndicator(null);
    }
    else if (player === self) {
      board.setPlayerBoardBadgeWithoutAnimation(opposite, null);
      board.setTargetDirectionIndicator(primary);
    }
    else {
      board.setPlayerBoardBadge(opposite, player, player.turnHighlight != null);
      board.setTargetDirectionIndicator(opposite);
    }
  }
  getCommandAlert(key: string): void {
    playSound(sounds.alert);
    runScheduledCallback(showCommandAlert(this, key)());
  }
  async submitCommand(bought: boolean): Promise<null> {
    const application = getApplication();
    this.setPlayerTargetControl(null);
    const room = application.dialog instanceof RoomController ? application.dialog : null;
    assertPresent(room);
    await room.updateRoomState(roomAction.submitCommand, true, new Map([['command', new Map([['bought', bought]])]]));
    return null;
  }
}
