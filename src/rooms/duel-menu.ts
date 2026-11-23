import {BASE_RATING} from '../domain/constants';
import {cloudFunction, firestoreDocument} from '../services/protocol';
import {surfaceSize, radius, screen} from '../ui/theme';
import {colors} from '../ui/palette';
import {RANKING_ICON} from '../ui/icons';
import { AnimatedElement, createAnimatedContainer, createImageContainer } from '../ui/elements';
import { ActionCard, Card, applySurface, appendLabel } from '../ui/components';
import { DisposablePanel, DuelRecordRow } from '../ui/decorative';
import { createScreenBackground } from '../ui/assets';
import { getApplication, state } from '../app/runtime';
import { GameModeDuel } from '../domain/enums';
import {sounds, playSound} from '../services/audio';
import { callCloudFunction, loadFirestoreDocument } from '../services/firebase';
import { replaceFirst } from '../shared/values';
import { createMessageBar } from '../ui/panels';
export class DuelMenu extends DisposablePanel {
  constructor(public rankingButton: RankingButton, element: HTMLDivElement) {
    super(element);
  }
  renderMenuPanel(): void {
    this.domElement.append(createScreenBackground('menu').domElement);
    const start = createMessageBar(state.translations.getDuelText('start'), false);
    start.setPosition(300, 280);
    start.setActionHandler(async () => {
      playSound(sounds.click);
      start.dispose(0);
      await getApplication().createRoomWithLanguage(GameModeDuel, state.language);
      return null;
    });
    this.domElement.append(start.domElement);
    const element = document.createElement('div'),
      records = new DuelRecordSummary(element);
    records.applyElementStyles(element, 160, null, null, 300);
    void records.loadRecords();
    records.setPosition(390, 460);
    this.domElement.append(element);
    getApplication().footer.domElement.append(this.rankingButton.domElement);
  }
  override dispose(_unused?: unknown): void {
    this.rankingButton.dispose(0);
    this.disposeElement(0);
  }
}
export class RankingPanel extends Card {
  constructor(public content: AnimatedElement, element: HTMLDivElement) {
    super(element);
  }
}
export class RankingButton extends ActionCard {
  records: DuelRankingRecords | null = null;
  constructor(public panel: RankingPanel, element: HTMLDivElement) {
    super(element);
  }
  renderRankingButton(): void {
    const background = createAnimatedContainer(24, 10, 3, 180);
    applySurface(background, {...surfaceSize.headerButton, left: 10, top: 3, radius: radius.small, background: colors.mintLight});
    const icon = createImageContainer(RANKING_ICON, 24, 10, null, 24);
    icon.domElement.style.color = colors.brand;
    background.domElement.append(icon.domElement);
    appendLabel(background, {
      text: state.translations.getDuelText('ranking'),
      height: 24, left: 40, top: null, width: 100,
      size: 20, color: colors.brand
    });
    this.domElement.append(background.domElement);
    this.applyAction(() => this.toggleRanking());
  }
  private async toggleRanking(): Promise<null> {
    playSound(sounds.click);
    const application = getApplication();
    if (this.panel.domElement.isConnected) {
      application.setHomeBanner(null);
    } else {
      application.setHomeBanner(this.panel);
      if (this.records === null) {
        const element = document.createElement('div');
        this.records = new DuelRankingRecords(element);
        this.records.applyElementStyles(element, null, null, null, 560);
        await this.records.loadRecords();
        this.panel.domElement.style.visibility = '';
      }
      this.panel.content.domElement.append(this.records.domElement);
    }
    return null;
  }
}
export class DuelRankingRecords extends AnimatedElement<HTMLDivElement> {
  async loadRecords(): Promise<null> {
    const data = await loadFirestoreDocument(firestoreDocument.duelRankings),
      value = data.get('records'),
      records: unknown[] = Array.isArray(value) ? value : [];
    let previousRating: number | null = null,
      previousRank = 0;
    for (const [index, value] of records.entries()) {
      const record: Map<string, unknown> = value instanceof Map ? value : new Map(),
        name = record.get('userName'),
        ratingValue = record.get('rating');
      const userName = typeof name === 'string' ? name : '',
        rating = typeof ratingValue === 'number' && Number.isInteger(ratingValue) ? ratingValue : 0,
        rank = rating === previousRating ? previousRank : index + 1;
      const element = document.createElement('div'),
        row = new DuelRecordRow(element);
      row.applySurface({...surfaceSize.rankingRow, radius: radius.small, background: colors.roseWhisper});
      row.appendLabel({text: String(rank), height: 30, left: null, top: null, width: 80, size: 25, color: colors.pink, bold: true, fit: true});
      row.appendLabel({text: userName, height: 30, left: 80, top: null, width: 350, size: 25, color: colors.brand, bold: true, align: 'left', fit: true});
      row.appendLabel({text: String(BASE_RATING + rating), height: 30, left: 430, top: null, width: 100, size: 25, color: colors.blue, bold: true, fit: true});
      element.style.contentVisibility = 'auto';
      element.style.left = '5px';
      element.style.top = `${3 + 33 * index}px`;
      this.domElement.append(element);
      previousRating = rating;
      previousRank = rank;
    }
    this.domElement.style.height = `${3 + 33 * records.length}px`;
    return null;
  }
}
export class DuelRecordSummary extends Card {
  async loadRecords(): Promise<null> {
    const data = await callCloudFunction(cloudFunction.getRecord, {mode: 'duel'}),
      ratingValue = data.get('rating'),
      countValue = data.get('gameCount');
    const rating = typeof ratingValue === 'number' && Number.isInteger(ratingValue) ? ratingValue : 0,
      count = typeof countValue === 'number' && Number.isInteger(countValue) ? countValue : 0;
    this.applySurface({height: this.getHeight(), width: this.getWidth(), radius: radius.large, background: colors.pink});
    const texts = state.translations;
    const heading = createAnimatedContainer(40, null, null, 300);
    appendLabel(heading, {text: texts.getDuelText('rating'), height: 40, left: 20, top: null, width: 260, size: 25, color: colors.roseWhisper, bold: true, fit: true});
    this.domElement.append(heading.domElement);
    const background = createAnimatedContainer(80, 5, 40, 290);
    applySurface(background, {...surfaceSize.summaryValue, left: 5, top: 40, background: colors.roseWhisper});
    appendLabel(background, {text: String(BASE_RATING + rating), height: 80, left: 10, top: null, width: 280, size: 50, color: colors.blue, bold: true, fit: true});
    this.domElement.append(background.domElement);
    const footer = createAnimatedContainer(40, null, 120, 300);
    appendLabel(footer, {text: replaceFirst(texts.getDuelText('gameCount'), '{{count}}', String(count)), height: 40, left: 20, top: null, width: 260, size: 25, color: colors.roseWhisper, align: 'right', fit: true});
    this.domElement.append(footer.domElement);
    return null;
  }
}
export function createDuelMenu(): DuelMenu {
  const ranking = createRankingButton(),
    element = document.createElement('div'),
    menu = new DuelMenu(ranking, element);
  menu.applyElementStyles(element, screen.height, null, 30, screen.width);
  menu.renderMenuPanel();
  return menu;
}
export function createRankingButton(): RankingButton {
  const content = createAnimatedContainer(screen.height, 10, null, 560);
  content.domElement.style.overflowY = 'scroll';
  const panelElement = document.createElement('div'),
    panel = new RankingPanel(content, panelElement);
  panel.applySurface({height: screen.height, left: 250, width: 580});
  panelElement.style.visibility = 'hidden';
  const background = createAnimatedContainer(screen.height, null, null, 580);
  applySurface(background, {height: screen.height, width: 580, background: colors.pink});
  panelElement.append(background.domElement);
  panelElement.append(content.domElement);
  const element = document.createElement('div'),
    button = new RankingButton(panel, element);
  button.applyElementStyles(element, 30, 440, null, 200);
  button.renderRankingButton();
  return button;
}
