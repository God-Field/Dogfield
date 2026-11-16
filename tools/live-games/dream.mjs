/**
 * Shared dream-transformation catalog.
 *
 * Dream disguises gifts as another giftable item of the same category. A live
 * game log records both the true `modelId` and the shown `fakeModelId`, so the
 * catalog learns which disguises each item can take and, when a disguised item
 * is actually used, what it turns into.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dreamCategories = new Set(['weapons', 'armor', 'sundries']);
const useActions = new Set(['useAttackItems', 'useDefenseItems', 'discard', 'sacrifice', 'exchange', 'sell']);
const defaultCatalogPath = path.join('logs', 'live', 'dream', 'dream-catalog.json');

export function emptyDreamCatalog() {
  return {
    schema: 'godfield-dream-catalog/1',
    games: 0,
    dreamGames: 0,
    totalObservedPairs: 0,
    totalUsedPairs: 0,
    mergedGameIds: [],
    items: {},
    pairs: {},
    reveals: {},
    updatedAt: null,
  };
}

function normalizeCatalog(input) {
  const catalog = emptyDreamCatalog();
  if (input === null || typeof input !== 'object') return catalog;
  for (const key of ['games', 'dreamGames', 'totalObservedPairs', 'totalUsedPairs']) {
    if (Number.isInteger(input[key])) catalog[key] = input[key];
  }
  if (Array.isArray(input.mergedGameIds)) catalog.mergedGameIds = input.mergedGameIds.filter(value => typeof value === 'string');
  if (input.items !== null && typeof input.items === 'object') catalog.items = input.items;
  if (input.pairs !== null && typeof input.pairs === 'object') catalog.pairs = input.pairs;
  if (input.reveals !== null && typeof input.reveals === 'object') catalog.reveals = input.reveals;
  if (typeof input.updatedAt === 'string') catalog.updatedAt = input.updatedAt;
  return catalog;
}

export async function loadDreamCatalog(file) {
  try {
    return normalizeCatalog(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return emptyDreamCatalog();
  }
}

function pairKey(trueModelId, fakeModelId) {
  return `${trueModelId}>${fakeModelId}`;
}

function itemName(itemModels, modelId) {
  return itemModels.find(model => model.id === modelId)?.name ?? null;
}

function itemCategory(itemModels, modelId) {
  return itemModels.find(model => model.id === modelId)?.category?.key ?? null;
}

function ensureItem(catalog, itemModels, modelId) {
  const key = String(modelId);
  catalog.items[key] ??= {
    modelId,
    name: itemName(itemModels, modelId),
    category: itemCategory(itemModels, modelId),
    dreamGifts: 0,
    dreamUses: 0,
    pairs: {},
  };
  return catalog.items[key];
}

function ensurePair(catalog, itemModels, trueModelId, fakeModelId) {
  const key = pairKey(trueModelId, fakeModelId);
  catalog.pairs[key] ??= {
    trueModelId,
    trueName: itemName(itemModels, trueModelId),
    trueCategory: itemCategory(itemModels, trueModelId),
    fakeModelId,
    fakeName: itemName(itemModels, fakeModelId),
    fakeCategory: itemCategory(itemModels, fakeModelId),
    observedGames: 0,
    usedCount: 0,
    lastGameId: null,
  };
  return catalog.pairs[key];
}

function isItemSlot(value) {
  return value !== null
    && typeof value === 'object'
    && Number.isInteger(value.modelId)
    && Number.isInteger(value.fakeModelId);
}

/** Walks a decoded log record and yields every serialized item slot it holds. */
function walkSlots(value, output) {
  if (Array.isArray(value)) {
    for (const entry of value) walkSlots(entry, output);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (isItemSlot(value)) output.push(value);
  for (const entry of Object.values(value)) walkSlots(entry, output);
}

/** Returns only the slots that belong to a server-confirmed item use event. */
function usedSlots(record) {
  if (record.type !== 'event' || !useActions.has(record.action)) return [];
  const output = [];
  if (isItemSlot(record.item)) output.push(record.item);
  for (const item of record.items ?? []) if (isItemSlot(item)) output.push(item);
  return output;
}

export function mergeDreamLog(catalog, records, itemModels, gameId) {
  if (catalog.mergedGameIds.includes(gameId)) return false;
  const slots = [];
  const used = [];
  for (const record of records) {
    walkSlots(record, slots);
    used.push(...usedSlots(record));
  }
  const observedPairs = new Map();
  let dreamed = false;
  for (const slot of slots) {
    if (slot.fakeModelId <= 0) continue;
    dreamed = true;
    if (slot.fakeModelId === slot.modelId) continue;
    observedPairs.set(pairKey(slot.modelId, slot.fakeModelId), slot);
  }
  ensureDreamedGifts(catalog, itemModels, slots);
  for (const [key, slot] of observedPairs) {
    const pair = ensurePair(catalog, itemModels, slot.modelId, slot.fakeModelId);
    pair.observedGames++;
    pair.lastGameId = gameId;
    const item = ensureItem(catalog, itemModels, slot.modelId);
    item.pairs[String(slot.fakeModelId)] ??= {fakeModelId: slot.fakeModelId, observedGames: 0, usedCount: 0};
    item.pairs[String(slot.fakeModelId)].observedGames++;
    catalog.totalObservedPairs++;
  }
  for (const slot of used) {
    if (slot.fakeModelId <= 0) continue;
    const item = ensureItem(catalog, itemModels, slot.modelId);
    item.dreamUses++;
    const reveal = catalog.reveals[String(slot.fakeModelId)] ??= {
      modelId: slot.fakeModelId,
      name: itemName(itemModels, slot.fakeModelId),
      category: itemCategory(itemModels, slot.fakeModelId),
      revealedAs: {},
    };
    reveal.revealedAs[String(slot.modelId)] = (reveal.revealedAs[String(slot.modelId)] ?? 0) + 1;
    if (slot.fakeModelId !== slot.modelId) {
      const pair = ensurePair(catalog, itemModels, slot.modelId, slot.fakeModelId);
      pair.usedCount++;
      pair.lastGameId = gameId;
      item.pairs[String(slot.fakeModelId)] ??= {fakeModelId: slot.fakeModelId, observedGames: 0, usedCount: 0};
      item.pairs[String(slot.fakeModelId)].usedCount++;
      catalog.totalUsedPairs++;
    }
  }
  catalog.games++;
  if (dreamed) catalog.dreamGames++;
  catalog.mergedGameIds.push(gameId);
  return true;
}

function ensureDreamedGifts(catalog, itemModels, slots) {
  const seen = new Set();
  for (const slot of slots) {
    if (slot.fakeModelId <= 0 || seen.has(slot.modelId)) continue;
    seen.add(slot.modelId);
    ensureItem(catalog, itemModels, slot.modelId).dreamGifts++;
  }
}

async function readLog(file) {
  const text = await fs.readFile(file, 'utf8');
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A truncated final line should not discard the rest of the game.
    }
  }
  return records;
}

