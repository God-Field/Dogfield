import {MAX_ITEM_SLOTS, ITEM_SLOTS_PER_ROW} from '../domain/constants';
import {roomAction} from '../services/protocol';
import {surfaceSize, radius, layer, screen, duration, itemLayout} from '../ui/theme';
import {SELECTION_ICON} from '../ui/icons';
import {
  AnimatedElement,
  InteractiveElement,
  createAnimatedContainer,
  createImageContainer,
  createInteractiveElement,
  runScheduledCallback
} from '../ui/elements';
import {ItemButtonBackground, ItemSelectionHighlight, ItemSelectionOverlay} from '../ui/decorative';
import {applySurface, appendLabel} from '../ui/components';
import {
  CategoryArmor,
  CategoryMiracles,
  CategorySundries,
  CategoryWeapons,
  EasingEaseIn,
  EasingEaseOut,
  GameModeDuel,
  GameModePrivate
} from '../domain/enums';
import {ItemSlot, type ItemDefinition} from '../domain/models';
import {DUEL_TURN_TIMEOUT_MS, PRIVATE_TURN_TIMEOUT_MS} from '../domain/turn-timing';
import {appendAll, filterValues, findLastRequired, findRequired, first, removeAt, removeValue, sizeOf} from '../shared/collections';
import {
  assertPresent,
  compare,
  indexError,
  invalidState,
  modulo,
  parseInteger,
  replaceAll,
  replaceFirst,
  truncateDivide,
  uninitialized,
  UNSET,
  waitAll
} from '../shared/values';
import {createHiddenItemArtwork, createItemArtwork} from '../ui/assets';
import {getAttackElement} from '../engine/calculations';
import {createCombatCounterDetails} from './item-details';
import {colors, itemCommandElementColor, responseBackgroundColor, responseTextColor} from '../ui/palette';
import {getApplication, state} from '../app/runtime';
import {RoomController} from '../rooms/room-controller';
import type {HomePage} from '../app/home-page';
import {sounds, playSound} from '../services/audio';
import type {CommandRules} from './command-rules';
import type {GamePageController} from './game-page';
import type {PlayerStatusPanel} from './player-panels';

const removalActions: ReadonlySet<string> = new Set(['discard', 'sacrifice', 'sell']);

function itemSlotPosition(position: number): {left: number; top: number} {
  return {
    left: itemLayout.rowStep * modulo(position, ITEM_SLOTS_PER_ROW),
    top: position < ITEM_SLOTS_PER_ROW ? itemLayout.firstRowTop : itemLayout.wrappedRowTop,
  };
}

function getBattleContext(): {page: GamePageController; rules: CommandRules} {
  const room = getApplication().dialog;
  const page = (room instanceof RoomController ? room : null)!.gamePage!;
  const rules = page.commandRules;
  if (rules === UNSET) uninitialized('command');
  return {page, rules};
}

export function createEmptyItemSlot(): ItemSlot {
  return new ItemSlot(0, 0, 0, false);
}

export class GiftEffect extends AnimatedElement<HTMLDivElement> {
  constructor(
    public firstGiftIcon: AnimatedElement,
    public secondGiftIcon: AnimatedElement,
    element: HTMLDivElement
  ) {
    super(element);
  }
  async playGiftEffect(): Promise<null> {
    playSound(sounds.gift);
    await waitAll(new Set([
      this.firstGiftIcon.animateToPosition({top: -40}, duration.fast, EasingEaseOut),
      this.secondGiftIcon.animateToPosition({top: itemLayout.giftOffset}, duration.fast, EasingEaseOut)
    ]));
    return null;
  }
}

export function createItemButtonBackground(): ItemButtonBackground {
  const element = document.createElement('div');
  const background = new ItemButtonBackground(element);
  background.applySurface({...surfaceSize.itemButton, background: colors.mint, insetBorder: {width: 1, color: colors.mintPale, inset: 2}});
  return background;
}

