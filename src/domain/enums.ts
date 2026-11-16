export class Category {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "Category." + this.name;
  }
}
export class ItemElement {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "ItemElement." + this.name;
  }
}
export class Curse {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "Curse." + this.name;
  }
}
export class Guardian {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "Guardian." + this.name;
  }
}
export class Team {
  constructor(public key: number, public index: number, public name: string) {}
  toString() {
    return "Team." + this.name;
  }
}
export class Side {
  constructor(public index: number, public name: string) {}
  toString() {
    return "Side." + this.name;
  }
}
export function sidePosition(side: Side, leftValue: number, rightValue: number): number | null {
  switch (side.index) {
    case 0:
      return leftValue;
    case 1:
      return rightValue;
    default:
      return null;
  }
}
export class GameMode {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "Mode." + this.name;
  }
}
export class Easing {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "Easing." + this.name;
  }
}
export class TextAlignment {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "TextAlign." + this.name;
  }
}

const languageCodes: ReadonlyMap<number, string> = new Map([
  [0, 'us'],
  [1, 'es'],
  [2, 'fr'],
  [3, 'jp'],
  [4, 'kr'],
  [5, 'br'],
  [6, 'ru'],
  [7, 'cn'],
  [8, 'tw'],
]);

export class Language {
  constructor(public key: string, public index: number, public name: string) {}
  toString() {
    return "Lang." + this.name;
  }
  getLanguageCode(): string | null {
    return languageCodes.get(this.index) ?? null;
  }
}
export const CategoryArmor = new Category("armor", 2, "armor");
export const CategoryDevils = new Category("devils", 5, "devils");
export const CategoryGuardians = new Category("guardians", 6, "guardians");
export const CategoryMiracles = new Category("miracles", 4, "miracles");
export const CategoryPhenomena = new Category("phenomena", 7, "phenomena");
export const CategorySundries = new Category("sundries", 3, "sundries");
export const CategoryTrade = new Category("trade", 0, "trade");
export const CategoryWeapons = new Category("weapons", 1, "weapons");
export const CurseCold = new Curse("cold", 0, "cold");
export const CurseDarkcloud = new Curse("darkcloud", 7, "darkcloud");
export const CurseDream = new Curse("dream", 6, "dream");
export const CurseFever = new Curse("fever", 1, "fever");
export const CurseFlash = new Curse("flash", 5, "flash");
export const CurseFog = new Curse("fog", 4, "fog");
export const CurseHeaven = new Curse("heaven", 3, "heaven");
export const CurseHell = new Curse("hell", 2, "hell");
export const EasingEaseIn = new Easing("ease-in", 1, "easeIn");
export const EasingEaseOut = new Easing("ease-out", 2, "easeOut");
export const EasingLinear = new Easing("linear", 0, "linear");
export const GuardianEarth = new Guardian("earth", 8, "earth");
export const GuardianJupiter = new Guardian("jupiter", 2, "jupiter");
export const GuardianMars = new Guardian("mars", 0, "mars");
export const GuardianMercury = new Guardian("mercury", 1, "mercury");
export const GuardianMoon = new Guardian("moon", 9, "moon");
export const GuardianNeptune = new Guardian("neptune", 6, "neptune");
export const GuardianPluto = new Guardian("pluto", 5, "pluto");
export const GuardianSaturn = new Guardian("saturn", 3, "saturn");
export const GuardianUranus = new Guardian("uranus", 4, "uranus");
export const GuardianVenus = new Guardian("venus", 7, "venus");
export const ItemElementDarkness = new ItemElement("darkness", 5, "darkness");
export const ItemElementFire = new ItemElement("fire", 0, "fire");
export const ItemElementLight = new ItemElement("light", 4, "light");
export const ItemElementStone = new ItemElement("stone", 3, "stone");
export const ItemElementWater = new ItemElement("water", 1, "water");
export const ItemElementWood = new ItemElement("wood", 2, "wood");
export const LanguageEn = new Language("en", 0, "en");
export const LanguageEs = new Language("es", 1, "es");
export const LanguageFr = new Language("fr", 2, "fr");
export const LanguageJa = new Language("ja", 3, "ja");
export const LanguageKo = new Language("ko", 4, "ko");
export const LanguagePt = new Language("pt", 5, "pt");
export const LanguageRu = new Language("ru", 6, "ru");
export const LanguageZhHans = new Language("zh-hans", 7, "zhHans");
export const LanguageZhHant = new Language("zh-hant", 8, "zhHant");
export const SideLeft = new Side(0, "left");
export const SideRight = new Side(1, "right");
export const GameModeTraining = new GameMode("training", 0, "training");
export const GameModePrivate = new GameMode("private", 1, "private");
export const GameModeDuel = new GameMode("duel", 2, "duel");
export const TeamSolo = new Team(0, 0, "solo");
export const TeamTeam1 = new Team(1, 1, "team1");
export const TeamTeam2 = new Team(2, 2, "team2");
export const TeamTeam3 = new Team(3, 3, "team3");
export const TeamTeam4 = new Team(4, 4, "team4");
export const TextAlignmentLeft = new TextAlignment("left", 0, "left");
export const allLanguages = [LanguageEn, LanguageEs, LanguageFr, LanguageJa, LanguageKo, LanguagePt, LanguageRu, LanguageZhHans, LanguageZhHant];
export const allGuardians = [GuardianMars, GuardianMercury, GuardianJupiter, GuardianSaturn, GuardianUranus, GuardianPluto, GuardianNeptune, GuardianVenus, GuardianEarth, GuardianMoon];
export const allSides = [SideLeft, SideRight];
export const allGameModes = [GameModeTraining, GameModePrivate, GameModeDuel];
export const allCurses = [CurseCold, CurseFever, CurseHell, CurseHeaven, CurseFog, CurseFlash, CurseDream, CurseDarkcloud];
export const allTextAlignments = [];
export const allCategories = [CategoryTrade, CategoryWeapons, CategoryArmor, CategorySundries, CategoryMiracles, CategoryDevils, CategoryGuardians, CategoryPhenomena];
export const allTeams = [TeamSolo, TeamTeam1, TeamTeam2, TeamTeam3, TeamTeam4];
export const allItemElements = [ItemElementFire, ItemElementWater, ItemElementWood, ItemElementStone, ItemElementLight, ItemElementDarkness];
