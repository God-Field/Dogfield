import {roomAction} from '../services/protocol';
import {surfaceSize, radius, layer, duration} from '../ui/theme';
import {createInteractiveElement, createTextElement} from '../ui/elements';
import {applySurface, appendLabel, Card} from '../ui/components';
import {CommandButton, CurseCard, ItemPriceTooltip, PurchaseConfirmationDialog, ToastNotification} from '../ui/decorative';
import {CategoryWeapons, Curse, ItemElement, Side, SideLeft, sidePosition} from '../domain/enums';
import type {ItemDefinition} from '../domain/models';
import {first, removeAt} from '../shared/collections';
import {assertPresent, replaceFirst, UNSET, uninitialized} from '../shared/values';
import {calculateAttackDamage, getAttackElement, getSharedElement} from '../engine/calculations';
import {hasAttackValue as modelsHaveAttackValue} from '../engine/validation';
import {colors, curseTextColor, elementColor, responseBackgroundColor, responseTextColor} from '../ui/palette';
import {createCurseArtwork, createElementArtwork} from '../ui/assets';
import {getApplication, state} from '../app/runtime';
import {RoomController} from '../rooms/room-controller';
import {sounds, playSound} from '../services/audio';
import type {CommandRules} from './command-rules';

export class ElementIcon extends Card {
  renderElementIcon(element: ItemElement | null): void {
    this.addBorderOverlay(4, elementColor(element)!);
    if (element !== null) {
      const image = createElementArtwork(element);
      image.setPosition(10, 10);
      this.domElement.append(image.domElement);
    }
  }
  renderElementLabel(label: string, color: string): void {
    const text = createTextElement(label, this.getHeight(), 5, null, this.getWidth() - 10);
    text.applyTextStyle(28, color, true);
    this.domElement.append(text.domElement);
  }
}

export class AttackPreviewPanel extends ElementIcon {
  constructor(
    public items: ItemDefinition[],
    public attackOverride: number,
    public hitRateOverride: number,
    public hasElementFilter: boolean,
    element: HTMLDivElement
  ) {
    super(element);
  }
  renderAttackPreview(): void {
    const translations = state.translations;
    const items = this.items;
    const itemCount = items.length;
    if (itemCount === 0) {
      this.setBackgroundColor(colors.teal);
      this.renderElementLabel(translations.getGameText('pray'), colors.cyanPale);
      return;
    }
    if (itemCount >= 2 && first(items).ability === 'callPhenomenon') removeAt(items, 0);
    if (!this.hasAttackValue()) return;
    this.setBackgroundColor(colors.mintPale);
    const attackElement = this.hasElementFilter ? null : items.length === 0 ? null : getAttackElement(items);
    this.renderElementIcon(attackElement);
    const damage = calculateAttackDamage(items, this.attackOverride);
    const hitRate = this.hitRateOverride;
    this.renderElementLabel(
      translations.formatAttackSummaryWithHitRate(damage, hitRate > 0 ? hitRate : first(items).hitRate),
      elementColor(attackElement)!
    );
  }
  hasAttackValue(): boolean {
    return modelsHaveAttackValue(this.items, this.attackOverride);
  }
}

export function createAttackPreviewPanel(items: ItemDefinition[], hasElementFilter: boolean, attackOverride: number, hitRateOverride: number): AttackPreviewPanel {
  const element = document.createElement('div');
  const panel = new AttackPreviewPanel(items, attackOverride, hitRateOverride, hasElementFilter, element);
  panel.applySurface({...surfaceSize.commandPanel, radius: radius.medium});
  panel.renderAttackPreview();
  return panel;
}

