import {surfaceSize, radius, timestampWindow} from './theme';
import {colors} from './palette';
import { createTextInput, createInteractiveElement } from './elements';
import { Card, applySurface, appendLabel } from './components';
import { getSettings, getApplication, state } from '../app/runtime';
import { getUserNameWidth } from '../shared/text';
import { Timestamp } from '../shared/timestamp';
import { trimText } from '../shared/values';
import {sounds, playSound} from '../services/audio';
export class UserNameEditor extends Card {
  constructor(element: HTMLDivElement) {
    super(element);
  }
  renderUserNameEditor(): void {
    const color = colors.brand,
      texts = state.translations;
    this.appendLabel({
      text: texts.getHomeText('userName'),
      height: 30, left: 50, top: null, width: 360,
      size: 25, color, bold: true, align: 'left', fit: true, shadow: colors.yellowWhisper
    });
    const input = createTextInput(34, 50, 40, 360);
    input.setBorderRadius(radius.small);
    input.applyNormalTextStyle(25, color);
    input.setBorder(2, colors.olive);
    input.domElement.maxLength = 18;
    input.domElement.value = getSettings().userName ?? '';
    input.setKeydownHandler(async key => {
      if (key === 'Enter') await this.submitUserNameChange(input.domElement.value);
      return null;
    });
    this.domElement.append(input.domElement);
    const button = createInteractiveElement(90, null, 100, 480);
    applySurface(button, {
      ...surfaceSize.nameAction, left: null, top: 100, radius: radius.large,
      background: color,
      insetBorder: {width: 2, color: colors.mintLight, inset: 4}
    });
    appendLabel(button, {
      text: texts.getHomeText('setUserName'),
      height: 90, left: 10, top: null, width: 460,
      size: 60, color: colors.mintLight, bold: true, fit: true
    });
    button.initializeClickable();
    button.setActionHandler(async () => {
      await this.submitUserNameChange(input.domElement.value);
      return null;
    });
    this.domElement.append(button.domElement);
  }
  async submitUserNameChange(input: string): Promise<void> {
    const settings = getSettings(),
      application = getApplication();
    playSound(sounds.click);
    let name = trimText(input);
    while (getUserNameWidth(name) > 18) {
      const characters = Array.from(name);
      if (!characters.length) break;
      characters.pop();
      name = characters.join('');
    }
    if (name !== settings.userName) {
      settings.userName = name;
      settings.clearRoomHistorySettings();
      settings.saveSettings();
    }
    if (name.length === 0) return;
    this.domElement.style.pointerEvents = 'none';
    application.setHomeTitle(name);
    await application.ensureFirebaseUser();
    application.submitAccountAction();
    application.preloadGameAssets();
    const previous = settings.lastGameUpdatedAt,
      threshold = new Timestamp(Date.now(), 0, false).addMicroseconds(-timestampWindow.restore),
      canRestore = previous !== null && threshold.isBefore(previous);
    const mode = canRestore ? settings.lastMode : null,
      roomId = canRestore ? settings.lastRoomId : null;
    settings.clearRoomHistorySettings();
    settings.saveSettings();
    if (mode !== null && roomId !== null) application.isRestoringRoom = true;
    application.renderHomePage(mode, roomId);
  }
}
export function createUserNameEditor(): UserNameEditor {
  const element = document.createElement('div'),
    editor = new UserNameEditor(element);
  editor.applySurface({...surfaceSize.nameEditor, left: 300, top: 300});
  editor.renderUserNameEditor();
  return editor;
}
