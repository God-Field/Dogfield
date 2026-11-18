import type { Player } from '../types.ts';

/**
 * Rule-based bot policy shared by attacks, targeting, economy, and prayer.
 *
 * Recorded choices are stochastic and state-dependent. The local utility
 * weights and strength-group preference approximate those observations;
 * the creator has not disclosed the official selection code.
 */

export interface BotItem {
  attack: number;
  isPlusAttack: boolean;
  defense: number;
  hitRate: number;
  price: number;
  cost: number;
  ability: string;
  abilityValue: number;
  category: {
    key: string;
  };
}

type BotTargetPlayer = Pick<Player, 'id' | 'hp' | 'mp' | 'cp' | 'dead'>;

export interface BotTargetContext {
  actor: BotTargetPlayer;
  players: readonly BotTargetPlayer[];
  targets: readonly BotTargetPlayer[];
}

// Fitted approximation of the creator's private strength grouping, not official
// coefficients. A soft preference accounts for the unknown scoring and cutoff.
const TARGET_OPPOSITE_GROUP_WEIGHT = 3;

function botPlayerStrength(player: BotTargetPlayer): number {
  return player.hp + player.mp / 2 + player.cp / 3;
}

function applyTargetGroupPreference(
  probabilities: number[],
  context?: BotTargetContext,
): number[] {
  if (!context || context.targets.length !== probabilities.length) {
    return probabilities;
  }
  const livingPlayers = context.players.filter((player) => !player.dead && player.hp > 0);
  if (livingPlayers.length < 2) {
    return probabilities;
  }
  const totalStrength = livingPlayers.reduce(
    (total, player) => total + botPlayerStrength(player),
    0,
  );
  const groupBoundary = totalStrength / livingPlayers.length;
  const actorIsUpper = botPlayerStrength(context.actor) >= groupBoundary;
  const weights = probabilities.map((probability, targetIndex) => {
    const targetIsUpper = botPlayerStrength(context.targets[targetIndex]) >= groupBoundary;
    const groupWeight = actorIsUpper === targetIsUpper ? 1 : TARGET_OPPOSITE_GROUP_WEIGHT;
    return probability * groupWeight;
  });
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  return weights.map((weight) => weight / totalWeight);
}

const HEALTH_PREFERENCE_BY_ABILITY: Record<string, number> = {
  absorbHP: 0.46,
  addCurse: 0.86,
  addCurseOnDamage: 0.86,
  atkBy2xMP: 0.86,
  boostCPToEnemy: 0.86,
  removeItems: 0.86,
  removeUsedMiracles: 0.86,
  setElement: 0.86,
  takeCP: 0.86,
};

const TARGET_FOCUS_WEAKEST = 0.104;
const TARGET_FOCUS_STRONGEST = 0.114;
const PRAYER_WEIGHT = 2.5;
const ATTACK_UTILITY_TEMPERATURE = 3;
const FOLLOW_UP_WEIGHT_SCALE = 0.5;
const SELL_RANK_WEIGHT_SCALE = 0.79;
// Official-game logs show the Bow used for its dying effect, not ordinary attacks.
const DYING_ATTACK_OPENING_UTILITY = -9;
const DYING_ATTACK_FOLLOW_UP_WEIGHT = 0.1;

const responseWeaponAbilities = new Set([
  'blockMiracle',
  'blockWeapon',
  'bounceMiracle',
  'bounceWeapon',
  'reflectAnything',
  'reflectMiracle',
  'reflectWeapon',
]);

function healthNeed(player: Player): number {
  return Math.max(0, 30 - player.hp) / 30;
}

function mpNeed(player: Player): number {
  return Math.max(0, 20 - player.mp) / 20;
}

/**
 * Relative HP-rank preference in the empirical target distribution.
 * This is separate from the estimated status/group preference.
 */
export function botTargetWeight(
  rankFraction: number,
  ability: string,
): number {
  const healthPreference = HEALTH_PREFERENCE_BY_ABILITY[ability] ?? 0;
  return 1 + healthPreference * rankFraction;
}

