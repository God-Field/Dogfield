#!/usr/bin/env node
/**
 * Builds the dream-transformation pool report from the shared catalog.
 *
 * A pool is a strongly connected component of the observed true->fake graph:
 * every item in the pool can reach every other item through observed
 * transformations. Pools are compared with the inferred same-category group
 * rule so remaining gaps are visible.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadEngine, root} from './engine.mjs';
import {loadCatalog} from './state.mjs';
import {loadDreamCatalog} from './dream.mjs';

const dreamCategories = new Set(['weapons', 'armor', 'sundries']);

function targetModels(itemModels) {
  return itemModels.filter(model =>
    dreamCategories.has(model.category?.key) && model.giftRate > 0);
}

const weaponResponseAbilities = new Set(['bounceWeapon', 'reflectWeapon']);
const miracleResponseAbilities = new Set(['bounceMiracle', 'reflectMiracle', 'blockMiracle']);
const specialDefenseAbilities = new Set(['filterAtkElement', 'reflectAnything']);
const nonTargetingSundryAbilities = new Set(['revive', 'attractDanger']);

function defenseElement(model) {
  return model.element?.key === 'darkness'
    ? 'none'
    : model.element?.key ?? 'none';
}

function createDreamKey(category, primaryRole, secondaryRole, element, effect, curse) {
  return [category, primaryRole, secondaryRole, element, effect, curse].join(':');
}

/** Compact reconstruction of the observed dream buckets. */
export function deriveDreamBucket(model) {
  const category = model.category?.key;
  const ability = model.ability ?? '';
  const defenseElementValue = defenseElement(model);
  const isPlusAttack = model.isPlusAttack;
  const isGroupAttack = category === 'weapons' && model.hitRate > 0;
  const rolePrefix = isPlusAttack ? 'plus-' : '';
  const attackRole = `${rolePrefix}attack`;
  let categoryKey = 'none';
  let primaryRole = attackRole;
  const secondaryRoles = [];
  let element = 'none';
  let effect = 'none';
  let curse = 'none';

  if (weaponResponseAbilities.has(ability)) secondaryRoles.push('weapon-response');
  if (miracleResponseAbilities.has(ability)) secondaryRoles.push('miracle-response');
  if (specialDefenseAbilities.has(ability)) secondaryRoles.push('special-response');
  if (ability === 'cutCost') {
    secondaryRoles.push('spiritual');
    effect = 'cutCost';
  }
  if (isGroupAttack) {
    primaryRole = `${rolePrefix}group-attack`;
  }

  if (category === 'weapons') {
    categoryKey = 'weapons';
    if (model.defense > 0) {
      secondaryRoles.push('defense');
      element = defenseElementValue;
    }
  }

  if (category === 'armor') {
    categoryKey = 'armor';
    primaryRole = 'defense';
    element = defenseElementValue;
    if (model.attack > 0) {
      secondaryRoles.push(attackRole);
      effect = ability === '' ? 'none' : ability;
    } else if (specialDefenseAbilities.has(ability)) {
      effect = ability;
    }
  }

  if (category === 'sundries') {
    categoryKey = 'sundries';
    primaryRole = 'utility';
    if (model.attack > 0) {
      secondaryRoles.push(attackRole);
      effect = ability === '' ? 'none' : ability;
    }
    if (nonTargetingSundryAbilities.has(ability)) {
      secondaryRoles.push('passive');
    }
  }

  if (effect === 'addCurseOnDamage') {
    curse = model.curse?.key ?? 'none';
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
    element,
    effect,
    curse,
  );
}

function stronglyConnectedComponents(edges) {
  const nodes = new Set();
  for (const [from, targets] of edges) {
    nodes.add(from);
    for (const target of targets) nodes.add(target);
  }
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let nextIndex = 0;

  const visit = node => {
    index.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node), index.get(target)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      for (;;) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      components.push(component);
    }
  };

  for (const node of nodes) if (!index.has(node)) visit(node);
  return components;
}

function itemSummary(model, catalog) {
  const entry = catalog.items[String(model.id)] ?? null;
  return {
    modelId: model.id,
    name: model.name,
    category: model.category?.key ?? null,
    element: model.element?.key ?? null,
    kind: deriveDreamBucket(model),
    ability: model.ability || null,
    giftRate: model.giftRate,
    dreamedSightings: entry?.dreamGifts ?? 0,
    dreamedUses: entry?.dreamUses ?? 0,
    observedFakeIds: Object.keys(entry?.pairs ?? {}).map(Number).sort((left, right) => left - right),
  };
}