function gameIdFor(records, file) {
  for (const record of records) if (typeof record.gameId === 'string') return record.gameId;
  return path.basename(file);
}

async function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function withCatalogLock(file, callback) {
  const lockFile = `${file}.lock`;
  await fs.mkdir(path.dirname(file), {recursive: true});
  let handle = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const status = await fs.stat(lockFile);
        if (Date.now() - status.mtimeMs > 60000) await fs.unlink(lockFile);
      } catch {
        // Another process may have released it between stat and unlink.
      }
      await sleep(100 + Math.floor(Math.random() * 200));
    }
  }
  if (handle === null) throw new Error(`Timed out waiting for dream catalog lock: ${lockFile}`);
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockFile).catch(() => {});
  }
}

async function writeDreamCatalog(file, catalog) {
  catalog.updatedAt = new Date().toISOString();
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
  await fs.rename(temporary, file);
}

export async function updateDreamCatalogFromLogs(file, logs, itemModels) {
  return withCatalogLock(file, async () => {
    const catalog = await loadDreamCatalog(file);
    let merged = 0;
    for (const log of logs) {
      const records = await readLog(log);
      if (records.length === 0) continue;
      if (mergeDreamLog(catalog, records, itemModels, gameIdFor(records, log))) merged++;
    }
    await writeDreamCatalog(file, catalog);
    return {catalog, merged};
  });
}

export function buildDreamPlan(catalog, itemModels) {
  const target = itemModels.filter(model =>
    dreamCategories.has(model.category?.key) && model.giftRate > 0);
  const byCategory = new Map();
  for (const model of target) {
    const list = byCategory.get(model.category.key) ?? [];
    list.push(model.id);
    byCategory.set(model.category.key, list);
  }
  const deficits = [];
  const unseen = [];
  let coveredItems = 0;
  let observedPairs = 0;
  let expectedPairs = 0;
  for (const model of target) {
    const entry = catalog.items[String(model.id)];
    const seen = new Set(Object.keys(entry?.pairs ?? {}).map(Number));
    const expected = byCategory.get(model.category.key) ?? [];
    expectedPairs += expected.length;
    observedPairs += seen.size;
    if (seen.size !== 0) coveredItems++;
    if (!entry || entry.dreamGifts === 0) unseen.push(model.id);
    if (seen.size < expected.length) deficits.push([model.id, expected.length - seen.size]);
  }
  return {
    targetCount: target.length,
    coveredItems,
    unseen,
    deficits,
    observedPairs,
    expectedPairs,
    dreamGames: catalog.dreamGames,
    games: catalog.games,
  };
}