export class ItemCommand extends AnimatedElement<HTMLDivElement> {
  slotIndex = 0;
  giftEffect: GiftEffect | null = null;
  itemModel: ItemDefinition | null = null;
  fakeItemModel: ItemDefinition | null = null;
  selectionOverlay: ItemSelectionOverlay | null = null;
  transitionContainer: AnimatedElement | null = null;
  isSelectable = false;
  highlight: AnimatedElement | null = null;
  detailBadge: ItemSelectionHighlight | null = null;
  sortKey = 0;

  constructor(
    public clickControl: InteractiveElement,
    public detailLayer: AnimatedElement,
    element: HTMLDivElement,
  ) {
    super(element);
  }
  async showItemCommandDetails(slot: ItemSlot): Promise<null> {
    this.selectItemCommand(slot);
    await this.giftEffect!.playGiftEffect();
    this.giftEffect!.dispose(0);
    this.giftEffect = null;
    this.renderItemCommandDetails();
    return null;
  }
  getItemModel(): ItemDefinition {
    let model = this.fakeItemModel;
    if (model === null) {
      model = this.itemModel;
      assertPresent(model);
    }
    return model;
  }
  selectItemCommand(slot: ItemSlot): void {
    this.slotIndex = slot.id;
    const modelIndex = slot.modelId - 1;
    const modelCount = state.itemModels.length;
    if (!(modelIndex >= 0 && modelIndex < modelCount)) return indexError(state.itemModels, modelIndex);
    this.itemModel = state.itemModels[modelIndex];
    let fakeModelIndex = slot.fakeModelId;
    if (fakeModelIndex === 0) this.domElement.append(createItemArtwork(this.getItemModel()).domElement);
    else {
      fakeModelIndex--;
      if (!(fakeModelIndex >= 0 && fakeModelIndex < modelCount)) return indexError(state.itemModels, fakeModelIndex);
      this.fakeItemModel = state.itemModels[fakeModelIndex];
      const container = createAnimatedContainer(itemLayout.commandWidth, null, null, itemLayout.commandWidth);
      const element = container.domElement;
      element.append(createItemArtwork(this.fakeItemModel).domElement);
      element.append(createHiddenItemArtwork().domElement);
      this.transitionContainer = container;
      this.domElement.append(element);
    }
    if (slot.used) this.createSelectionIndicator();
    this.setMouseOverHandler(() => this.showItemDetails());
    this.clickControl.setActionHandler(handleItemSelectionClick(this));
    this.domElement.append(this.clickControl.domElement);
  }
  async renderSelectedItemCommand(): Promise<null> {
    assertPresent(this.itemModel);
    const element = this.domElement;
    element.append(createItemArtwork(this.itemModel).domElement);
    element.append(this.transitionContainer!.domElement);
    element.append(this.clickControl.domElement);
    await this.transitionContainer!.fadeOut(duration.normal, EasingEaseIn);
    this.transitionContainer!.dispose(0);
    this.fakeItemModel = this.transitionContainer = null;
    this.renderItemCommandDetails();
    return null;
  }
  createSelectionIndicator(): void {
    if (this.selectionOverlay !== null) return;
    const element = document.createElement('div');
    const overlay = new ItemSelectionOverlay(element);
    overlay.applySurface({...surfaceSize.selectionBadge, radius: radius.small, background: colors.mint});
    const icon = createImageContainer(SELECTION_ICON, 20, null, null, 20).domElement;
    icon.style.color = colors.mintPale;
    element.append(icon);
    overlay.setPosition(58, 2);
    this.selectionOverlay = overlay;
    this.domElement.append(element);
    this.domElement.append(this.clickControl.domElement);
  }
  setItemCommandHighlight(isEnabled: boolean): void {
    this.highlight?.dispose(0);
    this.highlight = null;
    if (isEnabled) {
      const highlight = createAnimatedContainer(this.clickControl.getHeight(), null, null, this.clickControl.getWidth());
      applySurface(highlight, {height: this.clickControl.getHeight(), width: this.clickControl.getWidth(), border: {width: 5, color: colors.mintPale}});
      highlight.domElement.style.pointerEvents = 'none';
      this.highlight = highlight;
      this.domElement.append(highlight.domElement);
    }
  }
  renderItemCommandDetails(): void {
    this.detailBadge?.dispose(0);
    this.detailBadge = null;
    if (this.itemModel === null) return;
    const translations = state.translations;
    const {page, rules} = getBattleContext();
    const isSellMode = rules.submitButton !== null && rules.selectedItems.length !== 0 && first(rules.selectedItems).getItemModel().ability === 'sell';
    let text: string | null = null;
    let textColor: string | null = null;
    let backgroundColor: string | null = null;
    let borderColor: string | null = null;
    if (isSellMode) {
      if (this.getItemModel().price > 0) {
        text = replaceFirst(translations.getGameText('priceCP'), '{{price}}', String(this.getItemModel().price));
        textColor = colors.text;
        backgroundColor = colors.yellowPale;
        borderColor = colors.khaki;
      }
    } else {
      let isCutCost = false;
      if (rules.getCommandDiscardMode() && this.getItemModel().ability === 'cutCost') {
        isCutCost = this.slotIndex !== (rules.selectedItems.length !== 0 ? first(rules.selectedItems).slotIndex : null);
      }
      if (isCutCost) {
        text = translations.getGameText('cutCost');
        textColor = colors.lavender;
        backgroundColor = colors.periwinkle;
      } else if (this.isSelectable) {
        const isFilterMode = rules.isDefending;
        const guardian = page.board.getGuardianForCurrentPlayer();
        if (isFilterMode) {
          const guardianItems = guardian.items;
          const attackCategory = first(guardianItems).ability === 'categoryWeapons' ? CategoryWeapons : first(guardianItems).category;
          const attackElement = guardian.hasElementFilter ? null : getAttackElement(guardianItems);
          const response = this.getItemModel().getWeaponResponseAction(attackCategory, attackElement);
          if (response !== null) {
            text = translations.getGameText(response);
            textColor = responseBackgroundColor(response);
            backgroundColor = responseTextColor(response);
          }
        }
        if (text === null) {
          const category = this.getItemModel().category;
          if (category === CategoryWeapons || category === CategoryMiracles) {
            if (isFilterMode && this.getItemModel().defense > 0) {
              text = replaceFirst(translations.getGameText('def'), '{{def}}', String(this.getItemModel().defense));
            }
          } else if (category === CategoryArmor || category === CategorySundries) {
            if (!isFilterMode && this.getItemModel().attack > 0 && guardian.hasAttackValue()) {
              text = translations.formatAttackSummaryWithoutHitRate(this.getItemModel().attack, this.getItemModel().isPlusAttack);
            }
          }
        }
      }
      if (text === null) {
        const category = this.getItemModel().category;
        if (category === CategoryWeapons || category === CategoryMiracles) {
          if (this.getItemModel().attack > 0) text = translations.formatAttackSummary(this.getItemModel().attack, this.getItemModel().hitRate, this.getItemModel().isPlusAttack);
        } else if (category === CategoryArmor) {
          if (this.getItemModel().defense > 0) text = replaceFirst(translations.getGameText('def'), '{{def}}', String(this.getItemModel().defense));
        }
      }
    }
    if (text !== null) {
      const labelColor = textColor ?? itemCommandElementColor(this.getItemModel());
      const element = document.createElement('div');
      const badge = new ItemSelectionHighlight(element);
      badge.applySurface({
        ...surfaceSize.detailBadge, top: itemLayout.detailBadgeTop,
        corners: {bottomLeft: 8, bottomRight: 8},
        background: backgroundColor ?? colors.mintPale,
        border: borderColor !== null ? {width: 1, color: borderColor} : undefined
      });
      badge.appendLabel({
        text, height: itemLayout.detailHeight, left: itemLayout.detailLeft, top: itemLayout.detailTop, width: itemLayout.detailWidth,
        size: 18, color: labelColor!, bold: true, fit: true
      });
      this.detailBadge = badge;
      this.detailLayer.domElement.append(element);
    }
  }
  showItemDetails(): void {
    const application = getApplication();
    const room = application.dialog;
    const page = (room instanceof RoomController ? room : null)!.gamePage!;
    const useModel = page.playerRoster.findPlayerStatById(application.userId)!.dead || page.board.isOver;
    const detail = useModel ? this.itemModel! : this.getItemModel();
    page.showTurnOverlay(createCombatCounterDetails(detail, 0, false, 0, null, false, 0, 0));
  }
}

