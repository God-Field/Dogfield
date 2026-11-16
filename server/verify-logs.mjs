#!/usr/bin/env node
/**
 * Generic differential verifier for official Godfield logs.
 *
 * It replays every recorded submit-command or decision that has a raw `channel`
 * game snapshot on both sides of the update, using the local battle engine. The
 * comparison preserves key presence and array order, so omissions such as a
 * missing zero-valued field are visible without writing a check per field.
 *
 * A multi-turn update is split at `advanceGF`; the local replay is compared
 * with the first turn segment, and every update is also checked for scheduler
 * invariants. Normalized `state` snapshots without a raw channel are still used
 * for those structural invariants. Files with no game snapshot at all cannot be
 * replayed and are reported as skipped.
 *
 * Usage:
 *   node --import tsx server/verify-logs.mjs
 *   node --import tsx server/verify-logs.mjs --logs=logs,../godfield-refactor/logs
 *   node --import tsx server/verify-logs.mjs --logs=... --report=/tmp/report.json
 *   node --import tsx server/verify-logs.mjs --oracle
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Battle } from './battle/battle.ts';
import { applyDuelRatingGains } from './rooms/duel.ts';
import { Random } from './random.ts';
import { HttpError } from './errors.ts';

class EntropyBoundary extends Error {
  constructor(label) {
    super(label);
    this.label = label;
  }
}

class AuditRandom extends Random {
  value(label) {
    this.requirePrefix(label);
    this.trace(label);
    throw new EntropyBoundary(label);
  }
  chance(label) {
    throw new EntropyBoundary(label);
  }
  pick(label) {
    throw new EntropyBoundary(label);
  }
  shuffle(label) {
    throw new EntropyBoundary(label);
  }
}

class OracleRandom extends Random {
  constructor(officialEvents, nextGame, context = {}, before = null) {
    super(0);
    this.officialEvents = officialEvents;
    this.nextGame = nextGame;
    this.context = context;
    this.before = before;
    this.battle = null;
    this.segmentEvents = officialEvents;
    const firstAdvance = officialEvents.findIndex(
      (event) => event.action === 'advanceGF',
    );
    if (firstAdvance >= 0) {
      this.segmentEvents = officialEvents.slice(0, firstAdvance + 1);
    }
    const advanceCount = officialEvents.filter(
      (event) => event.action === 'advanceGF',
    ).length;
    this.multiAdvance =
      advanceCount > 1 ||
      (firstAdvance >= 0 && firstAdvance < officialEvents.length - 1);
    this.comparableOfficialEvents = comparableEvents(this.segmentEvents);
    this.targetOrderOffset = 0;
    this.targetOrderIndex = -1;
    this.usedGiftIndexes = new Set();
    this.lastGiftItem = null;
  }

  attach(battle) {
    this.battle = battle;
  }

  get localIndex() {
    return this.battle?.game.events.length ?? 0;
  }

  get localComparableIndex() {
    return comparableEvents(this.battle?.game.events ?? []).length;
  }

  eventAt(index) {
    return this.comparableOfficialEvents[index];
  }

  findNext(predicate, start = this.localComparableIndex) {
    for (let index = start; index < this.comparableOfficialEvents.length; index++) {
      if (predicate(this.comparableOfficialEvents[index])) {
        return this.comparableOfficialEvents[index];
      }
    }
    return null;
  }

  fail(label) {
    throw new EntropyBoundary(`${label}Oracle`);
  }

  prefixMatches() {
    const localEvents = comparableEvents(this.battle?.game.events ?? []);
    const officialEvents = this.comparableOfficialEvents;
    if (localEvents.length > officialEvents.length) {
      return false;
    }
    for (let index = 0; index < localEvents.length; index++) {
      if (
        JSON.stringify(canonicalize(localEvents[index], '/events')) !==
        JSON.stringify(canonicalize(officialEvents[index], '/events'))
      ) {
        return false;
      }
    }
    return true;
  }

  trace(label) {
    if (process.env.ORACLE_TRACE) {
      const localEvents = this.battle?.game.events ?? [];
      const localActions = localEvents.map((event) => event.action);
      const officialActions = this.segmentEvents.map((event) => event.action);
      console.error(
        'ORACLE',
        JSON.stringify({
          file: this.context.file,
          update: this.context.update,
          label,
          localIndex: this.localIndex,
          localActions,
          officialActions,
          label: label,
        }),
      );
    }
  }

  requirePrefix(label) {
    const localEvents = comparableEvents(this.battle?.game.events ?? []);
    const officialEvents = this.comparableOfficialEvents;
    if (localEvents.length > officialEvents.length) {
      throw new EntropyBoundary(
        `oraclePrefix:${officialEvents.length}:${localEvents.length}:${label}`,
      );
    }
    for (let index = 0; index < localEvents.length; index++) {
      if (
        JSON.stringify(canonicalize(localEvents[index], '/events')) !==
        JSON.stringify(canonicalize(officialEvents[index], '/events'))
      ) {
        const localAction = localEvents[index]?.action ?? 'none';
        const officialAction = officialEvents[index]?.action ?? 'none';
        throw new EntropyBoundary(
          `oraclePrefix:${index}:${localAction}->${officialAction}:${label}`,
        );
      }
    }
  }

  pickBy(values, identity, expected, label) {
    const value = values.find((candidate) => identity(candidate) === expected);
    if (value === undefined) {
      this.fail(label);
    }
    return value;
  }

  peekNextGiftEvent(playerId) {
    for (let index = 0; index < this.segmentEvents.length; index++) {
      const event = this.segmentEvents[index];
      if (
        event.action === 'gift' &&
        event.playerId === playerId &&
        !this.usedGiftIndexes.has(index)
      ) {
        return { event, index };
      }
    }
    return null;
  }

  takeNextGiftEvent(playerId) {
    const found = this.peekNextGiftEvent(playerId);
    if (!found) {
      return null;
    }
    this.usedGiftIndexes.add(found.index);
    this.lastGiftItem = {
      modelId: found.event.item?.modelId,
      fakeModelId: found.event.item?.fakeModelId,
    };
    return found.event;
  }

  inferSilentItemModel(playerId, values = null) {
    if (!this.before) {
      return undefined;
    }
    const beforePlayer = this.before.players?.find(
      (player) => player.id === playerId,
    );
    const nextPlayer = this.nextGame.players?.find(
      (player) => player.id === playerId,
    );
    if (!beforePlayer || !nextPlayer) {
      return undefined;
    }
    const localPlayer = this.battle?.game.players?.find(
      (player) => player.id === playerId,
    );
    if (localPlayer) {
      const occupiedIds = new Set(
        (localPlayer.items ?? [])
          .filter((item) => item.modelId > 0)
          .map((item) => item.id),
      );
      let expectedItemId = 1;
      while (occupiedIds.has(expectedItemId)) {
        expectedItemId++;
      }
      const predictedItem = (nextPlayer.items ?? []).find(
        (item) => item.id === expectedItemId && item.modelId > 0,
      );
      if (
        predictedItem &&
        (!values ||
          values.some((value) => value.id === predictedItem.modelId))
      ) {
        return {
          modelId: predictedItem.modelId,
          fakeModelId: predictedItem.fakeModelId,
        };
      }
    }
    const beforeItems = new Map(
      (beforePlayer.items ?? [])
        .filter((item) => item.modelId > 0)
        .map((item) => [item.id, item]),
    );
    const candidates = (nextPlayer.items ?? []).filter((item) => {
      if (item.modelId <= 0) {
        return false;
      }
      const previous = beforeItems.get(item.id);
      return !previous || previous.modelId !== item.modelId;
    });
    if (values) {
      const valueIds = new Set(values.map((value) => value.id));
      const matching = candidates.filter((item) =>
        valueIds.has(item.modelId),
      );
      if (matching.length === 1) {
        return {
          modelId: matching[0].modelId,
          fakeModelId: matching[0].fakeModelId,
        };
      }
    }
    if (candidates.length === 1) {
      return {
        modelId: candidates[0].modelId,
        fakeModelId: candidates[0].fakeModelId,
      };
    }
    return undefined;
  }

  chance(label, percent) {
    this.requirePrefix(label);
    this.trace(label);
    if (label === 'hit') {
      const event = this.eventAt(this.localComparableIndex);
      if (event?.action !== 'hit' && event?.action !== 'miss') {
        this.fail(label);
      }
      return event.action === 'hit';
    }
    if (label === 'guardianLeave') {
      const event = this.eventAt(this.localComparableIndex);
      if (!event) {
        this.fail(label);
      }
      return event.action === 'removeGuardian';
    }
    if (label === 'upgradeDisease') {
      const event = this.eventAt(this.localComparableIndex);
      if (!event) {
        this.fail(label);
      }
      return event.action === 'upgradeDisease'
        || event.action === 'upgradeHeaven';
    }
    if (label === 'tear') {
      const event = this.eventAt(this.localComparableIndex);
      if (event?.action !== 'boostHP' && event?.action !== 'dealDamage') {
        this.fail(label);
      }
      return event.action === 'boostHP';
    }
    const devilChanceMatch = /^devilChance:(\d+)$/.exec(label);
    if (devilChanceMatch) {
      const playerId = Number(devilChanceMatch[1]);
      const peeked = this.peekNextGiftEvent(playerId);
      if (peeked) {
        const nextEvent = this.segmentEvents[peeked.index + 1];
        return (
          nextEvent?.action === 'useDevilItem' &&
          nextEvent.playerId === playerId &&
          nextEvent.item?.id === peeked.event.item?.id
        );
      }
      return this.findNext(
        (event) =>
          event.action === 'useDevilItem' && event.playerId === playerId,
      ) !== null;
    }
    if (label === 'dreamReal') {
      if (!this.lastGiftItem) {
        this.fail(label);
      }
      if (this.lastGiftItem.fakeModelId === undefined) {
        this.fail(label);
      }
      return this.lastGiftItem.fakeModelId === this.lastGiftItem.modelId;
    }
    this.fail(label);
  }

  pick(label, values, weight) {
    this.requirePrefix(label);
    this.trace(label);
    if (label === 'giftRecipient') {
      const nextGift = this.segmentEvents.find((event, index) =>
        event.action === 'gift' && !this.usedGiftIndexes.has(index),
      );
      // Silent bot draws do not identify their place in this recipient order.
      if (!nextGift || values.some((player) => player.isBot)) {
        this.fail(label);
      }
      return this.pickBy(values, (player) => player.id, nextGift.playerId, label);
    }
    const modelMatch = /^(giftModel|devilModel):(\d+)$/.exec(label);
    if (modelMatch) {
      const playerId = Number(modelMatch[2]);
      const gift = this.takeNextGiftEvent(playerId);
      if (gift) {
        return this.pickBy(
          values,
          (candidate) => candidate.id,
          gift.item?.modelId,
          label,
        );
      }
      const silentGift = this.inferSilentItemModel(playerId, values);
      if (silentGift === undefined) {
        this.fail(label);
      }
      this.lastGiftItem = silentGift;
      return this.pickBy(
        values,
        (candidate) => candidate.id,
        silentGift.modelId,
        label,
      );
    }
    if (label === 'dreamItem') {
      if (!this.lastGiftItem) {
        this.fail(label);
      }
      return this.pickBy(
        values,
        (candidate) => candidate.id,
        this.lastGiftItem.fakeModelId,
        label,
      );
    }
    if (label === 'buyOffer') {
      const event = this.findNext((candidate) => candidate.action === 'buy');
      if (!event) {
        this.fail(label);
      }
      const exact = values.find(
        (candidate) =>
          candidate.modelId === event.item?.modelId &&
          (event.item?.id === undefined || candidate.id === event.item.id),
      );
      if (exact) {
        return exact;
      }
      return this.pickBy(
        values,
        (candidate) => candidate.modelId,
        event.item?.modelId,
        label,
      );
    }
    if (label === 'dangerHolder' || label === 'dangerItem') {
      const event = this.findNext(
        (candidate) => candidate.action === 'attractDanger',
      );
      if (!event) {
        this.fail(label);
      }
      const expectedId = label === 'dangerHolder'
        ? event.playerId
        : event.item?.id;
      return this.pickBy(values, (candidate) => candidate.id, expectedId, label);
    }
    if (label === 'guardian') {
      const event = this.findNext(
        (candidate) => candidate.action === 'setGuardian',
      );
      if (!event) {
        this.fail(label);
      }
      return this.pickBy(
        values,
        (candidate) => candidate,
        event.guardian,
        label,
      );
    }
    if (label === 'fogTarget' || label === 'dangerTarget') {
      const event = this.findNext(
        (candidate) => candidate.action === 'setTargetPlayer',
      );
      if (!event) {
        this.fail(label);
      }
      return this.pickBy(
        values,
        (candidate) => candidate.id,
        event.playerId,
        label,
      );
    }
    if (label === 'bounceTarget') {
      const event = this.findNext((candidate) => candidate.action === 'bounce');
      if (!event) {
        this.fail(label);
      }
      return this.pickBy(
        values,
        (candidate) => candidate.id,
        event.playerId,
        label,
      );
    }
    if (label === 'reviveItem') {
      const event = this.findNext((candidate) => candidate.action === 'revive');
      if (!event) {
        this.fail(label);
      }
      const exact = values.find(
        (candidate) =>
          candidate.modelId === event.item?.modelId &&
          (event.item?.id === undefined || candidate.id === event.item.id),
      );
      if (exact) {
        return exact;
      }
      return this.pickBy(
        values,
        (candidate) => candidate.modelId,
        event.item?.modelId,
        label,
      );
    }
    if (label === 'phenomenon') {
      const event = this.findNext(
        (candidate) => candidate.action === 'phenomenon',
      );
      if (!event) {
        this.fail(label);
      }
      return this.pickBy(
        values,
        (candidate) => candidate.id,
        event.itemModelId,
        label,
      );
    }
    if (label === 'devilStat') {
      const event = this.findNext(
        (candidate) =>
          candidate.action === 'boostHP' ||
          candidate.action === 'boostMP' ||
          candidate.action === 'boostCP',
      );
      if (!event) {
        this.fail(label);
      }
      const stat = event.action.slice('boost'.length).toLowerCase();
      return this.pickBy(
        values,
        (candidate) => candidate,
        stat,
        label,
      );
    }
    if (label === 'goldMountainRecipient') {
      const event = this.findNext(
        (candidate) => candidate.action === 'collectCPOfEverybody',
      );
      if (!event) {
        this.fail(label);
      }
      return this.pickBy(
        values,
        (candidate) => candidate.id,
        event.playerId,
        label,
      );
    }
    this.fail(label);
  }

  shuffle(label, values) {
    this.requirePrefix(label);
    this.trace(label);
    if (label === 'targetOrder' || label === 'dyingTargets') {
      if (this.targetOrderIndex !== this.localComparableIndex) {
        this.targetOrderIndex = this.localComparableIndex;
        this.targetOrderOffset = 0;
      }
      const targetIds = this.comparableOfficialEvents
        .slice(this.localComparableIndex)
        .filter((event) => event.action === 'setTargetPlayer')
        .map((event) => event.playerId);
      const chunk = targetIds.slice(
        this.targetOrderOffset,
        this.targetOrderOffset + values.length,
      );
      if (chunk.length !== values.length) {
        this.fail(label);
      }
      const byId = new Map(values.map((value) => [value.id, value]));
      const ordered = chunk.map((playerId) => byId.get(playerId));
      if (ordered.some((value) => value === undefined)) {
        this.fail(label);
      }
      this.targetOrderOffset += values.length;
      return ordered;
    }
    if (label === 'guardianOrder') {
      if (this.multiAdvance) {
        this.fail(label);
      }
      const orderedIds = this.nextGame.guardianPlayerIds ?? [];
      if (orderedIds.length !== values.length) {
        this.fail(label);
      }
      const byId = new Map(values.map((value) => [value.id, value]));
      const ordered = orderedIds.map((playerId) => byId.get(playerId));
      if (ordered.some((value) => value === undefined)) {
        this.fail(label);
      }
      return ordered;
    }
    if (label === 'removedItems' || label === 'removedUsedMiracles') {
      const action =
        label === 'removedItems' ? 'removeItems' : 'removeUsedMiracles';
      const event = this.findNext((candidate) => candidate.action === action);
      if (!event) {
        this.fail(label);
      }
      const selectedIds = (event.items ?? []).map((item) => item.id);
      const byId = new Map(values.map((value) => [value.id, value]));
      const selected = selectedIds.map((itemId) => byId.get(itemId));
      if (selected.some((value) => value === undefined)) {
        this.fail(label);
      }
      const selectedSet = new Set(selectedIds);
      return [
        ...selected,
        ...values.filter((value) => !selectedSet.has(value.id)),
      ];
    }
    if (label === 'devilItems') {
      const event = this.findNext(
        (candidate) => candidate.action === 'removeSomething',
      );
      if (!event) {
        this.fail(label);
      }
      const selectedIds = (event.items ?? []).map((item) => item.id);
      const byId = new Map(values.map((value) => [value.id, value]));
      const selected = selectedIds.map((itemId) => byId.get(itemId));
      if (selected.some((value) => value === undefined)) {
        this.fail(label);
      }
      const selectedSet = new Set(selectedIds);
      return [
        ...selected,
        ...values.filter((value) => !selectedSet.has(value.id)),
      ];
    }
    if (label === 'solarEclipseGuardians') {
      const event = this.findNext(
        (candidate) => candidate.action === 'setGuardianOfEverybody',
      );
      if (!event || !Array.isArray(event.guardians)) {
        this.fail(label);
      }
      const selected = event.guardians.map((guardian) => {
        const match = values.find((value) => value === guardian);
        if (match === undefined) {
          this.fail(label);
        }
        return match;
      });
      const selectedSet = new Set(event.guardians);
      return [
        ...selected,
        ...values.filter((value) => !selectedSet.has(value)),
      ];
    }
    this.fail(label);
  }

  value(label) {
    this.fail(label);
  }
}

const ignoredKeys = new Set([
  'updatedAt',
  'serverTurn',
  'eventIndex',
  'index',
  'isBot',
]);

function parseJsonLines(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore a partially written final line.
    }
  }
  return records;
}

async function readLogText(path) {
  const contents = await readFile(path);
  return path.endsWith('.gz')
    ? gunzipSync(contents).toString('utf8')
    : contents.toString('utf8');
}

async function findLogFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return findLogFiles(entryPath);
      }
      return /\.jsonl(?:\.gz)?$/.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

function ignoredPath(path) {
  return path.split('/').some((segment) => ignoredKeys.has(segment));
}

function canonicalize(value, path = '') {
  if (Array.isArray(value)) {
    const items = value
      .filter(
        (entry) => !(path.endsWith('/events') && entry?.action === 'gift'),
      )
      .map((entry, index) =>
        canonicalize(entry, `${path.replace(/\[\d+\]/g, '')}[${index}]`));
    if (path.endsWith('/players')) {
      return [...items].sort(
        (first, second) => (first?.id ?? 0) - (second?.id ?? 0),
      );
    }
    if (path.endsWith('/items') && path.includes('/players')) {
      return [...items].sort(
        (first, second) =>
          (first?.id ?? 0) - (second?.id ?? 0) ||
          (first?.modelId ?? 0) - (second?.modelId ?? 0),
      );
    }
    return items;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (ignoredPath(`${path}/${key}`)) {
      continue;
    }
    result[key] = canonicalize(entry, `${path}/${key}`);
  }
  return result;
}

function comparableEvents(events) {
  return events.filter((event) => event?.action !== 'gift');
}

function stableSortGiftRuns(events) {
  const result = [];
  for (let index = 0; index < events.length; ) {
    if (events[index]?.action !== 'gift') {
      result.push(events[index]);
      index++;
      continue;
    }
    let end = index;
    while (end < events.length && events[end]?.action === 'gift') {
      end++;
    }
    const run = events.slice(index, end);
    run.sort(
      (first, second) => (first.playerId ?? 0) - (second.playerId ?? 0),
    );
    result.push(...run);
    index = end;
  }
  return result;
}

function pathKey(path) {
  return path.replace(/\[\d+\]/g, '[]');
}

function createComparisonSummary() {
  return {
    transitions: 0,
    boundaryTransitions: 0,
    comparedTransitions: 0,
    segmentTransitions: 0,
    decisionTransitions: 0,
    rejectedCommandTransitions: 0,
    structuralTransitions: 0,
    eventlessTransitions: 0,
    structuralViolations: [],
    failures: [],
    differences: new Map(),
  };
}

function recordDifference(summary, path, expected, actual, context) {
  const key = `${pathKey(path)}|${expected === undefined ? 'missing' : actual === undefined ? 'extra' : 'value'}`;
  const existing = summary.differences.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  summary.differences.set(key, {
    path: pathKey(path),
    kind:
      actual === undefined
        ? 'missing-local'
        : expected === undefined
          ? 'extra-local'
          : 'value',
    count: 1,
    expected,
    actual,
    ...context,
  });
}

function compareValues(expected, actual, path, summary, context) {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      recordDifference(summary, path, expected, actual, context);
      return;
    }
    if (expected.length !== actual.length) {
      recordDifference(
        summary,
        `${path}/length`,
        expected.length,
        actual.length,
        context,
      );
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index++) {
      compareValues(
        expected[index],
        actual[index],
        `${path}[${index}]`,
        summary,
        context,
      );
    }
    return;
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object'
  ) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const expectedHas = Object.hasOwn(expected, key);
      const actualHas = Object.hasOwn(actual, key);
      const nextPath = `${path}/${key}`;
      if (!expectedHas) {
        recordDifference(summary, nextPath, undefined, actual[key], context);
      } else if (!actualHas) {
        recordDifference(summary, nextPath, expected[key], undefined, context);
      } else {
        compareValues(
          expected[key],
          actual[key],
          nextPath,
          summary,
          context,
        );
      }
    }
    return;
  }
  if (!Object.is(expected, actual)) {
    recordDifference(summary, path, expected, actual, context);
  }
}

function expectedPlayerId(game) {
  const pendingAttack = game.attacks?.[0];
  if (pendingAttack) {
    return pendingAttack.buyingItemModelId
      ? pendingAttack.playerId
      : pendingAttack.targetPlayerId;
  }
  return game.attackTurnPlayerId;
}

function removeStaleChannels(records) {
  let latestCreation = '';
  return records.filter((record) => {
    if (record.type !== 'channel') {
      return true;
    }
    const creation = record.document?.__createTime;
    if (typeof creation !== 'string') {
      return true;
    }
    if (creation < latestCreation) {
      return false;
    }
    latestCreation = creation;
    return true;
  });
}

function buildSnapshotMap(records, readGame) {
  const snapshots = new Map();
  for (const record of records) {
    const game = readGame(record);
    if (!game) {
      continue;
    }
    const existing = snapshots.get(game.updateCount);
    if (!existing || (!existing.events?.length && game.events?.length)) {
      snapshots.set(game.updateCount, game);
    }
  }
  return snapshots;
}

function recordStructuralViolation(summary, path, context) {
  summary.structuralViolations.push({
    path,
    ...context,
  });
}

function checkSnapshotStructure(previousGame, nextGame, context, summary) {
  if (!Array.isArray(nextGame.events)) {
    summary.eventlessTransitions++;
    return;
  }
  const events = nextGame.events;
  const advanceEvents = events.filter(
    (event) => event?.action === 'advanceGF',
  );
  const hasEndGame = events.some((event) => event?.action === 'endGame');
  summary.structuralTransitions++;

  if (
    !hasEndGame &&
    typeof previousGame.gf === 'number' &&
    typeof nextGame.gf === 'number'
  ) {
    const gfDelta = nextGame.gf - previousGame.gf;
    if (gfDelta !== advanceEvents.length) {
      recordStructuralViolation(summary, 'gf-delta', {
        ...context,
        expected: advanceEvents.length,
        actual: gfDelta,
      });
    }
  }

  if (advanceEvents.length === 0 || nextGame.isOver) {
    return;
  }
  const lastAdvance = advanceEvents.at(-1);
  if (
    !Number.isInteger(lastAdvance.playerId) ||
    lastAdvance.playerId <= 0
  ) {
    recordStructuralViolation(summary, 'advance-player', {
      ...context,
      actual: lastAdvance.playerId,
    });
    return;
  }
  if (nextGame.attackTurnPlayerId !== lastAdvance.playerId) {
    recordStructuralViolation(summary, 'advance-turn', {
      ...context,
      expected: lastAdvance.playerId,
      actual: nextGame.attackTurnPlayerId,
    });
  }
  if (
    nextGame.diseasePlayerId !== undefined &&
    nextGame.diseasePlayerId !== lastAdvance.playerId
  ) {
    recordStructuralViolation(summary, 'advance-disease', {
      ...context,
      expected: lastAdvance.playerId,
      actual: nextGame.diseasePlayerId,
    });
  }
  if (
    Array.isArray(nextGame.guardianPlayerIds) &&
    nextGame.guardianPlayerIds.includes(lastAdvance.playerId)
  ) {
    recordStructuralViolation(summary, 'advance-guardian-self', {
      ...context,
      playerId: lastAdvance.playerId,
    });
  }
}


function compareReplay({
  before,
  command,
  commandUserId,
  nextGame,
  context,
  summary,
}) {
  const randomSource = useOracle
    ? new OracleRandom(nextGame.events ?? [], nextGame, context, before)
    : new AuditRandom();
  const battle = new Battle(structuredClone(before), randomSource);
  if (randomSource instanceof OracleRandom) {
    randomSource.attach(battle);
  }
  let boundary = null;
  let failure = null;
  try {
    battle.submit(commandUserId, command);
  } catch (error) {
    if (error instanceof EntropyBoundary) {
      boundary = error.label;
    } else if (!(error instanceof HttpError)) {
      failure = String(error);
    }
  }
  if (!failure) {
    try {
      if (battle.botCommand()) {
        boundary = boundary ?? 'botDecision';
      }
    } catch (error) {
      // botCommand() is only used to detect the next decision boundary. A
      // missing legal bot command at a boundary is not a replay failure; the
      // event prefix is still compared below.
      boundary = boundary ?? (
        error instanceof EntropyBoundary ? error.label : 'botCommand'
      );
    }
  }
  if (failure) {
    summary.failures.push({
      ...context,
      command,
      failure,
    });
    return false;
  }
  const expectedEvents = canonicalize(
    comparableEvents(nextGame.events ?? []),
    '/events',
  );
  const actualEvents = canonicalize(
    comparableEvents(battle.game.events ?? []),
    '/events',
  );
  if (boundary) {
    summary.boundaryTransitions++;
    const length = Math.min(expectedEvents.length, actualEvents.length);
    compareValues(
      expectedEvents.slice(0, length),
      actualEvents.slice(0, length),
      '/events',
      summary,
      {
        ...context,
        boundary,
      },
    );
    return true;
  }
  const advanceCount = expectedEvents.filter(
    (event) => event.action === 'advanceGF',
  ).length;
  const officialAdvanceIndex = expectedEvents.findIndex(
    (event) => event.action === 'advanceGF',
  );
  const multiCommandUpdate =
    advanceCount > 1 ||
    (officialAdvanceIndex >= 0 &&
      officialAdvanceIndex < expectedEvents.length - 1);
  if (multiCommandUpdate) {
    const localAdvanceIndex = actualEvents.findIndex(
      (event) => event.action === 'advanceGF',
    );
    compareValues(
      expectedEvents.slice(0, officialAdvanceIndex + 1),
      actualEvents.slice(
        0,
        localAdvanceIndex >= 0 ? localAdvanceIndex + 1 : actualEvents.length,
      ),
      '/events',
      summary,
      {
        ...context,
        segment: 0,
      },
    );
    summary.segmentTransitions++;
    return true;
  }
  summary.comparedTransitions++;
  if (
    nextGame.players.some((player) => Object.hasOwn(player, 'ratingGain'))
  ) {
    applyDuelRatingGains(battle.game);
  }
  compareValues(
    canonicalize(nextGame),
    canonicalize(battle.game),
    '/game',
    summary,
    context,
  );
  return true;
}

/**
 * Indexes the submitter recorded for each rejected command. Rejected
 * submissions must be replayed as the account that actually sent them;
 * replaying as the expected player turns an out-of-turn rejection into a
 * false acceptance mismatch.
 */
