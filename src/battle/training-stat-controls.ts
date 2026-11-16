import {surfaceSize, radius} from '../ui/theme';
import {colors} from '../ui/palette';
import { AnimatedElement, createTextElement } from '../ui/elements';
import { ActionCard } from '../ui/components';
import { TrainingStatDisplay, createTrainingStatDisplay } from '../ui/stat-widgets';
import { Team } from '../domain/enums';
import {isStatTransferEnabled} from '../engine/stats';
import {sounds, playSound} from '../services/audio';

const stepperButtonTops: ReadonlyMap<number, number> = new Map([
  [10, 60],
  [1, 120],
  [-1, 240],
  [-10, 300],
]);

interface TrainingTarget {
  team: Team;
  hp: number;
  mp: number;
  cp: number;
}
export class TrainingStatControls extends AnimatedElement<HTMLDivElement> {
  constructor(public statDisplay: TrainingStatDisplay, public hpMpButtons: StepperButton[], public hpCpButtons: StepperButton[], element: HTMLDivElement) {
    super(element);
  }
  renderTrainingStatControls(_target: TrainingTarget): void {
    this.statDisplay.domElement.style.top = '180px';
    this.domElement.append(this.statDisplay.domElement);
    for (const amount of [10, 1, -1, -10]) {
      const button = createStepperButton(amount);
      button.domElement.style.left = '180px';
      button.setActionHandler(() => {
        playSound(sounds.increase);
        this.statDisplay.adjustHpAndMp(amount);
        this.updateTrainingStatButtons();
      });
      this.domElement.append(button.domElement);
      this.hpMpButtons.push(button);
    }
    for (const amount of [10, 1, -1, -10]) {
      const button = createStepperButton(amount);
      button.domElement.style.left = '320px';
      button.setActionHandler(() => {
        playSound(sounds.increase);
        this.statDisplay.adjustHpAndCp(amount);
        this.updateTrainingStatButtons();
      });
      this.domElement.append(button.domElement);
      this.hpCpButtons.push(button);
    }
    this.updateTrainingStatButtons();
  }
  updateTrainingStatButtons(): void {
    const {hp, mp, cp} = this.statDisplay;
    for (const button of this.hpMpButtons) button.setDisabled(!isStatTransferEnabled(hp, mp, button.amount));
    for (const button of this.hpCpButtons) button.setDisabled(!isStatTransferEnabled(hp, cp, button.amount));
  }
}
export function createTrainingStatControls(target: TrainingTarget): TrainingStatControls {
  const display = createTrainingStatDisplay(target.team, target.hp, target.mp, target.cp),
    element = document.createElement('div'),
    controls = new TrainingStatControls(display, [], [], element);
  controls.applyElementStyles(element, 350, 200, null, 440);
  controls.renderTrainingStatControls(target);
  return controls;
}
export class StepperButton extends ActionCard {
  constructor(public amount: number, element: HTMLDivElement) {
    super(element);
  }
  renderStepperButton(_amount: number): void {
    const top = stepperButtonTops.get(this.amount);
    if (top === undefined) throw new TypeError();
    this.renderCard({
      ...surfaceSize.stepper, top, radius: radius.medium,
      background: colors.oliveBright,
      insetBorder: {width: 2, color: colors.amberPale, inset: 4},
      label: {
        text: this.amount > 0 ? `+${this.amount}` : String(this.amount),
        height: 50, left: null, top: null, width: 120,
        size: 35, color: colors.amberPale, bold: true, fit: true
      }
    });
    this.initializeClickable();
  }
}
export function createStepperButton(amount: number): StepperButton {
  const element = document.createElement('div'),
    button = new StepperButton(amount, element);
  button.applyElementStyles(element, 50, null, null, 120);
  button.renderStepperButton(amount);
  return button;
}
