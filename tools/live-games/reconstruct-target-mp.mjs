#!/usr/bin/env node
/**
 * Enrich the existing decision-time targeting corpus with MP replayed from raw states.
 * Only updates whose final MP matches every recorded player are retained.
 * Usage: node --import tsx tools/live-games/reconstruct-target-mp.mjs \
 *   --corpus=../godfield-refactor --output=artifacts/creator-rules/targets.jsonl.gz
 */
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { engine, getItemDefinition } from '../../server/engine.ts';
import { readJsonl } from './log-files.mjs';

const corpusArgument = process.argv.find((argument) => argument.startsWith('--corpus='));
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='));
const corpusRoot = resolve(corpusArgument?.slice('--corpus='.length) ?? '../godfield-refactor');
const outputPath = resolve(outputArgument?.slice('--output='.length) ?? 'artifacts/creator-rules/targets.jsonl.gz');
const decisions = await readJsonl(resolve(corpusRoot, 'logs/live/campaigns/bot-targeting-audit/raw/target-decisions.jsonl.gz'));
const byFile = new Map();
for (const decision of decisions) {
  const rows = byFile.get(decision.file) ?? [];
  rows.push(decision);
  byFile.set(decision.file, rows);
}
const enriched = [];
const counts = { updates: 0, matchedUpdates: 0, decisions: 0, excludedUpdates: 0, unreadableFiles: 0 };
const selfGuardianAbilities = new Set([
  'boostHP', 'boostMP', 'boostCP', 'removeAllCurses', 'removeMildCurses',
  'addItem', 'setGuardian', 'boostCPOfEverybody', 'collectCPOfEverybody',
  'shuffleItemsOfEverybody', 'setGuardianOfEverybody', 'confuseEverybody',
  'setHPOfEverybody', 'setCurseOfEverybody', 'exchange',
]);

function replayMagicPoints(previous, current) {
  const magic = new Map(previous.players.map((player) => [player.id, player.mp ?? 0]));
  const snapshots = new Map();
  let actor = previous.attackTurnPlayerId;
  let attacker = previous.attacks?.[0]?.playerId ?? actor;
  let target = previous.attacks?.[0]?.targetPlayerId;
  let guardianAbility;
  let guardianTargeted = false;
  let pendingGiftOwner;
  let devilOwner;

  const spend = (playerId, slots) => {
    if (!magic.has(playerId)) {
      return;
    }
    const definitions = slots.map((slot) => getItemDefinition(slot.modelId));
    const cost = engine.calculateMpCost(definitions);
    magic.set(playerId, Math.max(0, magic.get(playerId) - cost));
    if (definitions[0]?.ability === 'atkBy2xMP') {
      magic.set(playerId, 0);
    }
  };
  for (const [eventIndex, event] of (current.events ?? []).entries()) {
    switch (event.action) {
      case 'advanceGF':
        actor = event.playerId;
        attacker = actor;
        target = undefined;
        guardianAbility = undefined;
        devilOwner = undefined;
        break;
      case 'useAttackItems':
        snapshots.set(eventIndex, Object.fromEntries(magic));
        attacker = actor;
        target = undefined;
        guardianAbility = undefined;
        devilOwner = undefined;
        spend(actor, event.items ?? []);
        break;
      case 'useDefenseItems':
        spend(target, event.items ?? []);
        break;
      case 'attackByGuardian':
      case 'nextAttack':
        attacker = event.attack.playerId;
        target = event.attack.targetPlayerId || undefined;
        guardianAbility = event.attack.guardian
          ? getItemDefinition(event.attack.itemModelIds[0]).ability : undefined;
        guardianTargeted = false;
        break;
      case 'setTargetPlayer':
        target = event.playerId;
        guardianTargeted = true;
        break;
      case 'bounce':
        target = event.playerId;
        break;
      case 'reflect': {
        const oldAttacker = attacker;
        attacker = target;
        target = oldAttacker;
        break;
      }
      case 'gift':
        pendingGiftOwner = event.playerId;
        devilOwner = undefined;
        break;
      case 'useDevilItem':
        devilOwner = event.playerId || pendingGiftOwner;
        break;
      case 'boostMP': {
        const guardianActsOnSelf = guardianAbility && !guardianTargeted
          && selfGuardianAbilities.has(guardianAbility);
        const recipient = event.playerId || devilOwner
          || (guardianActsOnSelf ? attacker : target || actor);
        if (magic.has(recipient)) {
          const nextMagic = Math.max(0, Math.min(99, magic.get(recipient) + (event.mp ?? 0)));
          magic.set(recipient, nextMagic);
        }
        break;
      }
      case 'exchange': {
        const recipient = event.playerId || (guardianAbility === 'exchange' ? attacker : target || actor);
        if (magic.has(recipient)) {
          magic.set(recipient, event.mp ?? 0);
        }
        break;
      }
      default:
        break;
    }
  }
  const matches = current.players.every((player) => magic.get(player.id) === (player.mp ?? 0));
  return { snapshots, matches };
}

let fileCount = 0;
for (const [file, fileDecisions] of byFile) {
  let records;
  try {
    records = await readJsonl(resolve(corpusRoot, 'logs', file));
  } catch {
    counts.unreadableFiles++;
    continue;
  }
  const states = records.filter((record) => record.type === 'state' && record.game)
    .sort((first, second) => first.updateCount - second.updateCount);
  const wantedUpdates = new Map();
  for (const decision of fileDecisions) {
    const rows = wantedUpdates.get(decision.updateCount) ?? [];
    rows.push(decision);
    wantedUpdates.set(decision.updateCount, rows);
  }
  for (let stateIndex = 1; stateIndex < states.length; stateIndex++) {
    const current = states[stateIndex];
    const rows = wantedUpdates.get(current.updateCount);
    if (!rows) {
      continue;
    }
    counts.updates++;
    const replay = replayMagicPoints(states[stateIndex - 1].game, current.game);
    if (!replay.matches) {
      counts.excludedUpdates++;
      continue;
    }
    counts.matchedUpdates++;
    for (const decision of rows) {
      const magic = replay.snapshots.get(decision.event_index);
      if (magic) {
        enriched.push({ ...decision, mp_fwd: magic, mp_endpoint_matched: true });
        counts.decisions++;
      }
    }
  }
  fileCount++;
  if (fileCount % 200 === 0) {
    process.stderr.write(`Reconstructed ${fileCount}/${byFile.size} source logs\n`);
  }
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, gzipSync(enriched.map((record) => JSON.stringify(record)).join('\n') + '\n'));
await writeFile(`${outputPath}.summary.json`, `${JSON.stringify(counts, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, ...counts }, null, 2)}\n`);
