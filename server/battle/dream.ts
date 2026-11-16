import type { Random } from '../random.ts';
import { engine, itemCatalog, getItemDefinition } from '../engine.ts';

type ItemDefinitionType = ReturnType<typeof getItemDefinition>;

const weaponResponseAbilities = new Set(['bounceWeapon', 'reflectWeapon']);
const miracleResponseAbilities = new Set([
  'bounceMiracle',
  'reflectMiracle',
  'blockMiracle',
]);
const specialDefenseAbilities = new Set([
  'filterAtkElement',
  'reflectAnything',
]);
const nonTargetingSundryAbilities = new Set([
  'revive',
  'attractDanger',
]);

function getDefenseElement(definition: ItemDefinitionType): string {
  return definition.element?.key === 'darkness'
    ? 'none'
    : definition.element?.key ?? 'none';
}

/**
 * One key shape for every disguisable card:
 *
 *   <category>:<primaryRole>:<secondaryRoles>:<defenseElement>:<effect>:<curse>
 *
 * Roles describe how the card is used, not its raw attack/defense numbers.
 * `secondaryRoles` is a sorted `+`-joined set so future multi-role cards keep
 * all of their secondary behavior without inventing another template.
 */
function createDreamKey(
  category: string,
  primaryRole: string,
  secondaryRole: string,
  defenseElement: string,
  effect: string,
  curse: string,
): string {
  return [
    category,
    primaryRole,
    secondaryRole,
    defenseElement,
    effect,
    curse,
  ].join(':');
}

export function getDreamBucket(definition: ItemDefinitionType): string | null {
  const category = definition.category.key;
  const ability = definition.ability ?? '';
  const defenseElementValue = getDefenseElement(definition);
  const isPlusAttack = definition.isPlusAttack;
  const isGroupAttack = category === engine.CategoryWeapons.key
    && definition.hitRate > 0;
  const rolePrefix = isPlusAttack ? 'plus-' : '';
  const attackRole = `${rolePrefix}attack`;
  let categoryKey = 'none';
  let primaryRole = attackRole;
  const secondaryRoles: string[] = [];
  let defenseElement = 'none';
  let effect = 'none';
  let curse = 'none';

  if (weaponResponseAbilities.has(ability)) {
    secondaryRoles.push('weapon-response');
  }
  if (miracleResponseAbilities.has(ability)) {
    secondaryRoles.push('miracle-response');
  }
  if (specialDefenseAbilities.has(ability)) {
    secondaryRoles.push('special-response');
  }
  if (ability === 'cutCost') {
    secondaryRoles.push('spiritual');
    effect = 'cutCost';
  }
  if (isGroupAttack) {
    primaryRole = `${rolePrefix}group-attack`;
  }

  if (category === engine.CategoryWeapons.key) {
    categoryKey = 'weapons';
    if (definition.defense > 0) {
      secondaryRoles.push('defense');
      defenseElement = defenseElementValue;
    }
  }

  if (category === engine.CategoryArmor.key) {
    categoryKey = 'armor';
    primaryRole = 'defense';
    defenseElement = defenseElementValue;
    if (definition.attack > 0) {
      secondaryRoles.push(attackRole);
      effect = ability === '' ? 'none' : ability;
    } else if (specialDefenseAbilities.has(ability)) {
      effect = ability;
    }
  }

  if (category === engine.CategorySundries.key) {
    categoryKey = 'sundries';
    primaryRole = 'utility';
    if (definition.attack > 0) {
      secondaryRoles.push(attackRole);
      effect = ability === '' ? 'none' : ability;
    }
    if (nonTargetingSundryAbilities.has(ability)) {
      secondaryRoles.push('passive');
    }
  }

  if (effect === 'addCurseOnDamage') {
    curse = definition.curse?.key ?? 'none';
  }

  let secondaryRole = 'none';
  if (secondaryRoles.length !== 0) {
    secondaryRole = secondaryRoles.sort().join('+');
  }
  if (categoryKey === 'none') {
    return null;
  }
  return createDreamKey(
    categoryKey,
    primaryRole,
    secondaryRole,
    defenseElement,
    effect,
    curse,
  );
}

export function getDreamDisguisePool(
  definition: ItemDefinitionType,
): ItemDefinitionType[] {
  const bucket = getDreamBucket(definition);
  if (bucket === null) {
    return [];
  }
  return itemCatalog.filter(
    (candidate) =>
      candidate.giftRate > 0 && getDreamBucket(candidate) === bucket,
  );
}

/**
 * Picks the fake model id for a newly acquired item, or undefined when the
 * item is not dreamable.
 *
 * Dream shows the real card half of the time. The other half shows a different
 * card from the same observed bucket. When the bucket has no other member,
 * official games leave the card undisguised rather than marking it as the real
 * model.
 */
export function selectDreamDisguise(
  random: Random,
  definition: ItemDefinitionType,
): number | undefined {
  const pool = getDreamDisguisePool(definition);
  if (pool.length === 0) {
    return undefined;
  }
  const alternatives = pool.filter((candidate) => candidate.id !== definition.id);
  if (alternatives.length === 0) {
    return undefined;
  }
  if (random.chance('dreamReal', 50)) {
    return definition.id;
  }
  return random.pick('dreamItem', alternatives, (candidate) => candidate.giftRate).id;
}
