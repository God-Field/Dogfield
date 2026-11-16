import {surfaceSize, radius} from '../ui/theme';
import { AnimatedElement, createAnimatedContainer } from '../ui/elements';
import { Card, applySurface, appendLabel } from '../ui/components';
import { createItemArtwork, createHiddenItemArtwork, createElementArtwork, createCurseArtwork, createGuardianArtwork } from '../ui/assets';
import { state } from '../app/state';
import { ItemDefinition } from '../domain/models';
import { Curse, Guardian, CategoryWeapons, CategoryMiracles, CategoryDevils, CategoryGuardians, CategoryPhenomena, CategoryArmor, CategorySundries } from '../domain/enums';
import {colors, curseColor, guardianColor, itemCommandElementColor} from '../ui/palette';
import { replaceFirst, replaceAll } from '../shared/values';
export class SpeechBubble extends Card {
  renderBubbleBackground(): void {
    this.applySurface({height: this.getHeight(), width: this.getWidth(), radius: radius.small, background: colors.mint});
    const title = createAnimatedContainer(33, 90, 5, 205);
    applySurface(title, {height: 33, left: 90, top: 5, width: 205, corners: {topRight: 5}, background: colors.mintPale, insetBorder: {width: 1, color: colors.mint, inset: 1}});
    this.domElement.append(title.domElement);
    const body = createAnimatedContainer(46, 90, 39, 205);
    applySurface(body, {height: 46, left: 90, top: 39, width: 205, corners: {bottomRight: 5}, background: colors.mintPale});
    this.domElement.append(body.domElement);
  }
  appendTextLine(text: string, color: string | null): void {
    this.appendLabel({
      text, height: 30, left: 97, top: 7, width: 195,
      size: 20, color: color!, bold: true, align: 'left', fit: true
    });
  }
  appendMarkupLine(markup: string, color: string | null, width: number | null): void {
    this.appendLabel({
      text: '', markup, height: 45, left: 95, top: 43, width: width ?? 195,
      size: 15, color: color!, align: 'left', lineHeight: 20, nowrap: true
    });
  }
  appendLine(text: string, color: string | null): void {
    this.appendMarkupLine(text, color, null);
  }
}
interface ItemSummary {
  primary: string | null;
  secondary: string | null;
  markup: string | null;
}
function summarizeItem(item: ItemDefinition, damage: number, isAttack: boolean, cpTaken: number, counterCurse: Curse | null, hitRate: number, mpBoost: number): ItemSummary {
  const texts = state.translations;
  let primary: string | null = null,
    secondary: string | null = null,
    markup: string | null = null;
  if (item.attack > 0) {
    if ([CategoryWeapons, CategoryMiracles, CategoryDevils, CategoryGuardians, CategoryPhenomena].includes(item.category)) {
      primary = texts.formatAttackSummary(item.attack, item.hitRate, item.isPlusAttack);
    } else if (item.category === CategoryArmor || item.category === CategorySundries) {
      secondary = texts.formatAttackSummaryWithoutHitRate(item.attack, item.isPlusAttack);
    }
  }
  if (item.defense > 0) {
    if (item.category.index === 1) {
      secondary = replaceFirst(texts.getGameText('def'), '{{def}}', String(item.defense));
    } else if (item.category.index === 2) {
      primary = replaceFirst(texts.getGameText('def'), '{{def}}', String(item.defense));
    }
  }
  const action = item.ability,
    ability = texts.getAbilitiesText(action),
    counter = texts.getGameText('counter');
  if (action.length !== 0) switch (action) {
    case 'setElement':
      secondary = replaceFirst(ability, '{{element}}', texts.getElementNamesText(item.element!.key));
      break;
    case 'counterAtk':
      if (damage === 0) {
        primary = counter;
        secondary = replaceFirst(texts.getGameText('hitRate'), '{{hitRate}}', String(item.hitRate)) + ability;
      } else primary = texts.formatAttackSummaryWithHitRate(damage, item.hitRate);
      break;
    case 'counter2xAtk':
      if (damage === 0) {
        primary = counter;
        secondary = ability;
      } else primary = texts.formatBasicAttackSummary(damage);
      break;
    case 'danger':
      secondary = texts.getAbilitiesText('attackSomebody');
      break;
    case 'attackDyingly':
      if (damage > 0) primary = texts.formatAttackSummaryWithHitRate(damage, hitRate);
      secondary = ability;
      break;
    case 'boostHP':
      primary = replaceFirst(ability, '{{hp}}', String(item.abilityValue));
      break;
    case 'boostHPOrDealDamage':
      primary = replaceFirst(texts.getAbilitiesText('boostHP'), '{{hp}}', String(item.abilityValue));
      secondary = replaceFirst(texts.getAbilitiesText('orDealDamage'), '{{damage}}', String(item.abilityValue));
      break;
    case 'dealDamage':
      primary = replaceFirst(texts.getAbilitiesText('dealDamage'), '{{damage}}', String(item.abilityValue));
      break;
    case 'revive':
    case 'setHPOfEverybody':
      markup = replaceFirst(ability, '{{hp}}', String(item.abilityValue));
      break;
    case 'boostMP':
      primary = replaceFirst(ability, '{{mp}}', String(item.abilityValue));
      break;
    case 'boostMPAndAddCurse':
      primary = replaceFirst(texts.getAbilitiesText('boostMP'), '{{mp}}', String(item.abilityValue));
      secondary = texts.getCurseNamesText(item.curse!.key);
      break;
    case 'counterBoost2xMP':
      if (mpBoost === 0) {
        primary = counter;
        secondary = ability;
      } else primary = replaceFirst(texts.getAbilitiesText('boostMP'), '{{mp}}', String(mpBoost));
      break;
    case 'atkBy2xMP':
      primary = isAttack ? texts.formatBasicAttackSummary(damage) : texts.getGameText(action);
      secondary = texts.getAbilitiesText('consumeAllMP');
      break;
    case 'boostCP':
    case 'takeCP':
      primary = replaceFirst(ability, '{{cp}}', String(item.abilityValue));
      break;
    case 'boostCPToEnemy':
    case 'boostCPOfEverybody':
      primary = replaceFirst(texts.getAbilitiesText('boostCP'), '{{cp}}', String(item.abilityValue));
      secondary = ability;
      break;
    case 'counterTakeCP':
      if (cpTaken === 0) {
        primary = counter;
        secondary = ability;
      } else primary = replaceFirst(texts.getAbilitiesText('takeCP'), '{{cp}}', String(cpTaken));
      break;
    case 'boostSomething':
      markup = replaceAll(ability, '{{value}}', String(item.abilityValue));
      break;
    case 'addCurse':
      primary = texts.getCurseNamesText(item.curse!.key);
      break;
    case 'addCurseOnDamage':
    case 'selfCurse':
    case 'selfCurseAndRedraw':
      secondary = replaceFirst(ability, '{{curse}}', texts.getCurseNamesText(item.curse!.key));
      break;
    case 'counterCurse':
      if (counterCurse === null) {
        primary = counter;
        secondary = texts.getCurseNamesText(item.curse!.key);
      } else primary = texts.getCurseNamesText(counterCurse.key);
      break;
    case 'setCurseOfEverybody':
      markup = replaceFirst(ability, '{{curse}}', texts.getCurseNamesText(item.curse!.key));
      break;
    case 'blockWeapon':
    case 'bounceMiracle':
    case 'cutCost':
      secondary = ability;
      break;
    default:
      if (primary === null) {
        markup = ability;
      } else {
        secondary = ability;
      }
  }
  return {
    primary,
    secondary,
    markup
  };
}
export class CounterState extends SpeechBubble {
  constructor(public model: ItemDefinition, element: HTMLDivElement) {
    super(element);
  }
  renderCombatCounterDetails(_model: ItemDefinition, damage: number, isAttack: boolean, cpTaken: number, counterCurse: Curse | null, disguised: boolean, hitRate: number, mpBoost: number): void {
    const item = this.model,
      texts = state.translations,
      artwork = createItemArtwork(item);
    artwork.setPosition(5, 5);
    this.domElement.append(artwork.domElement);
    if (disguised) {
      const hidden = createHiddenItemArtwork();
      hidden.setPosition(5, 5);
      this.domElement.append(hidden.domElement);
    }
    const color = itemCommandElementColor(item);
    this.appendTextLine(item.name, color);
    if (item.element !== null) {
      const icon = createElementArtwork(item.element);
      icon.setPosition(93, 42);
      this.domElement.append(icon.domElement);
    }
    const summary = summarizeItem(item, damage, isAttack, cpTaken, counterCurse, hitRate, mpBoost);
    if (summary.primary !== null) {
      this.appendLabel({
        text: summary.primary, height: 22, left: 118, top: 42,
        width: item.cost > 0 || item.price > 0 ? 125 : 170,
        size: 20, color: color!, bold: true, align: 'left', fit: true
      });
    }
    if (summary.secondary !== null) {
      this.appendLabel({
        text: summary.secondary, height: 16, left: 95, top: 67,
        width: item.cost > 0 ? 150 : item.price > 0 ? 155 : 195,
        size: 15, color: color!, align: 'left', fit: true
      });
    }
    if (summary.markup !== null) this.appendMarkupLine(summary.markup, color, item.cost > 0 ? 145 : item.price > 0 ? 150 : null);
    if (item.price > 0) {
      const price = createAnimatedContainer(44, 250, 40, 44);
      applySurface(price, {...surfaceSize.priceBadge, left: 250, top: 40, radius: radius.price, background: colors.yellowPale, border: {width: 1, color: colors.khaki}});
      appendLabel(price, {
        text: replaceFirst(texts.getGameText('priceCP'), '{{price}}', String(item.price)),
        height: 44, left: 1, top: null, width: 42,
        size: 18, color: colors.text, fit: true
      });
      this.domElement.append(price.domElement);
    } else if (item.cost > 0) {
      const cost = createAnimatedContainer(42, 243, 41, 50);
      applySurface(cost, {...surfaceSize.costBadge, left: 243, top: 41, radius: radius.small, background: colors.periwinkle});
      appendLabel(cost, {
        text: texts.getGameText('cost'),
        height: 21, left: null, top: 4, width: 50,
        size: 16, color: colors.lavender, lineHeight: 19, fit: true
      });
      appendLabel(cost, {
        text: replaceFirst(texts.getGameText('costMP'), '{{mp}}', String(item.cost)),
        height: 21, left: null, top: 23, width: 50,
        size: 16, color: colors.lavender, lineHeight: 19, fit: true
      });
      this.domElement.append(cost.domElement);
    }
  }
}
export function createCombatCounterDetails(item: ItemDefinition, damage: number, isAttack: boolean, cpTaken: number, counterCurse: Curse | null, disguised: boolean, hitRate: number, mpBoost: number): CounterState {
  const element = document.createElement('div'),
    details = new CounterState(item, element);
  details.applySurface({...surfaceSize.detail});
  details.renderBubbleBackground();
  details.renderCombatCounterDetails(item, damage, isAttack, cpTaken, counterCurse, disguised, hitRate, mpBoost);
  return details;
}
export class CurseMediumIcon extends SpeechBubble {}
export function createCurseMediumIcon(curse: Curse): CurseMediumIcon {
  const element = document.createElement('div'),
    details = new CurseMediumIcon(element);
  details.applySurface({...surfaceSize.detail});
  details.renderBubbleBackground();
  const image = createCurseArtwork(curse, 'medium');
  image.setPosition(15, 29);
  element.append(image.domElement);
  const texts = state.translations,
    color = curseColor(curse);
  details.appendTextLine(texts.getCurseNamesText(curse.key), color);
  details.appendLine(texts.curseDescriptions.get(curse.key) ?? '', color);
  return details;
}
export class GuardianMediumIcon extends SpeechBubble {}
export function createGuardianMediumIcon(guardian: Guardian): GuardianMediumIcon {
  const element = document.createElement('div'),
    details = new GuardianMediumIcon(element);
  details.applySurface({...surfaceSize.detail});
  details.renderBubbleBackground();
  const image = createGuardianArtwork(guardian, 'medium');
  image.setPosition(5, 13);
  element.append(image.domElement);
  const texts = state.translations,
    color = guardianColor(guardian);
  details.appendTextLine(texts.guardianNames.get(guardian.key) ?? '', color);
  details.appendLine(texts.guardianDescriptions.get(guardian.key) ?? '', color);
  return details;
}
