import {opacity, duration} from '../ui/theme';
import {colors} from '../ui/palette';
import {AnimatedElement, InteractiveElement, createAnimatedContainer, createInteractiveElement} from '../ui/elements';
import {SmallStatLabel, SmallStatValue} from '../ui/stat-widgets';
import {STARTING_CP, STARTING_HP, STARTING_MP} from '../domain/constants';
import type {ItemDefinition, ItemSlot, PlayerStatus} from '../domain/models';
import {
  CategoryMiracles,
  EasingEaseIn,
  TeamSolo
} from '../domain/enums';
import type {Curse, Guardian, Team} from '../domain/enums';
import {findRequired, removeEntry, removeValue} from '../shared/collections';
import {compare, indexError, invalidState, parseInteger, replaceAll, uninitialized, UNSET} from '../shared/values';
import {changeCp, changeHp, changeMp} from '../engine/stats';
import {findVisibleStatusEffect as findVisibleCurse, hasStatusEffect, isVisibleStatusEffect} from '../engine/status-effects';
import {applySurface} from '../ui/components';
import {getApplication, state} from '../app/runtime';
import {RoomController} from '../rooms/room-controller';
import {
  CurseIcon,
  ElementBadge,
  GuardianIcon,
  PlayerNameRow,
  StatGainRow,
  createCurseIconWidget,
  createElementBadge,
  createGuardianIconWidget,
  createPlayerNameRow
} from './status-widgets';

export class PlayerStatusList extends AnimatedElement<HTMLDivElement> {
  constructor(public headerWidget: PlayerNameRow, public commandList: ElementBadge[], element: HTMLDivElement) {
    super(element);
  }
  removeCommand(input: ItemDefinition): void {
    const badge = findRequired(this.commandList, candidate => candidate.model === input);
    badge.dispose(0);
    removeValue(this.commandList, badge);
  }
  clearCommands(): void {
    for (const badge of this.commandList) badge.dispose(0);
    this.commandList.length = 0;
  }
  arrangeCommands(): void {
    const commands = this.commandList;
    commands.sort((firstBadge, secondBadge) => compare(firstBadge.model.id, secondBadge.model.id));
    const count = commands.length;
    const container = this.domElement;
    const header = this.headerWidget.domElement;
    const compact = count <= 5;
    for (let index = 0; index < count; index++) {
      if (!(index < commands.length)) return indexError(commands, index);
      const badge = commands[index];
      const leftText = header.style.width;
      const left = leftText.length === 0 ? 0 : parseInteger(replaceAll(leftText, 'px', ''));
      const offset = compact ? index * 40 : count === 1 ? 0 : Math.trunc((index * 180) / (count - 1));
      badge.domElement.style.left = `${left + offset}px`;
      container.append(badge.domElement);
    }
  }
}

export class PlayerStatusPanel extends AnimatedElement<HTMLDivElement> {
  hp = STARTING_HP;
  mp = STARTING_MP;
  cp = STARTING_CP;
  dead = false;
  guardianIcon: GuardianIcon | null = null;
  turnHighlight: AnimatedElement | null = null;
  confusionCount = 0;
  confusionOverlay: AnimatedElement | null = null;
  ratingGainRow: StatGainRow | null = null;

