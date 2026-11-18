#!/usr/bin/env node
/**
 * Audit the creator's guardian/overflow clarification against recorded official games.
 * Reads the earlier campaign manifests, then reopens their source logs. No network calls.
 * Usage: node --import tsx tools/live-games/analyze-creator-rules.mjs \
 *   --corpus=../godfield-refactor --report=artifacts/creator-rules/distributions.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Battle } from '../../server/battle/battle.ts';
import { Random } from '../../server/random.ts';
import { itemCatalog } from '../../server/engine.ts';
import { getEarthItemPool, getMoonItemPool } from '../../server/battle/guardians.ts';
import { readJsonl } from './log-files.mjs';

const corpusArgument = process.argv.find((argument) => argument.startsWith('--corpus='));
const reportArgument = process.argv.find((argument) => argument.startsWith('--report='));
const corpusRoot = resolve(corpusArgument?.slice('--corpus='.length) ?? '../godfield-refactor');
const reportPath = resolve(reportArgument?.slice('--report='.length) ?? 'artifacts/creator-rules/distributions.json');
const campaignsRoot = resolve(corpusRoot, 'logs/live/campaigns');
const guardianManifest = await readJsonl(resolve(campaignsRoot, 'guardian-probabilities/raw/earth-moon-actions.jsonl.gz'));
const overflowManifest = JSON.parse(await readFile(resolve(campaignsRoot, 'guardian-buy-overflow/scan-results.json'), 'utf8'));
const sourceFiles = new Set(guardianManifest.map((record) => record.file));
for (const record of overflowManifest.overflowEvents) {
  sourceFiles.add(record.path);
}
const guardianCounts = { earth: {}, moon: {} };
const guardianSeen = new Set();
const overflowSeen = new Set();
const overflowRows = [];
const readErrors = [];
const guardianShapeErrors = [];
const guardianReplay = { compared: 0, failures: [] };
const replayGame = { players: [], gf: 1, attackTurnPlayerId: 1, events: [], updateCount: 1 };
const replayBattle = new Battle(replayGame);

class RecordedGuardianRandom extends Random {
  constructor(attack, specialCardIds) {
    super(0);
    this.attack = attack;
    this.specialCardIds = specialCardIds;
  }

  pick(label, candidates) {
    let selectedId;
    if (label === 'guardianItem') {
      const firstId = this.attack.itemModelIds[0];
      selectedId = this.specialCardIds.includes(firstId) ? this.attack.itemModelIds[1] : firstId;
    } else if (label === 'guardianSaleItem') {
      selectedId = this.attack.itemModelIds[1];
    } else {
      throw new Error(`Unrecorded guardian draw: ${label}`);
    }
    const selected = candidates.find((candidate) => candidate.id === selectedId);
    if (!selected) {
      throw new Error(`Recorded card ${selectedId} is outside the ${label} pool`);
    }
    return selected;
  }

  value(label) {
    throw new Error(`Unrecorded guardian random value: ${label}`);
  }
}
const dropId = itemCatalog.find((definition) => definition.guardian?.key === 'earth' && definition.ability === 'addItem').id;
const bladeId = itemCatalog.find((definition) => definition.guardian?.key === 'moon' && definition.ability === 'categoryWeapons').id;
let processedFiles = 0;

function slotKey(slot) {
  return `${slot.slotIndex ?? slot.id}:${slot.modelId}:${slot.used === true}`;
}

function sameHand(first, second) {
  return JSON.stringify(first.map(slotKey).sort()) === JSON.stringify(second.map(slotKey).sort());
}

for (const sourceFile of [...sourceFiles].sort()) {
  let records;
  try {
    const sourcePath = resolve(corpusRoot, sourceFile);
    try {
      records = await readJsonl(sourcePath);
    } catch (error) {
      if (error.code !== 'ENOENT' || !sourcePath.endsWith('.jsonl')) {
        throw error;
      }
      records = await readJsonl(`${sourcePath}.gz`);
    }
  } catch (error) {
    readErrors.push({ file: sourceFile, error: error.message });
    continue;
  }
  const states = new Map(records.filter((record) => record.type === 'state')
    .map((record) => [record.updateCount, record.game]));
  const eventGroups = new Map();
  for (const record of records) {
    if (record.type !== 'event') {
      continue;
    }
    const group = eventGroups.get(record.updateCount) ?? [];
    group.push(record);
    eventGroups.set(record.updateCount, group);
  }
  for (const [updateCount, events] of eventGroups) {
    let guardianOwner;
    let attackOwner;
    let attackTarget;
    for (const event of events) {
      if (event.action === 'attackByGuardian') {
        const attack = event.attack;
        guardianOwner = attack.playerId;
        attackOwner = attack.playerId;
        const guardian = attack.guardian;
        if (guardian === 'earth' || guardian === 'moon') {
          const key = `${event.gameId}:${updateCount}:${event.index}:${guardian}`;
          if (!guardianSeen.has(key)) {
            guardianSeen.add(key);
            const modelIds = attack.itemModelIds;
            let drawnId = modelIds[0];
            if (drawnId === dropId || drawnId === bladeId) {
              drawnId = modelIds[1];
            }
            const definition = itemCatalog.findById(drawnId);
            const expectsCombination = guardian === 'earth'
              ? !definition?.isItemTargetingCommand()
              : ['doubleAtk', 'attackEveryEnemy'].includes(definition?.ability);
            const hasCombination = modelIds[0] === (guardian === 'earth' ? dropId : bladeId);
            if (!definition || expectsCombination !== hasCombination) {
              guardianShapeErrors.push({ file: sourceFile, updateCount, modelIds });
            }
            guardianCounts[guardian][drawnId] = (guardianCounts[guardian][drawnId] ?? 0) + 1;
            try {
              replayBattle.random = new RecordedGuardianRandom(attack, [dropId, bladeId]);
              const replayed = replayBattle.selectGuardianAction({ guardian });
              const replayedIds = replayed.map((item) => item.id);
              if (JSON.stringify(replayedIds) !== JSON.stringify(modelIds)) {
                throw new Error(`Expected ${modelIds}, received ${replayedIds}`);
              }
              guardianReplay.compared++;
            } catch (error) {
              guardianReplay.failures.push({ file: sourceFile, updateCount, error: error.message });
            }
          }
        }
      }
      if (event.action === 'useAttackItems') {
        guardianOwner = undefined;
      }
      if (event.action === 'setTargetPlayer') {
        attackTarget = event.playerId;
      }
      if (event.action === 'advanceGF') {
        attackOwner = event.playerId;
        guardianOwner = undefined;
      }
      if (!event.overflowItem) {
        continue;
      }
      const key = `${event.gameId}:${updateCount}:${event.index}:${event.action}`;
      if (overflowSeen.has(key)) {
        continue;
      }
      overflowSeen.add(key);
      let ownerId = event.playerId || attackTarget || attackOwner;
      if (event.action === 'addItem') {
        ownerId = guardianOwner;
      }
      const previousHand = states.get(updateCount - 1)?.players
        .find((player) => player.id === ownerId)?.items?.filter((slot) => slot.modelId > 0);
      const nextHand = states.get(updateCount)?.players
        .find((player) => player.id === ownerId)?.items?.filter((slot) => slot.modelId > 0);
      // Only infer odds when the snapshots differ by exactly this replacement.
      // Other changes within the update make the instantaneous hand ambiguous.
      let candidatesConfirmed = false;
      if (previousHand?.length === 18 && nextHand && event.item) {
        const replacedKey = slotKey(event.overflowItem);
        const retained = previousHand.filter((slot) => slotKey(slot) !== replacedKey);
        candidatesConfirmed = retained.length === 17 && sameHand([...retained, event.item], nextHand);
      }
      overflowRows.push({
        gameId: event.gameId,
        file: sourceFile,
        updateCount,
        action: event.action,
        ownerId,
        performedSelected: event.overflowItem.used === true,
        candidatesConfirmed,
        performedProbability: candidatesConfirmed
          ? previousHand.filter((slot) => slot.used === true).length / previousHand.length
          : null,
      });
    }
  }
  processedFiles++;
  if (processedFiles % 200 === 0) {
    process.stderr.write(`Audited ${processedFiles}/${sourceFiles.size} source logs\n`);
  }
}

const game = { players: [], gf: 1, attackTurnPlayerId: 1, events: [], updateCount: 1 };
const battle = new Battle(game, new Random(20261118));
const earthPool = getEarthItemPool(battle);
const moonPool = getMoonItemPool(battle);
const sampleCount = 20000;
const localCounts = { earth: {}, moon: {} };
for (const guardian of ['earth', 'moon']) {
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const definitions = battle.selectGuardianAction({ guardian });
    const chosen = definitions[0].id === dropId || definitions[0].id === bladeId
      ? definitions[1] : definitions[0];
    localCounts[guardian][chosen.id] = (localCounts[guardian][chosen.id] ?? 0) + 1;
  }
}
const overflowLocalCounts = Array(18).fill(0);
for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
  const player = {
    id: 1, hp: 40, mp: 10, cp: 20,
    items: Array.from({ length: 18 }, (unusedValue, slotIndex) => ({
      id: slotIndex + 1, modelId: slotIndex < 6 ? 211 : 113, used: slotIndex < 6,
    })),
  };
  const acquisition = battle.addSlot(player, 146);
  overflowLocalCounts[acquisition.overflowItem.id - 1]++;
}
const summarizeGuardian = (guardian, pool) => ({
  poolSize: pool.length,
  specialIds: pool.filter((definition) => guardian === 'earth'
    ? !definition.isItemTargetingCommand()
    : ['doubleAtk', 'attackEveryEnemy'].includes(definition.ability)).map((definition) => definition.id),
  expectedSpecialProbability: pool.filter((definition) => guardian === 'earth'
    ? !definition.isItemTargetingCommand()
    : ['doubleAtk', 'attackEveryEnemy'].includes(definition.ability)).length / pool.length,
  officialCounts: guardianCounts[guardian],
  localCounts: localCounts[guardian],
  poolIds: pool.map((definition) => definition.id),
});
const report = {
  corpusRoot, sourceFiles: sourceFiles.size, processedFiles, readErrors, guardianShapeErrors, guardianReplay,
  earth: summarizeGuardian('earth', earthPool),
  moon: summarizeGuardian('moon', moonPool),
  overflow: {
    rows: overflowRows,
    localCountsBySlot: overflowLocalCounts,
    localPerformedSlots: 6,
  },
  limitations: [
    'Source files come from the recorded guardian and overflow campaign manifests; this is not a fresh live campaign.',
    'Only exact before/after single-card replacements identify the instantaneous overflow candidate pool.',
    'Guardian sale-partner selection is not specified by the tweet and remains the existing gift-rate-weighted model.',
  ],
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ reportPath, processedFiles, readErrors: readErrors.length, guardianShapeErrors: guardianShapeErrors.length, guardianReplay, overflows: overflowRows.length }, null, 2)}\n`);

if (readErrors.length > 0 || guardianShapeErrors.length > 0 || guardianReplay.failures.length > 0) {
  process.exitCode = 1;
}
