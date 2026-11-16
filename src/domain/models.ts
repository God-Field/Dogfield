import {Category,ItemElement,Curse,Guardian,Team,Side,GameMode,Easing,TextAlignment,Language,CategoryArmor,CategoryDevils,CategoryGuardians,CategoryMiracles,CategoryPhenomena,CategorySundries,CategoryTrade,CategoryWeapons,CurseCold,CurseDarkcloud,CurseDream,CurseFever,CurseFlash,CurseFog,CurseHeaven,CurseHell,EasingEaseIn,EasingEaseOut,EasingLinear,GuardianEarth,GuardianJupiter,GuardianMars,GuardianMercury,GuardianMoon,GuardianNeptune,GuardianPluto,GuardianSaturn,GuardianUranus,GuardianVenus,ItemElementDarkness,ItemElementFire,ItemElementLight,ItemElementStone,ItemElementWater,ItemElementWood,LanguageEn,LanguageEs,LanguageFr,LanguageJa,LanguageKo,LanguagePt,LanguageRu,LanguageZhHans,LanguageZhHant,SideLeft,SideRight,GameModeTraining,GameModePrivate,GameModeDuel,TeamSolo,TeamTeam1,TeamTeam2,TeamTeam3,TeamTeam4,TextAlignmentLeft,allLanguages,allGuardians,allSides,allGameModes,allCurses,allTextAlignments,allCategories,allTeams,allItemElements} from './enums';
import {defaultItemCatalog, type ItemCatalog} from './item-catalog';

const nonTargetingSundryAbilities: ReadonlySet<string> = new Set([
  'cutCost',
  'revive',
  'attractDanger',
]);
const responseAbilities: ReadonlySet<string> = new Set([
  'bounceWeapon',
  'reflectWeapon',
  'blockWeapon',
  'reflectAnything',
  'bounceMiracle',
  'reflectMiracle',
  'blockMiracle',
]);
/** Targeted economic/status abilities resolved against a chosen player. */
const directTargetAbilities: ReadonlySet<string> = new Set([
  'sell',
  'buy',
  'boostCPToEnemy',
  'takeCP',
  'addCurse',
  'removeItems',
  'removeUsedMiracles',
]);
const weaponCategoryIndex = 1;
const miracleCategoryIndex = 4;
const weaponResponses: ReadonlyMap<string, string> = new Map([
  ['bounceWeapon', 'bounce'],
  ['reflectWeapon', 'reflect'],
  ['blockWeapon', 'block'],
]);
const miracleResponses: ReadonlyMap<string, string> = new Map([
  ['bounceMiracle', 'bounce'],
  ['reflectMiracle', 'reflect'],
  ['blockMiracle', 'block'],
]);

export class ChatMessage {
  constructor(
    public userId: string,
    public messageText: string,
    public sender: string | null = null,
    public isTeamMessage = false,
  ) {}
}

export class BattleEvent {
  constructor(
    public action: string,
    public playerId: number,
    public attack: AttackCommand | null,
    public damage: number,
    public hp: number,
    public mp: number,
    public cp: number,
    public curse: Curse | null,
    public curses: Curse[],
    public guardian: Guardian | null,
    public guardians: Guardian[],
    public itemModelId: number,
    public item: ItemSlot | null,
    public items: ItemSlot[],
    public overflowItem: ItemSlot | null,
    public index: number,
    public bought: boolean,
    public natural: boolean,
  ) {}
}

export class AttackCommand {
  constructor(
    public playerId: number,
    public guardian: Guardian | null,
    public itemModelIds: number[],
    public attack: number,
    public hitRate: number,
    public mp: number,
    public cp: number,
    public targetPlayerId: number,
    public reversed: boolean,
    public buyingItemModelId: number,
  ) {}
}

export class GameState {
  constructor(
    public players: PlayerStatus[],
    public gf: number,
    public tiebreakGF: number | null,
    public attackTurnPlayerId: number,
    public attack: AttackCommand | null,
    public isOver: boolean,
    public events: BattleEvent[],
    public updateCount: number,
  ) {}
}