export function createItemCommand(slot: ItemSlot): ItemCommand {
  const clickControl = createInteractiveElement(itemLayout.commandWidth, null, null, itemLayout.commandWidth);
  const transition = createAnimatedContainer(itemLayout.commandHeight, null, null, itemLayout.commandWidth);
  const element = document.createElement('div');
  const item = new ItemCommand(clickControl, transition, element);
  item.applyElementStyles(element, itemLayout.commandHeight, null, null, itemLayout.commandWidth);
  element.append(transition.domElement);
  if (slot.modelId === 0) {
    const firstBackground = createItemButtonBackground();
    const secondBackground = createItemButtonBackground();
    const giftElement = document.createElement('div');
    const giftEffect = new GiftEffect(firstBackground, secondBackground, giftElement);
    giftEffect.applyElementStyles(giftElement, itemLayout.commandWidth, null, null, itemLayout.commandWidth);
    giftElement.style.zIndex = layer.raised;
    firstBackground.domElement.style.top = '0px';
    giftElement.append(firstBackground.domElement);
    secondBackground.domElement.style.top = '40px';
    giftElement.append(secondBackground.domElement);
    item.giftEffect = giftEffect;
    element.append(giftElement);
  } else item.selectItemCommand(slot);
  return item;
}

function copyItemPosition(source: ItemCommand, target: ItemCommand): void {
  const sourceStyle = source.domElement.style;
  const targetStyle = target.domElement.style;
  for (const property of ['left', 'top'] as const) {
    const value = sourceStyle[property];
    const pixels = value.length === 0 ? 0 : parseInteger(replaceAll(value, 'px', ''));
    targetStyle[property] = `${pixels}px`;
  }
}

