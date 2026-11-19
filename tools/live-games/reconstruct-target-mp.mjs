#!/usr/bin/env node
/**
 * Enrich the targeting corpus with stats replayed from raw states.
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
const buyArgument = process.argv.find((argument) => argument.startsWith('--buy-decisions='));
const buyPath = buyArgument && resolve(buyArgument.slice('--buy-decisions='.length));
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
const buyDecisions = [];
const counts = {
  updates: 0, matchedUpdates: 0, fullyMatchedUpdates: 0,
  decisions: 0, fullyMatchedDecisions: 0, changedStatDecisions: 0,
  statusMatchedUpdates: 0, statusMatchedDecisions: 0, confusionMatchedUpdates: 0,
  excludedUpdates: 0, unreadableFiles: 0,
};
const selfGuardianAbilities = new Set([
  'boostHP', 'boostMP', 'boostCP', 'removeAllCurses', 'removeMildCurses',
  'addItem', 'setGuardian', 'boostCPOfEverybody', 'collectCPOfEverybody',
  'shuffleItemsOfEverybody', 'setGuardianOfEverybody', 'confuseEverybody',
  'setHPOfEverybody', 'setCurseOfEverybody', 'exchange',
]);
const diseases = new Set(['cold', 'fever', 'hell', 'heaven']);

function replayStats(previous, current) {
  const stats = new Map(previous.players.map(({ id, hp, mp, cp, dead, curses, guardian, confusionCount }) => [
    id, { hp: hp ?? 0, mp: mp ?? 0, cp: cp ?? 0, dead: !!dead,
      curses: curses ?? [], guardian: guardian || null,
      confusion: Math.max(0, confusionCount ?? 0) },
  ]));
  const snapshots = new Map();
  const buys = [];
  let actor = previous.attackTurnPlayerId;
  const pendingAttack = previous.attack ?? previous.attacks?.[0];
  let attacker = pendingAttack?.playerId || actor;
  let target = pendingAttack?.targetPlayerId || undefined;
  let guardianAbility = pendingAttack?.guardian && pendingAttack.itemModelIds?.length
    ? getItemDefinition(pendingAttack.itemModelIds[0]).ability : undefined;
  let guardianTargeted = false;
  let pendingGiftOwner;
  let devilOwner;

  const change = (id, field, amount) => {
    const player = stats.get(id);
    if (!player) return;
    const next = field === 'hp' ? engine.changeHp(player.hp, amount)
      : field === 'mp' ? engine.changeMp(player.hp, player.mp, amount)
      : engine.changeCp(player.hp, player.mp, player.cp, amount);
    Object.assign(player, next);
  };
  const boostRecipient = (event) => event.playerId || devilOwner ||
    (guardianAbility && !guardianTargeted && selfGuardianAbilities.has(guardianAbility)
      ? attacker : target || actor);
  const addCurse = (player, curse) => {
    if (!player || !curse || player.curses.includes(curse)) return;
    const retained = diseases.has(curse)
      ? player.curses.filter((existing) => !diseases.has(existing)) : player.curses;
    player.curses = [...retained, curse];
  };
  const spend = (playerId, slots) => {
    const player = stats.get(playerId);
    if (!player) return;
    const definitions = slots.map((slot) => getItemDefinition(slot.modelId));
    const cost = engine.calculateMpCost(definitions);
    player.mp = Math.max(0, player.mp - cost);
    if (definitions[0]?.ability === 'atkBy2xMP') {
      player.mp = 0;
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
        snapshots.set(eventIndex, Object.fromEntries(
          [...stats].map(([id, player]) => [id, { ...player }]),
        ));
        attacker = actor;
        target = undefined;
        guardianAbility = undefined;
        devilOwner = undefined;
        spend(actor, event.items ?? []);
        if (stats.get(actor)?.confusion > 0) stats.get(actor).confusion--;
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
      case 'hit':
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
      case 'dealDamage':
        change(event.playerId || target || actor, 'hp', -(event.damage ?? 0));
        break;
      case 'dealDarkDamage': {
        const player = stats.get(event.playerId || target || actor);
        if (player) player.hp = 0;
        break;
      }
      case 'boostHP':
        change(boostRecipient(event), 'hp', event.hp ?? 0);
        break;
      case 'boostMP':
        change(boostRecipient(event), 'mp', event.mp ?? 0);
        break;
      case 'boostCP':
        change(boostRecipient(event), 'cp', event.cp ?? 0);
        break;
      case 'addCurse':
      case 'selfCurse':
      case 'upgradeDisease':
        addCurse(stats.get(boostRecipient(event)), event.curse);
        break;
      case 'removeCurse':
      case 'removeCurses': {
        const player = stats.get(boostRecipient(event));
        const removed = event.curses?.length ? event.curses : [event.curse];
        if (player) player.curses = player.curses.filter((curse) => !removed.includes(curse));
        break;
      }
      case 'setCurseOfEverybody':
        for (const player of stats.values()) {
          if (!player.dead) addCurse(player, event.curse);
        }
        break;
      case 'confuseEverybody':
        for (const player of stats.values()) {
          if (!player.dead) player.confusion += engine.CONFUSION_TURNS;
        }
        break;
      case 'setGuardian':
      case 'removeGuardian': {
        const player = stats.get(boostRecipient(event));
        if (player) player.guardian = event.action === 'setGuardian' ? event.guardian : null;
        break;
      }
      case 'setGuardianOfEverybody': {
        const living = [...stats.values()].filter((player) => !player.dead);
        for (const [index, player] of living.entries()) {
          player.guardian = event.guardians?.[index] || null;
        }
        break;
      }
      case 'boostCPOfEverybody':
        for (const [id, player] of stats) {
          if (!player.dead) change(id, 'cp', event.cp ?? 0);
        }
        break;
      case 'setHPOfEverybody':
        for (const player of stats.values()) {
          if (!player.dead) player.hp = event.hp ?? 0;
        }
        break;
      case 'collectCPOfEverybody': {
        let collected = 0;
        for (const player of stats.values()) {
          if (player.dead) continue;
          collected += player.cp;
          player.cp = 0;
        }
        change(event.playerId || attacker || actor, 'cp', collected);
        break;
      }
      case 'takeCP': {
        const amount = event.cp ?? 0;
        change(target, 'cp', -amount);
        change(attacker || actor, 'cp', amount);
        break;
      }
      case 'sell':
      case 'setBought': {
        const modelId = event.item?.modelId;
        if (!modelId) break;
        const price = getItemDefinition(modelId).price;
        const buyer = event.action === 'sell' ? target : attacker;
        const seller = event.action === 'sell' ? attacker : target;
        if (event.action === 'setBought') {
          const balance = stats.get(buyer)?.cp;
          if (Number.isFinite(balance)) buys.push({ eventIndex, buyer, modelId, balance });
          if (!event.bought) break;
        }
        change(buyer, 'cp', -price);
        change(seller, 'cp', price);
        break;
      }
      case 'die': {
        const player = stats.get(event.playerId);
        if (player) Object.assign(player, { dead: true, confusion: 0 });
        break;
      }
      case 'exchange': {
        const recipient = event.playerId || (guardianAbility === 'exchange' ? attacker : target || actor);
        const player = stats.get(recipient);
        if (player) Object.assign(player, { hp: event.hp ?? 0, mp: event.mp ?? 0, cp: event.cp ?? 0 });
        break;
      }
      default:
        break;
    }
  }
  const matches = current.players.every((player) => stats.get(player.id)?.mp === (player.mp ?? 0));
  const fullMatch = matches && current.players.every(({ id, hp, cp, dead }) => {
    const player = stats.get(id);
    return player?.hp === (hp ?? 0) && player.cp === (cp ?? 0) && player.dead === !!dead;
  });
  const statusMatch = fullMatch && current.players.every(({ id, curses = [], guardian }) => {
    const player = stats.get(id);
    return player.guardian === (guardian || null) && player.curses.length === curses.length &&
      curses.every((curse) => player.curses.includes(curse));
  });
  const confusionMatch = fullMatch && current.players.every(({ id, confusionCount }) =>
    stats.get(id).confusion === Math.max(0, confusionCount ?? 0));
  return { snapshots, matches, fullMatch, statusMatch, confusionMatch, buys };
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
    if (!rows && !(buyPath && current.game.events?.some(({ action }) => action === 'setBought'))) {
      continue;
    }
    const replay = replayStats(states[stateIndex - 1].game, current.game);
    if (buyPath && replay.fullMatch) {
      for (const decision of replay.buys) {
        buyDecisions.push({ file, updateCount: current.updateCount, ...decision });
      }
    }
    if (!rows) continue;
    counts.updates++;
    if (!replay.matches) {
      counts.excludedUpdates++;
      continue;
    }
    counts.matchedUpdates++;
    if (replay.fullMatch) counts.fullyMatchedUpdates++;
    if (replay.statusMatch) counts.statusMatchedUpdates++;
    if (replay.confusionMatch) counts.confusionMatchedUpdates++;
    for (const decision of rows) {
      const snapshot = replay.snapshots.get(decision.event_index);
      if (snapshot) {
        const followingEvent = current.game.events?.[decision.event_index + 1];
        const mapStat = (stat) => Object.fromEntries(
          Object.entries(snapshot).map(([id, player]) => [id, player[stat]]),
        );
        let replayedStats;
        if (replay.fullMatch) {
          const hp = mapStat('hp');
          const cp = mapStat('cp');
          const dead = mapStat('dead');
          counts.fullyMatchedDecisions++;
          if (Object.keys(snapshot).some((id) => hp[id] !== decision.hp_fwd?.[id] ||
              cp[id] !== decision.cp_fwd?.[id] || dead[id] !== decision.dead_fwd?.[id])) {
            counts.changedStatDecisions++;
          }
          replayedStats = { hp, cp, dead };
        }
        enriched.push({
          ...decision,
          mp_fwd: mapStat('mp'),
          mp_endpoint_matched: true,
          replayed_stats: replayedStats,
          replayed_status: replay.statusMatch
            ? { curses: mapStat('curses'), guardian: mapStat('guardian') } : undefined,
          replayed_confusion: replay.confusionMatch ? mapStat('confusion') : undefined,
          immediate_target_event: followingEvent?.action === 'setTargetPlayer' &&
            followingEvent.playerId === decision.target,
        });
        if (replay.statusMatch) counts.statusMatchedDecisions++;
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
if (buyPath) {
  await mkdir(dirname(buyPath), { recursive: true });
  await writeFile(buyPath, gzipSync(buyDecisions.map((record) => JSON.stringify(record)).join('\n') + '\n'));
}
await writeFile(outputPath, gzipSync(enriched.map((record) => JSON.stringify(record)).join('\n') + '\n'));
await writeFile(`${outputPath}.summary.json`, `${JSON.stringify(counts, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, ...counts }, null, 2)}\n`);