/**
 * Empirical target probabilities for a sorted enemy list. This approximates
 * the observed marginal distribution, not the official decision algorithm.
 * The creator confirmed that the official bot partitions all players by a
 * private strength score (HP has the largest influence) and attacks the other
 * group. The endpoint terms below are a surrogate for that undisclosed rule.
 * See docs/CREATOR-RULES.md for evidence and the limits of reconstruction.
 */
export function botTargetProbabilities(
  targetHps: readonly number[],
  ability: string,
  context?: BotTargetContext,
): number[] {
  if (targetHps.length === 0) {
    return [];
  }
  if (ability === 'buy') {
    return targetHps.map(() => 1 / targetHps.length);
  }
  if (ability === 'sell') {
    const weights = targetHps.map((unusedHp, rank) => botSellTargetWeight(rank));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map((weight) => weight / total);
  }
  const denominator = Math.max(1, targetHps.length - 1);
  const baseWeights = targetHps.map((hp, rank) =>
    botTargetWeight(rank / denominator, ability),
  );
  const totalWeight = baseWeights.reduce(
    (sum, weight) => sum + weight,
    0,
  );
  const remaining = Math.max(
    0,
    1 - TARGET_FOCUS_WEAKEST - TARGET_FOCUS_STRONGEST,
  );
  const probabilities = baseWeights.map((weight, rank) => {
    let probability = (remaining * weight) / totalWeight;
    if (rank === 0) {
      probability += TARGET_FOCUS_WEAKEST;
    }
    if (rank === targetHps.length - 1) {
      probability += TARGET_FOCUS_STRONGEST;
    }
    return probability;
  });
  return applyTargetGroupPreference(probabilities, context);
}

const TEAR_SELF_PERCENT_WITH_FEW_PLAYERS = 7;
const TEAR_SELF_PERCENT_WITH_MANY_PLAYERS = 3;
const TEAR_FEW_PLAYERS = 5;

export function botTearSelfPercent(livingPlayers: number): number {
  return livingPlayers <= TEAR_FEW_PLAYERS
    ? TEAR_SELF_PERCENT_WITH_FEW_PLAYERS
    : TEAR_SELF_PERCENT_WITH_MANY_PLAYERS;
}

const PRAYER_FALLOFF = 0.1;

export function botPrayerWeight(legalCount = 1): number {
  const extraOptions = Math.max(0, legalCount - 1);
  return (
    PRAYER_WEIGHT /
    (1 + PRAYER_FALLOFF * extraOptions * extraOptions)
  );
}

/**
 * Rough utility of opening with an item. The bot prefers healing when hurt,
 * resource recovery when low, efficient weapons, and affordable utility cards.
 */
export function botAttackUtility(
  player: Player,
  item: BotItem,
): number {
  const ability = item.ability ?? '';
  let utility = 1 + item.attack * 0.4;

  switch (ability) {
    case 'boostHP':
      utility = Math.max(
        6.5,
        5 + healthNeed(player) * 12 + (player.hp <= 10 ? 8 : 0),
      );
      break;
    case 'boostMP':
      utility = 2 + mpNeed(player) * 10;
      break;
    case 'exchange':
      utility =
        1 +
        (player.hp < 30 ? 7 : 0) +
        (player.mp < 30 ? 3 : 0);
      break;
    case 'sell':
      utility = 4.5;
      break;
    case 'buy':
      utility = 2.5;
      break;
    case 'addCurse':
      utility = 3;
      break;
    case 'addCurseOnDamage':
      utility = 2 + item.attack * 0.4;
      break;
    case 'setGuardian':
      utility = 5;
      break;
    case 'removeMildCurses':
      utility = 1.5;
      break;
    case 'removeAllCurses':
      utility = 2;
      break;
    case 'atkBy2xMP':
      utility = 1 + player.mp * 0.4;
      break;
    case 'boostCP':
      utility = 2;
      break;
    case 'attackTwice':
      utility = 1 + item.attack * 1.2;
      break;
    case 'absorbHP':
      utility = 1 + item.attack * 1.0;
      break;
    case 'discard':
    case 'sacrifice':
      return 0.01;
    default:
      break;
  }

  if (item.category.key === 'weapons') {
    utility += 1.7;
    if (responseWeaponAbilities.has(ability)) {
      utility -= 2;
    }
  }

  utility -= item.price * 0.15;
  return Math.max(0.01, utility);
}

