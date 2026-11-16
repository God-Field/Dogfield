/**
 * Scenario coverage collected from live games.
 *
 * A coverage file is a plain JSON document so both the exploration policy and
 * offline analysis can read it. The wrapper merges per-game deltas after each
 * run, but every game also embeds its own delta in its log.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function emptyCoverage() {
  return {
    eventActions: {},
    itemModels: {},
    commandTypes: {},
    categories: {},
    curses: {},
    guardians: {},
    playerCounts: {},
    decisionKinds: {},
    games: 0,
    wins: 0,
  };
}

function bump(map, key, amount = 1) {
  if (key === null || key === undefined || key === '') return;
  map[String(key)] = (map[String(key)] ?? 0) + amount;
}

function addModel(coverage, model, source) {
  if (!model) return;
  const key = String(model.id);
  const entry = coverage.itemModels[key] ?? {uses: 0, name: model.name, category: model.category?.key ?? null, commandType: model.ability ?? null, sources: {}};
  entry.uses++;
  entry.sources[source] = (entry.sources[source] ?? 0) + 1;
  coverage.itemModels[key] = entry;
  bump(coverage.categories, model.category?.key ?? null);
  bump(coverage.commandTypes, model.ability || model.category?.key || null);
}

export function collectEvent(coverage, event, catalog) {
  bump(coverage.eventActions, event.action);
  if (event.itemModelId > 0) addModel(coverage, catalog.findByIndex(event.itemModelId - 1), `event:${event.action}`);
  for (const id of event.attack?.itemModelIds ?? []) addModel(coverage, catalog.findByIndex(id - 1), 'event:attack');
  for (const item of event.items ?? []) if (item?.modelId > 0) addModel(coverage, catalog.findByIndex(item.modelId - 1), `event:${event.action}:item`);
  if (event.item?.modelId > 0) addModel(coverage, catalog.findByIndex(event.item.modelId - 1), `event:${event.action}:item`);
  if (event.overflowItem?.modelId > 0) addModel(coverage, catalog.findByIndex(event.overflowItem.modelId - 1), 'event:overflow');
  for (const curse of event.curses ?? []) bump(coverage.curses, curse);
  if (event.curse) bump(coverage.curses, event.curse);
  for (const guardian of event.guardians ?? []) bump(coverage.guardians, guardian);
  if (event.guardian) bump(coverage.guardians, event.guardian);
}

export function collectDecision(coverage, decision, catalog) {
  bump(coverage.decisionKinds, decision.kind);
  for (const selected of decision.selected ?? []) {
    addModel(coverage, catalog.findByIndex(selected.modelId - 1), `decision:${decision.kind}`);
  }
}

export function collectStatChange(coverage, statChange, catalog = null) {
  for (const curse of statChange.cursesAdded ?? []) bump(coverage.curses, curse);
  if (statChange.guardian?.to) bump(coverage.guardians, statChange.guardian.to);
  if (catalog !== null) {
    const items = statChange.items;
    for (const item of [...(items?.added ?? []), ...(items?.changed ?? [])]) {
      if (item.modelId > 0) addModel(coverage, catalog.findByIndex(item.modelId - 1), 'stat:item');
    }
  }
}

export function mergeCoverage(target, source) {
  for (const key of ['eventActions', 'itemModels', 'commandTypes', 'categories', 'curses', 'guardians', 'playerCounts', 'decisionKinds']) {
    for (const [name, value] of Object.entries(source[key] ?? {})) {
      if (key === 'itemModels') {
        const current = target.itemModels[name] ?? {uses: 0, name: value.name, category: value.category, commandType: value.commandType, sources: {}};
        current.uses += value.uses ?? 0;
        current.name = value.name ?? current.name;
        current.category = value.category ?? current.category;
        current.commandType = value.commandType ?? current.commandType;
        for (const [sourceName, count] of Object.entries(value.sources ?? {})) {
          current.sources[sourceName] = (current.sources[sourceName] ?? 0) + count;
        }
        target.itemModels[name] = current;
      } else {
        target[key][name] = (target[key][name] ?? 0) + value;
      }
    }
  }
  target.games += source.games ?? 0;
  target.wins += source.wins ?? 0;
  return target;
}

export async function loadCoverage(file) {
  if (!file) return emptyCoverage();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return mergeCoverage(emptyCoverage(), parsed);
  } catch {
    return emptyCoverage();
  }
}

export async function writeCoverage(file, coverage) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(coverage, null, 2)}\n`);
  await fs.rename(temporary, file);
}

export function summarizeCoverage(coverage) {
  return {
    games: coverage.games,
    wins: coverage.wins,
    eventActions: Object.keys(coverage.eventActions).length,
    itemModels: Object.keys(coverage.itemModels).length,
    commandTypes: Object.keys(coverage.commandTypes).length,
    categories: Object.keys(coverage.categories).length,
    curses: Object.keys(coverage.curses).length,
    guardians: Object.keys(coverage.guardians).length,
    decisionKinds: Object.keys(coverage.decisionKinds).length,
  };
}
