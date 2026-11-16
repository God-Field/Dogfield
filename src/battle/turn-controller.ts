import {sounds, playSound} from '../services/audio';
import {radius, duration} from '../ui/theme';
import {colors} from '../ui/palette';
import { ItemSlot, BattleEvent, ItemDefinition } from "../domain/models";
import type {PlayerStatusPanel} from './player-panels';
import type {GamePageController} from './game-page';
import {createCombatCounterDetails} from './item-details';
import {createEmptyItemSlot} from './item-commands';
import {createForgiveCommandPanel, createAttackPreviewPanel} from './action-panels';
import {isAttackEveryEnemyCommand} from './command-rules';
import { assertPresent, indexError, invalidState } from "../shared/values";
import { appendAll, first, getValue, last, removeAt, removeEntry, removeValue, setValue } from "../shared/collections";
import { createElement, createTextElement, runScheduledCallback } from "../ui/elements";
import { getApplication, state } from "../app/runtime";
import { BattleBackdrop, BattleHeader } from "../ui/decorative";
import { CategoryArmor, CategoryDevils, CategoryMiracles, CurseDarkcloud, CurseDream, CurseFlash, CurseFog, Side, SideLeft, SideRight } from "../domain/enums";
import { calculateMpCost } from '../engine/calculations';
import { CONFUSION_TURNS } from '../domain/constants';
import {TurnActionQueue} from './turn-action-queue';

const fogGuardianAbilityExceptions: ReadonlySet<string> = new Set(['attackSomebody', 'danger']);

type TurnActionHandler = (controller: TurnController, action: BattleEvent) => unknown;

const turnActionHandlers: ReadonlyMap<string, TurnActionHandler> = new Map([
  ['startGame', (controller, action) => controller.handleStartGame(action)],
  ['gift', (controller, action) => controller.handleGift(action)],
  ['useDevilItem', (controller, action) => controller.handleUseDevilItem(action)],
  ['advanceGF', (controller, action) => controller.handleAdvanceGF(action)],
  ['attackByGuardian', (controller, action) => controller.handleAttackByGuardian(action)],
  ['useAttackItems', (controller, action) => controller.handleUseAttackItems(action)],
  ['pray', (controller, action) => controller.handlePray(action)],
  ['discard', (controller, action) => controller.handleDiscard(action)],
  ['sacrifice', (controller, action) => controller.handleSacrifice(action)],
  ['phenomenon', (controller, action) => controller.handlePhenomenon(action)],
  ['useDefenseItems', (controller, action) => controller.handleUseDefenseItems(action)],
  ['nextAttack', (controller, action) => controller.handleNextAttack(action)],
  ['setTargetPlayer', (controller, action) => controller.handleSetTargetPlayer(action)],
  ['hit', (controller, action) => controller.handleHit(action)],
  ['miss', (controller, action) => controller.handleMiss(action)],
  ['danger', (controller, action) => controller.handleDanger(action)],
  ['attractDanger', (controller, action) => controller.handleAttractDanger(action)],
  ['bounce', (controller, action) => controller.handleBounce(action)],
  ['reflect', (controller, action) => controller.handleReflect(action)],
  ['block', (controller, action) => controller.handleBlock(action)],
  ['safe', (controller, action) => controller.handleSafe(action)],
  ['exchange', (controller, action) => controller.handleExchange(action)],
  ['sell', (controller, action) => controller.handleSell(action)],
  ['buy', (controller, action) => controller.handleBuy(action)],
  ['canNotBuy', (controller, action) => controller.handleCanNotBuy(action)],
  ['setBought', (controller, action) => controller.handleSetBought(action)],
  ['addItem', (controller, action) => controller.handleAddItem(action)],
  ['dealDamage', (controller, action) => controller.handleDealDamage(action)],
  ['dealDarkDamage', (controller, action) => controller.handleDealDarkDamage(action)],
  ['boostHP', (controller, action) => controller.handleBoostHP(action)],
  ['setHPOfEverybody', (controller, action) => controller.handleSetHPOfEverybody(action)],
  ['boostMP', (controller, action) => controller.handleBoostMP(action)],
  ['boostCP', (controller, action) => controller.handleBoostCP(action)],
  ['boostCPOfEverybody', (controller, action) => controller.handleBoostCPOfEverybody(action)],
  ['collectCPOfEverybody', (controller, action) => controller.handleCollectCPOfEverybody(action)],
  ['takeCP', (controller, action) => controller.handleTakeCP(action)],
  ['addCurse', (controller, action) => controller.handleAddCurse(action)],
  ['setCurseOfEverybody', (controller, action) => controller.handleSetCurseOfEverybody(action)],
  ['disease', (controller, action) => controller.handleDisease(action)],
  ['upgradeDisease', (controller, action) => controller.handleUpgradeDisease(action)],
  ['upgradeHeaven', (controller, action) => controller.handleUpgradeHeaven(action)],
  ['removeCurses', (controller, action) => controller.handleRemoveCurses(action)],
  ['confuseEverybody', (controller, action) => controller.handleConfuseEverybody(action)],
  ['setGuardian', (controller, action) => controller.handleSetGuardian(action)],
  ['setGuardianOfEverybody', (controller, action) => controller.handleSetGuardianOfEverybody(action)],
  ['removeGuardian', (controller, action) => controller.handleRemoveGuardian(action)],
  ['removeItems', (controller, action) => controller.handleRemoveItems(action)],
  ['removeUsedMiracles', (controller, action) => controller.handleRemoveUsedMiracles(action)],
  ['removeSomething', (controller, action) => controller.handleRemoveSomething(action)],
  ['redraw', (controller, action) => controller.handleRedraw(action)],
  ['replaceItems', (controller, action) => controller.handleReplaceItems(action)],
  ['selfCurse', (controller, action) => controller.handleSelfCurse(action)],
  ['counterAttack', (controller, action) => controller.handleCounterAttack(action)],
  ['revive', (controller, action) => controller.handleRevive(action)],
  ['die', (controller, action) => controller.handleDie(action)],
  ['attackDyingly', (controller, action) => controller.handleAttackDyingly(action)],
  ['endGame', (controller, action) => controller.handleEndGame(action)],
]);

export class TurnController {
  private readonly actionQueue: TurnActionQueue<BattleEvent>;

  constructor(
    public page: GamePageController,
    public pendingActions: BattleEvent[],
  ) {
    this.actionQueue = new TurnActionQueue(
      pendingActions,
      () => this.page.commandOverlay.hideItemCommandOverlay(),
      action => this.dispatchTurnAction(action),
      () => this.page.renderCurrentCommand(),
      () => this.page.isOver,
    );
  }

  get isProcessing(): boolean {
    return this.actionQueue.isProcessing;
  }

