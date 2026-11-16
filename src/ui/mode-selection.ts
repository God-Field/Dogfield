import {surfaceSize, radius} from './theme';
import {colors} from './palette';
import { KeydownHandler, TextElement, createAnimatedContainer, createInteractiveElement, createTextElement, createTextInput } from './elements';
import { ActionCard, Card, applySurface, appendLabel } from './components';
import { GameMode, GameModePrivate } from '../domain/enums';
import { getApplication, getSettings, state } from '../app/runtime';
import {sounds, playSound} from '../services/audio';
import { trimText } from '../shared/values';
export class ModeCard extends ActionCard {
  constructor(public mode: GameMode, public descriptionWidget: TextElement, element: HTMLDivElement) {
    super(element);
  }
  renderModeCard(_mode: GameMode): void {
    const modeColors = [[colors.lavender, colors.brandBlue], [colors.brand, colors.mintLight], [colors.roseWhisper, colors.pink]][this.mode.index];
    if (!modeColors) throw new Error('Unknown game mode');
    const [background, foreground] = modeColors;
    this.applySurface({
      height: this.getHeight(), width: this.getWidth(), radius: radius.round,
      background,
      border: this.mode.index === 1 ? undefined : {width: 4, color: foreground},
      insetBorder: this.mode.index === 1 ? {width: 2, color: foreground, inset: 4} : undefined
    });
    const texts = state.translations;
    this.appendLabel({
      text: texts.getModeNamesText(this.mode.key),
      height: 80, left: 15, top: 15, width: 470,
      size: 70, color: foreground, bold: true, fit: true
    });
    const countBackground = createAnimatedContainer(50, 10, 100, 480);
    applySurface(countBackground, {...surfaceSize.modeCount, left: 10, top: 100, background: foreground});
    this.descriptionWidget.setBounds(50, 20, 0, 440);
    this.descriptionWidget.domElement.style.textAlign = 'right';
    this.descriptionWidget.applyNormalTextStyle(30, background);
    countBackground.domElement.append(this.descriptionWidget.domElement);
    this.domElement.append(countBackground.domElement);
    this.appendLabel({
      text: texts.modeDescriptions.get(this.mode.key) ?? '',
      height: 30, left: 15, top: 158, width: 470,
      size: 22, color: foreground
    });
    this.applyAction(() => this.selectMode());
  }
  private async selectMode(): Promise<null> {
    playSound(sounds.click);
    const application = getApplication();
    switch (this.mode.index) {
      case 0:
        await application.createRoomWithDefaults(this.mode);
        break;
      case 1:
        {
          const editor = createRoomPasswordEditor();
          application.createHomeDimmer(editor);
          editor.input.domElement.focus();
          break;
        }
      default:
        application.openHomePage(this.mode);
    }
    return null;
  }
}
export function createModeCard(mode: GameMode): ModeCard {
  const description = createTextElement('', null, null, null, null),
    element = document.createElement('div'),
    card = new ModeCard(mode, description, element);
  card.applySurface({...surfaceSize.modeCard});
  card.renderModeCard(mode);
  return card;
}
export class RoomPasswordEditor extends Card {
  constructor(public input: KeydownHandler, element: HTMLDivElement) {
    super(element);
  }
  renderRoomPasswordEditor(): void {
    this.applySurface({height: this.getHeight(), width: this.getWidth(), radius: radius.large, background: colors.mintLight});
    const texts = state.translations;
    this.appendLabel({
      text: texts.getMenuText('roomPassword'),
      height: 30, left: 30, top: 40, width: 420,
      size: 25, color: colors.brand, bold: true, align: 'left'
    });
    this.input.setBorderRadius(radius.small);
    this.input.setBackgroundColor(colors.inputYellow);
    this.input.setBorder(2, colors.brand);
    this.input.applyNormalTextStyle(25, colors.brand);
    this.input.domElement.maxLength = 20;
    this.input.domElement.value = getSettings().roomPassword ?? '';
    this.input.setKeydownHandler(async key => {
      if (key === 'Enter') await this.submitRoomPasswordChange();
      return null;
    });
    this.domElement.append(this.input.domElement);
    const button = createInteractiveElement(100, 20, 150, 440);
    applySurface(button, {
      ...surfaceSize.action, left: 20, top: 150, radius: radius.large,
      background: colors.brand,
      insetBorder: {width: 2, color: colors.mintLight, inset: 4}
    });
    appendLabel(button, {
      text: texts.getMenuText('setRoomPassword'),
      height: 100, left: null, top: null, width: 440,
      size: 60, color: colors.mintLight, bold: true, fit: true
    });
    button.initializeClickable();
    button.setActionHandler(async () => {
      await this.submitRoomPasswordChange();
      return null;
    });
    this.domElement.append(button.domElement);
  }
  async submitRoomPasswordChange(): Promise<null> {
    playSound(sounds.click);
    const password = trimText(this.input.domElement.value);
    this.input.domElement.value = password;
    const settings = getSettings();
    settings.roomPassword = password;
    settings.saveSettings();
    return password.length === 0 ? null : await getApplication().createRoomWithPassword(GameModePrivate, password);
  }
}
export function createRoomPasswordEditor(): RoomPasswordEditor {
  const input = createTextInput(35, 30, 80, 420),
    element = document.createElement('div'),
    editor = new RoomPasswordEditor(input, element);
  editor.applySurface({...surfaceSize.dialog});
  editor.renderRoomPasswordEditor();
  return editor;
}