export function handleItemSelectionClick(item: ItemCommand): () => void {
  return () => {
    if (!item.isSelectable) return;
    const room = getApplication().dialog;
    const page = (room instanceof RoomController ? room : null)!.gamePage;
    assertPresent(page);
    const rules = page.commandRules;
    if (rules === UNSET) uninitialized('command');
    if (item.highlight !== null) {
      playSound(sounds.cancelItem);
      rules.updateSelectedItemCommand(item);
    } else {
      playSound(sounds.selectItem);
      rules.selectExchangeItem(item);
    }
  };
}

export function isWeaponItem(item: ItemCommand): boolean {
  const model = item.fakeItemModel ?? item.itemModel;
  return model !== null && model.category === CategoryWeapons;
}

export function isUninitializedItem(item: ItemCommand): boolean {
  return item.itemModel === null;
}

export function hasNoSelectionOverlay(item: ItemCommand): boolean {
  return item.selectionOverlay === null;
}

export function matchesSlotIndex(slotIndex: number): (item: ItemCommand) => boolean {
  return item => item.slotIndex === slotIndex;
}

export function compareSortKeys(first: ItemCommand, second: ItemCommand): number {
  return compare(first.sortKey, second.sortKey);
}

export function hasTransition(item: ItemCommand): boolean {
  return item.transitionContainer !== null;
}

