import { opacity, duration } from '../ui/theme';
import { AnimatedElement, runScheduledCallback } from '../ui/elements';
import { EasingEaseIn, GameModeDuel, CurseFog, CurseFlash, TeamSolo, Side, SideLeft, SideRight } from '../domain/enums';
import { GameState, ItemSlot } from '../domain/models';
import { assertPresent, indexError, invalidState, UNSET, uninitialized } from '../shared/values';
import { getApplication, state } from '../app/runtime';
import { RoomController } from '../rooms/room-controller';
import { TurnController } from './turn-controller';
import { CommandRules } from './command-rules';
import { createCombatCounterDetails } from './item-details';
import { createItemCommand, ItemActionPanel, ItemCommandOverlay } from './item-commands';
import { PlayerRoster } from './player-roster';
import type { PlayerStatusPanel } from './player-panels';
import { createAbandonGameDialog, resetGame } from './action-panels';
import { createRatingBadge } from './status-widgets';
import type { TiebreakBadge } from '../ui/stat-widgets';
import type { BattleBoard } from './board';
import type { BattleEffects } from './effects';
import { createMessageBar } from '../ui/panels';

export class GamePageController extends AnimatedElement<HTMLDivElement> {
  turnController: TurnController | typeof UNSET = UNSET;
  commandRules: CommandRules | typeof UNSET = UNSET;
  turnOverlay: AnimatedElement | null = null;
  resetButton: ReturnType<typeof createMessageBar> | null = null;
  ratingBadge: ReturnType<typeof createRatingBadge> | null = null;
  updateCount = 0;
  isOver = false;