export class ForgiveCommandPanel extends ElementIcon {
  constructor(element: HTMLDivElement) {
    super(element);
  }
  renderForgiveCommand(items: ItemDefinition[]): void {
    const translations = state.translations;
    const itemCount = items.length;
    if (itemCount === 0) {
      this.setBackgroundColor(colors.brick);
      this.renderElementLabel(translations.getGameText('forgive'), colors.rosePale);
      return;
    }
    let command: ItemDefinition | null = null;
    for (const item of items) {
      if (item.ability !== 'filterAtkElement') {
        command = item;
        break;
      }
    }
    const room = getApplication().dialog;
    const guardian = (room instanceof RoomController ? room : null)!.gamePage!.board.getGuardianForCurrentPlayer();
    let response: string | null = null;
    if (command !== null) {
      const guardianItems = guardian.items;
      const attackCategory = first(guardianItems).ability === 'categoryWeapons' ? CategoryWeapons : first(guardianItems).category;
      const attackElement = guardian.hasElementFilter || guardianItems.length === 0 ? null : getAttackElement(guardianItems);
      response = command.getWeaponResponseAction(attackCategory, attackElement);
    }
    if (response !== null) {
      this.setBackgroundColor(responseTextColor(response));
      this.renderElementLabel(translations.getGameText(response), responseBackgroundColor(response));
      return;
    }
    this.setBackgroundColor(colors.mintPale);
    const sharedElement = getSharedElement(items);
    let defense = 0;
    for (const item of items) defense += item.defense;
    this.renderElementIcon(sharedElement);
    this.renderElementLabel(replaceFirst(translations.getGameText('def'), '{{def}}', String(defense)), elementColor(sharedElement)!);
  }
}

export function createForgiveCommandPanel(items: ItemDefinition[]): ForgiveCommandPanel {
  const element = document.createElement('div');
  const panel = new ForgiveCommandPanel(element);
  panel.applySurface({...surfaceSize.commandPanel, radius: radius.medium});
  panel.renderForgiveCommand(items);
  return panel;
}

export class PurchaseChoiceButton extends Card {
  constructor(public isBuyChoice: boolean, element: HTMLDivElement) {
    super(element);
  }
  renderPurchaseChoice(): void {
    const choice = createInteractiveElement(this.getHeight(), null, null, this.getWidth());
    applySurface(choice, {height: this.getHeight(), width: this.getWidth(), radius: radius.large});
    choice.initializeClickable();
    choice.setActionHandler(submitSelectedCommand(this));
    this.container.append(choice.domElement);
  }
}

export function createPurchaseChoiceButton(isBuyChoice: boolean): PurchaseChoiceButton {
  const top = isBuyChoice ? 0 : 200;
  const element = document.createElement('div');
  const button = new PurchaseChoiceButton(isBuyChoice, element);
  button.renderCard({
    ...surfaceSize.purchaseChoice, top, radius: radius.large,
    background: colors.rose,
    insetBorder: {width: 2, color: colors.cream, inset: 4},
    label: {
      text: state.translations.getGameText(isBuyChoice ? 'doBuy' : 'doNotBuy'),
      height: 90, left: 10, top: null, width: 280,
      size: 50, color: colors.cream, bold: true, fit: true
    }
  });
  return button;
}

export function createPurchaseConfirmationDialog(isEnabled: boolean, side: Side): PurchaseConfirmationDialog {
  const left = side === SideLeft ? 20 : 360;
  const element = document.createElement('div');
  const dialog = new PurchaseConfirmationDialog(element);
  dialog.applySurface({...surfaceSize.purchaseDialog, left, top: 60});
  if (isEnabled) {
    const buy = createPurchaseChoiceButton(true);
    buy.renderPurchaseChoice();
    element.append(buy.domElement);
    const decline = createPurchaseChoiceButton(false);
    decline.renderPurchaseChoice();
    element.append(decline.domElement);
  }
  return dialog;
}

export function submitSelectedCommand(button: PurchaseChoiceButton): () => Promise<null> {
  return async () => {
    playSound(sounds.command);
    const room = getApplication().dialog;
    const commands = (room instanceof RoomController ? room.gamePage : null)!.commandRules;
    if (commands === UNSET) uninitialized('command');
    await commands.submitCommand(button.isBuyChoice);
    return null;
  };
}

