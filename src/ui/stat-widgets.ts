import {radius} from './theme';
import { Team } from '../domain/enums';
import {colors, teamBackgroundColor, teamBorderColor} from './palette';
import { state } from '../app/state';
import { AnimatedElement, TextElement, createTextElement } from './elements';
import { Card } from './components';
import { parseInteger } from '../shared/values';
import { transferStat } from '../engine/stats';
export class ChatInput extends TextElement {
  constructor(element: HTMLSpanElement) {
    super(element);
  }
}
export class LargeTextLabel extends TextElement {
  constructor(element: HTMLSpanElement) {
    super(element);
  }
}
export class StatLabel extends TextElement {
  constructor(element: HTMLSpanElement) {
    super(element);
  }
}
export class StatValue extends TextElement {
  constructor(element: HTMLSpanElement) {
    super(element);
  }
}
export class SmallStatLabel extends TextElement {
  constructor(element: HTMLSpanElement) {
    super(element);
  }
}
export class SmallStatValue extends TextElement {
  constructor(element: HTMLSpanElement) {
    super(element);
  }
}
export class TiebreakBadge extends Card {
  currentCount = 0;
  constructor(
    public countLabel: TextElement,
    public maxCount: number | null,
    element: HTMLDivElement,
  ) {
    super(element);
  }
  isTiebreakComplete(): boolean {
    return this.maxCount !== null && this.currentCount >= this.maxCount;
  }
  updateTiebreak(count: number): void {
    this.currentCount = count;
    const text = this.maxCount === null ? String(count) : `${count} /${this.maxCount}`;
    this.countLabel.domElement.innerHTML = `G.F.<span style="color: ${colors.pinkLight}">${text}</span>`;
    if (this.isTiebreakComplete()) this.setBackgroundColor(colors.ink);
  }
}
export class TrainingStatDisplay extends AnimatedElement<HTMLDivElement> {
  constructor(
    public hpLabel: TextElement,
    public mpLabel: TextElement,
    public cpLabel: TextElement,
    public hp: number,
    public mp: number,
    public cp: number,
    element: HTMLDivElement,
  ) {
    super(element);

    this.renderValues();
  }

  adjustHpAndMp(amount: number): void {
    const next = transferStat(this.hp, this.mp, amount);
    this.hp = next.hp;
    this.mp = next.target;
    this.renderValues();
  }

  adjustHpAndCp(amount: number): void {
    const next = transferStat(this.hp, this.cp, amount);
    this.hp = next.hp;
    this.cp = next.target;
    this.renderValues();
  }

  private renderValues(): void {
    this.hpLabel.setText(String(this.hp));
    this.mpLabel.setText(String(this.mp));
    this.cpLabel.setText(String(this.cp));
  }
}
export function createStatLabel(text: string): StatLabel {
  const element = document.createElement('span'),
    label = new StatLabel(element);
  label.applyElementStyles(element, 50, null, null, 60);
  label.setText(text, 50, null, null, 60);
  element.style.textAlign = 'right';
  label.applyTextStyle(30, colors.slate, true);
  return label;
}
export function createStatValue(): StatValue {
  const element = document.createElement('span'),
    label = new StatValue(element);
  label.applyElementStyles(element, 50, null, null, 70);
  label.setText('', 50, null, null, 70);
  element.style.textAlign = 'right';
  label.applyTextStyle(40, colors.text, true);
  return label;
}
export function createTrainingStatDisplay(team: Team, hp: number, mp: number, cp: number): TrainingStatDisplay {
  const hpValue = createStatValue(),
    mpValue = createStatValue(),
    cpValue = createStatValue(),
    element = document.createElement('div'),
    display = new TrainingStatDisplay(hpValue, mpValue, cpValue, hp, mp, cp, element);
  display.applyElementStyles(element, 50, null, null, 440);
  element.style.borderTopLeftRadius = '25px';
  element.style.borderBottomLeftRadius = '25px';
  display.setBackgroundColor(teamBackgroundColor(team));
  display.addBorderOverlay(1, teamBorderColor(team)!);
  const hpLabel = createStatLabel(state.translations.getGameText('hp'));
  hpLabel.domElement.style.left = '10px';
  element.append(hpLabel.domElement);
  hpValue.domElement.style.left = '70px';
  element.append(hpValue.domElement);
  const mpLabel = createStatLabel(state.translations.getGameText('mp'));
  mpLabel.domElement.style.left = '150px';
  element.append(mpLabel.domElement);
  mpValue.domElement.style.left = '205px';
  element.append(mpValue.domElement);
  const cpLabel = createStatLabel(state.translations.getGameText('cp'));
  cpLabel.domElement.style.left = '280px';
  element.append(cpLabel.domElement);
  cpValue.domElement.style.left = '340px';
  element.append(cpValue.domElement);
  hpValue.domElement.textContent = String(hp);
  mpValue.domElement.textContent = String(mp);
  cpValue.domElement.textContent = String(cp);
  return display;
}

export function createTiebreakBadge(maximum: number | null): TiebreakBadge {
  const label = createTextElement('', null, null, null, null);
  const width = maximum == null ? 120 : 160;
  const element = document.createElement('div');
  const badge = new TiebreakBadge(label, maximum, element);
  badge.applySurface({
    height: 28, width, radius: radius.tiebreak,
    background: colors.mintLight,
    edgeBorder: {width: 2, color: colors.brand}
  });
  label.setSize(badge.getHeight() - 4, badge.getWidth() - 4);
  label.applyTextStyle(20, colors.orangeDark, true);
  element.append(label.domElement);
  return badge;
}