  constructor(
    public playerId: number,
    public userId: string | null,
    public name: string,
    public alias: string | null,
    public team: Team,
    public isBot: boolean,
    public outerContainer: AnimatedElement,
    public statusContainer: AnimatedElement,
    public nameRow: PlayerNameRow,
    public hpLabel: SmallStatValue,
    public mpLabel: SmallStatValue,
    public cpLabel: SmallStatValue,
    public curseIcons: Map<Curse, CurseIcon>,
    public usedMiracles: PlayerStatusList,
    public selectionOverlay: InteractiveElement,
    element: HTMLDivElement
  ) {
    super(element);
  }
  renderCombatCounters(player: PlayerStatus): void {
    const translations = state.translations;
    this.outerContainer.setSize(this.getHeight(), this.getWidth());
    this.statusContainer.setSize(this.getHeight(), this.getWidth());
    const statusContainer = this.nameRow;
    const hpLabel = createSmallStatLabel(translations.getGameText('hp')).domElement;
    hpLabel.style.left = '160px';
    const health = statusContainer.domElement;
    health.append(hpLabel);
    const hpValue = this.hpLabel.domElement;
    hpValue.style.left = '190px';
    health.append(hpValue);
    const mpLabel = createSmallStatLabel(translations.getGameText('mp')).domElement;
    mpLabel.style.left = '220px';
    health.append(mpLabel);
    const mpValue = this.mpLabel.domElement;
    mpValue.style.left = '250px';
    health.append(mpValue);
    const cpLabel = createSmallStatLabel(translations.getGameText('cp')).domElement;
    cpLabel.style.left = '275px';
    health.append(cpLabel);
    const cpValue = this.cpLabel.domElement;
    cpValue.style.left = '305px';
    health.append(cpValue);
    const statusElement = this.statusContainer.domElement;
    statusElement.append(health);
    const outer = this.outerContainer.domElement;
    outer.append(statusElement);
    this.domElement.append(outer);
    hpValue.textContent = String(STARTING_HP);
    mpValue.textContent = String(STARTING_MP);
    cpValue.textContent = String(STARTING_CP);
    this.selectionOverlay.setSize(this.getHeight(), statusContainer.getWidth());
    this.selectionOverlay.domElement.style.borderTopLeftRadius = '20px';
    this.selectionOverlay.domElement.style.borderBottomLeftRadius = '20px';
    this.selectionOverlay.initializeClickable();
    this.selectionOverlay.setActionHandler(openCommandTarget(this));
  }
  updatePlayerStatus(player: PlayerStatus): void {
    this.setCombatCounters(player.hp, player.mp, player.cp);
    for (const curse of player.curses.values()) this.addStatusEffect(curse);
    this.setGuardianStatusIcon(player.guardian);
    if (player.confusionCount > 0) this.setConfusionCounter(player.confusionCount);
    const items = player.items;
    const itemCount = items.length;
    const commandList = this.usedMiracles.commandList;
    for (const slot of items) {
      if (items.length !== itemCount) invalidState(items);
      if (slot.used) {
        commandList.push(createElementBadge(this.resolveSlotModel(slot)));
      }
    }
    this.usedMiracles.arrangeCommands();
    if (player.dead) this.showDefeatedPlayerState();
  }
  private resolveSlotModel(slot: ItemSlot): ItemDefinition {
    const modelIndex = slot.fakeModelId > 0 ? slot.fakeModelId - 1 : slot.modelId - 1;
    const models = state.itemModels;
    if (modelIndex < 0 || modelIndex >= models.length) {
      return indexError(models, modelIndex);
    }
    return models[modelIndex];
  }
  isOpponentStatusPanel(item: PlayerStatusPanel): boolean {
    return this.team === TeamSolo && this !== item || this.team !== item.team;
  }
  changeHpDisplay(input: number): void {
    this.setHp(changeHp(this.hp, input).hp);
  }

  changeMpDisplay(input: number): void {
    const next = changeMp(this.hp, this.mp, input);
    this.setCombatCounters(next.hp, next.mp, this.cp);
  }

  changeCpDisplay(input: number): void {
    const next = changeCp(this.hp, this.mp, this.cp, input);
    this.setCombatCounters(next.hp, next.mp, next.cp);
  }

  setCombatCounters(hp: number, mp: number, cp: number): void {
    this.hp = hp;
    this.mp = mp;
    this.cp = cp;
    this.hpLabel.setText(String(hp));
    this.mpLabel.setText(String(mp));
    this.cpLabel.setText(String(cp));
  }

  setHp(hp: number): void {
    this.setCombatCounters(hp, this.mp, this.cp);
  }

