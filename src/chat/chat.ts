import {roomAction, firestoreDocument} from '../services/protocol';
import {surfaceSize, radius, timestampWindow, layer, screen, duration} from '../ui/theme';
import {colors} from '../ui/palette';
import {HISTORY_ICON, TEAM_CHAT_ICON, ALL_CHAT_ICON} from '../ui/icons';
import { AnimatedElement, ImageContainer, TextElement, KeydownHandler, createAnimatedContainer, createImageContainer, createTextElement, createTextInput, runScheduledCallback } from '../ui/elements';
import { ActionCard, applySurface } from '../ui/components';
import { ChatLogEntry, ChatMessageContainer } from '../ui/decorative';
import { ChatInput, LargeTextLabel } from '../ui/stat-widgets';
import { createChatVisibilityToggle, ChatVisibilityToggle } from '../ui/audio-controls';
import { getMeasuringElement } from '../ui/measurement';
import { getApplication, state } from '../app/runtime';
import type { HomePage } from '../app/home-page';
import { ChatMessage } from '../domain/models';
import { Team, TeamSolo } from '../domain/enums';
import { MAX_CHAT_MESSAGES_PER_USER } from '../domain/constants';
import { RoomController } from '../rooms/room-controller';
import { Timestamp } from '../shared/timestamp';
import { trimText, stringify } from '../shared/values';
import { subscribeToFirestoreDocument } from '../services/firebase';
import {sounds, playSound} from '../services/audio';
export class ChatLog extends AnimatedElement<HTMLDivElement> {
  constructor(public messageEntries: ChatLogEntry[], element: HTMLDivElement) {
    super(element);
  }
  getContentHeight(): number {
    return this.messageEntries.reduce((height, entry) => height + entry.getHeight() + 1, 0);
  }
  appendMessage(message: ChatMessage): void {
    while (this.getContentHeight() > this.getHeight() + 50) this.messageEntries.shift()!.dispose(0);
    const element = document.createElement('div'),
      entry = new ChatLogEntry(element);
    entry.applyElementStyles(element, 25, null, null, 550);
    const prefix = stringify(message.sender) + ': ';
    const text = createTextElement(prefix + message.messageText, null, null, null, null),
      measure = getMeasuringElement().domElement;
    text.domElement.style.fontSize = '20px';
    text.domElement.style.fontWeight = 'bold';
    measure.textContent = text.getText();
    measure.style.fontWeight = 'bold';
    measure.style.fontSize = '20px';
    const width = measure.offsetWidth;
    measure.textContent = '';
    if (width > entry.getWidth()) element.style.height = '50px';
    const sender = createSmallTextLabel(prefix);
    sender.applyTextStyle(20, colors.brand, true);
    sender.setTextShadow(colors.mintLight);
    element.append(sender.domElement);
    const body = createSmallTextLabel(message.messageText);
    body.applyTextStyle(20, message.isTeamMessage ? colors.periwinkle : colors.mintLight, true);
    body.setTextShadow(message.isTeamMessage ? colors.mintLight : colors.text);
    element.append(body.domElement);
    element.style.left = '15px';
    this.domElement.append(element);
    this.messageEntries.push(entry);
    let top = this.getHeight() - this.getContentHeight();
    for (const line of this.messageEntries) {
      line.domElement.style.top = `${top}px`;
      top += line.getHeight() + 1;
    }
  }
}
export class ChatMessageView extends ActionCard {
  constructor(public iconWidget: ImageContainer, public textWidget: TextElement, element: HTMLDivElement) {
    super(element);
  }
  setMessageMarkup(markup: string, color: string): void {
    this.iconWidget.domElement.innerHTML = markup;
    this.iconWidget.domElement.style.color = color;
  }
  setMessageText(text: string, color: string): void {
    this.textWidget.domElement.style.textAlign = 'left';
    this.textWidget.domElement.textContent = text;
    this.textWidget.applyNormalTextStyle(20, color);
    this.textWidget.fitFontSize();
  }
}
export class ChatPanel extends AnimatedElement<HTMLDivElement> {
  isTeamAudience = false;
  isProcessingMessages = false;
  allMessagesUnsubscribe: (() => void) | null = null;
  teamMessagesUnsubscribe: (() => void) | null = null;
  constructor(public audienceBackground: AnimatedElement, public input: KeydownHandler, public audienceButton: ChatMessageView, public historyButton: ChatMessageView, public visibilityToggle: ChatVisibilityToggle, public floatingMessages: AnimatedElement, public history: ChatLog, public pendingMessages: ChatMessage[], public visibleMessages: ChatMessage[], public allMessagesStartedAt: Timestamp, public teamMessagesStartedAt: Timestamp, element: HTMLDivElement) {
    super(element);
  }
  renderChatPanel(): void {
    this.domElement.append(this.audienceBackground.domElement);
    this.input.setBorderRadius(radius.small);
    this.input.setBackgroundColor(colors.inputYellow);
    this.input.applyNormalTextStyle(20, colors.text);
    this.input.domElement.maxLength = 50;
    this.input.setKeydownHandler(handleChatInput(this));
    this.domElement.append(this.input.domElement);
    this.audienceButton.domElement.style.left = '290px';
    this.audienceButton.setActionHandler(() => {
      playSound(sounds.click);
      this.setChatAudience(!this.isTeamAudience);
    });
    this.domElement.append(this.audienceButton.domElement);
    this.setChatAudience(false);
    this.historyButton.domElement.style.left = '470px';
    this.historyButton.setMessageMarkup(HISTORY_ICON, colors.brand);
    this.historyButton.setMessageText(state.translations.getPrivateText('chatLog'), colors.brand);
    this.historyButton.setActionHandler(() => {
      playSound(sounds.click);
      this.setChatHistoryVisible(!this.history.domElement.isConnected);
    });
    this.domElement.append(this.historyButton.domElement);
    this.visibilityToggle.domElement.style.left = '650px';
    this.domElement.append(this.visibilityToggle.domElement);
    const room = getApplication().dialog;
    if (!(room instanceof RoomController)) throw new Error('Chat requires an active room');
    room.domElement.append(this.floatingMessages.domElement);
  }
  private getPlayerTeam(): Team | null {
    const application = getApplication(),
      room = application.dialog;
    return room instanceof RoomController ? room.gamePage?.playerRoster.findPlayerStatById(application.userId)?.team ?? null : null;
  }
  setChatAudience(teamOnly: boolean): void {
    this.isTeamAudience = teamOnly && this.getPlayerTeam() !== null;
    const color = this.isTeamAudience ? colors.periwinkle : colors.brand;
    this.audienceBackground.setBackgroundColor(this.isTeamAudience ? colors.periwinkle : null);
    this.input.domElement.style.color = this.isTeamAudience ? colors.periwinkle : colors.text;
    this.audienceButton.setMessageMarkup(this.isTeamAudience ? TEAM_CHAT_ICON : ALL_CHAT_ICON, color);
    this.audienceButton.setMessageText(state.translations.getPrivateText(this.isTeamAudience ? 'chatToTeam' : 'chatToAll'), color);
  }
  refreshTeamChatSubscription(): void {
    if (this.allMessagesUnsubscribe === null) this.allMessagesUnsubscribe = this.subscribeToAllRoomMessages();
    const team = this.getPlayerTeam();
    if (team === null) {
      if (this.teamMessagesUnsubscribe !== null) {
        this.teamMessagesUnsubscribe();
        this.teamMessagesUnsubscribe = null;
        this.setChatAudience(false);
      }
    } else if (team !== TeamSolo && this.teamMessagesUnsubscribe === null) this.teamMessagesUnsubscribe = this.subscribeToPrivateRoomMessages(team);
  }
  isWithinChatHistoryWindow(teamOnly: boolean): boolean {
    return new Timestamp(Date.now(), 0, false).isBefore((teamOnly ? this.teamMessagesStartedAt : this.allMessagesStartedAt).addMicroseconds(timestampWindow.chatHistory));
  }
  subscribeToPrivateRoomMessages(team: Team | null): (() => void) | null {
    const application = getApplication(),
      roomId = application.roomId;
    if (roomId === null) return null;
    const now = new Timestamp(Date.now(), 0, false);
    if (team === null) {
      this.allMessagesStartedAt = now;
    } else {
      this.teamMessagesStartedAt = now;
    }
    const audience = team === null ? 'all' : `team${team.key}`;
    return subscribeToFirestoreDocument(firestoreDocument.roomMessages(roomId, audience), handleIncomingChatMessage(this, team !== null, application));
  }
  subscribeToAllRoomMessages(): (() => void) | null {
    return this.subscribeToPrivateRoomMessages(null);
  }
  countMessagesFromUser(userId: string | null): number {
    return [...this.pendingMessages, ...this.visibleMessages].filter(message => message.userId === userId).length;
  }
  async appendMessage(message: ChatMessage): Promise<null> {
    if (this.isProcessingMessages) {
      this.pendingMessages.push(message);
      return null;
    }
    this.isProcessingMessages = true;
    runScheduledCallback(this.renderChatMessage(message));
    const result = await this.animateAsync(duration.message);
    this.isProcessingMessages = false;
    if (this.pendingMessages.length !== 0) runScheduledCallback(this.appendMessage(this.pendingMessages.shift()!));
    return result;
  }
  async renderChatMessage(message: ChatMessage): Promise<null> {
    this.history.appendMessage(message);
    this.visibleMessages.push(message);
    const element = document.createElement('div'),
      container = new ChatMessageContainer(element);
    container.applyElementStyles(element, 100, null, null, 1060);
    element.style.left = '10px';
    element.style.pointerEvents = 'none';
    const sender = createLargeTextElement(stringify(message.sender) + ': ');
    sender.applyTextStyle(40, colors.brand, true);
    sender.setTextShadow(colors.mintLight);
    element.append(sender.domElement);
    const body = createLargeTextElement(message.messageText);
    body.applyTextStyle(40, message.isTeamMessage ? colors.periwinkle : colors.mintLight, true);
    body.setTextShadow(message.isTeamMessage ? colors.mintLight : colors.text);
    element.append(body.domElement);
    element.style.top = '660px';
    this.floatingMessages.domElement.append(element);
    await container.animateToPosition({top: -120}, duration.chatScroll, null);
    container.dispose(0);
    const index = this.visibleMessages.indexOf(message);
    if (index >= 0) this.visibleMessages.splice(index, 1);
    return null;
  }
  setChatHistoryVisible(visible: boolean): void {
    const application = getApplication();
    if (application.referenceMenu.domElement.isConnected) {
      application.setReferenceMenuVisible(false);
      application.setHomeBanner(this.history);
    } else application.setHomeBanner(visible ? this.history : null);
  }
  override dispose(_unused?: unknown): void {
    this.allMessagesUnsubscribe?.();
    this.teamMessagesUnsubscribe?.();
    this.floatingMessages.dispose(0);
    this.disposeElement(0);
  }
}
export function handleChatInput(panel: ChatPanel): (key: string) => Promise<null> {
  return async key => {
    switch (key) {
      case 'ArrowUp':
        playSound(sounds.click);
        panel.setChatAudience(!panel.isTeamAudience);
        return null;
      case 'ArrowDown':
        playSound(sounds.click);
        panel.setChatHistoryVisible(!panel.history.domElement.isConnected);
        return null;
      case 'Enter':
        break;
      default:
        return null;
    }
    if (panel.isWithinChatHistoryWindow(panel.isTeamAudience)) return null;
    const application = getApplication();
    if (
      panel.countMessagesFromUser(application.userId) >=
      MAX_CHAT_MESSAGES_PER_USER
    ) return null;
    const input = panel.input.domElement,
      text = trimText(input.value);
    if (text.length === 0) return null;
    input.value = '';
    const room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('Chat requires an active room');
    const team = room.gamePage?.playerRoster.findPlayerStatById(application.userId)?.team ?? null;
    if (panel.isTeamAudience && team === null) return null;
    return await room.sendRoomActionWithPayload(roomAction.postMessage, new Map<string, unknown>([['text', text], ['team', panel.isTeamAudience ? team!.key : null]]));
  };
}
export function handleIncomingChatMessage(panel: ChatPanel, teamOnly: boolean, application: HomePage): (data: Map<string, unknown>) => void {
  return data => {
    if (data.size === 0 || panel.isWithinChatHistoryWindow(teamOnly)) return;
    const userId = data.get('userId'),
      text = data.get('text'),
      message = new ChatMessage(typeof userId === 'string' ? userId : '', typeof text === 'string' ? text : '');
    const room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('Chat requires an active room');
    message.sender = room.getRoomUserName(message.userId);
    message.isTeamMessage = teamOnly;
    if (
      message.sender === null ||
      panel.countMessagesFromUser(message.userId) >=
        MAX_CHAT_MESSAGES_PER_USER
    ) return;
    runScheduledCallback(panel.appendMessage(message));
  };
}
export function createChatPanel(): ChatPanel {
  const background = createAnimatedContainer(30, null, null, 470),
    input = createTextInput(24, 5, 3, 280);
  applySurface(background, {...surfaceSize.chatBar});
  const audience = createChatMessageView(),
    historyButton = createChatMessageView(),
    toggle = createChatVisibilityToggle(),
    messages = createAnimatedContainer(screen.height, null, null, screen.width);
  applySurface(messages, {height: screen.height, width: screen.width});
  messages.domElement.style.zIndex = layer.overlay;
  messages.domElement.style.pointerEvents = 'none';
  const logElement = document.createElement('div'),
    log = new ChatLog([], logElement);
  log.applyElementStyles(logElement, screen.height, 500, null, 580);
  const logBackground = createAnimatedContainer(screen.height, 10, null, 560);
  applySurface(logBackground, {height: screen.height, left: 10, width: 560, background: colors.chatGreen});
  logElement.append(logBackground.domElement);
  const border = createAnimatedContainer(screen.height, null, null, 580);
  border.setBorderLeft(10, colors.brand);
  border.setBorderRight(10, colors.brand);
  logElement.append(border.domElement);
  const allStarted = Date.now(),
    teamStarted = Date.now(),
    element = document.createElement('div');
  const panel = new ChatPanel(background, input, audience, historyButton, toggle, messages, log, [], [], new Timestamp(allStarted, 0, false), new Timestamp(teamStarted, 0, false), element);
  panel.applyElementStyles(element, 30, 210, null, 680);
  panel.renderChatPanel();
  return panel;
}
export function createChatMessageView(): ChatMessageView {
  const icon = createImageContainer(null, 24, 15, 3, 24),
    text = createTextElement('', 24, 42, 3, 123),
    element = document.createElement('div'),
    view = new ChatMessageView(icon, text, element);
  view.applyElementStyles(element, 30, null, null, 180);
  const background = createAnimatedContainer(24, 10, 3, 160);
  applySurface(background, {...surfaceSize.chatBadge, left: 10, top: 3, radius: radius.small, background: colors.mintLight});
  element.append(background.domElement);
  element.append(icon.domElement);
  element.append(text.domElement);
  view.initializeClickable();
  return view;
}
export function createLargeTextElement(text: string): ChatInput {
  const element = document.createElement('span'),
    label = new ChatInput(element);
  label.applyElementStyles(element, 50, null, null, null);
  label.setText(text, 50, null, null, null);
  element.style.fontSize = '40px';
  element.style.fontWeight = 'bold';
  element.style.position = '';
  return label;
}
export function createSmallTextLabel(text: string): LargeTextLabel {
  const element = document.createElement('span'),
    label = new LargeTextLabel(element);
  label.applyElementStyles(element, 25, null, null, null);
  label.setText(text, 25, null, null, null);
  element.style.fontSize = '20px';
  element.style.position = '';
  return label;
}