function indexRejectedCommandUsers(rows) {
  const usersByCommand = new Map();
  for (const row of rows) {
    if (row.type !== 'rejected' || !row.command || !row.userId) {
      continue;
    }
    const key = JSON.stringify([row.updateCount, row.command]);
    const users = usersByCommand.get(key);
    if (users) {
      users.push(row.userId);
    } else {
      usersByCommand.set(key, [row.userId]);
    }
  }
  return usersByCommand;
}

function takeRejectedCommandUser(usersByCommand, updateCount, command) {
  const users = usersByCommand.get(JSON.stringify([updateCount, command]));
  if (!users || users.length === 0) {
    return null;
  }
  return users.shift();
}

function compareRejectedCommand({
  before,
  command,
  commandUserId,
  status,
  context,
  summary,
}) {
  const battle = new Battle(structuredClone(before), new AuditRandom());
  let localStatus = 200;
  summary.rejectedCommandTransitions++;

  try {
    battle.submit(commandUserId, command);
  } catch (error) {
    if (error instanceof HttpError) {
      localStatus = error.status;
    } else if (!(error instanceof EntropyBoundary)) {
      summary.failures.push({ ...context, command, failure: String(error) });
      return;
    }
    // Reaching battle randomness means command validation already succeeded.
  }

  compareValues(status, localStatus, '/command/status', summary, {
    ...context,
    command,
    rejected: true,
  });
}