  constructor(
    public turnMessage: AnimatedElement,
    public fogOverlay: AnimatedElement,
    public tiebreakBadge: TiebreakBadge,
    public board: BattleBoard,
    public effects: BattleEffects,
    public commandOverlay: ItemCommandOverlay,
    public playerRoster: PlayerRoster,
    public itemPanel: ItemActionPanel,
    element: HTMLDivElement,
  ) {
    super(element);
  }
  override dispose(_unused?: unknown): void {
    this.tiebreakBadge.dispose(0);
    this.commandOverlay.hideItemCommandOverlay();
    this.disposeElement(0);
  }
  applyUpdate(game: GameState): void {
    const updateCount = game.updateCount;
    if (updateCount < this.updateCount) return;
    const stats = this.playerRoster, players = game.players;
    stats.updatePlayerStats(players);
    if (updateCount === this.updateCount) return;
    const application = getApplication(), isOver = game.isOver;
    if (isOver && application.mode === GameModeDuel) stats.renderStatGain(players);
    if (!application.isRestoringRoom) {
      if (updateCount === this.updateCount + 1 && game.events.length !== 0) {
        this.updateCount = updateCount;
        const events = this.turnController;
        if (events === UNSET) uninitialized('eventHandler');
        void events.enqueueTurnEvent(game.events);
        return;
      }
      if (this.updateCount > 0) {
        window.location.reload();
        return;
      }
    }
    this.updateCount = updateCount;
    this.tiebreakBadge.updateTiebreak(game.gf);
    application.header.domElement.append(this.tiebreakBadge.domElement);
    if (this.tiebreakBadge.isTiebreakComplete()) this.turnMessage.domElement.style.visibility = '';
    const count = players.length;
    for (const player of players) {
      stats.requirePlayer(player.id).updatePlayerStatus(player);
      if (players.length !== count) invalidState(players);
    }
    this.domElement.append(stats.domElement);
    this.domElement.append(this.itemPanel.domElement);
    const self = stats.findPlayerStatById(getApplication().userId);
    if (self !== null) {
      if (self.curseIcons.has(CurseFog) && !self.dead && !isOver) {
        this.fogOverlay.setOpacity(opacity.visible);
        const visible = stats.getAlivePlayerStats(), length = visible.length, team = self.team;
        for (const player of visible) {
          if (player.team === TeamSolo && player !== self || player.team !== team) player.setCurrentTurnHighlight(true);
          if (visible.length !== length) invalidState(visible);
        }
      }
      const player = players.find(player => player.id === self.playerId);
      if (!player) throw new Error('No element');
      this.itemPanel.replaceItemSlots(player.items);
      this.itemPanel.repositionItemSlots();
    }
    if (isOver) {
      this.showGameEnding();
      return;
    }
    const board = this.board, attack = game.attack;
    board.clearBattleBoard(0);
    if (attack === null) { board.setPlayerBoardBadgeWithoutAnimation(board.isReversed ? SideRight : SideLeft, stats.requirePlayer(game.attackTurnPlayerId)); }
    else {
      board.renderAttackModifiers(attack, stats.requirePlayer(attack.playerId));
      if (attack.targetPlayerId > 0) {
        this.resolveActiveTarget(stats.requirePlayer(attack.targetPlayerId));
        const boughtId = attack.buyingItemModelId;
        if (boughtId > 0) {
          const side = board.isReversed ? SideLeft : SideRight;
          board.addPlayerSideItemWithoutAnimation(side, null);
          const index = boughtId - 1;
          if (!(index < state.itemModels.length)) return indexError(state.itemModels, index);
          board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(state.itemModels[index], 0, false, 0, null, false, 0, 0));
          board.animatePlayerSideItemsDefault(side);
        }
      }
    }
    this.renderCurrentCommand();
  }
  async showTurnMessage(isOpening: boolean): Promise<null> {
    this.turnMessage.domElement.style.visibility = '';
    await this.turnMessage.animateCircleClip(EasingEaseIn, isOpening ? duration.normal : duration.message, 640);
    return null;
  }
  hideTurnMessage(): Promise<null> { return this.showTurnMessage(false); }
  async animateTransition(isFog: boolean): Promise<null> {
    if (isFog) {
      await this.fogOverlay.fadeIn(duration.normal, EasingEaseIn);
    } else {
      await this.fogOverlay.fadeOut(duration.normal, EasingEaseIn);
    }
    return null;
  }
  getCurrentTurnPlayer(): PlayerStatusPanel | null {
    const board = this.board, active = board.isReversed ? SideRight : SideLeft;
    return board.findPlayer(active === SideLeft ? SideRight : SideLeft) ?? board.findPlayer(active);
  }
  getPlayerSide(player: PlayerStatusPanel | null): Side | null {
    const board = this.board, active = board.isReversed ? SideRight : SideLeft, opposite = active === SideLeft ? SideRight : SideLeft;
    if (player === board.findPlayer(opposite)) return opposite;
    if (player === board.findPlayer(active)) return active;
    return null;
  }
  resolveActiveTarget(player: PlayerStatusPanel): void {
    const board = this.board, active = board.isReversed ? SideRight : SideLeft;
    if (player === board.findPlayer(active)) board.setTargetDirectionIndicator(active);
    else {
      const opposite = active === SideLeft ? SideRight : SideLeft;
      board.setPlayerBoardBadgeWithoutAnimation(opposite, player);
      board.setTargetDirectionIndicator(opposite);
    }
  }
  renderCurrentCommand(): void {
    const board = this.board, active = board.isReversed ? SideRight : SideLeft, opposite = active === SideLeft ? SideRight : SideLeft;
    let turnPlayer: PlayerStatusPanel | null;
    if (board.findPlayer(opposite) === null) turnPlayer = board.findPlayer(active);
    else if (board.getPlayerSideItemList(opposite).length === 0) {
      turnPlayer = board.findPlayer(opposite);
      assertPresent(turnPlayer);
      if (turnPlayer.curseIcons.has(CurseFlash) && turnPlayer.turnHighlight === null) board.renderFlashEffect(opposite);
    } else turnPlayer = board.findPlayer(active);
    assertPresent(turnPlayer);
    const application = getApplication();
    if (turnPlayer !== this.playerRoster.findPlayerStatById(application.userId)) {
      this.commandOverlay.showItemCommandOverlayForSlot(turnPlayer);
      return;
    }
    this.commandOverlay.showItemCommandOverlay();
    if (board.findPlayer(opposite) === null) {
      const command = this.requiredCommandRules;
      command.selectedItems.length = 0;
      command.isDefending = false;
      command.setItemActionControl(command.page.board.isReversed ? SideRight : SideLeft);
      command.renderCommandPanels();
      const room = application.dialog instanceof RoomController ? application.dialog : null;
      assertPresent(room);
      assertPresent(room.gamePage);
      const item = createItemCommand(new ItemSlot(0, room.gamePage.tiebreakBadge.isTiebreakComplete() ? 2 : 1, 0, false));
      item.domElement.style.left = '656px';
      this.itemPanel.selectedItemCommand = item;
      this.itemPanel.domElement.append(item.domElement);
      this.itemPanel.renderSelectedCommand();
      const players = this.playerRoster.getAlivePlayerStats(), length = players.length;
      for (const player of players) {
        player.setPlayerSelectionHighlight(true);
        if (players.length !== length) invalidState(players);
      }
    } else if (board.getPlayerSideItemList(opposite).length === 0) {
      const command = this.requiredCommandRules;
      command.selectedItems.length = 0;
      command.isDefending = true;
      command.setItemActionControl(command.page.board.isReversed ? SideLeft : SideRight);
      command.renderCommandPanels();
      this.itemPanel.renderSelectedCommand();
    } else {
      board.renderGuardianArtwork(null);
      board.clearPlayerSideItems(active);
      this.requiredCommandRules.setPlayerTargetControl(active);
    }
  }
  private get requiredCommandRules(): CommandRules {
    const command = this.commandRules;
    if (command === UNSET) uninitialized('command');
    return command;
  }
  showTurnOverlay(overlay: AnimatedElement): void {
    this.turnOverlay?.dispose(0);
    this.turnOverlay = overlay;
    overlay.domElement.style.left = '770px';
    overlay.domElement.style.top = '420px';
    this.domElement.append(overlay.domElement);
  }
  showReconnectPromptIfNeeded(): boolean {
    if (!this.isOver) {
      const application = getApplication(), self = this.playerRoster.findPlayerStatById(application.userId);
      if (self !== null && !self.dead) {
        application.createHomeDimmer(createAbandonGameDialog());
        return true;
      }
    }
    return false;
  }
  showGameEnding(): void {
    this.isOver = true;
    this.board.renderGameEnding();
    this.showResetGameConfirmation();
  }
  showResetGameConfirmation(): void {
    const application = getApplication(), room = application.dialog instanceof RoomController ? application.dialog : null;
    assertPresent(room);
    if (application.mode === GameModeDuel) {
      if (this.ratingBadge !== null) return;
      const rating = createRatingBadge();
      rating.setPosition(100, 340);
      this.ratingBadge = rating;
      this.domElement.append(rating.domElement);
    } else {
      if (application.userId !== (room.users.length === 0 ? null : room.users[0].userId)) return;
      if (this.resetButton === null) {
        const reset = createMessageBar(state.translations.getGameText('resetGame'), false);
        reset.setPosition(100, 340);
        reset.setActionHandler(resetGame(room));
        this.resetButton = reset;
        this.domElement.append(reset.domElement);
      }
    }
  }
}
