import {surfaceSize, radius, duration} from '../ui/theme';
import {colors} from '../ui/palette';
import {TARGET_ARROW} from '../ui/icons';
import { AnimatedElement, ImageElement, createImageContainer, runScheduledCallback } from '../ui/elements';
import { applySurface, appendLabel } from '../ui/components';
import { BattleFooter, TurnSideMarker, BattleOverlay, ItemAnimationLayer } from '../ui/decorative';
import { Side, SideLeft, SideRight, Guardian, EasingEaseOut, CategoryArmor } from '../domain/enums';
import { AttackCommand, ItemDefinition } from '../domain/models';
import { getApplication, state } from '../app/runtime';
import { RoomController } from '../rooms/room-controller';
import { PlayerBadge, ItemDetailSlot, createPlayerBadge, createItemDetailSlot } from './item-slots';
import { CounterState, createCombatCounterDetails } from './item-details';
import { findRequired } from '../shared/collections';
import { createGuardianArtwork } from '../ui/assets';
import { indexError } from '../shared/values';
import { AttackPreviewPanel, ForgiveCommandPanel, createAttackPreviewPanel } from './action-panels';
import type { PlayerStatusPanel } from './player-panels';
export function calculateItemSlotPosition(side: Side): number {
  return side.index === 0 ? 20 : 360;
}
export function calculateItemSlotOffset(count: number, index: number): number {
  return count <= 3 ? index * 100 : Math.trunc(index * 200 / (count - 1));
}
function getGamePage() {
  const room = getApplication().dialog;
  if (!(room instanceof RoomController) || room.gamePage === null) throw new Error('No active battle');
  return room.gamePage;
}
export class BattleBoard extends AnimatedElement<HTMLDivElement> {
  attackOverlay: AnimatedElement | null = null;
  defenseOverlay: AnimatedElement | null = null;
  targetIndicator: BattleOverlay | null = null;
  guardianArtwork: ImageElement | null = null;
  currentEffect: ItemAnimationLayer | null = null;
  isReversed = false;
  isOver = false;
  constructor(public playerBadges: Map<Side, PlayerBadge>, public leftItems: ItemDetailSlot[], public rightItems: ItemDetailSlot[], public commandPanels: Map<Side, AttackPreviewPanel | ForgiveCommandPanel>, element: HTMLDivElement) {
    super(element);
  }
  renderGameEnding(): void {
    this.isOver = true;
    const game = getGamePage(),
      winners = game.playerRoster.getWinningPlayerStats(),
      draw = winners.length === 0,
      element = document.createElement('div'),
      panel = draw ? new TurnSideMarker(element) : new BattleFooter(element);
    panel.applySurface({
      ...surfaceSize.endingBanner, left: 20, top: draw ? 150 : 60, radius: radius.panel,
      background: draw ? colors.purpleBright : colors.hotPink,
      border: game.tiebreakBadge.isTiebreakComplete() ? {width: 2, color: colors.ink} : undefined
    });
    panel.appendLabel({
      text: state.translations.getGameText(draw ? 'endingDraw' : 'endingWin'),
      height: 100, left: 10, top: null, width: 620,
      size: 60, color: draw ? colors.lavender : colors.roseWhisper, bold: true, fit: true
    });
    this.domElement.append(element);
    if (!draw) for (const [index, player] of winners.entries()) {
      const badge = createPlayerBadge(player, false);
      badge.domElement.style.left = '200px';
      badge.domElement.style.top = `${190 + index * 35}px`;
      this.domElement.append(badge.domElement);
    }
  }
  findPlayer(side: Side): PlayerStatusPanel | null {
    return this.playerBadges.get(side)?.player ?? null;
  }
  get currentSide(): Side {
    return this.isReversed ? SideRight : SideLeft;
  }
  get oppositeSide(): Side {
    return this.isReversed ? SideLeft : SideRight;
  }
  get responseSide(): Side {
    return this.findPlayer(this.oppositeSide) === null ? this.currentSide : this.oppositeSide;
  }
  setPlayerBoardBadge(side: Side, player: PlayerStatusPanel | null, hidden: boolean): void {
    this.playerBadges.get(side)?.dispose(0);
    this.playerBadges.delete(side);
    if (player !== null) {
      const badge = createPlayerBadge(player, hidden);
      badge.domElement.style.left = `${side.index === 0 ? 30 : 370}px`;
      badge.domElement.style.top = '15px';
      this.domElement.append(badge.domElement);
      this.playerBadges.set(side, badge);
    }
  }
  setPlayerBoardBadgeWithoutAnimation(side: Side, player: PlayerStatusPanel | null): void {
    this.setPlayerBoardBadge(side, player, false);
  }
  setTargetDirectionIndicator(side: Side | null): void {
    this.targetIndicator?.dispose(0);
    this.targetIndicator = null;
    if (side === null) return;
    const element = document.createElement('div'),
      overlay = new BattleOverlay(element);
    overlay.applySurface({...surfaceSize.targetIndicator, left: 310});
    const arrow = createImageContainer(TARGET_ARROW, 60, null, null, 60),
      game = getGamePage();
    arrow.domElement.style.color = game.tiebreakBadge.isTiebreakComplete() && game.fogOverlay.getOpacity() !== 1 ? colors.ink : colors.hotPink;
    if (side === SideLeft) arrow.rotateElement(180);
    element.append(arrow.domElement);
    this.targetIndicator = overlay;
    this.domElement.append(element);
  }
  renderGuardianArtwork(guardian: Guardian | null): void {
    this.guardianArtwork?.dispose(0);
    this.guardianArtwork = null;
    if (guardian === null) return;
    const image = createGuardianArtwork(guardian, 'large');
    image.setPosition(20, 55);
    this.guardianArtwork = image;
    this.domElement.append(image.domElement);
  }
  renderFlashEffect(side: Side): void {
    this.clearCurrentBoardEffect();
    const element = document.createElement('div'),
      effect = new ItemAnimationLayer(element);
    effect.applySurface({...surfaceSize.flashEffect, top: 160, radius: radius.medium, background: colors.yellow});
    effect.appendLabel({
      text: state.translations.getGameText('flash'),
      height: 100, left: 20, top: 45, width: 260,
      size: 70, color: colors.cream, bold: true, fit: true
    });
    element.style.left = `${side.index === 0 ? 20 : 360}px`;
    this.currentEffect = effect;
    this.domElement.append(element);
  }
  clearCurrentBoardEffect(): void {
    this.currentEffect?.dispose(0);
    this.currentEffect = null;
  }
  getPlayerSideItemList(side: Side | null): ItemDetailSlot[] {
    switch (side!.index) {
      case 0:
        return this.leftItems;
      case 1:
        return this.rightItems;
      default:
        throw new TypeError('Unknown side');
    }
  }
  getPlayerSideItemAtIndex(side: Side): ItemDetailSlot {
    return findRequired(this.getPlayerSideItemList(side), slot => slot.itemWidget !== null);
  }
  addPlayerSideItem(side: Side, details: CounterState | null, hidden: boolean): void {
    const slots = this.getPlayerSideItemList(side),
      slot = createItemDetailSlot(details, hidden);
    slot.setPosition(calculateItemSlotPosition(side), 60 + calculateItemSlotOffset(slots.length + 1, slots.length));
    this.domElement.append(slot.domElement);
    slots.push(slot);
  }
  addPlayerSideItemWithoutAnimation(side: Side, details: CounterState | null): void {
    this.addPlayerSideItem(side, details, false);
  }
  animatePlayerSideItems(side: Side | null, duration: number): void {
    const slots = this.getPlayerSideItemList(side);
    for (const [index, slot] of slots.entries()) {
      const left = calculateItemSlotPosition(side!),
        top = 60 + calculateItemSlotOffset(slots.length, index);
      if (slot.getLeft() !== left || slot.getTop() !== top) runScheduledCallback(slot.translateElement(duration, EasingEaseOut, left, top));
    }
  }
  animatePlayerSideItemsDefault(side: Side | null): void {
    this.animatePlayerSideItems(side, 500);
  }
  getPlayerSideGuardianList(side: Side): ItemDefinition[] {
    return this.getPlayerSideItemList(side).flatMap(slot => slot.itemWidget === null ? [] : [slot.itemWidget.model]);
  }
  hasPrimaryPlayerGuardian(): boolean {
    return this.leftItems.length !== 0 && this.leftItems[0]!.placeholderWidget !== null;
  }
  async resolveGuardianTurnEffect(side: Side): Promise<void> {
    this.renderGuardianArtwork(null);
    this.clearCurrentBoardEffect();
    const active = this.getPlayerSideItemList(side),
      opposite = side === SideLeft ? SideRight : SideLeft,
      opposing = this.getPlayerSideItemList(opposite);
    while (opposing.length !== 0 && opposing.at(-1)!.itemWidget!.model.ability !== 'filterAtkElement') opposing.pop()!.dispose();
    active.push(...opposing);
    opposing.length = 0;
    opposing.push(...active.filter(slot => slot.itemWidget !== null));
    active.length = 0;
    this.animatePlayerSideItems(opposite, 750);
    await this.animateAsync(duration.slow);
    this.isReversed = !this.isReversed;
  }
  clearPlayerSideItems(side: Side): void {
    const slots = this.getPlayerSideItemList(side);
    for (const slot of slots) slot.dispose(0);
    slots.length = 0;
  }
  getGuardianForCurrentPlayer(): AttackPreviewPanel {
    for (const overlay of this.commandPanels.values()) if (overlay instanceof AttackPreviewPanel) return overlay;
    throw new TypeError();
  }
  setPlayerSideOverlay(side: Side, overlay: AttackPreviewPanel | ForgiveCommandPanel | null): void {
    this.commandPanels.get(side)?.dispose(0);
    this.commandPanels.delete(side);
    if (overlay === null) return;
    overlay.domElement.style.left = `${side.index === 0 ? 40 : 380}px`;
    overlay.domElement.style.top = '365px';
    this.domElement.append(overlay.domElement);
    this.commandPanels.set(side, overlay);
  }
  renderAttackModifiers(command: AttackCommand, player: PlayerStatusPanel | null): void {
    this.clearBattleBoard(0);
    this.isReversed = command.reversed;
    const side = command.reversed ? SideRight : SideLeft;
    this.setPlayerBoardBadgeWithoutAnimation(side, player);
    this.renderGuardianArtwork(command.guardian);
    if (command.guardian !== null) {
      this.addPlayerSideItemWithoutAnimation(side, null);
      if (command.itemModelIds.length === 1) this.addPlayerSideItemWithoutAnimation(side, null);
    }
    const definitions: ItemDefinition[] = [];
    for (const id of command.itemModelIds) {
      const index = id - 1;
      if (!(index >= 0 && index < state.itemModels.length)) indexError(state.itemModels, index);
      const model = state.itemModels[index];
      let details: CounterState;
      switch (model.ability) {
        case 'atkBy2xMP':
          details = createCombatCounterDetails(model, command.attack, true, 0, null, false, 0, 0);
          break;
        case 'attackDyingly':
          details = createCombatCounterDetails(model, command.attack, false, 0, null, false, command.hitRate, 0);
          break;
        case 'counterAtk':
        case 'counter2xAtk':
          details = createCombatCounterDetails(model, command.attack, false, 0, null, false, 0, 0);
          break;
        case 'counterBoost2xMP':
          details = createCombatCounterDetails(model, 0, false, 0, null, false, 0, command.mp);
          break;
        case 'counterTakeCP':
          details = createCombatCounterDetails(model, 0, false, command.cp, null, false, 0, 0);
          break;
        case 'counterCurse':
          details = createCombatCounterDetails(model, 0, false, 0, model.curse, false, 0, 0);
          break;
        default:
          details = createCombatCounterDetails(model, 0, false, 0, null, false, 0, 0);
      }
      this.addPlayerSideItemWithoutAnimation(side, details);
      definitions.push(model);
    }
    this.animatePlayerSideItems(side, 0);
    this.setPlayerSideOverlay(side, createAttackPreviewPanel(definitions, false, command.attack, command.hitRate));
  }
  clearBattleBoard(_duration: number): void {
    this.attackOverlay?.dispose(0);
    this.attackOverlay = null;
    this.defenseOverlay?.dispose(0);
    this.defenseOverlay = null;
    this.setTargetDirectionIndicator(null);
    this.renderGuardianArtwork(null);
    this.clearCurrentBoardEffect();
    for (const side of [SideLeft, SideRight]) {
      this.setPlayerBoardBadgeWithoutAnimation(side, null);
      this.clearPlayerSideItems(side);
      this.setPlayerSideOverlay(side, null);
    }
    this.isReversed = false;
  }
}