function summarize(summary, fileStats, rootNames) {
  const differences = [...summary.differences.values()].sort(
    (first, second) => second.count - first.count,
  );
  return {
    roots: rootNames,
    oracle: useOracle,
    files: fileStats.processed,
    rawSnapshotFiles: fileStats.raw,
    stateSnapshotFiles: fileStats.state,
    skippedFiles: fileStats.skipped,
    transitions: summary.transitions,
    boundaryTransitions: summary.boundaryTransitions,
    comparedTransitions: summary.comparedTransitions,
    segmentTransitions: summary.segmentTransitions,
    decisionTransitions: summary.decisionTransitions,
    rejectedCommandTransitions: summary.rejectedCommandTransitions,
    structuralTransitions: summary.structuralTransitions,
    eventlessTransitions: summary.eventlessTransitions,
    structuralViolationCount: summary.structuralViolations.length,
    structuralViolations: summary.structuralViolations.slice(0, 200),
    differenceCount: differences.reduce(
      (total, difference) => total + difference.count,
      0,
    ),
    differences,
    failures: summary.failures.slice(0, 200),
  };
}

const useOracle = process.argv.includes('--oracle');

async function main() {
  const logArgument = process.argv.find((argument) =>
    argument.startsWith('--logs='));
  const logRoots = (
    logArgument
      ? logArgument.slice('--logs='.length).split(',')
      : ['logs', '../godfield-refactor/logs']
  ).filter((path) => existsSync(path));
  const reportPath = process.argv.find((argument) =>
    argument.startsWith('--report='))?.slice('--report='.length);

  const summary = createComparisonSummary();
  const files = (await Promise.all(logRoots.map(findLogFiles))).flat();
  const seenTransitions = new Set();
  const fileStats = {
    processed: 0,
    raw: 0,
    state: 0,
    skipped: 0,
  };

  for (const file of files) {
    let rows;
    try {
      rows = parseJsonLines(await readLogText(file));
    } catch {
      continue;
    }
    rows = removeStaleChannels(rows);
    const rawSnapshots = buildSnapshotMap(
      rows,
      (record) =>
        record.type === 'channel' ? record.document?.game : undefined,
    );
    const stateSnapshots = buildSnapshotMap(
      rows,
      (record) => (record.type === 'state' ? record.game : undefined),
    );
    const hasRawSnapshots = rawSnapshots.size > 0;
    const hasStateSnapshots = stateSnapshots.size > 0;
    if (!hasRawSnapshots && !hasStateSnapshots) {
      fileStats.skipped++;
      continue;
    }
    fileStats.processed++;
    if (hasRawSnapshots) {
      fileStats.raw++;
    } else {
      fileStats.state++;
    }

    const snapshotMap = hasRawSnapshots ? rawSnapshots : stateSnapshots;
    const updateCounts = [...snapshotMap.keys()].sort(
      (first, second) => first - second,
    );
    for (const updateCount of updateCounts) {
      const previousGame = snapshotMap.get(updateCount - 1);
      if (!previousGame) {
        continue;
      }
      checkSnapshotStructure(
        previousGame,
        snapshotMap.get(updateCount),
        {
          file: relative('.', file),
          update: updateCount,
        },
        summary,
      );
    }

    if (!hasRawSnapshots) {
      continue;
    }

    const snapshots = rawSnapshots;
    let currentGame = null;
    let pendingCommand = null;
    let lastDecision = null;
    const userId =
      rows.find((record) => record.type === 'identity')?.userId ??
      rows.find(
        (record) => record.action === 'auth.signUp' && record.response?.localId,
      )?.response.localId ??
      rows.find((record) => record.type === 'meta' && record.userId)?.userId;
    const rejectedCommandUsers = indexRejectedCommandUsers(rows);

    for (const row of rows) {
      if (row.type === 'decision') {
        lastDecision = row;
        continue;
      }
      if (row.type === 'request' && row.action === 'submit-command') {
        if (!currentGame || ![200, 400].includes(row.status)) {
          continue;
        }
        const before = structuredClone(currentGame);
        const command = row.request?.command;
        if (command === undefined) {
          continue;
        }
        const commandPlayerId = expectedPlayerId(before);
        const commandPlayer = before.players.find(
          (player) => player.id === commandPlayerId,
        );
        const commandUserId = userId ?? commandPlayer?.userId;
        if (commandPlayer && !commandPlayer.userId && commandUserId) {
          commandPlayer.userId = commandUserId;
        }
        let expectedUpdateCount = before.updateCount + 1;
        if (
          lastDecision &&
          JSON.stringify(lastDecision.command) === JSON.stringify(command)
        ) {
          if (before.updateCount !== lastDecision.updateCount) {
            lastDecision = null;
            pendingCommand = null;
            continue;
          }
          expectedUpdateCount = lastDecision.updateCount + 1;
          lastDecision = null;
        }
        if (row.status === 400) {
          pendingCommand = null;
          const rejectedUserId = takeRejectedCommandUser(
            rejectedCommandUsers,
            before.updateCount,
            command,
          ) ?? commandUserId;
          if (rejectedUserId) {
            compareRejectedCommand({
              before,
              command,
              commandUserId: rejectedUserId,
              status: row.status,
              context: {
                file: relative('.', file),
                update: before.updateCount,
              },
              summary,
            });
          }
          continue;
        }
        pendingCommand = {
          before,
          command,
          userId: commandUserId,
          playerId: commandPlayerId,
          expectedUpdateCount,
        };
        continue;
      }
      if (row.type !== 'channel' || !row.document?.game) {
        continue;
      }
      const nextGame = row.document.game;
      currentGame = nextGame;
      if (!pendingCommand) {
        continue;
      }
      if (nextGame.updateCount !== pendingCommand.expectedUpdateCount) {
        pendingCommand = null;
        continue;
      }
      if (!Array.isArray(nextGame.events) || nextGame.events.length === 0) {
        pendingCommand = null;
        continue;
      }
      const {
        before,
        command,
        userId: commandUserId,
        playerId: commandPlayerId,
      } = pendingCommand;
      pendingCommand = null;
      if (!commandUserId) {
        continue;
      }
      const transitionKey = JSON.stringify([
        row.gameId,
        before.updateCount,
        commandPlayerId,
        command,
      ]);
      if (seenTransitions.has(transitionKey)) {
        continue;
      }
      seenTransitions.add(transitionKey);
      summary.transitions++;
      compareReplay({
        before,
        command,
        commandUserId,
        nextGame,
        context: {
          file: relative('.', file),
          update: before.updateCount,
        },
        summary,
      });
    }

    const rejectedCommands = new Set();
    const rejectedCommandShapes = new Set();
    for (const row of rows) {
      if (row.type === 'rejected' && row.command) {
        rejectedCommands.add(
          JSON.stringify([
            row.updateCount,
            row.actor?.playerId,
            row.command,
          ]),
        );
        rejectedCommandShapes.add(JSON.stringify(row.command));
      }
      if (
        row.type === 'request' &&
        row.action === 'submit-command' &&
        row.status !== 200 &&
        row.request?.command
      ) {
        rejectedCommandShapes.add(JSON.stringify(row.request.command));
      }
    }

    for (const row of rows) {
      if (
        row.type !== 'decision' ||
        !row.command ||
        !row.actor?.userId
      ) {
        continue;
      }
      const rejectedKey = JSON.stringify([
        row.updateCount,
        row.actor.playerId,
        row.command,
      ]);
      if (
        rejectedCommands.has(rejectedKey) ||
        rejectedCommandShapes.has(JSON.stringify(row.command))
      ) {
        continue;
      }
      const before = snapshots.get(row.updateCount);
      const nextGame = snapshots.get(row.updateCount + 1);
      if (!before || !nextGame || !nextGame.events?.length) {
        continue;
      }
      if (expectedPlayerId(before) !== row.actor.playerId) {
        continue;
      }
      const decisionKey = JSON.stringify([
        row.gameId,
        row.updateCount,
        row.actor.playerId,
        row.command,
      ]);
      if (seenTransitions.has(decisionKey)) {
        continue;
      }
      seenTransitions.add(decisionKey);
      summary.decisionTransitions++;
      summary.transitions++;
      compareReplay({
        before,
        command: row.command,
        commandUserId: row.actor.userId,
        nextGame,
        context: {
          file: relative('.', file),
          update: row.updateCount,
          decision: true,
        },
        summary,
      });
    }
  }

  const report = summarize(summary, fileStats, logRoots);
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export {
  canonicalize,
  OracleRandom,
  removeStaleChannels,
  checkSnapshotStructure,
  createComparisonSummary,
  compareRejectedCommand,
  indexRejectedCommandUsers,
  takeRejectedCommandUser,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