export class AbandonGameDialog extends Card {
  constructor(element: HTMLDivElement) {
    super(element);
  }
  renderAbandonGameDialog(): void {
    const foreground = colors.roseWhisper;
    const button = createInteractiveElement(100, 20, 100, 440);
    applySurface(button, {
      ...surfaceSize.action, left: 20, top: 100, radius: radius.large,
      background: colors.red,
      insetBorder: {width: 2, color: foreground, inset: 4}
    });
    appendLabel(button, {
      text: state.translations.getGameText('abandon'),
      height: 100, left: 10, top: null, width: 420,
      size: 60, color: foreground, bold: true, fit: true
    });
    button.initializeClickable();
    button.setActionHandler(abandonGame());
    this.container.append(button.domElement);
  }
}

export function createAbandonGameDialog(): AbandonGameDialog {
  const element = document.createElement('div');
  const dialog = new AbandonGameDialog(element);
  dialog.applySurface({...surfaceSize.dialog, radius: radius.large, background: colors.roseWhisper});
  dialog.renderAbandonGameDialog();
  return dialog;
}

export function abandonGame(): () => Promise<null> {
  return async () => {
    playSound(sounds.click);
    const room = getApplication().dialog;
    await (room instanceof RoomController ? room : null)!.leaveCurrentRoom();
    return null;
  };
}

export function resetGame(room: RoomController): () => Promise<null> {
  return async () => {
    playSound(sounds.click);
    await room.sendRoomAction(roomAction.resetGame);
    return null;
  };
}

export function createCommandButton(side: Side): CommandButton {
  const top = sidePosition(side, 15, 355);
  const element = document.createElement('div');
  const button = new CommandButton(element);
  button.applySurface({...surfaceSize.commandButton, left: top, top: 55, radius: radius.medium});
  element.style.zIndex = layer.raised;
  button.initializeClickable();
  return button;
}

export function showCommandAlert(commandRules: CommandRules, alert: string): () => Promise<null> {
  return async () => {
    const message = state.translations.alerts.get(alert) ?? '';
    const element = document.createElement('div');
    const notification = new ToastNotification(element);
    const room = getApplication().dialog;
    const page = room instanceof RoomController ? room.gamePage : null;
    assertPresent(page);
    const tiebreak = page.tiebreakBadge;
    const isTiebreakVisible = tiebreak.isTiebreakComplete() && page.fogOverlay.getOpacity() !== 1;
    notification.renderCard({
      ...surfaceSize.toast, left: 15, top: 180, radius: radius.medium,
      background: isTiebreakVisible ? colors.ink : colors.red,
      label: {
        text: message, height: 50, left: 10, top: null, width: 630,
        size: 30, color: isTiebreakVisible ? colors.neutral : colors.roseWhisper, bold: true, fit: true
      }
    });
    commandRules.page.domElement.append(element);
    await notification.animateAsync(duration.display);
    notification.dispose(0);
    return null;
  };
}

export function createItemPriceTooltip(amount: number): ItemPriceTooltip {
  const element = document.createElement('div');
  const tooltip = new ItemPriceTooltip(element);
  tooltip.renderCard({
    ...surfaceSize.priceTooltip, radius: radius.pill,
    background: colors.yellowPale,
    border: {width: 4, color: colors.khaki},
    label: {
      text: replaceFirst(state.translations.getEffectsText('cp'), '{{cp}}', String(amount)),
      height: 160, left: 5, top: null, width: 150,
      size: 70, color: colors.text, bold: true, fit: true
    }
  });
  return tooltip;
}

export function createCurseCard(curse: Curse): CurseCard {
  const element = document.createElement('div');
  const card = new CurseCard(element);
  card.applySurface({...surfaceSize.curseCard, radius: radius.panel, background: curseTextColor(curse)});
  const image = createCurseArtwork(curse, 'medium');
  image.setPosition(110, 20);
  element.append(image.domElement);
  card.appendLabel({
    text: state.translations.getCurseNamesText(curse.key),
    height: 80, left: 10, top: 60, width: 260,
    size: 60, color: colors.text, bold: true, fit: true, shadow: colors.neutral
  });
  return card;
}