  enqueueTurnEvent(input: BattleEvent[]) {
    return this.processTurnActionQueue(input);
  }
  processTurnActionQueue(actions: BattleEvent[]): Promise<unknown> {
    return this.actionQueue.enqueue(actions);
  }
  async dispatchTurnAction(action: BattleEvent) {
    const handler = turnActionHandlers.get(action.action);
    if (handler) {
      return handler(this, action);
    }
    return undefined;
  }
  async handleStartGame(action: BattleEvent) {
    let page = this.page;
    await page.animateAsync(duration.normal);
    playSound(sounds.startGame);
    let tiebreak = page.tiebreakBadge;
    tiebreak.updateTiebreak(0);
    let application = getApplication();
    application.header.domElement.append(tiebreak.domElement);
    let board = page.board;
    let backdropElement = globalThis.document.createElement("div");
    let backdrop = new BattleBackdrop(backdropElement);
    backdrop.applyElementStyles(backdropElement, 200, 20, 110, 640);
    backdrop.setBorderRadius(radius.panel);
    backdrop.setBackgroundColor(colors.brand);
    let backdropWidth = backdrop.getWidth();
    let label = createTextElement("", backdrop.getHeight(), null, 30, backdropWidth);
    let labelElement = label.domElement;
    labelElement.style.lineHeight = "75px";
    labelElement.innerHTML = state.translations.getGameText("opening");
    label.applyTextStyle(48, colors.mintLight, true);
    backdropElement.append(labelElement);
    board.attackOverlay = backdrop;
    board.domElement.append(backdropElement);
    let playerStats = page.playerRoster;
    if (playerStats.findPlayerStatById(application.userId) != null) {
      page.itemPanel.populateEmptyItemSlots();
    }
    let pageElement = page.domElement;
    pageElement.append(playerStats.domElement);
    pageElement.append(page.itemPanel.domElement);
    await page.animateAsync(duration.display);
    return;
  }
  async handleGift(action: BattleEvent) {
    let page = this.page;
    let playerStats = page.playerRoster;
    if (playerStats.requirePlayer(action.playerId) === playerStats.findPlayerStatById(getApplication().userId)) {
      let slot = action.item;
      assertPresent(slot);
      let itemPanel = page.itemPanel;
      await itemPanel.findEmptyItemSlot().showItemCommandDetails(slot);
      if (!itemPanel.hasUninitializedItemSlot() && slot.getItemModel().category !== CategoryDevils) {
        itemPanel.resetItemArrangement(0);
      }
    }
    return;
  }
  async handleUseDevilItem(action: BattleEvent) {
    let page = this.page;
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    let slot = action.item;
    assertPresent(slot);
    let board = page.board;
    board.clearBattleBoard(0);
    await page.animateAsync(duration.normal);
    let delay = 0;
    switch (slot.getItemModel().ability) {
      case "dealDamage":
        switch (slot.getItemModel().abilityValue) {
          case 10:
            playSound(sounds.devilToDealDamage1);
            delay = 750;
            break;
          case 20:
            playSound(sounds.devilToDealDamage2);
            delay = 1000;
            break;
          case 30:
            playSound(sounds.devilToDealDamage3);
            delay = 1250;
            break;
        }
        break;
      case "removeSomething":
        playSound(sounds.devilToRemoveSomething);
        delay = duration.display;
        break;
      case "boostSomething":
        playSound(sounds.devilToBoostSomething);
        delay = duration.display;
        break;
    }
    board.setPlayerBoardBadgeWithoutAnimation(SideRight, player);
    board.addPlayerSideItemWithoutAnimation(SideRight, createCombatCounterDetails(slot.getItemModel(), 0, false, 0, null, false, 0, 0));
    board.animatePlayerSideItemsDefault(SideRight);
    let application = getApplication();
    if (player === playerStats.findPlayerStatById(application.userId)) {
      page.itemPanel.getItemAtSlot(slot.id).setItemCommandHighlight(true);
    }
    await page.animateAsync(delay);
    if (player === playerStats.findPlayerStatById(application.userId)) {
      page.itemPanel.renderItemCommandSelection(slot.id);
    }
    return;
  }
  async handleAdvanceGF(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    board.clearBattleBoard(0);
    let tiebreak = page.tiebreakBadge;
    if (tiebreak.currentCount === 0 && tiebreak.maxCount === 1) {
      await page.showTurnMessage(true);
    } else {
      await page.animateAsync(duration.normal);
    }
    tiebreak.updateTiebreak(tiebreak.currentCount + 1);
    let maxCount = tiebreak.maxCount;
    if (tiebreak.currentCount === maxCount && maxCount !== 1) {
      playSound(sounds.tiebreak);
      let headerElement = globalThis.document.createElement("div");
      let header = new BattleHeader(headerElement);
      header.applyElementStyles(headerElement, 150, 20, 135, 640);
      header.setBorderRadius(radius.panel);
      header.setBackgroundColor(colors.ink);
      let texts = state.translations;
      let label = createTextElement(texts.getGameText("tiebreak"), 60, 10, 15, header.getWidth() - 20);
      label.applyTextStyle(48, colors.orangeDark, true);
      label.fitFontSize();
      headerElement.append(label.domElement);
      const tiebreakBody = createTextElement(texts.getGameText("tiebreakBody"), 60, 10, 75, header.getWidth() - 20);
      tiebreakBody.applyTextStyle(48, colors.pinkLight, true);
      tiebreakBody.fitFontSize();
      headerElement.append(tiebreakBody.domElement);
      board.defenseOverlay = header;
      board.domElement.append(headerElement);
      await page.hideTurnMessage();
      await page.animateAsync(duration.normal);
      board.clearBattleBoard(0);
      await page.animateAsync(duration.normal);
    }
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    board.setPlayerBoardBadgeWithoutAnimation(board.currentSide, player);
    if (player.confusionCount > 0) {
      await page.effects.createConfusionEffect();
    } else {
      if (player !== playerStats.findPlayerStatById(getApplication().userId)) {
        playSound(sounds.turnPlayer);
      }
      if (player.isBot) {
        await page.animateAsync(duration.normal);
      }
    }
    return;
  }
  async handleAttackByGuardian(action: BattleEvent) {
    var modelIndex;
    var itemModelId;
    var itemModel;
    let page = this.page;
    let board = page.board;
    board.clearBattleBoard(0);
    await page.animateAsync(duration.normal);
    let side = board.currentSide;
    let attack = action.attack;
    let player = page.playerRoster.requirePlayer(attack!.playerId);
    board.setPlayerBoardBadgeWithoutAnimation(side, player);
    let guardian = attack!.guardian;
    assertPresent(guardian);
    await page.effects.createGuardianAttackEffect(guardian);
    let guardianIcon = player.guardianIcon;
    board.renderGuardianArtwork(guardianIcon == null ? null : guardianIcon.guardian);
    board.addPlayerSideItemWithoutAnimation(side, null);
    let itemModelIds = attack!.itemModelIds;
    if (itemModelIds.length === 1) {
      board.addPlayerSideItemWithoutAnimation(side, null);
    }
    let itemModels = [];
    let itemCount = itemModelIds.length;
    let itemIndex = 0;
    while (itemIndex < itemModelIds.length) {
      itemModelId = itemModelIds[itemIndex];
      playSound(sounds.selectItem);
      modelIndex = itemModelId - 1;
      if (!(modelIndex >= 0 && modelIndex < state.itemModels.length)) {
        indexError(state.itemModels, modelIndex);
        return;
      } else {
        itemModel = state.itemModels[modelIndex];
        itemModels.push(itemModel);
        board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(itemModel, 0, false, 0, null, false, 0, 0));
        board.animatePlayerSideItemsDefault(side);
        board.setPlayerSideOverlay(side, createAttackPreviewPanel(itemModels, false, 0, 0));
        await page.animateAsync(duration.normal);
        itemModelIds.length === itemCount || invalidState(itemModelIds);
        ++itemIndex;
        continue;
      }
    }
    if (first(itemModels).ability === "atkBy2xMP") {
      await this.resolveDoubleMpAttackEvent(itemModels, 2 * player.mp);
      player.setMp(0);
    }
    return;
  }
  async handleUseAttackItems(action: BattleEvent) {
    const page = this.page,
      board = page.board,
      side = board.currentSide,
      player = board.findPlayer(side);
    assertPresent(player);
    const isConfusedSelf = player === page.playerRoster.findPlayerStatById(getApplication().userId) && player.confusionCount > 0,
      slots = action.items;
    if (slots.length === 0) {
      playSound(sounds.useNoItems);
      board.setPlayerSideOverlay(side, createAttackPreviewPanel([], false, 0, 0));
      await page.animateAsync(duration.normal);
      if (isConfusedSelf) page.itemPanel.appendItemSlot(createEmptyItemSlot());
    } else {
      const initial = requireItemModelById(first(slots).modelId);
      const isHidden = board.findPlayer(side)!.turnHighlight != null && initial.category !== CategoryMiracles && ['exchange', 'boostHP', 'boostMP', 'boostCP', 'removeMildCurses', 'removeAllCurses', 'setGuardian'].includes(initial.ability);
      const definitions: ItemDefinition[] = [],
        count = slots.length,
        panel = page.itemPanel;
      for (const slot of slots) {
        playSound(sounds.selectItem);
        const isFake = slot.fakeModelId !== 0;
        definitions.push(slot.getItemModel());
        if (isHidden) {
          board.addPlayerSideItem(side, createCombatCounterDetails(slot.getItemModel(), 0, false, 0, null, isFake, 0, 0), true);
          board.animatePlayerSideItemsDefault(side);
          board.setPlayerSideOverlay(side, createAttackPreviewPanel(definitions, false, 0, 0));
        } else {
          board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(slot.getItemModel(), 0, false, 0, null, isFake, 0, 0));
          board.animatePlayerSideItemsDefault(side);
          board.setPlayerSideOverlay(side, createAttackPreviewPanel(definitions, false, 0, 0));
          if (isConfusedSelf) panel.getItemAtSlot(slot.id).setItemCommandHighlight(true);
        }
        if (isFake) {
          await this.resolveDreamActionWithDefaults(side, slot);
          if (definitions.length === 0) return indexError(definitions, -1);
          definitions.pop();
          definitions.push(requireItemModelById(slot.modelId));
          board.setPlayerSideOverlay(side, createAttackPreviewPanel(definitions, false, 0, 0));
        }
        await page.animateAsync(duration.normal);
        if (slots.length !== count) invalidState(slots);
      }
      if (isHidden) await page.animateAsync(duration.normal);
      player.changeMpDisplay(-calculateMpCost(definitions));
      const ability = first(definitions).ability;
      if (ability === 'discard' || ability === 'sacrifice') {
        player.removeUsedMiracles(slots);
      } else if (ability !== 'sell') {
        player.addUsedMiracles(slots);
      }
      if (ability === 'atkBy2xMP') {
        await this.resolveDoubleMpAttackEvent(definitions, 2 * player.mp);
        player.setMp(0);
      }
      if (isConfusedSelf) {
        panel.clearItemActionControl();
        panel.renderItemCommandSelection(first(slots).id);
        panel.resetItemArrangement(0);
      }
    }
    const confusion = player.confusionCount;
    if (confusion > 0) player.setConfusionCounter(confusion - 1);
  }
  async handlePray(action: BattleEvent) {
    await this.page.effects.createPrayerEffect();
    await this.animateItemAcquisition(SideLeft, action.overflowItem, true);
    return;
  }
  async handleDiscard(action: BattleEvent) {
    var playerItems;
    let page = this.page;
    await page.animateAsync(duration.normal);
    let board = page.board;
    let side = board.currentSide;
    let guardianItems = Array.from(board.getPlayerSideGuardianList(side));
    setValue(guardianItems, 0, null);
    while (board.getPlayerSideItemList(side).length > 1) {
      playerItems = board.getPlayerSideItemList(side);
      if (0 >= playerItems.length) {
        indexError(playerItems, -1);
        return;
      }
      playerItems.pop()!.dispose();
    }
    await page.effects.createSacrificeOrRemovalEffect(guardianItems, false, side);
    return;
  }
  async handleSacrifice(action: BattleEvent) {
    var playerItems;
    let page = this.page;
    await page.animateAsync(duration.normal);
    let board = page.board;
    let side = board.currentSide;
    let guardianItems = Array.from(board.getPlayerSideGuardianList(side));
    setValue(guardianItems, 0, null);
    while (board.getPlayerSideItemList(side).length > 1) {
      playerItems = board.getPlayerSideItemList(side);
      if (0 >= playerItems.length) {
        indexError(playerItems, -1);
        return;
      }
      playerItems.pop()!.dispose();
    }
    await page.effects.createSacrificeOrRemovalEffect(guardianItems, true, side);
    return;
  }
  async handlePhenomenon(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let side = board.currentSide;
    await page.animateAsync(duration.message);
    playSound(sounds.phenomenon);
    let itemModelIndex = action.itemModelId - 1;
    if (!(itemModelIndex >= 0 && itemModelIndex < state.itemModels.length)) {
      indexError(state.itemModels, itemModelIndex);
    } else {
      let definition = state.itemModels[itemModelIndex];
      let guardianItems = board.getPlayerSideGuardianList(side);
      guardianItems.push(definition);
      if (board.guardianArtwork != null) {
        removeAt(board.getPlayerSideItemList(side), 0).dispose(0);
      }
      board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(definition, 0, false, 0, null, false, 0, 0));
      board.animatePlayerSideItemsDefault(side);
      board.setPlayerSideOverlay(side, createAttackPreviewPanel(guardianItems, false, 0, 0));
      await page.animateAsync(duration.message);
    }
    return;
  }
  async handleUseDefenseItems(action: BattleEvent) {
    const page = this.page,
      board = page.board,
      primary = board.currentSide,
      opposite = primary === SideLeft ? SideRight : SideLeft;
    const side = board.findPlayer(opposite) == null ? primary : opposite,
      slots = action.items;
    if (slots.length === 0) {
      playSound(sounds.useNoItems);
      board.setPlayerSideOverlay(board.findPlayer(opposite) == null ? primary : opposite, createForgiveCommandPanel([]));
      await page.animateAsync(duration.normal);
    } else {
      const attackItems = board.getPlayerSideGuardianList(primary),
        definitions: ItemDefinition[] = [],
        count = slots.length;
      for (const slot of slots) {
        playSound(sounds.selectItem);
        const isFake = slot.fakeModelId !== 0;
        board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(slot.getItemModel(), 0, false, 0, null, isFake, 0, 0));
        board.animatePlayerSideItemsDefault(side);
        if (slot.getItemModel().ability === 'filterAtkElement') {
          if (isFake) await this.resolveDreamActionWithDefaults(side, slot);
          board.setPlayerSideOverlay(board.currentSide, createAttackPreviewPanel(attackItems, true, board.getGuardianForCurrentPlayer().attackOverride, board.getGuardianForCurrentPlayer().hitRateOverride));
        } else {
          definitions.push(slot.getItemModel());
          board.setPlayerSideOverlay(side, createForgiveCommandPanel(definitions));
          if (isFake) {
            await this.resolveDreamActionWithDefaults(side, slot);
            if (definitions.length === 0) return indexError(definitions, -1);
            definitions.pop();
            definitions.push(requireItemModelById(slot.modelId));
            board.setPlayerSideOverlay(side, createForgiveCommandPanel(definitions));
          }
        }
        await page.animateAsync(duration.normal);
        if (slots.length !== count) invalidState(slots);
      }
      const player = page.getCurrentTurnPlayer();
      assertPresent(player);
      player.changeMpDisplay(-calculateMpCost(definitions));
      player.addUsedMiracles(slots);
    }
  }
  async handleNextAttack(action: BattleEvent) {
    let attack = action.attack;
    let page = this.page;
    page.board.renderAttackModifiers(attack!, page.playerRoster.requirePlayer(attack!.playerId));
    await page.animateAsync(duration.normal);
    return;
  }
  async handleSetTargetPlayer(action: BattleEvent) {
    let page = this.page;
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    page.resolveActiveTarget(player);
    let board = page.board;
    if (board.findPlayer(board.oppositeSide) != null) {
      let _playerSideItemList = board.getPlayerSideItemList(board.currentSide);
      let itemCount = _playerSideItemList.length;
      let itemIndex = 0;
      while (itemIndex < _playerSideItemList.length) {
        await _playerSideItemList[itemIndex].showItem();
        _playerSideItemList.length === itemCount || invalidState(_playerSideItemList);
        ++itemIndex;
        continue;
      }
    }
    let guardianItems = board.getPlayerSideGuardianList(board.currentSide);
    let targetPlayer = board.findPlayer(board.currentSide);
    if (targetPlayer!.turnHighlight == null && targetPlayer!.curseIcons.has(CurseFog) && board.guardianArtwork == null && player.isOpponentStatusPanel(targetPlayer!) && playerStats.getOpponentPlayerStats(targetPlayer).length >= 2 && first(guardianItems).category !== CategoryArmor && !fogGuardianAbilityExceptions.has(first(guardianItems).ability) && !guardianItems.some(isAttackEveryEnemyCommand)) {
      playSound(sounds.fog);
      let side = board.responseSide;
      await getValue(board.playerBadges, side)!.showItem();
    } else {
      if (board.findPlayer(board.oppositeSide) == null || player.dead || player !== playerStats.findPlayerStatById(getApplication().userId)) {
        playSound(sounds.targetPlayer);
      }
    }
    if (board.findPlayer(board.oppositeSide) == null) {
      await page.animateAsync(duration.normal);
    } else {
      await this.waitForAttackResponseEffect(player);
    }
    return;
  }
  async handleHit(action: BattleEvent) {
    const page = this.page,
      player = page.playerRoster.requirePlayer(action.playerId),
      self = page.playerRoster.findPlayerStatById(getApplication().userId);
    page.resolveActiveTarget(player);
    const darkCloud = player.curseIcons.has(CurseDarkcloud) && (self == null || self.dead || !self.curseIcons.has(CurseFog) || !player.isOpponentStatusPanel(self));
    if (darkCloud) {
      await page.effects.createDarkCloudEffect();
    } else {
      await page.effects.createHitEffect();
    }
    await this.waitForAttackResponseEffect(player);
  }
  async handleMiss(action: BattleEvent) {
    let page = this.page;
    page.resolveActiveTarget(page.playerRoster.requirePlayer(action.playerId));
    await page.effects.createMissEffect();
    return;
  }
  async handleDanger(action: BattleEvent) {
    await this.page.animateAsync(duration.message);
    return;
  }
  async handleAttractDanger(action: BattleEvent) {
    playSound(sounds.attractDanger);
    let slot = action.item;
    assertPresent(slot);
    let page = this.page;
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    page.resolveActiveTarget(player);
    let board = page.board;
    let side = board.responseSide;
    let isFakeItem = slot.fakeModelId !== 0;
    if (board.guardianArtwork != null && board.getPlayerSideItemList(side).length !== 0) {
      removeAt(board.getPlayerSideItemList(side), 0).dispose(0);
    }
    board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(slot.getItemModel(), 0, false, 0, null, isFakeItem, 0, 0));
    board.animatePlayerSideItemsDefault(side);
    let application = getApplication();
    if (player === playerStats.findPlayerStatById(application.userId)) {
      page.itemPanel.getItemAtSlot(slot.id).setItemCommandHighlight(true);
    }
    await page.animateAsync(duration.normal);
    if (isFakeItem) {
      await this.resolveDreamActionWithDefaults(side, slot);
    }
    await page.animateAsync(duration.normal);
    if (player === playerStats.findPlayerStatById(application.userId)) {
      let itemPanel = page.itemPanel;
      itemPanel.refreshItemCommandSelection();
      itemPanel.resetItemArrangement(0);
    }
    return;
  }
  async handleBounce(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let side = board.responseSide;
    await page.effects.createBounceEffect(side);
    let attackGuardian = board.getGuardianForCurrentPlayer();
    let hitRateGuardian = board.getGuardianForCurrentPlayer();
    board.setPlayerBoardBadgeWithoutAnimation(board.currentSide, null);
    board.setTargetDirectionIndicator(null);
    board.setPlayerSideOverlay(board.currentSide, null);
    await board.resolveGuardianTurnEffect(board.currentSide);
    let overlaySide = board.currentSide;
    board.setPlayerSideOverlay(overlaySide, createAttackPreviewPanel(board.getPlayerSideGuardianList(board.currentSide), false, attackGuardian.attackOverride, hitRateGuardian.hitRateOverride));
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    page.resolveActiveTarget(player);
    if (board.findPlayer(board.oppositeSide) == null || player !== playerStats.findPlayerStatById(getApplication().userId)) {
      playSound(sounds.targetPlayer);
    }
    if (board.findPlayer(board.oppositeSide) == null) {
      await page.animateAsync(duration.normal);
    } else {
      await this.waitForAttackResponseEffect(player);
    }
    return;
  }
  async handleReflect(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let side = board.responseSide;
    await page.effects.createReflectEffect(side);
    let attackGuardian = board.getGuardianForCurrentPlayer();
    let hitRateGuardian = board.getGuardianForCurrentPlayer();
    let player = board.findPlayer(board.currentSide);
    assertPresent(player);
    board.setPlayerBoardBadgeWithoutAnimation(board.currentSide, null);
    board.setTargetDirectionIndicator(null);
    board.setPlayerSideOverlay(board.currentSide, null);
    await board.resolveGuardianTurnEffect(board.currentSide);
    let overlaySide = board.currentSide;
    board.setPlayerSideOverlay(overlaySide, createAttackPreviewPanel(board.getPlayerSideGuardianList(board.currentSide), false, attackGuardian.attackOverride, hitRateGuardian.hitRateOverride));
    page.resolveActiveTarget(player);
    if (player.dead || player !== page.playerRoster.findPlayerStatById(getApplication().userId)) {
      playSound(sounds.targetPlayer);
    }
    await this.waitForAttackResponseEffect(player);
    return;
  }
  async handleBlock(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let side = board.responseSide;
    await page.effects.createBlockEffect(side);
    return;
  }
  async handleSafe(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    if (!board.hasPrimaryPlayerGuardian()) {
      let side = board.responseSide;
      await page.effects.createSafeEffect(side);
    }
    return;
  }
  async handleExchange(action: BattleEvent) {
    let hp = action.hp;
    let mp = action.mp;
    let cp = action.cp;
    let page = this.page;
    let board = page.board;
    let player = board.findPlayer(board.currentSide);
    assertPresent(player);
    if (!board.hasPrimaryPlayerGuardian()) {
      await page.effects.createExchangeEffect(player, hp, mp, cp);
    }
    player.setCombatCounters(hp, mp, cp);
    return;
  }
  async handleSell(action: BattleEvent) {
    let slot = action.item;
    let definition = slot!.getItemModel();
    let page = this.page;
    let board = page.board;
    let playerItems = board.getPlayerSideItemList(board.currentSide);
    if (0 >= playerItems.length) {
      indexError(playerItems, -1);
    } else {
      playerItems.pop()!.dispose();
      let effects = page.effects;
      if (board.findPlayer(board.oppositeSide) == null) {
        await effects.createCpTransferSequenceWithoutDarkEffect(definition, SideLeft, SideLeft);
      } else {
        board.clearCurrentBoardEffect();
        let sourceSide = board.currentSide;
        let destinationSide = board.responseSide;
        await effects.createCpTransferSequence(definition, destinationSide, board.guardianArtwork != null, sourceSide);
      }
      const price = definition.price;
      page.getCurrentTurnPlayer()!.changeCpDisplay(-price);
      board.findPlayer(board.currentSide)!.changeCpDisplay(price);
      let receivedSide = board.responseSide;
      await this.showReceivedItem(receivedSide, action.overflowItem);
      if (page.getCurrentTurnPlayer() == page.playerRoster.findPlayerStatById(getApplication().userId)) {
        let itemPanel = page.itemPanel;
        itemPanel.appendItemSlot(slot!);
        itemPanel.resetItemArrangement(0);
        await page.animateAsync(duration.normal);
      }
    }
    return;
  }
  async handleBuy(action: BattleEvent) {
    let board = this.page.board;
    if (board.findPlayer(board.oppositeSide) != null) {
      let side = board.responseSide;
      board.clearCurrentBoardEffect();
      board.clearPlayerSideItems(side);
      board.setPlayerSideOverlay(side, null);
      board.addPlayerSideItemWithoutAnimation(side, null);
    }
    let destinationSide = board.responseSide;
    let slot = action.item;
    assertPresent(slot);
    await this.showRemovedItemImmediately(destinationSide, [slot]);
    return;
  }
  async handleCanNotBuy(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let effects = page.effects;
    if (board.findPlayer(board.oppositeSide) == null) {
      await page.animateAsync(duration.normal);
      let side = board.responseSide;
      await effects.createSafeEffect(side);
    } else {
      await effects.createPoorEffect(board.currentSide);
    }
    if (page.getCurrentTurnPlayer() == page.playerRoster.findPlayerStatById(getApplication().userId)) {
      let itemPanel = page.itemPanel;
      let slot = action.item;
      assertPresent(slot);
      itemPanel.appendItemSlot(slot);
      itemPanel.resetItemArrangement(0);
      await page.animateAsync(duration.normal);
    }
    return;
  }
  async handleSetBought(action: BattleEvent) {
    let slot = action.item;
    assertPresent(slot);
    let page = this.page;
    let board = page.board;
    let side = board.currentSide;
    board.renderGuardianArtwork(null);
    board.clearPlayerSideItems(side);
    await page.animateAsync(duration.normal);
    let effects = page.effects;
    let wasBought = action.bought;
    await effects.createPurchaseEffect(wasBought, side);
    if (wasBought) {
      let destinationSide = board.responseSide;
      board.clearPlayerSideItems(destinationSide);
      let definition = slot.getItemModel();
      let receivedSide = board.responseSide;
      await effects.createCpTransferSequenceWithoutDarkEffect(definition, side, receivedSide);
      let price = definition.price;
      board.findPlayer(board.currentSide)!.changeCpDisplay(-price);
      page.getCurrentTurnPlayer()!.changeCpDisplay(price);
      await this.showReceivedItem(side, action.overflowItem);
    }
    let player = wasBought ? board.findPlayer(board.currentSide) : page.getCurrentTurnPlayer();
    if (player == page.playerRoster.findPlayerStatById(getApplication().userId)) {
      let itemPanel = page.itemPanel;
      itemPanel.appendItemSlot(slot);
      itemPanel.resetItemArrangement(0);
      await page.animateAsync(duration.normal);
    }
    return;
  }
  async handleAddItem(action: BattleEvent) {
    let slot = action.item;
    assertPresent(slot);
    let page = this.page;
    await page.animateAsync(duration.normal);
    let board = page.board;
    let side = board.currentSide;
    board.renderGuardianArtwork(null);
    board.clearPlayerSideItems(side);
    await page.effects.createItemAdditionEffect(slot.getItemModel());
    await this.showReceivedItem(side, action.overflowItem);
    if (board.findPlayer(board.currentSide) == page.playerRoster.findPlayerStatById(getApplication().userId)) {
      let itemPanel = page.itemPanel;
      itemPanel.appendItemSlot(slot);
      itemPanel.resetItemArrangement(0);
      await page.animateAsync(duration.normal);
    }
    return;
  }
  async handleDealDamage(action: BattleEvent) {
    var targetPlayer;
    let playerId = action.playerId;
    let page = this.page;
    if (playerId === 0) {
      let player = page.getCurrentTurnPlayer();
      assertPresent(player);
      targetPlayer = player;
    } else {
      targetPlayer = page.playerRoster.requirePlayer(playerId);
    }
    let damage = action.damage;
    let side = page.getPlayerSide(targetPlayer);
    assertPresent(side);
    await page.effects.createDamageEffect(damage, side);
    targetPlayer.changeHpDisplay(-damage);
    return;
  }
  async handleDealDarkDamage(action: BattleEvent) {
    let page = this.page;
    let player = page.getCurrentTurnPlayer()!;
    let hp = player.hp;
    let board = page.board;
    let side = board.responseSide;
    await page.effects.createDarkDamageEffect(hp, side);
    player.setHp(0);
    return;
  }
  async handleBoostHP(action: BattleEvent) {
    var targetPlayer;
    let playerId = action.playerId;
    let page = this.page;
    if (playerId === 0) {
      let player = page.getCurrentTurnPlayer();
      assertPresent(player);
      targetPlayer = player;
    } else {
      targetPlayer = page.playerRoster.requirePlayer(playerId);
    }
    if (!page.board.hasPrimaryPlayerGuardian()) {
      let side = page.getPlayerSide(targetPlayer);
      assertPresent(side);
      await page.effects.createHpBoostEffect(action.hp, side);
    }
    targetPlayer.changeHpDisplay(action.hp);
    return;
  }
  async handleSetHPOfEverybody(action: BattleEvent) {
    var players;
    var playerCount;
    players = this.page.playerRoster.getAlivePlayerStats();
    playerCount = players.length;
    for (const player of players) {
      if (players.length !== playerCount) {
        invalidState(players);
      }
      player.setHp(action.hp);
    }
    if (players.length !== playerCount) {
      invalidState(players);
    }
    return;
  }
  async handleBoostMP(action: BattleEvent) {
    let playerId = action.playerId;
    let page = this.page;
    let targetPlayer = playerId === 0
      ? page.getCurrentTurnPlayer()
      : page.playerRoster.requirePlayer(playerId);
    assertPresent(targetPlayer);
    if (!page.board.hasPrimaryPlayerGuardian()) {
      let side = page.getPlayerSide(targetPlayer);
      assertPresent(side);
      await page.effects.createMpBoostEffect(action.mp, side);
    }
    targetPlayer.changeMpDisplay(action.mp);
    return;
  }
  async handleBoostCP(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    if (!board.hasPrimaryPlayerGuardian()) {
      let side = board.responseSide;
      await page.effects.createCpBoostEffect(action.cp, side);
    }
    page.getCurrentTurnPlayer()!.changeCpDisplay(action.cp);
    return;
  }
  async handleBoostCPOfEverybody(action: BattleEvent) {
    playSound(sounds.boostCp);
    await this.page.animateAsync(duration.long);
    const players = this.page.playerRoster.getAlivePlayerStats(),
      count = players.length,
      amount = action.cp;
    for (const player of players) {
      player.changeCpDisplay(amount);
      if (players.length !== count) invalidState(players);
    }
  }
  async handleCollectCPOfEverybody(action: BattleEvent) {
    const roster = this.page.playerRoster;
    const players = roster.getAlivePlayerStats();
    let totalCp = 0;
    for (const player of players) {
      totalCp += player.cp;
      player.setCombatCounters(player.hp, player.mp, 0);
    }

    roster.requirePlayer(action.playerId).changeCpDisplay(totalCp);
  }
  async handleTakeCP(action: BattleEvent) {
    let page = this.page;
    let cp = action.cp;
    let board = page.board;
    let side = board.currentSide;
    await page.effects.createCpTransferToOtherSide(cp, side);
    page.getCurrentTurnPlayer()!.changeCpDisplay(-cp);
    board.findPlayer(board.currentSide)!.changeCpDisplay(cp);
    return;
  }
  async handleAddCurse(action: BattleEvent) {
    let curse = action.curse;
    assertPresent(curse);
    let page = this.page;
    let board = page.board;
    let side = board.responseSide;
    await page.effects.createCurseAdditionEffect(curse, side);
    let player = page.getCurrentTurnPlayer();
    player!.addStatusEffect(curse);
    if (curse === CurseFog && player == page.playerRoster.findPlayerStatById(getApplication().userId) && !player!.dead) {
      await this.animateTurnSideChange(true);
    }
    return;
  }
  async handleSetCurseOfEverybody(action: BattleEvent) {
    const curse = action.curse;
    assertPresent(curse);
    const status = this.page.playerRoster,
      players = status.getAlivePlayerStats(),
      count = players.length;
    for (const player of players) {
      player.addStatusEffect(curse);
      if (players.length !== count) invalidState(players);
    }
    if (curse === CurseFog) {
      const self = status.findPlayerStatById(getApplication().userId);
      if (self != null && !self.dead) await this.animateTurnSideChange(true);
    }
  }
  async handleDisease(action: BattleEvent) {
    let page = this.page;
    let player = page.playerRoster.requirePlayer(action.playerId);
    let side = page.getPlayerSide(player);
    if (side == null) {
      let board = page.board;
      board.clearBattleBoard(0);
      await page.animateAsync(duration.normal);
      board.setPlayerBoardBadgeWithoutAnimation(SideLeft, player);
      side = SideLeft;
    } else {
      let board = page.board;
      let responseSide = board.responseSide;
      if (side === responseSide) {
        board.clearCurrentBoardEffect();
      }
      board.clearPlayerSideItems(side);
      board.setPlayerSideOverlay(side, null);
    }
    let curse = player.findVisibleStatusEffect();
    assertPresent(curse);
    await page.effects.createDiseaseEffect(curse, side);
    return;
  }
  async handleUpgradeDisease(action: BattleEvent) {
    let curse = action.curse;
    assertPresent(curse);
    let page = this.page;
    let player = page.playerRoster.requirePlayer(action.playerId);
    let previousCurse = player.findVisibleStatusEffect();
    assertPresent(previousCurse);
    let side = page.getPlayerSide(player);
    assertPresent(side);
    await page.effects.createDiseaseUpgradeEffect(previousCurse, curse, action.natural, side);
    player.addStatusEffect(curse);
    return;
  }
  async handleUpgradeHeaven(action: BattleEvent) {
    let page = this.page;
    let side = page.getPlayerSide(page.playerRoster.requirePlayer(action.playerId));
    assertPresent(side);
    await page.effects.createHeavenUpgradeEffect(action.natural, side);
    return;
  }
  async handleRemoveCurses(action: BattleEvent) {
    const page = this.page,
      board = page.board,
      primary = board.currentSide,
      opposite = primary === SideLeft ? SideRight : SideLeft;
    const localPlayer = page.playerRoster.findPlayerStatById(getApplication().userId);
    const localHadDream = localPlayer?.curseIcons.has(CurseDream) ?? false;
    if (!board.hasPrimaryPlayerGuardian()) await page.effects.createCurseRemovalEffectForPlayer(action.curses, board.findPlayer(opposite) == null ? primary : opposite);
    const curses = action.curses,
      count = curses.length;
    for (const curse of curses) {
      const player = board.playerBadges.get(opposite)?.player ?? board.playerBadges.get(primary)?.player;
      assertPresent(player);
      const icon = removeEntry(player.curseIcons, curse);
      if (icon != null) icon.dispose(0);
      if (curses.length !== count) invalidState(curses);
    }
    if (curses.includes(CurseDream)) {
      const player = page.getCurrentTurnPlayer();
      assertPresent(player);
      page.commandOverlay.targetedPlayers.add(player);
    }
    if (
      curses.includes(CurseFog)
      && page.getCurrentTurnPlayer() === localPlayer
    ) {
      await this.animateTurnSideChange(false);
    }
    const dreamWasRemovedFromLocalPlayer =
      curses.includes(CurseDream)
      && localHadDream
      && localPlayer !== null
      && !localPlayer.curseIcons.has(CurseDream);
    if (dreamWasRemovedFromLocalPlayer) {
      await page.itemPanel.clearDreamedItems();
    }
  }
  async handleConfuseEverybody(action: BattleEvent) {
    var players;
    var playerCount;
    players = this.page.playerRoster.getAlivePlayerStats();
    playerCount = players.length;
    for (const player of players) {
      if (players.length !== playerCount) {
        invalidState(players);
      }
      player.setConfusionCounter(player.confusionCount + CONFUSION_TURNS);
    }
    if (players.length !== playerCount) {
      invalidState(players);
    }
    return;
  }
  async handleSetGuardian(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    if (!board.hasPrimaryPlayerGuardian()) {
      let guardian = action.guardian;
      assertPresent(guardian);
      let side = board.responseSide;
      await page.effects.createGuardianSetEffect(guardian, side);
    }
    page.getCurrentTurnPlayer()!.setGuardianStatusIcon(action.guardian);
    return;
  }
  async handleSetGuardianOfEverybody(action: BattleEvent) {
    var players;
    var playerCount;
    var guardians;
    players = this.page.playerRoster.getAlivePlayerStats();
    playerCount = players.length;
    guardians = action.guardians;
    for (const player of players) {
      if (players.length !== playerCount) {
        invalidState(players);
      }
      player.setGuardianStatusIcon(removeAt(guardians, 0));
    }
    if (players.length !== playerCount) {
      invalidState(players);
    }
    return;
  }
  async handleRemoveGuardian(action: BattleEvent) {
    let page = this.page;
    let player = page.playerRoster.requirePlayer(action.playerId);
    if (player.turnHighlight == null) {
      const guardian = player.guardianIcon;
      assertPresent(guardian);
      let side = page.getPlayerSide(player);
      assertPresent(side);
      await page.effects.createGuardianRemovalEffect(guardian.guardian, side);
    }
    player.setGuardianStatusIcon(null);
    return;
  }
  async handleRemoveItems(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let side = board.responseSide;
    board.clearCurrentBoardEffect();
    board.clearPlayerSideItems(side);
    board.setPlayerSideOverlay(side, null);
    if (board.findPlayer(board.oppositeSide) == null) {
      await page.animateAsync(duration.normal);
    }
    await this.showRemovedItemImmediately(side, action.items);
    await page.animateAsync(duration.normal);
    let guardianItems = board.getPlayerSideGuardianList(side);
    board.clearPlayerSideItems(side);
    await page.effects.createSacrificeEffectForPlayer(guardianItems, side);
    return;
  }
  async handleRemoveUsedMiracles(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let side = board.responseSide;
    board.clearCurrentBoardEffect();
    board.clearPlayerSideItems(side);
    board.setPlayerSideOverlay(side, null);
    board.addPlayerSideItemWithoutAnimation(side, null);
    if (board.findPlayer(board.oppositeSide) == null) {
      await page.animateAsync(duration.normal);
    }
    let slots = action.items;
    await this.showRemovedItemImmediately(side, slots);
    page.getCurrentTurnPlayer()!.removeUsedMiracles(slots);
    await page.animateAsync(duration.normal);
    let sacrificeItems = [null];
    appendAll(sacrificeItems, board.getPlayerSideGuardianList(side));
    board.clearPlayerSideItems(side);
    await page.effects.createSacrificeEffectForPlayer(sacrificeItems, side);
    return;
  }
  async handleRemoveSomething(action: BattleEvent) {
    var playerItems;
    let slots = action.items;
    await this.showRemovedItemImmediately(SideRight, slots);
    let page = this.page;
    page.getCurrentTurnPlayer()!.removeUsedMiracles(slots);
    await page.animateAsync(duration.normal);
    let board = page.board;
    let guardianItems = Array.from(board.getPlayerSideGuardianList(SideRight));
    setValue(guardianItems, 0, null);
    while (board.getPlayerSideItemList(SideRight).length > 1) {
      playerItems = board.getPlayerSideItemList(SideRight);
      if (0 >= playerItems.length) {
        indexError(playerItems, -1);
        return;
      }
      playerItems.pop()!.dispose();
    }
    await page.effects.createSacrificeEffectForPlayer(guardianItems, SideRight);
    return;
  }
  async handleRedraw(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    let side = board.responseSide;
    await page.effects.createRedrawEffect(side);
    return;
  }
  async handleReplaceItems(action: BattleEvent) {
    let page = this.page;
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    player.usedMiracles.clearCommands();
    if (player === playerStats.findPlayerStatById(getApplication().userId)) {
      let itemPanel = page.itemPanel;
      itemPanel.reorderItems(action.items);
      itemPanel.resetItemArrangement(0);
      await page.animateAsync(duration.normal);
    }
    return;
  }
  async handleSelfCurse(action: BattleEvent) {
    playSound(sounds.selfCurse);
    let board = this.page.board;
    let side = board.responseSide;
    let playerItems = board.getPlayerSideItemList(side);
    let itemIndex = action.index;
    if (!(itemIndex >= 0 && itemIndex < playerItems.length)) {
      indexError(playerItems, itemIndex);
    } else {
      await playerItems[itemIndex].pulsePlayerItem();
    }
    return;
  }
  async handleCounterAttack(action: BattleEvent) {
    playSound(sounds.counterAttack);
    let board = this.page.board;
    let side = board.responseSide;
    let playerItems = board.getPlayerSideItemList(side);
    let itemIndex = action.index;
    if (!(itemIndex >= 0 && itemIndex < playerItems.length)) {
      indexError(playerItems, itemIndex);
    } else {
      await playerItems[itemIndex].pulsePlayerItem();
    }
    return;
  }
  async handleRevive(action: BattleEvent) {
    let slot = action.item;
    assertPresent(slot);
    let page = this.page;
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    let side = page.getPlayerSide(player);
    assertPresent(side);
    let board = page.board;
    if (side === board.currentSide) {
      board.renderGuardianArtwork(null);
    } else {
      board.clearCurrentBoardEffect();
    }
    board.clearPlayerSideItems(side);
    board.setPlayerSideOverlay(side, null);
    await page.animateAsync(duration.normal);
    playSound(sounds.revive);
    let isFakeItem = slot.fakeModelId !== 0;
    board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(slot.getItemModel(), 0, false, 0, null, isFakeItem, 0, 0));
    board.animatePlayerSideItemsDefault(side);
    let application = getApplication();
    if (player === playerStats.findPlayerStatById(application.userId)) {
      page.itemPanel.getItemAtSlot(slot.id).setItemCommandHighlight(true);
    }
    await page.animateAsync(duration.normal);
    if (isFakeItem) {
      await this.resolveDreamActionWithDefaults(side, slot);
    }
    await page.animateAsync(duration.normal);
    if (player === playerStats.findPlayerStatById(application.userId)) {
      let itemPanel = page.itemPanel;
      itemPanel.refreshItemCommandSelection();
      itemPanel.resetItemArrangement(0);
    }
    return;
  }
  async handleDie(action: BattleEvent) {
    let page = this.page;
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(action.playerId);
    let side = page.getPlayerSide(player);
    assertPresent(side);
    if (player.turnHighlight != null) {
      runScheduledCallback(player.animateStatusPanelHighlight(false));
      let playerItems = page.board.getPlayerSideItemList(side);
      let itemCount = playerItems.length;
      let itemIndex = 0;
      while (itemIndex < playerItems.length) {
        await playerItems[itemIndex].showItem();
        playerItems.length === itemCount || invalidState(playerItems);
        ++itemIndex;
        continue;
      }
    }
    await page.effects.createDeathEffect(side);
    player.showDefeatedPlayerState();
    if (player === playerStats.findPlayerStatById(getApplication().userId)) {
      page.itemPanel.resetItemArrangement(0);
      if (page.fogOverlay.getOpacity() === 1) {
        await this.animateTurnSideChange(false);
      }
    }
    return;
  }
  async handleAttackDyingly(action: BattleEvent) {
    let page = this.page;
    let board = page.board;
    board.clearBattleBoard(0);
    await page.animateAsync(duration.normal);
    playSound(sounds.attackDyingly);
    let side = board.currentSide;
    let attack = action.attack;
    let playerStats = page.playerRoster;
    let player = playerStats.requirePlayer(attack!.playerId);
    let slot = action.item;
    let fakeModelId = slot!.fakeModelId;
    let isFakeItem = fakeModelId !== 0;
    let isDisguised = isFakeItem && slot!.modelId !== fakeModelId;
    let displayedAttack = isDisguised ? 0 : attack!.attack;
    let displayedHitRate = isDisguised ? 0 : attack!.hitRate;
    board.setPlayerBoardBadgeWithoutAnimation(side, player);
    board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(slot!.getItemModel(), displayedAttack, false, 0, null, isFakeItem, displayedHitRate, 0));
    board.animatePlayerSideItemsDefault(side);
    board.setPlayerSideOverlay(side, createAttackPreviewPanel([slot!.getItemModel()], false, displayedAttack, displayedHitRate));
    let currentPlayer = board.findPlayer(board.currentSide);
    let application = getApplication();
    if (currentPlayer == playerStats.findPlayerStatById(application.userId)) {
      page.itemPanel.getItemAtSlot(slot!.id).setItemCommandHighlight(true);
    }
    await page.animateAsync(duration.display);
    if (isFakeItem) {
      let attackDamage = attack!.attack;
      let hitRate = attack!.hitRate;
      await this.resolveDreamAction(side, slot!, attackDamage, hitRate);
      let modelIndex = slot!.modelId - 1;
      if (!(modelIndex >= 0 && modelIndex < state.itemModels.length)) {
        indexError(state.itemModels, modelIndex);
      } else {
        board.setPlayerSideOverlay(side, createAttackPreviewPanel([state.itemModels[modelIndex]], false, attackDamage, hitRate));
        if (board.findPlayer(board.currentSide) == playerStats.findPlayerStatById(application.userId)) {
          let itemPanel = page.itemPanel;
          itemPanel.refreshItemCommandSelection();
          itemPanel.resetItemArrangement(0);
        } else {
          if (playerStats.findPlayerStatById(application.userId) != null && playerStats.findPlayerStatById(application.userId)!.dead) {
            page.itemPanel.resetItemArrangement(0);
          }
        }
        await page.animateAsync(duration.normal);
      }
    } else {
      if (board.findPlayer(board.currentSide) == playerStats.findPlayerStatById(application.userId)) {
        let itemPanel = page.itemPanel;
        itemPanel.refreshItemCommandSelection();
        itemPanel.resetItemArrangement(0);
      } else {
        if (playerStats.findPlayerStatById(application.userId) != null && playerStats.findPlayerStatById(application.userId)!.dead) {
          page.itemPanel.resetItemArrangement(0);
        }
      }
      await page.animateAsync(duration.normal);
    }
    return;
  }
  async handleEndGame(action: BattleEvent) {
    const page = this.page;
    page.board.clearBattleBoard(0);
    const visible = page.playerRoster.getAlivePlayerStats(),
      players = page.playerRoster.getAlivePlayerStats(),
      count = players.length;
    for (const player of players) {
      player.setConfusionCounter(0);
      if (players.length !== count) invalidState(players);
    }
    if (page.fogOverlay.getOpacity() === 1) {
      await page.animateTransition(false);
    } else {
      await page.animateAsync(duration.normal);
    }
    playSound(visible.length === 0 ? sounds.drawGame : sounds.winGame);
    page.showGameEnding();
  }
  async animateTurnSideChange(isFog: boolean) {
    const page = this.page;
    if (page.fogOverlay.getOpacity() === 1 === isFog) return null;
    const self = page.playerRoster.findPlayerStatById(getApplication().userId);
    assertPresent(self);
    const players = page.playerRoster.getOpponentPlayerStats(self),
      count = players.length;
    if (count === 0) return null;
    for (const player of players) {
      runScheduledCallback(player.animateStatusPanelHighlight(isFog));
      if (players.length !== count) invalidState(players);
    }
    return await page.animateTransition(isFog);
  }
  async resolveDreamAction(side: Side, slot: ItemSlot, attackDamage: number, hitRate: number) {
    let page = this.page;
    await page.animateAsync(duration.normal);
    let modelIndex = slot.modelId;
    let isDreamed = slot.fakeModelId !== 0;
    if (isDreamed) {
      playSound(sounds.dream);
    }
    --modelIndex;
    if (!(modelIndex >= 0 && modelIndex < state.itemModels.length)) {
      indexError(state.itemModels, modelIndex);
    } else {
      let counter = createCombatCounterDetails(state.itemModels[modelIndex], attackDamage, false, 0, null, false, hitRate, 0);
      await last(page.board.getPlayerSideItemList(side)).swapPlayerItem(counter, isDreamed);
    }
    return;
  }
  resolveDreamActionWithDefaults(side: Side, slot: ItemSlot) {
    return this.resolveDreamAction(side, slot, 0, 0);
  }
  resolveDoubleMpAttackEvent(items: ItemDefinition[], attackDamage: number) {
    return this.resolveDoubleMpAttack(items, attackDamage);
  }
  async resolveDoubleMpAttack(items: ItemDefinition[], attackDamage: number) {
    let page = this.page;
    {
      await page.animateAsync(duration.normal);
      playSound(sounds.atkBy2xMp);
      let board = page.board;
      {
        await board.getPlayerSideItemAtIndex(board.currentSide).showItemDamage(attackDamage);
        let side = board.currentSide;
        board.setPlayerSideOverlay(side, createAttackPreviewPanel(items, false, attackDamage, 0));
        {
          await page.animateAsync(duration.normal);
          return null;
        }
      }
    }
  }
  async waitForAttackResponseEffect(input: PlayerStatusPanel) {
    if (input.dead || input.isBot) {
      if (input.curseIcons.has(CurseFlash) && input.turnHighlight == null) {
        let board = this.page.board;
        let side = board.responseSide;
        board.renderFlashEffect(side);
      }
      await this.page.animateAsync(duration.normal);
    }
    return null;
  }
  showRemovedItemForSide(container: Side, items: ItemSlot[], isDisabled: boolean) {
    return this.showRemovedItem(container, items, isDisabled);
  }
  showRemovedItemImmediately(container: Side, items: ItemSlot[]) {
    return this.showRemovedItemForSide(container, items, false);
  }
  async showRemovedItem(side: Side, slots: ItemSlot[], addEmptySlot: boolean) {
    const page = this.page,
      board = page.board,
      player = board.findPlayer(side),
      status = page.playerRoster,
      panel = page.itemPanel,
      itemViews = panel.items,
      length = slots.length;
    for (const slot of slots) {
      playSound(sounds.showRemovedItem);
      const isFake = slot.fakeModelId !== 0,
        definition = slot.getItemModel();
      board.addPlayerSideItemWithoutAnimation(side, createCombatCounterDetails(definition, 0, false, 0, null, isFake, 0, 0));
      board.animatePlayerSideItemsDefault(side);
      if (player == status.findPlayerStatById(getApplication().userId)) {
        const view = panel.getItemAtSlot(slot.id);
        view.dispose();
        removeValue(itemViews, view);
      }
      if (isFake) await this.resolveDreamActionWithDefaults(side, slot);
      await page.animateAsync(duration.normal);
      if (slots.length !== length) invalidState(slots);
    }
    if (player == status.findPlayerStatById(getApplication().userId)) {
      if (addEmptySlot) panel.appendItemSlot(createEmptyItemSlot());
      panel.arrangeItemSlots(0, true);
    }
  }
  async animateItemAcquisition(side: Side, slot: ItemSlot | null, addEmptySlot: boolean) {
    if (slot == null) return;
    const page = this.page,
      board = page.board;
    await page.animateAsync(duration.normal);
    board.addPlayerSideItemWithoutAnimation(side, null);
    await this.showRemovedItemForSide(side, [slot], addEmptySlot);
    board.clearPlayerSideItems(side);
    const index = slot.modelId - 1;
    if (!(index >= 0 && index < state.itemModels.length)) return indexError(state.itemModels, index);
    await page.effects.createSacrificeEffectForPlayer([null, state.itemModels[index]], side);
    const player = board.findPlayer(side);
    assertPresent(player);
    player.removeUsedMiracles([slot]);
  }
  showReceivedItem(container: Side, content: ItemSlot | null) {
    return this.animateItemAcquisition(container, content, false);
  }
}
function requireItemModelById(id: number): ItemDefinition {
  const index = id - 1;
  if (!(index >= 0 && index < state.itemModels.length)) return indexError(state.itemModels, index);
  return state.itemModels[index];
}
