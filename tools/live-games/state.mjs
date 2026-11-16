/**
 * Catalog loading, state decoding, and log serialization.
 *
 * Decoding and calibration always go through the real engine modules. This file
 * only adapts the Firestore REST document into the Map-based shape expected by
 * src/domain/decode and turns decoded classes into stable JSON fields.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const cacheFile = path.join(import.meta.dirname, '.cache', 'en.json');
const localCatalog = path.resolve(import.meta.dirname, '../../public/i18n/en.json');
const remoteCatalog = 'https://godfield.net/i18n/en.json';

export async function loadCatalog(engine, {refresh = false} = {}) {
  let text;
  if (!refresh) {
    for (const source of [cacheFile, localCatalog]) {
      try {
        text = await fs.readFile(source, 'utf8');
        break;
      } catch {
        // Try the next local source.
      }
    }
  }
  if (text === null || text === undefined) {
    const response = await fetch(remoteCatalog);
    if (!response.ok) throw new Error(`Catalog download failed: HTTP ${response.status}`);
    text = await response.text();
    await fs.mkdir(path.dirname(cacheFile), {recursive: true});
    await fs.writeFile(cacheFile, text);
  }
  const json = JSON.parse(text);
  const catalog = engine.defaultItemCatalog;
  catalog.clear();
  engine.decodeItemModel(engine.decodeJson(json.items), catalog);
  return {
    catalog,
    itemCount: json.items.length,
    catalogHash: crypto.createHash('sha256').update(text).digest('hex'),
    source: cacheFile,
    translations: json.texts ?? {},
  };
}

export function decodeRoom(engine, raw) {
  return engine.decodeLobbyState(engine.decodeJson(raw));
}

function enumKey(value) {
  return value === null || value === undefined ? null : value.key;
}

export function serializeSlot(slot, catalog) {
  if (slot === null || slot === undefined) return null;
  let model = null;
  try {
    model = slot.getItemModel(catalog);
  } catch {
    model = null;
  }
  return {
    slotIndex: slot.id,
    modelId: slot.modelId,
    fakeModelId: slot.fakeModelId,
    used: slot.used === true,
    name: model?.name ?? null,
    category: model?.category?.key ?? null,
    commandType: model?.ability ?? null,
  };
}

export function serializeAttack(attack, catalog) {
  if (attack === null || attack === undefined) return null;
  return {
    playerId: attack.playerId,
    guardian: attack.guardian?.key ?? null,
    itemModelIds: [...attack.itemModelIds],
    items: attack.itemModelIds.map(id => {
      const model = catalog.findByIndex(id - 1);
      return {modelId: id, name: model?.name ?? null, category: model?.category?.key ?? null, commandType: model?.ability ?? null};
    }),
    attack: attack.attack,
    hitRate: attack.hitRate,
    mp: attack.mp,
    cp: attack.cp,
    targetPlayerId: attack.targetPlayerId,
    reversed: attack.reversed === true,
    buyingItemModelId: attack.buyingItemModelId,
  };
}

export function serializeEvent(event, catalog, updateCount, index) {
  const model = event.itemModelId > 0 ? catalog.findByIndex(event.itemModelId - 1) : null;
  const slotModel = event.item === null ? null : (() => {
    try {
      return event.item.getItemModel(catalog);
    } catch {
      return null;
    }
  })();
  return {
    updateCount,
    index,
    action: event.action,
    playerId: event.playerId,
    attack: serializeAttack(event.attack, catalog),
    damage: event.damage,
    hp: event.hp,
    mp: event.mp,
    cp: event.cp,
    curse: event.curse?.key ?? null,
    curses: event.curses.map(curse => curse.key),
    guardian: event.guardian?.key ?? null,
    guardians: event.guardians.map(guardian => guardian.key),
    itemModelId: event.itemModelId,
    item: serializeSlot(event.item, catalog),
    itemName: slotModel?.name ?? null,
    items: event.items.map(slot => serializeSlot(slot, catalog)),
    overflowItem: serializeSlot(event.overflowItem, catalog),
    overflowItemName: event.overflowItem === null ? null : (() => {
      try {
        return event.overflowItem.getItemModel(catalog).name;
      } catch {
        return null;
      }
    })(),
    eventIndex: event.index,
    bought: event.bought === true,
    natural: event.natural === true,
    modelName: model?.name ?? null,
  };
}

export function serializePlayer(player, catalog) {
  return {
    id: player.id,
    userId: player.userId,
    name: player.name,
    alias: player.alias,
    team: player.team?.key ?? null,
    isBot: player.isBot === true,
    hp: player.hp,
    mp: player.mp,
    cp: player.cp,
    curses: [...player.curses].map(curse => curse.key),
    guardian: player.guardian?.key ?? null,
    confusionCount: player.confusionCount,
    dead: player.dead === true,
    items: player.items.map(slot => serializeSlot(slot, catalog)),
    rating: player.rating,
    ratingGain: player.ratingGain,
  };
}

export function serializeGame(game, catalog) {
  return {
    gf: game.gf,
    tiebreakGF: game.tiebreakGF,
    attackTurnPlayerId: game.attackTurnPlayerId,
    attack: serializeAttack(game.attack, catalog),
    isOver: game.isOver === true,
    updateCount: game.updateCount,
    players: game.players.map(player => serializePlayer(player, catalog)),
    events: game.events.map((event, index) => serializeEvent(event, catalog, game.updateCount, index)),
  };
}

export function serializeRoom(room, catalog) {
  return {
    users: room.users.map(user => ({userId: user.userId, displayName: user.displayName})),
    isLocked: room.isLocked === true,
    entries: room.entries.map(entry => ({userId: entry.userId, team: entry.team?.key ?? null})),
    tiebreakGF: room.tiebreakGF,
    game: room.game === null ? null : serializeGame(room.game, catalog),
  };
}

function fieldChanges(previous, current, fields) {
  const changes = {};
  for (const [key, getter] of fields) {
    const before = getter(previous);
    const after = getter(current);
    if (before !== after) {
      const change = {from: before, to: after};
      if (typeof before === 'number' && typeof after === 'number') change.delta = after - before;
      changes[key] = change;
    }
  }
  return changes;
}

function itemMap(items, catalog) {
  const map = new Map();
  for (const item of items) {
    const model = catalog.findByIndex(item.modelId - 1);
    map.set(item.id, {
      slotIndex: item.id,
      modelId: item.modelId,
      fakeModelId: item.fakeModelId,
      used: item.used === true,
      name: model?.name ?? null,
    });
  }
  return map;
}

function diffItems(previous, current, catalog) {
  const before = itemMap(previous.items, catalog);
  const after = itemMap(current.items, catalog);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [index, item] of after) {
    const old = before.get(index);
    if (!old) added.push(item);
    else if (old.modelId !== item.modelId || old.fakeModelId !== item.fakeModelId || old.used !== item.used) {
      changed.push({...item, previous: old});
    }
  }
  for (const [index, item] of before) if (!after.has(index)) removed.push(item);
  return {added, removed, changed};
}

export function diffPlayerSnapshots(previous, current, catalog) {
  if (previous === null || current === null) return [];
  const before = new Map(previous.players.map(player => [player.id, player]));
  const changes = [];
  for (const player of current.players) {
    const old = before.get(player.id);
    if (!old) {
      changes.push({playerId: player.id, playerName: player.name, kind: 'joined', player: serializePlayer(player, catalog)});
      continue;
    }
    const fields = fieldChanges(old, player, [
      ['hp', value => value.hp],
      ['mp', value => value.mp],
      ['cp', value => value.cp],
      ['confusionCount', value => value.confusionCount],
      ['dead', value => value.dead],
      ['name', value => value.name],
      ['alias', value => value.alias],
      ['team', value => value.team?.key ?? null],
      ['rating', value => value.rating],
      ['ratingGain', value => value.ratingGain],
    ]);
    const cursesBefore = new Set([...old.curses].map(curse => curse.key));
    const cursesAfter = new Set([...player.curses].map(curse => curse.key));
    const cursesAdded = [...cursesAfter].filter(curse => !cursesBefore.has(curse));
    const cursesRemoved = [...cursesBefore].filter(curse => !cursesAfter.has(curse));
    const guardianChanged = (old.guardian?.key ?? null) !== (player.guardian?.key ?? null);
    const items = diffItems(old, player, catalog);
    const itemChanged = items.added.length || items.removed.length || items.changed.length;
    if (Object.keys(fields).length === 0 && cursesAdded.length === 0 && cursesRemoved.length === 0 && !guardianChanged && !itemChanged) continue;
    changes.push({
      playerId: player.id,
      playerName: player.name,
      kind: 'delta',
      fields,
      cursesAdded,
      cursesRemoved,
      guardian: guardianChanged ? {from: old.guardian?.key ?? null, to: player.guardian?.key ?? null} : null,
      items,
    });
  }
  for (const old of previous.players) {
    if (!current.players.some(player => player.id === old.id)) {
      changes.push({playerId: old.id, playerName: old.name, kind: 'left'});
    }
  }
  return changes;
}

export function worldChanges(previousRaw, currentRaw) {
  if (!previousRaw || !currentRaw) return null;
  const before = previousRaw.game ?? {};
  const after = currentRaw.game ?? {};
  const output = {};
  for (const key of ['guardianPlayerIds', 'diseasePlayerId', 'gf', 'attackTurnPlayerId']) {
    const old = JSON.stringify(before[key] ?? null);
    const next = JSON.stringify(after[key] ?? null);
    if (old !== next) output[key] = {from: before[key] ?? null, to: after[key] ?? null};
  }
  return Object.keys(output).length === 0 ? null : output;
}