export class ItemActionPanel extends AnimatedElement<HTMLDivElement> {
  selectedItemCommand: ItemCommand | null = null;
  constructor(public items: ItemCommand[], element: HTMLDivElement) {
    super(element);
  }
  hasSpecialItemCommand(): boolean {
    return this.items.some(isWeaponItem);
  }
  replaceItemSlots(items: ItemSlot[]): void {
    for (const item of this.items) item.dispose(0);
    this.items.length = 0;
    for (const slot of items) this.appendItemSlot(slot);
  }
  reorderItems(input: ItemSlot[]): void {
    const reordered: ItemCommand[] = [];
    const container = this.domElement;
    for (const item of this.items) {
      if (item.itemModel === null) {
        reordered.push(item);
        continue;
      }
      const replacement = createItemCommand(removeAt(input, 0));
      copyItemPosition(item, replacement);
      replacement.renderItemCommandDetails();
      item.dispose(0);
      container.append(replacement.domElement);
      reordered.push(replacement);
    }
    this.items.length = 0;
    appendAll(this.items, reordered);
  }
  hasUninitializedItemSlot(): boolean {
    return this.items.some(isUninitializedItem);
  }
  findEmptyItemSlot(): ItemCommand {
    return findRequired(this.items, isUninitializedItem);
  }
  getItemAtSlot(slotIndex: number): ItemCommand {
    if (slotIndex === 0) {
      assertPresent(this.selectedItemCommand);
      return this.selectedItemCommand;
    }
    return findRequired(this.items, matchesSlotIndex(slotIndex));
  }
  clearItemActionControl(): void {
    this.selectedItemCommand?.dispose(0);
    this.selectedItemCommand = null;
  }
  async clearDreamedItems(): Promise<void> {
    for (const item of this.items) {
      if (item.fakeItemModel !== null) {
        await item.renderSelectedItemCommand();
      }
    }
  }
  populateEmptyItemSlots(): void {
    for (let index = 0; index < ITEM_SLOTS_PER_ROW; index++) {
      this.appendItemSlot(new ItemSlot(0, 0, 0, false));
    }
  }
  appendItemSlot(slot: ItemSlot): void {
    if (this.items.length >= MAX_ITEM_SLOTS) {
      const last = findLastRequired(this.items, isUninitializedItem);
      last.dispose(0);
      removeValue(this.items, last);
    }
    const unselectedCount = sizeOf(filterValues(this.items, hasNoSelectionOverlay));
    const position = itemSlotPosition(unselectedCount);
    const item = createItemCommand(slot);
    item.setPosition(position.left, position.top);
    item.renderItemCommandDetails();
    this.domElement.append(item.domElement);
    this.items.push(item);
  }
  renderItemCommandSelection(slotIndex: number | null): void {
    const selectedModel = slotIndex === null ? null : this.getItemAtSlot(slotIndex).itemModel;
    const isEnabled = selectedModel === null;
    const shouldKeepMiracles = !removalActions.has(isEnabled ? '' : selectedModel!.ability);
    const commandItems = this.items;
    const snapshot = Array.from(commandItems);
    const container = this.domElement;
    for (const [originalIndex, item] of snapshot.entries()) {
      if (item.highlight === null) {
        item.isSelectable = false;
        item.clickControl.domElement.style.cursor = '';
        item.clickControl.interactionOverlay?.dispose(0);
        item.clickControl.interactionOverlay = null;
        item.clickControl.setDisabled(false);
        item.renderItemCommandDetails();
        continue;
      }
      const model = item.fakeItemModel ?? item.itemModel;
      assertPresent(model);
      if (model.category === CategoryMiracles && shouldKeepMiracles) {
        if (item.selectionOverlay === null) {
          item.createSelectionIndicator();
          removeValue(commandItems, item);
          commandItems.push(item);
        }
        item.setItemCommandHighlight(false);
        item.isSelectable = false;
        item.clickControl.domElement.style.cursor = '';
        item.clickControl.interactionOverlay?.dispose(0);
        item.clickControl.interactionOverlay = null;
        item.renderItemCommandDetails();
        if (commandItems.length >= MAX_ITEM_SLOTS) continue;
      } else {
        item.dispose(0);
        removeValue(commandItems, item);
        switch (isEnabled ? null : selectedModel!.ability) {
          case 'discard':
            continue;
          case 'sell':
            if (item.slotIndex !== slotIndex) continue;
            break;
        }
      }
      const replacement = createItemCommand(new ItemSlot(0, 0, 0, false));
      copyItemPosition(item, replacement);
      container.append(replacement.domElement);
      commandItems.splice(originalIndex, 0, replacement);
    }
  }
  refreshItemCommandSelection(): void {
    this.renderItemCommandSelection(null);
  }
  arrangeItemSlots(_unused: number, isCommandOrder: boolean): void {
    this.appendVisibleItemWidgets();
    this.sortItemsByCommandPriority(isCommandOrder);
    const items = this.items;
    for (const [index, item] of items.entries()) {
      const position = item.selectionOverlay !== null ? MAX_ITEM_SLOTS - (items.length - index) : index;
      const slotPosition = itemSlotPosition(position);
      runScheduledCallback(item.translateElement(duration.normal, EasingEaseOut, slotPosition.left, slotPosition.top));
    }
  }
  resetItemArrangement(_input: number): void {
    this.arrangeItemSlots(0, false);
  }
  repositionItemSlots(): void {
    this.sortItemsByDefaultOrder();
    const items = this.items;
    for (const [index, item] of items.entries()) {
      const position = item.selectionOverlay !== null ? MAX_ITEM_SLOTS - (items.length - index) : index;
      const slotPosition = itemSlotPosition(position);
      item.setPosition(slotPosition.left, slotPosition.top);
    }
  }
  appendVisibleItemWidgets(): void {
    for (const item of this.items) if (item.itemModel !== null) this.domElement.append(item.domElement);
  }
  sortItemsByCommandPriority(isEnabled: boolean): void {
    const items = this.items;
    for (const [index, item] of items.entries()) {
      const model = item.itemModel;
      if (model === null) item.sortKey = 100000 + index;
      else {
        let key = isEnabled ? index : 100 * (item.fakeItemModel ?? model).id + index;
        if (item.selectionOverlay !== null) key += 200000;
        item.sortKey = key;
      }
    }
    items.sort(compareSortKeys);
    for (const item of items) item.sortKey = 0;
  }
  sortItemsByDefaultOrder(): void {
    this.sortItemsByCommandPriority(false);
  }
  hasAnimatingItemSlot(): boolean {
    return this.items.some(hasTransition);
  }
  async waitForItemAnimations(): Promise<null> {
    const items = this.items;
    const length = items.length;
    for (const item of items) {
      if (item.transitionContainer !== null) await item.renderSelectedItemCommand();
      if (items.length !== length) invalidState(items);
    }
    return null;
  }
  renderSelectedCommand(): void {
    const items = this.items.slice(0);
    if (this.selectedItemCommand !== null) items.push(this.selectedItemCommand);
    const {rules} = getBattleContext();
    for (const item of items) {
      if (item.itemModel === null) continue;
      const isSelectable = item.highlight !== null ? true : rules.isDiscardOrSaleCommand(item);
      if (isSelectable) {
        item.isSelectable = true;
        item.clickControl.initializeClickable();
        item.clickControl.setDisabled(false);
      } else {
        item.isSelectable = false;
        item.clickControl.domElement.style.cursor = '';
        item.clickControl.interactionOverlay?.dispose(0);
        item.clickControl.interactionOverlay = null;
        item.clickControl.setDisabled(true);
      }
      item.renderItemCommandDetails();
    }
  }
}

