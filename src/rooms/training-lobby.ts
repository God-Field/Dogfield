import {MAX_PLAYERS} from '../domain/constants';
import {roomAction} from '../services/protocol';
import {surfaceSize, radius, screen} from '../ui/theme';
import {colors} from '../ui/palette';
import { AnimatedElement, TextElement, createTextElement } from '../ui/elements';
import { ActionCard, Card } from '../ui/components';
import { PlayerCountOption } from '../ui/decorative';
import { getApplication, getSettings, state } from '../app/runtime';
import { RoomController } from './room-controller';
import { DrawTiebreakPanel, createDrawTiebreakPanel, createTiebreakPanel } from './tiebreak-controls';
import {sounds, playSound} from '../services/audio';
import { replaceFirst, UNSET, uninitialized } from '../shared/values';
import { createMessageBar } from '../ui/panels';
export class TrainingLobbyPanel extends AnimatedElement<HTMLDivElement> {
  constructor(public playerCount: PlayerCountButton, public tiebreak: DrawTiebreakPanel, element: HTMLDivElement) {
    super(element);
  }
  renderTrainingLobby(): void {
    const settings = getSettings(),
      application = getApplication();
    this.domElement.append(this.playerCount.domElement);
    this.tiebreak.updateTiebreak(settings.trainingTiebreakGF);
    this.tiebreak.setActionHandler(() => {
      playSound(sounds.click);
      application.createHomeDimmer(createTiebreakPanel(gf => {
        if (gf === this.tiebreak.selectedGf) return;
        this.tiebreak.updateTiebreak(gf);
        settings.trainingTiebreakGF = gf;
        settings.saveSettings();
      }));
    });
    this.domElement.append(this.tiebreak.domElement);
    const start = createMessageBar(state.translations.getPrivateText('startGame'), false);
    start.setPosition(300, 420);
    start.setActionHandler(submitStartGameRequest(this, application));
    this.domElement.append(start.domElement);
  }
}
export function createTrainingLobbyPanel(): TrainingLobbyPanel {
  const players = createPlayerCountButton(),
    tiebreak = createDrawTiebreakPanel();
  tiebreak.setPosition(440, 300);
  const element = document.createElement('div'),
    panel = new TrainingLobbyPanel(players, tiebreak, element);
  panel.applyElementStyles(element, screen.height, null, null, screen.width);
  panel.renderTrainingLobby();
  return panel;
}
export class PlayerCountButton extends ActionCard {
  private selectedCount: number | typeof UNSET = UNSET;
  constructor(public label: TextElement, element: HTMLDivElement) {
    super(element);
  }
  get count(): number {
    if (this.selectedCount === UNSET) return uninitialized('_count');
    return this.selectedCount;
  }
  renderPlayerCountButton(): void {
    this.applySurface({
      ...surfaceSize.playerCountButton, left: 240, top: 150, radius: radius.large,
      background: colors.lavender,
      border: {width: 4, color: colors.brandBlue}
    });
    this.label.setHeightLeftWidth(100, 10, 580);
    this.label.applyTextStyle(65, colors.brandBlue, true);
    this.domElement.append(this.label.domElement);
    this.initializeClickable();
    this.setActionHandler(() => {
      playSound(sounds.click);
      getApplication().createHomeDimmer(createPlayerCountPanel(this));
    });
    this.renderPlayerCount(getSettings().trainingPlayerCount ?? 2);
  }
  renderPlayerCount(count: number): void {
    this.selectedCount = count;
    this.label.domElement.textContent = replaceFirst(state.translations.getTrainingText('playerCount'), '{{count}}', String(count));
  }
}
export function createPlayerCountButton(): PlayerCountButton {
  const label = createTextElement('', null, null, null, null),
    element = document.createElement('div'),
    button = new PlayerCountButton(label, element);
  button.applyElementStyles(element, 100, 240, 150, 600);
  button.renderPlayerCountButton();
  return button;
}
export class PlayerCountPanel extends Card {
  constructor(public button: PlayerCountButton | undefined, element: HTMLDivElement) {
    super(element);
  }
  renderPlayerCountOptions(_button: PlayerCountButton | undefined): void {
    this.appendLabel({
      text: state.translations.getTrainingText('players'),
      height: 60, left: 10, top: 25, width: 460,
      size: 50, color: colors.brandBlue, bold: true, fit: true
    });
    for (let count = 2; count <= MAX_PLAYERS; count++) {
      const element = document.createElement('div'),
        option = new PlayerCountOption(element);
      option.renderCard({
        ...surfaceSize.playerOption, left: 20 + (count - 1) % 3 * 150, top: 100 + Math.trunc((count - 1) / 3) * 90, radius: radius.medium,
        background: colors.brandBlue,
        label: {
          text: replaceFirst(state.translations.getTrainingText('countOption'), '{{count}}', String(count)),
          height: 70, left: 10, top: null, width: 120,
          size: 50, color: colors.lavender, bold: true, fit: true
        }
      });
      option.applyAction(() => {
        playSound(sounds.click);
        getApplication().setHomeBanner(null);
        this.button!.renderPlayerCount(count);
        const settings = getSettings();
        settings.trainingPlayerCount = count === 2 ? null : count;
        settings.saveSettings();
      });
      this.domElement.append(element);
    }
  }
}
export function createPlayerCountPanel(button?: PlayerCountButton): PlayerCountPanel {
  const element = document.createElement('div'),
    panel = new PlayerCountPanel(button, element);
  panel.applySurface({...surfaceSize.menuPanel, left: 300, radius: radius.large, background: colors.lavender});
  panel.renderPlayerCountOptions(button);
  return panel;
}
export function submitStartGameRequest(panel: TrainingLobbyPanel, application: ReturnType<typeof getApplication>): () => Promise<null> {
  return async () => {
    playSound(sounds.click);
    const room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    await room.sendRoomActionWithPayload(roomAction.startGame, new Map<string, unknown>([['lang', state.language.key], ['playerCount', panel.playerCount.count], ['gf', panel.tiebreak.selectedGf]]));
    return null;
  };
}
