import {asMap} from '../shared/collections';
import {replaceFirst} from '../shared/values';

export class Translations {
  readonly app: Map<string,string>;
  readonly langNames: Map<string,string>;
  readonly reference: Map<string,string>;
  readonly elementNames: Map<string,string>;
  readonly elementDescriptions: Map<string,string>;
  readonly curseNames: Map<string,string>;
  readonly curseDescriptions: Map<string,string>;
  readonly guardianNames: Map<string,string>;
  readonly guardianDescriptions: Map<string,string>;
  readonly modeNames: Map<string,string>;
  readonly modeDescriptions: Map<string,string>;
  readonly home: Map<string,string>;
  readonly settings: Map<string,string>;
  readonly menu: Map<string,string>;
  readonly training: Map<string,string>;
  readonly private: Map<string,string>;
  readonly duel: Map<string,string>;
  readonly game: Map<string,string>;
  readonly abilities: Map<string,string>;
  readonly alerts: Map<string,string>;
  readonly effects: Map<string,string>;
  private constructor(data: ReadonlyMap<string,unknown>) {
    const readGroup = (name: string): Map<string,string> => asMap(data.get(name)) as Map<string,string>;
    this.app = readGroup('app');
    this.langNames = readGroup('langNames');
    this.reference = readGroup('reference');
    this.elementNames = readGroup('elementNames');
    this.elementDescriptions = readGroup('elementDescriptions');
    this.curseNames = readGroup('curseNames');
    this.curseDescriptions = readGroup('curseDescriptions');
    this.guardianNames = readGroup('guardianNames');
    this.guardianDescriptions = readGroup('guardianDescriptions');
    this.modeNames = readGroup('modeNames');
    this.modeDescriptions = readGroup('modeDescriptions');
    this.home = readGroup('home');
    this.settings = readGroup('settings');
    this.menu = readGroup('menu');
    this.training = readGroup('training');
    this.private = readGroup('private');
    this.duel = readGroup('duel');
    this.game = readGroup('game');
    this.abilities = readGroup('abilities');
    this.alerts = readGroup('alerts');
    this.effects = readGroup('effects');
  }
  static fromData(data: ReadonlyMap<string,unknown>): Translations { return new Translations(data); }
  getAppText(key: string): string { return this.app.get(key) ?? ''; }
  getReferenceText(key: string): string { return this.reference.get(key) ?? ''; }
  getElementNamesText(key: string): string { return this.elementNames.get(key) ?? ''; }
  getCurseNamesText(key: string): string { return this.curseNames.get(key) ?? ''; }
  getModeNamesText(key: string): string { return this.modeNames.get(key) ?? ''; }
  getHomeText(key: string): string { return this.home.get(key) ?? ''; }
  getSettingsText(key: string): string { return this.settings.get(key) ?? ''; }
  getMenuText(key: string): string { return this.menu.get(key) ?? ''; }
  getTrainingText(key: string): string { return this.training.get(key) ?? ''; }
  getPrivateText(key: string): string { return this.private.get(key) ?? ''; }
  getDuelText(key: string): string { return this.duel.get(key) ?? ''; }
  getGameText(key: string): string { return this.game.get(key) ?? ''; }
  getAbilitiesText(key: string): string { return this.abilities.get(key) ?? ''; }
  getEffectsText(key: string): string { return this.effects.get(key) ?? ''; }
  formatAttackSummary(attack: number, hitRate: number, isBonus: boolean): string {
    if (isBonus) return replaceFirst(this.getGameText('plusAtk'), '{{atk}}', String(attack));
    const damage = replaceFirst(this.getGameText('atk'), '{{atk}}', String(attack));
    return hitRate === 0 ? damage : replaceFirst(this.getGameText('hitRate'), '{{hitRate}}', String(hitRate)) + damage;
  }
  formatAttackSummaryWithoutHitRate(attack: number,isBonus: boolean): string { return this.formatAttackSummary(attack,0,isBonus); }
  formatAttackSummaryWithHitRate(attack: number,hitRate: number): string { return this.formatAttackSummary(attack,hitRate,false); }
  formatBasicAttackSummary(attack: number): string { return this.formatAttackSummary(attack,0,false); }
}