export class ItemCommandOverlay extends AnimatedElement<HTMLDivElement> {
  turnDurationSeconds = 0;
  elapsedSeconds = 0;
  currentCommand: AnimatedElement | null = null;

  constructor(public targetedPlayers: Set<PlayerStatusPanel>, element: HTMLDivElement) {
    super(element);
  }
  initializeItemCommandOverlay(): void {
    switch (getApplication().mode) {
      case GameModePrivate:
        this.turnDurationSeconds = PRIVATE_TURN_TIMEOUT_MS / 1000;
        this.elapsedSeconds = 40;
        break;
      case GameModeDuel:
        this.turnDurationSeconds = DUEL_TURN_TIMEOUT_MS / 1000;
        this.elapsedSeconds = 10;
        break;
    }
  }
  showItemCommandOverlay(): void {
    runScheduledCallback(createTurnControls(this)());
  }
  showItemCommandOverlayForSlot(slot: PlayerStatusPanel): void {
    if (this.turnDurationSeconds === 0) return;
    const application = getApplication();
    const room = application.dialog;
    const page = room instanceof RoomController ? room.gamePage : null;
    const player = page?.playerRoster.findPlayerStatById(application.userId) ?? null;
    if (player === null) return;
    const base = this.targetedPlayers.has(slot) ? 9 : 3;
    runScheduledCallback(createKickUserControl(this, base + (application.mode === GameModeDuel ? 0 : (player.playerId - 1) * 2), application)());
  }
  hideItemCommandOverlay(): void {
    this.targetedPlayers.clear();
    this.currentCommand?.dispose(0);
    this.currentCommand = null;
  }
  get deviceMode(): Set<PlayerStatusPanel> {
    return this.targetedPlayers;
  }
  set deviceMode(value: Set<PlayerStatusPanel>) {
    this.targetedPlayers = value;
  }
  get overlayWidth(): number {
    return this.turnDurationSeconds;
  }
  set overlayWidth(value: number) {
    this.turnDurationSeconds = value;
  }
  get overlayHeight(): number {
    return this.elapsedSeconds;
  }
  set overlayHeight(value: number) {
    this.elapsedSeconds = value;
  }
}