export function summarizeDreamCatalog(catalog, itemModels) {
  const plan = buildDreamPlan(catalog, itemModels);
  const usedIds = Object.values(catalog.items).filter(item => item.dreamUses > 0).map(item => item.modelId);
  const revealedFakeIds = Object.keys(catalog.reveals).map(Number);
  return {
    games: catalog.games,
    dreamGames: catalog.dreamGames,
    itemsWithDreamGifts: Object.values(catalog.items).filter(item => item.dreamGifts > 0).length,
    itemsUsedInDream: usedIds.length,
    targetItems: plan.targetCount,
    coveredItems: plan.coveredItems,
    observedPairs: plan.observedPairs,
    expectedPairs: plan.expectedPairs,
    pairsWithUses: Object.values(catalog.pairs).filter(pair => pair.usedCount > 0).length,
    fakeModelsSeen: revealedFakeIds.length,
    updatedAt: catalog.updatedAt,
  };
}

export function formatDreamReport(catalog, itemModels) {
  const summary = summarizeDreamCatalog(catalog, itemModels);
  const lines = [
    `Dream catalog: ${summary.games} games (${summary.dreamGames} with dream), ${summary.itemsUsedInDream}/${summary.targetItems} items used in dream`,
    `Disguise candidates: ${summary.coveredItems}/${summary.targetItems} true items seen, ${summary.observedPairs}/${summary.expectedPairs} possible true->fake pairs observed`,
    `Used transformations: ${summary.pairsWithUses} true->fake pairs used, ${summary.fakeModelsSeen} fake models revealed`,
  ];
  const used = Object.values(catalog.items)
    .filter(item => item.dreamUses > 0)
    .sort((left, right) => right.dreamUses - left.dreamUses);
  if (used.length !== 0) {
    lines.push('Items used in dream:');
    for (const item of used.slice(0, 40)) {
      const disguises = Object.entries(item.pairs)
        .sort((left, right) => Number(right[1].usedCount) - Number(left[1].usedCount))
        .slice(0, 5)
        .map(([fakeId, pair]) => `${catalog.pairs[pairKey(item.modelId, Number(fakeId))]?.fakeName ?? fakeId}x${pair.usedCount}`)
        .join(', ');
      lines.push(`  ${item.modelId} ${item.name}: ${item.dreamUses} uses (${disguises})`);
    }
  }
  const missing = itemModels
    .filter(model => dreamCategories.has(model.category?.key) && model.giftRate > 0)
    .filter(model => !catalog.items[String(model.id)] || catalog.items[String(model.id)].dreamGifts === 0);
  if (missing.length !== 0) {
    lines.push(`Never seen while dreaming (${missing.length}): ${missing.map(model => `${model.id} ${model.name}`).join(', ')}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const options = {catalog: defaultCatalogPath, logs: [], report: false};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const next = () => args[++index];
    if (argument === '--catalog') options.catalog = next();
    else if (argument === '--log') options.logs.push(next());
    else if (argument === '--run') {
      const run = next();
      const entries = await fs.readdir(run);
      for (const entry of entries) if (entry.endsWith('.jsonl')) options.logs.push(path.join(run, entry));
    } else if (argument === '--report') options.report = true;
    else if (argument === '--help') {
      process.stdout.write('Usage: node dream.mjs [--catalog FILE] [--log FILE | --run DIR] [--report]\n');
      return;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const {loadCatalog} = await import('./state.mjs');
  const engine = await (await import('./engine.mjs')).loadEngine();
  const loaded = await loadCatalog(engine);
  const itemModels = loaded.catalog.models;
  if (options.logs.length !== 0) {
    const {catalog} = await updateDreamCatalogFromLogs(options.catalog, options.logs, itemModels);
    process.stdout.write(`${formatDreamReport(catalog, itemModels)}\n`);
  } else {
    const catalog = await loadDreamCatalog(options.catalog);
    process.stdout.write(`${formatDreamReport(catalog, itemModels)}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