// Opening utility offsets fitted on training games only. These preserve the
// state-dependent utility terms while accounting for cards kept for reactions.
const OPENING_EFFECT_UTILITY: Readonly<Record<string, number>> = {
  absorbHP: -4,
  addCurse: 2.2,
  addCurseOnDamage: 1.1,
  atkBy2xMP: -2.6,
  attackDyingly: DYING_ATTACK_OPENING_UTILITY,
  attackTwice: 1,
  boostCP: 2.4,
  boostHP: -0.3,
  boostHPOrDealDamage: 4.4,
  boostMP: -0.6,
  buy: -1,
  callPhenomenon: 2.2,
  danger: -6.1,
  dealSameDamage: -2.2,
  exchange: -0.1,
  removeAllCurses: -2.3,
  removeMildCurses: -1.5,
  sell: -0.4,
  setGuardian: 2,
};
const DEFENSIVE_WEAPON_OPENING_UTILITY = -5.5;
const LOW_HP_HEAL_OPENING_UTILITY = -1.2;

export function botAttackWeight(player: Player, item: BotItem): number {
  const isDefensiveWeapon = item.category.key === 'weapons'
    && responseWeaponAbilities.has(item.ability);
  const openingPreference = isDefensiveWeapon
    ? DEFENSIVE_WEAPON_OPENING_UTILITY
    : OPENING_EFFECT_UTILITY[item.ability] ?? 0;
  const lowHpHealPreference = item.ability === 'boostHP' && player.hp <= 10
    ? LOW_HP_HEAL_OPENING_UTILITY
    : 0;
  const utility = botAttackUtility(player, item) + openingPreference + lowHpHealPreference;
  return Math.exp(utility / ATTACK_UTILITY_TEMPERATURE);
}

export function botFollowUpWeight(player: Player, item: BotItem): number {
  if (item.ability === 'attackDyingly') {
    return DYING_ATTACK_FOLLOW_UP_WEIGHT;
  }

  return 1 + botAttackUtility(player, item) * FOLLOW_UP_WEIGHT_SCALE;
}

/**
 * Sell to the healthiest buyer in HP-rank order, never to the seller.
 */
export function botSellTargetWeight(rank: number): number {
  return 1 + rank * SELL_RANK_WEIGHT_SCALE;
}

const UNWANTED_PURCHASE_ABILITIES: ReadonlySet<string> = new Set([
  'attractDanger',
  'boostMPAndAddCurse',
  'dealSameDamage',
  'selfCurse',
  'selfCurseAndRedraw',
]);
const VALUABLE_WEAPON_ABILITIES: ReadonlySet<string> = new Set([
  'atkBy2xMP',
  'attackDyingly',
  'attackEveryEnemy',
  'attackTwice',
  'reflectMiracle',
  'setElement',
]);
const BUY_WEAPON_PRICE_LIMIT = 10;
const BUY_ARMOR_PRICE_LIMIT = 10;
const BUY_STRONG_ARMOR_MIN_DEFENSE = 9;
const BUY_STRONG_ARMOR_PRICE_LIMIT = 15;