function buildAnalysis(catalog, itemModels) {
  const targets = targetModels(itemModels);
  const targetById = new Map(targets.map(model => [model.id, model]));
  const observedPairs = Object.values(catalog.pairs)
    .filter(pair => pair.trueModelId !== pair.fakeModelId && pair.observedGames > 0);
  const edges = new Map();
  for (const pair of observedPairs) {
    const set = edges.get(pair.trueModelId) ?? new Set();
    set.add(pair.fakeModelId);
    edges.set(pair.trueModelId, set);
  }
  const components = stronglyConnectedComponents(edges)
    .filter(component => component.length > 1)
    .sort((left, right) => right.length - left.length);
  const pools = components.map(component => {
    const members = component.map(id => targetById.get(id)).filter(Boolean).sort((left, right) => left.id - right.id);
    const internalPairs = observedPairs.filter(pair =>
      component.includes(pair.trueModelId) && component.includes(pair.fakeModelId));
    const possiblePairs = component.length * (component.length - 1);
    const mutual = internalPairs.filter(pair => edges.get(pair.fakeModelId)?.has(pair.trueModelId));
    return {
      size: component.length,
      categories: [...new Set(members.map(model => model.category.key))],
      elements: [...new Set(members.map(model => model.element?.key ?? 'none'))],
      kinds: [...new Set(members.map(model => deriveDreamBucket(model)))],
      observedInternalPairs: internalPairs.length,
      possibleInternalPairs: possiblePairs,
      mutualPairs: mutual.length,
      items: members.map(model => itemSummary(model, catalog)),
    };
  });

  const mutualPairs = [];
  for (const pair of observedPairs) {
    const reverseKey = `${pair.fakeModelId}>${pair.trueModelId}`;
    if (!catalog.pairs[reverseKey]) continue;
    if (pair.trueModelId > pair.fakeModelId) continue;
    const reverse = catalog.pairs[reverseKey];
    mutualPairs.push({
      left: itemSummary(targetById.get(pair.trueModelId), catalog),
      right: itemSummary(targetById.get(pair.fakeModelId), catalog),
      leftToRight: pair.observedGames,
      rightToLeft: reverse.observedGames,
    });
  }
  mutualPairs.sort((left, right) =>
    (right.leftToRight + right.rightToLeft) - (left.leftToRight + left.rightToLeft));

  const derivedGroups = new Map();
  for (const model of targets) {
    const key = deriveDreamBucket(model);
    const group = derivedGroups.get(key) ?? {key, items: [], observedPairs: 0, possiblePairs: 0, coveredItems: 0};
    group.items.push(itemSummary(model, catalog));
    derivedGroups.set(key, group);
  }
  for (const group of derivedGroups.values()) {
    const ids = new Set(group.items.map(item => item.modelId));
    const internal = observedPairs.filter(pair => ids.has(pair.trueModelId) && ids.has(pair.fakeModelId));
    group.observedPairs = internal.length;
    group.possiblePairs = group.items.length * (group.items.length - 1);
    group.coveredItems = group.items.filter(item => item.observedFakeIds.length > 0).length;
  }
  const derivedMismatches = [];
  for (const pool of pools) {
    const keys = new Set(pool.items.map(item => item.kind));
    if (keys.size !== 1) derivedMismatches.push({poolSize: pool.size, derivedKeys: [...keys]});
  }


  const unusedWhileDreamed = targets
    .filter(model => (catalog.items[String(model.id)]?.dreamUses ?? 0) === 0)
    .map(model => itemSummary(model, catalog));
  const neverDreamed = targets
    .filter(model => (catalog.items[String(model.id)]?.dreamGifts ?? 0) === 0)
    .map(model => itemSummary(model, catalog));
  const seenNotUsed = targets
    .filter(model => (catalog.items[String(model.id)]?.dreamGifts ?? 0) > 0)
    .filter(model => (catalog.items[String(model.id)]?.dreamUses ?? 0) === 0)
    .map(model => itemSummary(model, catalog));
  const predictedBuckets = targets
    .filter(model => (catalog.items[String(model.id)]?.dreamGifts ?? 0) === 0)
    .map(model => ({modelId: model.id, name: model.name, predictedBucket: deriveDreamBucket(model)}));

  return {
    schema: 'godfield-dream-analysis/1',
    generatedAt: new Date().toISOString(),
    catalog: {
      games: catalog.games,
      dreamGames: catalog.dreamGames,
      uniqueObservedPairs: Object.keys(catalog.pairs).length,
      pairObservations: catalog.totalObservedPairs,
      usedPairObservations: catalog.totalUsedPairs,
    },
    targets: targets.length,
    itemsUsedWhileDreamed: targets.length - unusedWhileDreamed.length,
    pools,
    mutualPairs,
    derivedGroups: [...derivedGroups.values()].sort((left, right) => right.items.length - left.items.length),
    derivedMismatches,
    predictedBuckets,
    unusedWhileDreamed,
    seenNotUsed,
    neverDreamed,
  };
}

function formatItem(item) {
  return `${item.modelId} ${item.name}`;
}