export class ItemSlot {
  constructor(
    public id: number,
    public modelId: number,
    public fakeModelId: number,
    public used: boolean,
  ) {}

  getItemModel(catalog: ItemCatalog = defaultItemCatalog) {
    const index = (this.fakeModelId > 0 ? this.fakeModelId : this.modelId) - 1;
    return catalog.requireModel(index);
  }
}

export class ItemDefinition {
  declare disabled?: boolean;
  constructor(
    public id: number,
    public name: string,
    public imageName: string,
    public category: Category,
    public element: ItemElement | null,
    public attack: number,
    public isPlusAttack: boolean,
    public hitRate: number,
    public defense: number,
    public ability: string,
    public abilityValue: number,
    public curse: Curse | null,
    public guardian: Guardian | null,
    public price: number,
    public cost: number,
    public giftRate: number,
    public appearanceRate: number,
    public guardianAttackRate: number,
  ) {}

  isItemTargetingCommand(): boolean {
    const category = this.category;
    if (category === CategoryTrade || category === CategoryWeapons) {
      return true;
    }
    if (category === CategorySundries) {
      if (this.isPlusAttack) {
        return false;
      }
      return !nonTargetingSundryAbilities.has(this.ability);
    }
    if (category === CategoryMiracles) {
      if (this.isPlusAttack && this.attack === 0) {
        return false;
      }
      return !responseAbilities.has(this.ability);
    }
    return false;
  }

  /**
   * True for commands resolved against a chosen target through the fixed-target
   * branch: weapons/damaging actions and targeted economic or status abilities.
   * Random hit-rate actions are handled by the separate random-target branch.
   */
  isDirectTargetCommand(): boolean {
    if (this.hitRate > 0) {
      return false;
    }
    if (this.attack > 0 || this.category === CategoryWeapons) {
      return true;
    }
    return directTargetAbilities.has(this.ability);
  }

  getWeaponResponseAction(itemCategory: Category, filter: ItemElement | null): string | null {
    const commandType = this.ability;
    if (commandType === 'reflectAnything') {
      return 'reflect';
    }
    if (itemCategory.index === weaponCategoryIndex && filter === null) {
      return weaponResponses.get(commandType) ?? null;
    }
    if (itemCategory.index === miracleCategoryIndex) {
      return miracleResponses.get(commandType) ?? null;
    }
    return null;
  }

  matchesCommandElement(element: ItemElement | null): boolean {
    const commandElement = this.element;
    switch (element) {
      case ItemElementFire:
        return commandElement === ItemElementWater || commandElement === ItemElementLight;
      case ItemElementWater:
        return commandElement === ItemElementFire || commandElement === ItemElementLight;
      case ItemElementWood:
        return commandElement === ItemElementStone || commandElement === ItemElementLight;
      case ItemElementStone:
        return commandElement === ItemElementWood || commandElement === ItemElementLight;
      case ItemElementLight:
        return false;
      default:
        return true;
    }
  }
}

export class PlayerStatus {
  constructor(
    public id: number,
    public userId: string | null,
    public name: string,
    public alias: string | null,
    public team: Team,
    public isBot: boolean,
    public hp: number,
    public mp: number,
    public cp: number,
    public curses: Set<Curse>,
    public guardian: Guardian | null,
    public confusionCount: number,
    public dead: boolean,
    public items: ItemSlot[],
    public rating: number,
    public ratingGain: number,
  ) {}
}

export class RoomState {
  constructor(
    public users: RoomUser[],
    public isLocked: boolean,
    public entries: RoomPlayer[],
    public tiebreakGF: number | null,
    public game: GameState | null,
    public teamsShuffled: boolean | null = null,
  ) {}
}

export class RoomUser {
  constructor(
    public userId: string,
    public displayName: string,
  ) {}
}

export class RoomPlayer {
  constructor(
    public userId: string,
    public team: Team,
  ) {}
}