export function createTurnControls(overlay: ItemCommandOverlay): () => Promise<null> {
  return async () => {
    playSound(sounds.startTurn);
    const gauge = createAnimatedContainer(20, null, null, screen.contentWidth);
    gauge.domElement.style.borderTopRightRadius = '5px';
    gauge.domElement.style.borderBottomRightRadius = '5px';
    gauge.setBackgroundColor(colors.brand);
    overlay.currentCommand = gauge;
    overlay.domElement.append(gauge.domElement);
    if (overlay.turnDurationSeconds !== 0) {
      let width = gauge.getWidth();
      let elapsed = overlay.elapsedSeconds;
      await gauge.animateToPosition({left: truncateDivide(-width * elapsed, overlay.turnDurationSeconds)}, elapsed * 1000, null);
      playSound(sounds.timeGaugeAlarm);
      gauge.setBackgroundColor(colors.red);
      width = gauge.getWidth();
      await gauge.animateToPosition({left: -width}, (overlay.turnDurationSeconds - elapsed) * 1000, null);
      const application = getApplication();
      const room = application.dialog;
      if (room instanceof RoomController) {
        room.isLeaving = true;
        await room.sendRoomAction(roomAction.leaveRoom);
        if (application.dialog === room) {
          application.openHomePage(null);
        }
      }
    }
    return null;
  };
}

export function createKickUserControl(overlay: ItemCommandOverlay, extraSeconds: number, application: HomePage): () => Promise<null> {
  return async () => {
    const gauge = createAnimatedContainer(null, null, null, null);
    overlay.currentCommand = gauge;
    overlay.domElement.append(gauge.domElement);
    await gauge.animateAsync((overlay.turnDurationSeconds + extraSeconds) * 1000);
    const room = application.dialog;
    await (room instanceof RoomController ? room : null)!.sendRoomAction(roomAction.kickUser);
    return null;
  };
}
