import {surfaceSize, radius} from '../ui/theme';
import {colors} from '../ui/palette';
import { AnimatedElement, createAnimatedContainer, createInteractiveElement } from '../ui/elements';
import { applySurface, appendLabel, Card } from '../ui/components';
import { TiebreakChoice } from '../ui/decorative';
import { getApplication, state } from '../app/runtime';
import {sounds, playSound} from '../services/audio';
import { createTiebreakBadge } from '../ui/stat-widgets';
import { TIEBREAK_VALUES } from '../domain/constants';
export type TiebreakSelection = (gf: number | null) => unknown;
export class DrawTiebreakPanel extends Card {
  selectedGf: number | null = null;
  private content: AnimatedElement | null = null;
  private action: (() => unknown) | null = null;
  constructor(public display: AnimatedElement, element: HTMLDivElement) {
    super(element);
  }
  updateTiebreak(gf: number | null): void {
    this.selectedGf = gf;
    this.content?.dispose(0);
    this.content = createAnimatedContainer(this.display.getHeight(), null, null, this.display.getWidth());
    this.display.domElement.append(this.content.domElement);
    if (gf === null) {
      const background = createAnimatedContainer(24, 40, 2, 120);
      applySurface(background, {...surfaceSize.smallPill, left: 40, top: 2, radius: radius.smallBadge, border: {width: 1, color: colors.mintLight}});
      appendLabel(background, {
        text: state.translations.getPrivateText('tiebreakNone'),
        height: 24, left: null, top: null, width: 120,
        size: 18, color: colors.mintLight, fit: true
      });
      this.content.domElement.append(background.domElement);
    } else {
      const badge = createTiebreakBadge(null);
      badge.domElement.style.left = '40px';
      badge.updateTiebreak(gf);
      this.content.domElement.append(badge.domElement);
    }
  }
  setActionHandler(action: () => unknown): void {
    if (this.action !== null) return;
    this.action = action;
    const button = createInteractiveElement(this.getHeight(), null, null, this.getWidth());
    applySurface(button, {height: this.getHeight(), width: this.getWidth(), radius: radius.medium});
    button.initializeClickable();
    button.setActionHandler(action);
    this.domElement.append(button.domElement);
  }
}
export function createDrawTiebreakPanel(): DrawTiebreakPanel {
  const display = createAnimatedContainer(28, null, 34, 200),
    element = document.createElement('div'),
    panel = new DrawTiebreakPanel(display, element);
  panel.applySurface({
    ...surfaceSize.drawTiebreak, radius: radius.medium,
    background: colors.brand,
    insetBorder: {width: 1, color: colors.mintLight, inset: 2}
  });
  panel.appendLabel({
    text: state.translations.getPrivateText('tiebreak'),
    height: 30, left: 10, top: 6, width: panel.getWidth() - 20,
    size: 24, color: colors.mintLight, bold: true, fit: true
  });
  element.append(display.domElement);
  return panel;
}
export class TiebreakPanel extends Card {
  renderTiebreakStatus(onSelect: TiebreakSelection): void {
    this.appendLabel({
      text: state.translations.getPrivateText('tiebreak'),
      height: 50, left: 10, top: 25, width: 460,
      size: 40, color: colors.mintLight, bold: true, fit: true
    });
    const tiebreakPositions: Record<number, [number, number]> = {
      1: [140, 90],
      50: [30, 160],
      75: [250, 160],
      100: [30, 230],
      150: [250, 230],
    };
    const choices: [number | null, number, number][] = [
      [null, 140, 300],
      ...TIEBREAK_VALUES.map((gf): [number, number, number] => [
        gf,
        ...tiebreakPositions[gf],
      ]),
    ];
    for (const [gf, left, top] of choices) {
      const element = document.createElement('div'),
        button = new TiebreakChoice(element);
      button.renderCard({
        ...surfaceSize.tiebreakChoice, left, top, radius: radius.panel,
        background: gf === null ? colors.brand : colors.mintLight,
        border: gf === null ? {width: 2, color: colors.mintLight} : undefined,
        label: {
          text: gf === null ? state.translations.getPrivateText('tiebreakNone') : '',
          height: 50, left: 10, top: null, width: 180,
          size: 35, color: gf === null ? colors.mintLight : colors.orangeDark, bold: gf !== null, fit: true,
          markup: gf === null ? undefined : `G.F.<span style="color: ${colors.pinkLight}">${gf}</span>`
        }
      });
      button.applyAction(() => {
        playSound(sounds.click);
        getApplication().setHomeBanner(null);
        onSelect(gf);
      });
      this.domElement.append(element);
    }
  }
}
export function createTiebreakPanel(onSelect: TiebreakSelection): TiebreakPanel {
  const element = document.createElement('div'),
    panel = new TiebreakPanel(element);
  panel.applySurface({
    ...surfaceSize.menuPanel, left: 300, radius: radius.large,
    background: colors.brand,
    border: {width: 2, color: colors.mintLight}
  });
  panel.renderTiebreakStatus(onSelect);
  return panel;
}