function formatMarkdown(analysis) {
  const lines = [];
  lines.push('# Dream transformation analysis');
  lines.push('');
  lines.push(`Generated: ${analysis.generatedAt}`);
  lines.push(`Games: ${analysis.catalog.games} (${analysis.catalog.dreamGames} with dream items)`);
  lines.push(`Items used while dreamed: ${analysis.itemsUsedWhileDreamed}/${analysis.targets}`);
  lines.push(`Unique observed true->fake pairs: ${analysis.catalog.uniqueObservedPairs}; pair observations: ${analysis.catalog.pairObservations}; used pair observations: ${analysis.catalog.usedPairObservations}`);
  lines.push('');
  lines.push('A slot is dreamed only when `fakeModelId > 0`. Items already in hand when Dream is applied do not change; only items acquired afterwards are dreamed.');
  lines.push('');
  lines.push('These pools describe the broad groups observed on the live service. The local server uses the same role-slot key in `server/battle/dream.ts`.');
  lines.push('');
  lines.push('## Observed transformation pools');
  lines.push('');
  lines.push('Each pool is a strongly connected component: every item can reach every other item through observed transformations.');
  lines.push('');
  for (const [index, pool] of analysis.pools.entries()) {
    lines.push(`### Pool ${index + 1}: ${pool.size} items (${pool.categories.join(', ')}; ${pool.elements.join(', ')})`);
    lines.push(`Observed internal pairs: ${pool.observedInternalPairs}/${pool.possibleInternalPairs}; mutual pairs: ${pool.mutualPairs}`);
    lines.push('');
    lines.push(pool.items.map(item => `${formatItem(item)} (${item.kind}, dreamUses=${item.dreamedUses})`).join(', '));
    lines.push('');
  }
  lines.push('## Derived ruleset');
  lines.push('');
  lines.push('Every key uses one template: `<category>:<primaryRole>:<secondaryRoles>:<defenseElement>:<effect>:<curse>`.');
  lines.push('');
  lines.push('Primary roles are attack/plus-attack/group-attack/plus-group-attack/defense/utility. Secondary roles are attack/plus-attack/defense/weapon-response/miracle-response/special-response/spiritual/passive, sorted and joined with `+`. The defense element is always the actual defense-action element when one exists, and the curse slot is `none` unless the effect is `addCurseOnDamage`. Trade, miracles, devils, guardians, and phenomena are never disguised.');
  lines.push('');
  lines.push(`Validation against the observed pools: ${analysis.derivedMismatches.length === 0 ? '0 mismatches' : JSON.stringify(analysis.derivedMismatches)}`);
  lines.push('');
  lines.push('Bucket sizes:');
  lines.push('');
  for (const group of analysis.derivedGroups) {
    lines.push(`- ${group.key}: ${group.coveredItems}/${group.items.length} items seen, ${group.observedPairs}/${group.possiblePairs} directed pairs observed`);
  }
  lines.push('');
  lines.push('## Predicted buckets for never-dreamed items');
  lines.push('');
  if (analysis.predictedBuckets.length === 0) lines.push('None.');
  else for (const item of analysis.predictedBuckets) {
    lines.push(`- ${item.modelId} ${item.name} -> ${item.predictedBucket}`);
  }
  lines.push('');
  lines.push('## Items not yet used while dreamed');
  lines.push('');
  if (analysis.unusedWhileDreamed.length === 0) lines.push('None.');
  else for (const item of analysis.unusedWhileDreamed) {
    lines.push(`- ${formatItem(item)} (${item.category}, dreamedSightings=${item.dreamedSightings}, dreamedUses=${item.dreamedUses})`);
  }
  lines.push('');
  lines.push('## Items never acquired while dreamed');
  lines.push('');
  if (analysis.neverDreamed.length === 0) lines.push('None.');
  else lines.push(analysis.neverDreamed.map(formatItem).join(', '));
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    catalog: path.join(root, 'logs', 'live', 'dream', 'dream-catalog.json'),
    json: path.join(root, 'logs', 'live', 'dream', 'dream-analysis.json'),
    markdown: path.join(root, 'logs', 'live', 'dream', 'DREAM_ANALYSIS.md'),
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const next = () => {
      const value = args[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    if (argument === '--catalog') options.catalog = path.resolve(next());
    else if (argument === '--json') options.json = path.resolve(next());
    else if (argument === '--markdown') options.markdown = path.resolve(next());
    else if (argument === '--help') {
      process.stdout.write('Usage: node analyze-dream.mjs [--catalog FILE] [--json FILE] [--markdown FILE]\n');
      return;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  const engine = await loadEngine();
  const {catalog: itemCatalog} = await loadCatalog(engine);
  const dreamCatalog = await loadDreamCatalog(options.catalog);
  const analysis = buildAnalysis(dreamCatalog, itemCatalog.models);
  await fs.mkdir(path.dirname(options.json), {recursive: true});
  await fs.writeFile(options.json, `${JSON.stringify(analysis, null, 2)}\n`);
  await fs.writeFile(options.markdown, `${formatMarkdown(analysis)}\n`);
  process.stdout.write(`${formatMarkdown(analysis)}\n`);
  process.stdout.write(`JSON: ${options.json}\nMarkdown: ${options.markdown}\n`);
}

await main();
