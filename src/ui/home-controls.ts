import {firestoreDocument} from '../services/protocol';
import {surfaceSize, radius, screen} from './theme';
import {colors} from './palette';
import {BACK_ICON, SETTINGS_ICON} from './icons';
import { AnimatedElement, InteractiveElement, ChangeHandler, GameElement, createAnimatedContainer, createImageContainer, createInteractiveElement } from './elements';
import { ActionCard, Card, applySurface, appendLabel } from './components';
import { DisposablePanel, SettingsRow, SettingsDialog, LanguageOption, SettingsContent } from './decorative';
import { getApplication, state } from '../app/runtime';
import { GameModeDuel, allLanguages, allGameModes } from '../domain/enums';
import {sounds, playSound} from '../services/audio';
import { subscribeToFirestoreDocument } from '../services/firebase';
import { replaceFirst } from '../shared/values';
import { RoomController } from '../rooms/room-controller';
import { createScreenBackground } from './assets';
import { createModeCard } from './mode-selection';
import type { ModeCard } from './mode-selection';
export class BackButton extends ActionCard {
  renderBackButton(): void {
    const background = createAnimatedContainer(24, 10, 3, 100);
    applySurface(background, {...surfaceSize.headerLabel, left: 10, top: 3, radius: radius.small, background: colors.mintLight});
    this.domElement.append(background.domElement);
    const icon = createImageContainer(BACK_ICON, 30, 45, null, 30);
    icon.domElement.style.color = colors.brand;
    this.domElement.append(icon.domElement);
    this.applyAction(() => this.navigateBack());
  }
  private async navigateBack(): Promise<void> {
    playSound(sounds.click);
    const application = getApplication();
    if (application.referenceMenu.domElement.isConnected) {
      application.setReferenceMenuVisible(false);
      return;
    }
    if (application.banner !== null) {
      application.setHomeBanner(null);
      return;
    }
    if (application.dialog instanceof ScrollablePage) {
      application.showCreditsPage(false);
      return;
    }
    if (application.dialog instanceof RoomController) {
      const room = application.dialog,
        game = room.gamePage;
      if (game === null && application.mode === GameModeDuel) return;
      if (game !== null && game.showReconnectPromptIfNeeded()) return;
      await room.leaveCurrentRoom();
      return;
    }
    if (application.mode == null) application.setHomeTitle(null);
    application.openHomePage(null);
  }
}
export function createBackButton(): BackButton {
  const element = document.createElement('div'),
    button = new BackButton(element);
  button.applyElementStyles(element, 30, null, null, 120);
  button.renderBackButton();
  return button;
}
export class SettingsButton extends ActionCard {
  renderSettingsButton(): void {
    const background = createAnimatedContainer(24, 10, 3, 180);
    applySurface(background, {...surfaceSize.headerButton, left: 10, top: 3, radius: radius.small, background: colors.mintLight});
    const icon = createImageContainer(SETTINGS_ICON, 24, 10, null, 24);
    icon.domElement.style.color = colors.brand;
    background.domElement.append(icon.domElement);
    appendLabel(background, {
      text: state.translations.getSettingsText('settings'),
      height: 24, left: 40, top: null, width: 100,
      size: 20, color: colors.brand, fit: true
    });
    this.domElement.append(background.domElement);
    this.applyAction(() => {
      playSound(sounds.click);
      const application = getApplication();
      if (application.referenceMenu.domElement.isConnected) {
        application.setReferenceMenuVisible(false);
        application.showCreditsPage(true);
      } else application.showCreditsPage(!(application.dialog instanceof ScrollablePage));
    });
  }
}
export function createSettingsButton(): SettingsButton {
  const element = document.createElement('div'),
    button = new SettingsButton(element);
  button.applyElementStyles(element, 30, 440, null, 200);
  button.renderSettingsButton();
  return button;
}
export class LanguageDropdown extends ChangeHandler {
  renderLanguageDropdown(): void {
    this.setBorderRadius(radius.small);
    this.applyNormalTextStyle(25, colors.brand);
    this.setBorder(2, colors.olive);
    for (const language of allLanguages) {
      const option = document.createElement('option');
      option.value = language.key;
      option.text = state.translations.langNames.get(language.key) ?? '';
      this.domElement.add(option);
    }
    this.domElement.value = state.language.key;
    this.setChangeHandler(() => {
      if (this.domElement.value !== state.language.key) {
        getApplication();
        window.location.href = `/?lang=${this.domElement.value}`;
      }
    });
  }
}
export function createLanguageDropdown(): LanguageDropdown {
  const element = document.createElement('select'),
    dropdown = new LanguageDropdown(element);
  dropdown.applyElementStyles(element, 40, 440, null, 200);
  dropdown.setBackgroundColor(colors.inputYellow);
  dropdown.renderLanguageDropdown();
  return dropdown;
}
export function createSettingsPage(heading: string, credit: string): SettingsRow {
  const element = document.createElement('div'),
    row = new SettingsRow(element);
  row.applySurface({height: 90, width: screen.width});
  row.appendLabel({text: heading, height: 40, left: null, top: null, width: screen.width, size: 30, color: colors.leaf, fit: true});
  row.appendLabel({text: credit, height: 50, left: null, top: 40, width: screen.width, size: 40, color: colors.leaf, bold: true, fit: true});
  return row;
}
export function createSettingsDialog(heading: string, credit: string): SettingsDialog {
  const element = document.createElement('div'),
    row = new SettingsDialog(element);
  row.applySurface({height: 60, width: screen.width});
  row.appendLabel({text: heading, height: 30, left: null, top: null, width: screen.width, size: 20, color: colors.leaf, fit: true});
  row.appendLabel({text: credit, height: 30, left: null, top: 30, width: screen.width, size: 24, color: colors.leaf, bold: true, fit: true});
  return row;
}
export function createSettingsRow(caption: string, url: string, width: number): LanguageOption {
  const element = document.createElement('div'),
    button = new LanguageOption(element);
  button.renderCard({
    height: 40, width, radius: radius.small,
    background: colors.leaf,
    insetBorder: {width: 1, color: colors.cream, inset: 2},
    label: {
      text: caption, height: 40, left: 10, top: null, width: width - 20,
      size: 25, color: colors.cream, fit: true
    }
  });
  button.initializeClickable();
  const anchor = document.createElement('a');
  anchor.href = url;
  new GameElement(anchor).applyElementStyles(anchor, button.getHeight(), null, null, button.getWidth());
  for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'] as const) anchor.style[corner] = element.style[corner] || '0px';
  button.interactionOverlay!.domElement.append(anchor);
  return button;
}
export class DeleteAccountAction extends ActionCard {
  renderDeleteAccountAction(): void {
    this.renderCard({
      ...surfaceSize.settingsAction, radius: radius.small,
      background: colors.leaf,
      insetBorder: {width: 1, color: colors.cream, inset: 2},
      label: {
        text: state.translations.getSettingsText('deleteAccount'),
        height: 40, left: 10, top: null, width: 380,
        size: 25, color: colors.cream, fit: true
      }
    });
    this.applyAction(() => {
      playSound(sounds.click);
      getApplication().createHomeDimmer(createDeleteAccountConfirmation());
    });
  }
}
export function createDeleteAccountAction(): DeleteAccountAction {
  const element = document.createElement('div'),
    button = new DeleteAccountAction(element);
  button.renderDeleteAccountAction();
  return button;
}
export class DeleteAccountConfirmation extends Card {
  confirmDeleteAccount(): void {
    this.applySurface({...surfaceSize.dialog, radius: radius.large, background: colors.roseWhisper});
    this.appendLabel({
      text: state.translations.getSettingsText('deleteAccount'),
      height: 70, left: 10, top: 40, width: 460,
      size: 60, color: colors.red, bold: true, fit: true
    });
    const button = createInteractiveElement(100, 20, 150, 440);
    applySurface(button, {
      ...surfaceSize.action, left: 20, top: 150, radius: radius.large,
      background: colors.red,
      insetBorder: {width: 2, color: colors.roseWhisper, inset: 4}
    });
    appendLabel(button, {
      text: state.translations.getSettingsText('delete'),
      height: 100, left: 10, top: null, width: 420,
      size: 60, color: colors.roseWhisper, bold: true, fit: true
    });
    button.initializeClickable();
    button.setActionHandler(async () => {
      playSound(sounds.click);
      const application = getApplication();
      await application.deleteFirebaseUser();
      application.setHomeBanner(null);
      return null;
    });
    this.domElement.append(button.domElement);
  }
}
export function createDeleteAccountConfirmation(): DeleteAccountConfirmation {
  const element = document.createElement('div'),
    dialog = new DeleteAccountConfirmation(element);
  dialog.confirmDeleteAccount();
  return dialog;
}
export class HomePageLayer extends DisposablePanel {
  constructor(public contentWidget: SettingsButton, element: HTMLDivElement) {
    super(element);
  }
  override dispose(_unused?: unknown): void {
    this.contentWidget.dispose(0);
    this.disposeElement(0);
  }
}
export class ScrollablePage extends DisposablePanel {
  constructor(public contentWidget: SettingsButton, element: HTMLDivElement) {
    super(element);
  }
  override dispose(_unused?: unknown): void {
    this.contentWidget.dispose(0);
    this.disposeElement(0);
  }
}
export class HomeDialogLayer extends AnimatedElement<HTMLDivElement> {
  constructor(public contentWidget: InteractiveElement, element: HTMLDivElement) {
    super(element);
  }
}
export class LanguageSelectionMenu extends DisposablePanel {
  unsubscribeUserCount: (() => void) | null = null;
  constructor(public modeCards: ModeCard[], element: HTMLDivElement) {
    super(element);
  }
  renderLanguageMenu(): void {
    this.domElement.append(createScreenBackground('menu').domElement);
    for (const mode of allGameModes) {
      const card = createModeCard(mode);
      card.domElement.style.left = '290px';
      card.domElement.style.top = `${[20, 230, 440][mode.index]}px`;
      this.domElement.append(card.domElement);
      this.modeCards.push(card);
    }
    this.renderUserCount();
  }
  renderUserCount(): void {
    this.unsubscribeUserCount?.();
    this.unsubscribeUserCount = subscribeToFirestoreDocument(
      firestoreDocument.userCount,
      counts => this.updateUserCounts(counts),
    );
  }
  updateUserCounts(counts: Map<string, unknown>): void {
    for (const card of this.modeCards) {
      const value = counts.get(card.mode.key),
        count = typeof value === 'number' && Number.isInteger(value) ? value : 0;
      card.descriptionWidget.domElement.textContent = replaceFirst(state.translations.getMenuText('userCount'), '{{count}}', String(count));
    }
  }
  override dispose(_unused?: unknown): void {
    this.unsubscribeUserCount?.();
    this.unsubscribeUserCount = null;
    this.disposeElement(0);
  }
}
export class CreditsPage extends AnimatedElement<HTMLDivElement> {
  renderCreditsPage(): void {
    const texts = state.translations,
      element = document.createElement('div'),
      header = new SettingsContent(element);
    header.applySurface({...surfaceSize.settingsHeader, left: 340, radius: radius.medium, insetBorder: {width: 2, color: colors.leaf, inset: 2}});
    header.appendLabel({
      text: texts.getAppText('title'),
      height: 80, left: 10, top: null, width: 380,
      size: 30, color: colors.leaf, bold: true, fit: true
    });
    element.style.top = '0px';
    this.domElement.append(element);
    const design = createSettingsPage(texts.getSettingsText('design'), texts.getSettingsText('designCredit'));
    design.domElement.style.top = '120px';
    this.domElement.append(design.domElement);
    const author = createSettingsRow('X @guuji', 'https://x.com/guuji', 200);
    author.domElement.style.left = '440px';
    author.domElement.style.top = '210px';
    this.domElement.append(author.domElement);
    const art = createSettingsPage(texts.getSettingsText('art'), texts.getSettingsText('artCredit'));
    art.domElement.style.top = '290px';
    this.domElement.append(art.domElement);
    let top = 410;
    for (const key of ['soundMaterials', 'ptTranslation', 'zhHansTranslation', 'frTranslation', 'zhHantTranslation', 'koTranslation', 'ruTranslation', 'esTranslation', 'trTranslation']) {
      const row = createSettingsDialog(texts.getSettingsText(key), texts.getSettingsText(key + 'Credit'));
      row.domElement.style.top = `${top}px`;
      this.domElement.append(row.domElement);
      top += 80;
    }
    top += 20;
    const privacy = createSettingsRow(texts.getSettingsText('privacyPolicy'), '/privacy', 400);
    privacy.domElement.style.left = '340px';
    privacy.domElement.style.top = `${top}px`;
    this.domElement.append(privacy.domElement);
    top += 80;
    const deletion = createDeleteAccountAction();
    deletion.domElement.style.left = '340px';
    deletion.domElement.style.top = `${top}px`;
    this.domElement.append(deletion.domElement);
    this.domElement.style.height = `${top + 80}px`;
  }
}