  setMp(mp: number): void {
    this.setCombatCounters(this.hp, mp, this.cp);
  }
  findVisibleStatusEffect(): Curse | null {
    return findVisibleCurse(this.curseIcons.keys());
  }
  addStatusEffect(curse: Curse): void {
    if (isVisibleStatusEffect(curse)) {
      const visible = this.findVisibleStatusEffect();
      if (visible !== null) this.removeStatusEffect(visible);
    } else if (hasStatusEffect(this.curseIcons.keys(), curse)) return;
    const icon = createCurseIconWidget(curse);
    this.statusContainer.domElement.append(icon.domElement);
    this.curseIcons.set(curse, icon);
    this.setConfusionCounter(this.confusionCount);
  }
  removeStatusEffect(curse: Curse): void {
    const icon = removeEntry(this.curseIcons, curse);
    icon?.dispose(0);
  }
  setCurrentTurnHighlight(isEnabled: boolean): void {
    this.turnHighlight?.dispose(0);
    this.turnHighlight = null;
    const statusContainer = this.statusContainer;
    const header = this.outerContainer.domElement;
    if (isEnabled) {
      statusContainer.dispose(0);
      const highlight = createAnimatedContainer(this.nameRow.getHeight(), null, null, this.nameRow.getWidth());
      applySurface(highlight, {
        height: this.nameRow.getHeight(), width: this.nameRow.getWidth(),
        corners: {topLeft: 20, bottomLeft: 20},
        background: colors.violet, opacity: opacity.placeholder
      });
      this.turnHighlight = highlight;
      header.append(highlight.domElement);
    } else header.append(statusContainer.domElement);
  }
  async animateStatusPanelHighlight(isEnabled: boolean): Promise<null> {
    const statusContainer = this.statusContainer;
    const header = this.outerContainer.domElement;
    const element = statusContainer.domElement;
    if (isEnabled) {
      this.setCurrentTurnHighlight(true);
      statusContainer.setOpacity(opacity.visible);
      header.append(element);
      await statusContainer.fadeOut(duration.normal, EasingEaseIn);
      statusContainer.dispose(0);
    } else {
      statusContainer.setOpacity(opacity.hidden);
      header.append(element);
      await statusContainer.fadeIn(duration.normal, EasingEaseIn);
      this.setCurrentTurnHighlight(false);
    }
    return null;
  }
  setGuardianStatusIcon(guardian: Guardian | null): void {
    this.guardianIcon?.dispose(0);
    this.guardianIcon = null;
    if (guardian !== null) {
      this.guardianIcon = createGuardianIconWidget(guardian);
      this.statusContainer.domElement.append(this.guardianIcon.domElement);
    }
  }
  setConfusionCounter(value: number): void {
    this.confusionCount = value;
    this.confusionOverlay?.dispose(0);
    this.confusionOverlay = null;
    if (this.confusionCount > 0) {
      const overlay = createAnimatedContainer(this.nameRow.getHeight(), null, null, this.nameRow.getWidth());
      applySurface(overlay, {
        height: this.nameRow.getHeight(), width: this.nameRow.getWidth(),
        corners: {topLeft: 20, bottomLeft: 20},
        border: {width: 3, color: colors.orange}
      });
      overlay.domElement.style.pointerEvents = 'none';
      this.confusionOverlay = overlay;
      this.statusContainer.domElement.append(overlay.domElement);
    }
  }
  addUsedMiracles(items: ItemSlot[]): void {
    const selected: ItemDefinition[] = [];
    for (const slot of items) {
      if (!slot.used) {
        const model = this.resolveSlotModel(slot);
        if (model.category === CategoryMiracles) selected.push(model);
      }
    }
    if (selected.length === 0) return;
    for (const model of selected) this.usedMiracles.commandList.push(createElementBadge(model));
    this.usedMiracles.arrangeCommands();
  }
  removeUsedMiracles(items: ItemSlot[]): void {
    for (const slot of items) {
      if (slot.used) {
        this.usedMiracles.removeCommand(this.resolveSlotModel(slot));
      }
    }
    this.usedMiracles.arrangeCommands();
  }
  showDefeatedPlayerState(): void {
    this.dead = true;
    this.nameRow.setDisabled();
    this.hpLabel.setOpacity(opacity.disabled);
    this.mpLabel.setOpacity(opacity.disabled);
    this.cpLabel.setOpacity(opacity.disabled);
    this.setConfusionCounter(0);
    this.usedMiracles.headerWidget.setDisabled();
    this.refreshPlayerStatusColors();
  }
  setPlayerSelectionHighlight(isEnabled: boolean): void {
    if (isEnabled) {
      const highlight = this.turnHighlight ?? this.nameRow;
      this.selectionOverlay.initializeClickable();
      highlight.domElement.append(this.selectionOverlay.domElement);
    } else this.selectionOverlay.dispose(0);
  }
  refreshPlayerStatusColors(): void {
    const decoration = this.isBot && !this.dead && this.userId !== null ? colors.red : null;
    this.nameRow.valueWidget.setTextDecoration(decoration);
    this.usedMiracles.headerWidget.valueWidget.setTextDecoration(decoration);
  }
}

export function createPlayerStatusPanel(input: PlayerStatus): PlayerStatusPanel {
  const outer = createAnimatedContainer(null, null, null, null);
  const status = createAnimatedContainer(null, null, null, null);
  const hp = createSmallStatValue();
  const mp = createSmallStatValue();
  const cp = createSmallStatValue();
  const selection = createInteractiveElement(null, null, null, null);
  const header = createPlayerNameRow(input, 340);
  const items: ElementBadge[] = [];
  const listHeader = createPlayerNameRow(input, 170);
  const element = document.createElement('div');
  const commandList = new PlayerStatusList(listHeader, items, element);
  commandList.applyElementStyles(element, 40, null, null, 390);
  element.append(listHeader.domElement);
  const panelElement = document.createElement('div');
  const panel = new PlayerStatusPanel(
    input.id, input.userId, input.name, input.alias, input.team, input.isBot,
    outer, status, header, hp, mp, cp, new Map(), commandList, selection, panelElement
  );
  panel.applyElementStyles(panelElement, 40, null, null, 390);
  panel.renderCombatCounters(input);
  return panel;
}

export function createSmallStatLabel(input: string): SmallStatLabel {
  const element = document.createElement('span');
  const label = new SmallStatLabel(element);
  label.applyElementStyles(element, 26, null, null, 30);
  label.setText(input, 26, null, null, 30);
  element.style.textAlign = 'right';
  label.applyTextStyle(14, colors.slate, true);
  return label;
}

export function createSmallStatValue(): SmallStatValue {
  const element = document.createElement('span');
  const value = new SmallStatValue(element);
  value.applyElementStyles(element, 26, null, null, 30);
  value.setText('', 26, null, null, 30);
  element.style.textAlign = 'right';
  value.applyTextStyle(20, colors.text, true);
  return value;
}

export function openCommandTarget(panel: PlayerStatusPanel): () => void {
  return () => {
    const room = getApplication().dialog;
    const rules = (room instanceof RoomController ? room : null)!.gamePage!.commandRules;
    if (rules === UNSET) uninitialized('command');
    rules.resolveActiveTarget(panel);
  };
}