// Calibrated on complete legal defense records, with whole games held out.
const DEFENSE_FORGIVE_FLOOR = 3;
const DEFENSE_FORGIVE_RANGE = 94;
const DEFENSE_BASE_LOG_ODDS = 2.25;
const DEFENSE_DAMAGE_LOG_ODDS = 0.41;
const DEFENSE_OPTION_LOG_ODDS = 0.86;
const DEFENSE_SPECIAL_LOG_ODDS = 0.60;
const DEFENSE_FULL_COVERAGE_LOG_ODDS = 0.07;
const DEFENSE_LETHAL_LOG_ODDS = 1.45;
const DEFENSE_EFFECT_LOG_ODDS = 3.37;
const DEFENSE_MIRACLE_LOG_ODDS = -0.64;
const DEFENSE_GUARDIAN_LOG_ODDS = -0.75;
const DEFENSE_TRADE_LOG_ODDS = 1.37;
const DEFENSE_FOLLOW_UP_PERCENT = 50;

/** Prefer useful prevention without spending cards on unnecessary defense. */
export function botDefenseChoiceWeight(
  item: BotItem,
  damage: number,
  response: boolean,
): number {
  const prevention = Math.min(item.defense, damage);
  const excessDefense = Math.max(0, item.defense - damage);
  const utility = prevention * 0.2 - excessDefense * 0.065
    + (response ? 1.7 : 0);
  return Math.exp(utility);
}

export function botDefenseFollowUpPercent(
  damage: number,
  defense: number,
  response: boolean,
): number {
  return response || defense >= damage ? 0 : DEFENSE_FOLLOW_UP_PERCENT;
}

/** Estimate forgiveness separately from which legal card the bot selects. */
export function botDefenseForgivePercent(
  damage: number,
  legalCount: number,
  hasSpecialDefense: boolean,
  lethal: boolean,
  bestDefense: number,
  attackCategory = 'weapons',
): number {
  if (legalCount === 0) {
    return 100;
  }
  let logOdds = DEFENSE_BASE_LOG_ODDS
    - Math.min(damage, 15) * DEFENSE_DAMAGE_LOG_ODDS
    - Math.log1p(legalCount) * DEFENSE_OPTION_LOG_ODDS;
  if (hasSpecialDefense) {
    logOdds += DEFENSE_SPECIAL_LOG_ODDS;
  }
  if (bestDefense >= damage) {
    logOdds -= DEFENSE_FULL_COVERAGE_LOG_ODDS;
  }
  if (lethal) {
    logOdds -= DEFENSE_LETHAL_LOG_ODDS;
  }
  if (damage === 0) {
    logOdds -= DEFENSE_EFFECT_LOG_ODDS;
  }
  if (attackCategory === 'miracles') {
    logOdds += DEFENSE_MIRACLE_LOG_ODDS;
  }
  if (attackCategory === 'guardians') {
    logOdds += DEFENSE_GUARDIAN_LOG_ODDS;
  }
  if (attackCategory === 'trade') {
    logOdds += DEFENSE_TRADE_LOG_ODDS;
  }
  return DEFENSE_FORGIVE_FLOOR
    + DEFENSE_FORGIVE_RANGE / (1 + Math.exp(-logOdds));
}

/** Recorded purchase choices follow card roles and price limits, without a roll. */
export function botBuyAcceptancePercent(item: BotItem): number {
  if (UNWANTED_PURCHASE_ABILITIES.has(item.ability)) {
    return 0;
  }
  if (item.category.key === 'weapons') {
    const isCheap = item.price < BUY_WEAPON_PRICE_LIMIT;
    const isValuableEffect = VALUABLE_WEAPON_ABILITIES.has(item.ability);
    return isCheap || item.isPlusAttack || isValuableEffect ? 100 : 0;
  }
  if (item.category.key === 'armor') {
    const isCheap = item.price <= BUY_ARMOR_PRICE_LIMIT;
    const isStrongAndAffordable = item.defense >= BUY_STRONG_ARMOR_MIN_DEFENSE
      && item.price <= BUY_STRONG_ARMOR_PRICE_LIMIT;
    return isCheap || isStrongAndAffordable ? 100 : 0;
  }
  if (item.category.key === 'sundries') {
    return item.ability === '' ? 0 : 100;
  }
  if (item.category.key === 'trade' || item.category.key === 'miracles') {
    return 100;
  }
  return 0;
}
