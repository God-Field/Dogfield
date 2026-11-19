#!/usr/bin/env node
/**
 * Distributional validation of the local rule-based bot policy against the
 * reconstructed official-bot decision corpus.
 *
 * Exact per-decision parity is not expected: the official bot is stochastic.
 * This reports category and state-conditional agreement instead.
 *
 * Usage:
 *   node --import tsx server/verify-bot-policy.mjs
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  BOT_TARGET_EXACT_TIE_PERCENT,
  botAttackWeight,
  botPlayerStrength,
  botShouldAcceptBuy,
  botDefenseForgivePercent,
  botDefenseChoiceWeight,
  botPrayerWeight,
  botSellTargetWeight,
  botTargetProbabilities,
  sameTargetStats,
  botTearSelfPercent,
} from './battle/bot-policy.ts';
import { engine, getItemDefinition } from './engine.ts';
import { Battle } from './battle/battle.ts';
import { areEnemies } from './battle/targets.ts';

const refactorRoot = process.env.REFACTOR_ROOT ?? '../godfield-refactor';
const episodeArgument = process.argv.find((argument) => argument.startsWith('--episodes='));
const episodePath = episodeArgument
  ? resolve(episodeArgument.slice('--episodes='.length))
  : resolve(
      refactorRoot,
      'logs/live/campaigns/bot-policy/raw/episodes.jsonl.gz',
    );
const targetArgument = process.argv.find((argument) => argument.startsWith('--targets='));
const buyArgument = process.argv.find((argument) => argument.startsWith('--buy-decisions='));
const targetPath = targetArgument
  ? resolve(targetArgument.slice('--targets='.length))
  : resolve(refactorRoot, 'logs/live/campaigns/bot-targeting-audit/raw/target-decisions.jsonl.gz');
const split = process.argv.find((argument) => argument.startsWith('--split='))
  ?.slice('--split='.length) ?? 'all';
if (!['all', 'training', 'validation'].includes(split)) {
  throw new Error(`Unknown evidence split: ${split}`);
}

function belongsToSplit(episode) {
  const gameKey = episode.gameId ?? episode.file;
  const hash = createHash('sha256').update(gameKey).digest().readUInt32BE(0);
  const isValidation = hash % 5 === 0;
  return split === 'all' || (split === 'validation' ? isValidation : !isValidation);
}

const reportPath = process.argv
  .find((argument) => argument.startsWith('--report='))
  ?.slice('--report='.length);

if (!existsSync(episodePath) || !existsSync(targetPath)) {
  throw new Error(`Missing official campaign data under ${refactorRoot}`);
}

async function* readGzipLines(path) {
  const stream = createReadStream(path).pipe(createGunzip());
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.length > 0) {
      yield JSON.parse(line);
    }
  }
}

function buyDecisionKey(file, updateCount, eventIndex, buyer, modelId) {
  return JSON.stringify([file, updateCount, eventIndex, buyer, modelId]);
}

const buyBalances = new Map();
if (buyArgument) {
  for await (const decision of readGzipLines(resolve(buyArgument.slice('--buy-decisions='.length)))) {
    const { file, updateCount, eventIndex, buyer, modelId, balance } = decision;
    buyBalances.set(buyDecisionKey(file, updateCount, eventIndex, buyer, modelId), balance);
  }
}
const buyBalanceAudit = { replayed: 0, replayedUnaffordable: 0, inferredFromAcceptance: 0, legacy: 0 };

function projectDefenseEpisode(episode) {
  const recordedAttack = episode.attack;
  if (!recordedAttack?.itemModelIds?.length) {
    return { reason: 'missing-attack' };
  }
  if (episode.hp <= 0 || episode.dead || recordedAttack.playerId === episode.actor) {
    return { reason: 'automatic-or-dead-target' };
  }
  if ((episode.curses ?? []).includes('dream')) {
    return { reason: 'unobserved-disguise' };
  }
  const definitions = recordedAttack.itemModelIds.map(getItemDefinition);
  const damage = engine.calculateAttackDamage(definitions, 0);
  if (damage !== episode.incomingDamage) {
    return { reason: 'unknown-attack-override' };
  }
  const player = {
    ...actorPlayer(episode),
    items: (episode.hand ?? []).map((item) => ({
      id: item.slotIndex, modelId: item.modelId, used: item.used,
    })),
  };
  const attacker = { id: recordedAttack.playerId, hp: 40, mp: 10, cp: 20, items: [] };
  const battle = new Battle({
    players: [player, attacker],
    attacks: [{ ...recordedAttack, targetPlayerId: player.id }],
    gf: 1, attackTurnPlayerId: attacker.id, events: [], updateCount: 1,
  });
  const candidates = battle.botDefenseCandidates(player);
  const observedIds = (episode.legalDefense ?? [])
    .filter((candidate) => candidate.source !== 'forgive')
    .map((candidate) => candidate.seedSlotIndex)
    .sort((first, second) => first - second);
  const localIds = candidates.map((candidate) => candidate.command.itemIds[0])
    .sort((first, second) => first - second);
  if (JSON.stringify(observedIds) !== JSON.stringify(localIds)) {
    return { reason: 'inconsistent-legal-options' };
  }
  return {
    candidates, damage, category: definitions[0].category.key,
    element: engine.getAttackElement(definitions)?.key ?? 'none',
  };
}

function addCount(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function definitionItem(definition) {
  return {
    attack: definition.attack,
    isPlusAttack: definition.isPlusAttack,
    defense: definition.defense,
    hitRate: definition.hitRate,
    price: definition.price,
    cost: definition.cost,
    ability: definition.ability,
    abilityValue: definition.abilityValue,
    category: definition.category,
  };
}

function actorPlayer(episode) {
  return {
    id: episode.actor,
    hp: episode.hp,
    mp: episode.mp,
    cp: episode.cp,
    curses: episode.curses ?? [],
  };
}

function categoryForAbility(ability, itemCategory) {
  if (ability === '' && itemCategory === 'weapons') return 'plain';
  if (ability === 'absorbHP') return 'absorb';
  if (ability === 'addCurseOnDamage') return 'curse';
  if (ability === 'attackTwice') return 'attackTwice';
  if (ability === 'boostHPOrDealDamage') return 'tear';
  if (ability === 'buy') return 'buy';
  if (ability === 'sell') return 'sell';
  return 'other';
}

function totalVariation(first, second) {
  const keys = new Set([...first.keys(), ...second.keys()]);
  let total = 0;
  for (const key of keys) {
    total += Math.abs((first.get(key) ?? 0) - (second.get(key) ?? 0));
  }
  return total / 2;
}

function normalizedDistribution(counts, total) {
  return [...counts.entries()]
    .sort(([first], [second]) => first - second)
    .map(([key, value]) => [key, value / total]);
}

const targetLookupKeys = new Set();
for await (const decision of readGzipLines(targetPath)) {
  if (decision.target != null && (decision.replayed_stats ||
      (decision.rank_agree && decision.enemies_fwd >= 2))) {
    targetLookupKeys.add(`${decision.file}|${decision.updateCount}|${decision.event_index}`);
  }
}
const episodes = new Map();
for await (const episode of readGzipLines(episodePath)) {
  const key = `${episode.file}|${episode.updateCount}|${episode.eventIndex}`;
  if (episode.kind !== 'attack' || !episode.isBot ||
      !belongsToSplit(episode) || !targetLookupKeys.has(key)) {
    continue;
  }
  episodes.set(key, {
    handCertain: episode.handCertain,
    confused: episode.confused,
    curses: episode.curses,
    chosen: episode.chosen,
  });
}
targetLookupKeys.clear();

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

const targetLikelihood = { rows: 0, groupContextRows: 0, negativeLogLikelihood: 0, previousNegativeLogLikelihood: 0 };
const targetBoundary = { eligible: 0, ties: 0, matched: 0, mismatched: 0, examples: [] };
const targetProvenance = { immediate: 0, indirect: 0, unavailable: 0 };
const sharedCutoffDisplacement = { zero: 0, upTo10: 0, upTo30: 0, over30: 0 };
const fullStatReplayBoundary = { forced: 0, ties: 0, matched: 0, mismatched: 0, changedSnapshots: 0 };
const targetStatusReplay = {
  confirmed: 0, fogDisagreements: 0, confusionConfirmed: 0, confusionDisagreements: 0,
};
const guardianBoundary = {
  withGuardianScore: { ties: 0, matched: 0, mismatched: 0 },
  withoutGuardianScore: { ties: 0, matched: 0, mismatched: 0 },
  byAttackItemCount: {},
  byDefeatedCount: {},
  tieReasons: { allScoresEqual: 0, actorAtMean: 0, targetScoreEqual: 0 },
  actorAtMeanTargets: { weaker: 0, equal: 0, stronger: 0 },
  exactTieCandidates: { rows: 0, chosen: 0, expected: 0 },
  byPairStatus: {
    neither: { ties: 0, matched: 0, mismatched: 0 },
    elsewhere: { ties: 0, matched: 0, mismatched: 0 },
    actorOnly: { ties: 0, matched: 0, mismatched: 0 },
    targetOnly: { ties: 0, matched: 0, mismatched: 0 },
    both: { ties: 0, matched: 0, mismatched: 0 },
  },
};
const actorRelativeBoundary = {
  ties: 0, matched: 0, mismatched: 0, byActorMargin: {}, byTargetMargin: {},
  farthestMismatches: [],
};
const directionConflicts = { count: 0, examples: [] };
const statusPartitionConflicts = { repeatedSnapshots: 0, conflicts: 0, examples: [] };
const runtimeTargetSupport = {
  freeForAll: { eligible: 0, supported: 0, unsupported: 0, tieDrawOnly: 0, fallbackOnly: 0 },
  teams: { eligible: 0, supported: 0, unsupported: 0, tieDrawOnly: 0, fallbackOnly: 0 },
  freeForAllByLivingCount: {},
  freeForAllByAbility: {},
  examples: [],
};
const statusSnapshots = new Map();
let statusSnapshotFile;
let currentTargetUpdate;
const directionsBySnapshot = new Map();

function strictlyDominates(first, second) {
  return first.hp >= second.hp && first.mp >= second.mp && first.cp >= second.cp &&
    (first.hp > second.hp || first.mp > second.mp || first.cp > second.cp);
}

function canPartitionAttacks(edges) {
  const neighbors = new Map();
  for (const { actor, target } of edges) {
    if (!neighbors.has(actor)) neighbors.set(actor, []);
    if (!neighbors.has(target)) neighbors.set(target, []);
    neighbors.get(actor).push(target);
    neighbors.get(target).push(actor);
  }
  const groups = new Map();
  for (const start of neighbors.keys()) {
    if (groups.has(start)) continue;
    groups.set(start, false);
    const pending = [start];
    while (pending.length) {
      const player = pending.pop();
      const group = groups.get(player);
      for (const neighbor of neighbors.get(player)) {
        if (groups.get(neighbor) === group) return false;
        if (!groups.has(neighbor)) {
          groups.set(neighbor, !group);
          pending.push(neighbor);
        }
      }
    }
  }
  return true;
}

function finishStatusSnapshots() {
  for (const [snapshot, attacks] of statusSnapshots) {
    if (attacks.size < 2) continue;
    statusPartitionConflicts.repeatedSnapshots++;
    if (canPartitionAttacks(attacks.values())) continue;
    statusPartitionConflicts.conflicts++;
    if (statusPartitionConflicts.examples.length < 5) {
      statusPartitionConflicts.examples.push({
        file: statusSnapshotFile, living: JSON.parse(snapshot), attacks: [...attacks.values()],
      });
    }
  }
  statusSnapshots.clear();
}

function auditRuntimeTargetSupport({ decision, ability, living, actor, target }) {
  if (!areEnemies(actor, target)) return;
  const candidates = living.filter((player) => areEnemies(actor, player))
    .sort((first, second) => first.hp - second.hp || first.id - second.id);
  const targetIndex = candidates.findIndex(({ id }) => id === target.id);
  if (targetIndex < 0) return;
  const counts = actor.team ? runtimeTargetSupport.teams : runtimeTargetSupport.freeForAll;
  const hps = candidates.map(({ hp }) => hp);
  const attackMpCost = engine.calculateMpCost((decision.items ?? []).map(getItemDefinition));
  const branches = [false, true].map((allowTies) => {
    const probabilities = botTargetProbabilities(hps, ability, {
      actor, players: living, targets: candidates, attackMpCost,
      drawExactTieBoundary: () => allowTies,
    });
    return { target: probabilities[targetIndex], fallback: probabilities.every((probability) => probability === 0) };
  });
  const [closed, open] = branches;
  const canChoose = ({ target, fallback }) => target > 0 || fallback;
  const supported = branches.some(canChoose);
  counts.eligible++;
  counts[supported ? 'supported' : 'unsupported']++;
  if (!actor.team) {
    const bySize = runtimeTargetSupport.freeForAllByLivingCount[living.length] ??=
      { supported: 0, unsupported: 0 };
    bySize[supported ? 'supported' : 'unsupported']++;
    const byAbility = runtimeTargetSupport.freeForAllByAbility[ability || '(plain)'] ??=
      { supported: 0, unsupported: 0 };
    byAbility[supported ? 'supported' : 'unsupported']++;
  }
  if (supported && !canChoose(closed) && canChoose(open)) counts.tieDrawOnly++;
  if (supported && !branches.some(({ target }) => target > 0)) counts.fallbackOnly++;
  if (!supported && runtimeTargetSupport.examples.length < 8) {
    runtimeTargetSupport.examples.push({
      file: decision.file, update: decision.updateCount, event: decision.event_index,
      actor: actor.id, target: target.id, ability, living,
    });
  }
}
const targetByRank = new Map();
const targetByN = new Map();
const targetByCategory = new Map();

for await (const decision of readGzipLines(targetPath)) {
  if (decision.file !== statusSnapshotFile) {
    finishStatusSnapshots();
    statusSnapshotFile = decision.file;
  }
  const hasLegacyRank = decision.rank_agree && decision.enemies_fwd >= 2;
  if (decision.target == null || (!hasLegacyRank && !decision.replayed_stats)) {
    continue;
  }
  const episode = episodes.get(
    `${decision.file}|${decision.updateCount}|${decision.event_index}`,
  );
  if (
    !episode ||
    episode.handCertain !== true ||
    episode.confused ||
    (episode.curses ?? []).includes('fog')
  ) {
    continue;
  }
  const ability = episode.chosen?.firstAbility ?? '';
  const firstItem = episode.chosen?.items?.[0];
  const category = categoryForAbility(ability, firstItem?.category);
  if (category === 'tear') {
    continue;
  }
  const definition = firstItem && getItemDefinition(firstItem.modelId);
  const wasDirectCombat = definition?.isDirectTargetCommand() &&
    !['buy', 'sell', 'attackSomebody', 'danger'].includes(ability) &&
    !episode.chosen?.items?.some((item) => item.ability === 'attackEveryEnemy');
  const hasMatchingChoice = episode.chosen?.targetPlayerId === decision.target;
  const recordedFog = decision.curses?.includes('fog') ?? false;
  const replayedCurses = decision.replayed_status?.curses[decision.actor];
  const replayedFog = replayedCurses?.includes('fog');
  const replayedConfusion = decision.replayed_confusion?.[decision.actor];
  if (wasDirectCombat && hasMatchingChoice && replayedCurses) {
    targetStatusReplay.confirmed++;
    if (recordedFog !== replayedFog) targetStatusReplay.fogDisagreements++;
  }
  if (wasDirectCombat && hasMatchingChoice && replayedConfusion !== undefined) {
    targetStatusReplay.confusionConfirmed++;
    if ((replayedConfusion > 0) !== (decision.confusion > 0)) {
      targetStatusReplay.confusionDisagreements++;
    }
  }
  const eligibleTarget = wasDirectCombat && hasMatchingChoice &&
    decision.immediate_target_event !== false &&
    !((replayedConfusion ?? decision.confusion) > 0) && !(replayedFog ?? recordedFog);
  const replay = decision.replayed_stats;
  if (eligibleTarget && replay) {
    const living = Object.entries(replay.hp)
      .filter(([id, hp]) => !replay.dead[id] && hp > 0)
      .map(([id, hp]) => ({ id: Number(id), hp, cp: replay.cp[id], mp: decision.mp_fwd[id] }));
    const replayActor = living.find((player) => player.id === decision.actor);
    const replayTarget = living.find((player) => player.id === decision.target);
    if (replayActor && replayTarget && decision.replayed_status && decision.replayed_confusion &&
        decision.immediate_target_event && living.every(({ mp }) => Number.isFinite(mp))) {
      const roster = living.map((player) => ({
        ...player, team: decision.team_fwd?.[player.id],
        guardian: decision.replayed_status.guardian[player.id],
        curses: decision.replayed_status.curses[player.id] ?? [],
      }));
      auditRuntimeTargetSupport({
        decision, ability, living: roster,
        actor: roster.find(({ id }) => id === replayActor.id),
        target: roster.find(({ id }) => id === replayTarget.id),
      });
    }
    if (replayActor && replayTarget && replayActor !== replayTarget &&
        living.every(({ id, mp }) => !decision.team_fwd?.[id] && Number.isFinite(mp))) {
      const withStatus = (player) => ({
        ...player,
        guardian: decision.replayed_status?.guardian[player.id],
        curses: decision.replayed_status?.curses[player.id] ?? [],
      });
      const sum = living.reduce((total, player) => total + botPlayerStrength(withStatus(player)), 0);
      const score = botPlayerStrength(withStatus(replayActor));
      const gap = score - botPlayerStrength(withStatus(replayTarget));
      const side = score * living.length - sum;
      const outcome = living.length === 2 ? 'forced' : gap === 0 || side === 0
        ? 'ties' : gap * side > 0 ? 'matched' : 'mismatched';
      fullStatReplayBoundary[outcome]++;
      if (living.length > 2 && firstItem.category === 'weapons' && ability === '' &&
          decision.immediate_target_event && decision.replayed_status && decision.replayed_confusion) {
        const { guardian, curses } = decision.replayed_status;
        const roster = living.map((player) => ({
          ...player, guardian: guardian[player.id], curses: [...curses[player.id]].sort(),
          confusion: decision.replayed_confusion[player.id],
        }));
        const actorState = roster.find(({ id }) => id === replayActor.id);
        const targetState = roster.find(({ id }) => id === replayTarget.id);
        if (!sameTargetStats(actorState, targetState)) {
          const snapshot = JSON.stringify(roster);
          if (!statusSnapshots.has(snapshot)) statusSnapshots.set(snapshot, new Map());
          const pair = [replayActor.id, replayTarget.id].sort((first, second) => first - second).join(':');
          statusSnapshots.get(snapshot).set(pair, {
            actor: replayActor.id, target: replayTarget.id,
            update: decision.updateCount, event: decision.event_index,
          });
        }
      }
      if (decision.replayed_status && living.length > 2) {
        const { guardian } = decision.replayed_status;
        const guardianScore = (player) => botPlayerStrength({
          ...player, guardian: guardian[player.id],
          curses: decision.replayed_status.curses[player.id] ?? [],
        });
        const actorWithGuardian = guardianScore(replayActor);
        const guardianGap = actorWithGuardian - guardianScore(replayTarget);
        const guardianScores = living.map(guardianScore);
        const guardianSide = actorWithGuardian * living.length -
          guardianScores.reduce((total, strength) => total + strength, 0);
        const guardianOutcome = guardianGap === 0 || guardianSide === 0
          ? 'ties' : guardianGap * guardianSide > 0 ? 'matched' : 'mismatched';
        guardianBoundary.withGuardianScore[guardianOutcome]++;
        guardianBoundary.withoutGuardianScore[outcome]++;
        if (guardianSide !== 0 && guardianScores.filter((score) => score === actorWithGuardian).length > 1) {
          const withGuardian = living.map((player) => ({ ...player, guardian: guardian[player.id] }));
          const tiedActor = withGuardian.find(({ id }) => id === replayActor.id);
          const candidates = withGuardian.filter(({ id }) => id !== tiedActor.id)
            .sort((first, second) => first.hp - second.hp || first.id - second.id);
          const isTied = candidates.map((player) => sameTargetStats(tiedActor, player));
          if (isTied.some(Boolean)) {
            const counts = guardianBoundary.exactTieCandidates;
            counts.rows++;
            if (isTied[candidates.findIndex(({ id }) => id === replayTarget.id)]) counts.chosen++;
            const openBoundary = botTargetProbabilities(candidates.map(({ hp }) => hp), ability, {
              actor: tiedActor, players: withGuardian, targets: candidates,
              drawExactTieBoundary: () => true,
            });
            const tieMass = openBoundary.reduce((total, probability, index) =>
              total + (isTied[index] ? probability : 0), 0);
            counts.expected += BOT_TARGET_EXACT_TIE_PERCENT * tieMass / 100;
          }
        }
        if (guardianOutcome === 'ties') {
          const tieReason = guardianScores.every((strength) => strength === actorWithGuardian)
            ? 'allScoresEqual' : guardianSide === 0 ? 'actorAtMean' : 'targetScoreEqual';
          guardianBoundary.tieReasons[tieReason]++;
          if (tieReason === 'actorAtMean') {
            const relativeTarget = guardianGap > 0 ? 'weaker'
              : guardianGap < 0 ? 'stronger' : 'equal';
            guardianBoundary.actorAtMeanTargets[relativeTarget]++;
          }
        }
        const itemCount = episode.chosen.items.length;
        const attackSize = guardianBoundary.byAttackItemCount[itemCount] ??=
          { ties: 0, matched: 0, mismatched: 0 };
        attackSize[guardianOutcome]++;
        const defeatedCount = Object.keys(replay.hp).length - living.length;
        const rosterSize = guardianBoundary.byDefeatedCount[defeatedCount] ??=
          { ties: 0, matched: 0, mismatched: 0 };
        rosterSize[guardianOutcome]++;
        const actorHasGuardian = Boolean(guardian[replayActor.id]);
        const targetHasGuardian = Boolean(guardian[replayTarget.id]);
        const pairStatus = actorHasGuardian ? (targetHasGuardian ? 'both' : 'actorOnly')
          : targetHasGuardian ? 'targetOnly'
          : living.some(({ id }) => guardian[id]) ? 'elsewhere' : 'neither';
        guardianBoundary.byPairStatus[pairStatus][guardianOutcome]++;
      }
      if (Object.keys(replay.hp).some((id) => replay.hp[id] !== decision.hp_fwd?.[id] ||
          replay.cp[id] !== decision.cp_fwd?.[id] || replay.dead[id] !== decision.dead_fwd?.[id])) {
        fullStatReplayBoundary.changedSnapshots++;
      }
    }
  }
  if (!hasLegacyRank) continue;
  const enemies = [...(decision.enemy_hp_fwd ?? [])].sort(
    (first, second) => first[1] - second[1] || first[0] - second[0],
  );
  if (enemies.length < 2) {
    continue;
  }
  const targetRank = enemies.findIndex(
    ([id]) => id === decision.target,
  );
  if (targetRank < 0) {
    continue;
  }
  // MP must be reconstructed from source events; post-update episode stats
  // include costs and effects that happened after the targeting decision.
  const players = decision.mp_fwd
    ? Object.entries(decision.hp_fwd).map(([playerId, hp]) => ({
      id: Number(playerId), hp,
      mp: decision.mp_fwd[playerId] ?? 0,
      cp: decision.cp_fwd[playerId] ?? 0,
      dead: decision.dead_fwd[playerId] ?? false,
    }))
    : [];
  const actor = players.find((player) => player.id === decision.actor);
  const targets = enemies.map(([playerId]) => players.find((player) => player.id === playerId));
  const context = actor && targets.every(Boolean) ? { actor, players, targets } : undefined;
  const probabilities = botTargetProbabilities(
    enemies.map(([, hp]) => hp),
    ability,
    context,
  );
  const previousProbabilities = botTargetProbabilities(enemies.map(([, hp]) => hp), ability);
  const target = targets[targetRank];
  if (wasDirectCombat && hasMatchingChoice) {
    const origin = decision.immediate_target_event === true ? 'immediate'
      : decision.immediate_target_event === false ? 'indirect' : 'unavailable';
    targetProvenance[origin]++;
  }
  const targetUpdate = JSON.stringify([decision.file, decision.updateCount]);
  if (targetUpdate !== currentTargetUpdate) {
    currentTargetUpdate = targetUpdate;
    directionsBySnapshot.clear();
  }
  if (context && target && eligibleTarget && firstItem.category === 'weapons' &&
      ability === '' && decision.mp_endpoint_matched === true &&
      players.every(({ id }) => !decision.team_fwd?.[id] && Number.isFinite(decision.mp_fwd[id]))) {
    const direction = strictlyDominates(actor, target) ? 'down'
      : strictlyDominates(target, actor) ? 'up' : undefined;
    if (direction) {
      const snapshot = JSON.stringify(players);
      if (!directionsBySnapshot.has(snapshot)) {
        directionsBySnapshot.set(snapshot, { up: [], down: [] });
      }
      const recorded = directionsBySnapshot.get(snapshot);
      const choice = { actor, target, event: decision.event_index };
      const otherDirection = direction === 'up' ? 'down' : 'up';
      for (const other of recorded[otherDirection]) {
        const [up, down] = direction === 'up' ? [choice, other] : [other, choice];
        if (!strictlyDominates(up.actor, down.actor)) continue;
        directionConflicts.count++;
        if (directionConflicts.examples.length < 5) {
          directionConflicts.examples.push({
            file: decision.file, update: decision.updateCount, up, down, players,
          });
        }
      }
      recorded[direction].push(choice);
    }
  }
  if (context && target && eligibleTarget &&
      decision.mp_endpoint_matched === true &&
      players.every((player) => Number.isFinite(decision.mp_fwd[player.id])) &&
      players.every((player) => !decision.team_fwd?.[player.id]) &&
      (decision.first_in_update || players.every(({ id, hp, cp }) =>
        hp === decision.hp_bwd?.[id] && cp === decision.cp_bwd?.[id]))) {
    targetBoundary.eligible++;
    const living = players.filter((player) => !player.dead && player.hp > 0);
    const scoreSum = living.reduce((sum, player) => sum + botPlayerStrength(player), 0);
    const actorScore = botPlayerStrength(actor);
    const targetScore = botPlayerStrength(target);
    const actorSide = actorScore * living.length - scoreSum;
    const targetSide = targetScore * living.length - scoreSum;
    if (actorScore !== targetScore) {
      const displacement = Math.max(0, Math.min(actorSide, targetSide),
        -Math.max(actorSide, targetSide)) / living.length;
      const bucket = displacement === 0 ? 'zero' : displacement <= 10 ? 'upTo10'
        : displacement <= 30 ? 'upTo30' : 'over30';
      sharedCutoffDisplacement[bucket]++;
    }
    if (actorScore === targetScore || actorSide === 0) {
      actorRelativeBoundary.ties++;
    } else {
      const matched = (actorSide > 0) === (actorScore > targetScore);
      const outcome = matched ? 'matched' : 'mismatched';
      const actorMargin = Math.abs(actorSide) / living.length;
      const band = actorMargin < 5 ? '0–5' : actorMargin < 15 ? '5–15' :
        actorMargin < 30 ? '15–30' : actorMargin < 60 ? '30–60' : '60+';
      const group = actorRelativeBoundary.byActorMargin[band] ??= { matched: 0, mismatched: 0 };
      const targetMargin = Math.abs(actorScore - targetScore);
      const targetBand = targetMargin <= 6 ? '1–6' : targetMargin <= 12 ? '7–12' :
        targetMargin <= 18 ? '13–18' : targetMargin <= 30 ? '19–30' :
        targetMargin <= 60 ? '31–60' : '61+';
      const targetGroup = actorRelativeBoundary.byTargetMargin[targetBand] ??=
        { matched: 0, mismatched: 0 };
      actorRelativeBoundary[outcome]++;
      group[outcome]++;
      targetGroup[outcome]++;
      const examples = actorRelativeBoundary.farthestMismatches;
      if (!matched && (examples.length < 5 || actorMargin > examples.at(-1).actorMargin)) {
        examples.push({
          file: decision.file, update: decision.updateCount, event: decision.event_index,
          actor: actor.id, target: target.id, actorMargin, targetMargin, living,
        });
        examples.sort((first, second) => second.actorMargin - first.actorMargin);
        if (examples.length > 5) examples.pop();
      }
    }
    if (actorScore === targetScore || actorSide === 0 || targetSide === 0) {
      targetBoundary.ties++;
    } else if ((actorSide > 0) !== (targetSide > 0)) {
      targetBoundary.matched++;
    } else {
      targetBoundary.mismatched++;
      if (targetBoundary.examples.length < 5) {
        targetBoundary.examples.push({
          file: decision.file, update: decision.updateCount, event: decision.event_index,
          actor: actor.id, target: target.id, living,
        });
      }
    }
  }
  targetLikelihood.rows++;
  targetLikelihood.groupContextRows += context ? 1 : 0;
  targetLikelihood.negativeLogLikelihood -= Math.log(Math.max(probabilities[targetRank], Number.EPSILON));
  targetLikelihood.previousNegativeLogLikelihood -= Math.log(Math.max(previousProbabilities[targetRank], Number.EPSILON));
  const rankCounts = targetByRank;
  addCount(rankCounts, `obs|${targetRank}`);
  probabilities.forEach((probability, rank) => {
    addCount(rankCounts, `pred|${rank}`, probability);
  });

  const byN = targetByN;
  addCount(byN, `rows|${enemies.length}`);
  addCount(byN, `obs|${enemies.length}|${targetRank}`);
  probabilities.forEach((probability, rank) => {
    addCount(
      byN,
      `pred|${enemies.length}|${rank}`,
      probability,
    );
  });

  const byCategory = targetByCategory;
  addCount(byCategory, `rows|${category}|${enemies.length}`);
  addCount(
    byCategory,
    `obs|${category}|${enemies.length}|${targetRank}`,
  );
  probabilities.forEach((probability, rank) => {
    addCount(
      byCategory,
      `pred|${category}|${enemies.length}|${rank}`,
      probability,
    );
  });
}

finishStatusSnapshots();

function targetSummary() {
  const observed = new Map();
  const predicted = new Map();
  for (const [key, value] of targetByRank) {
    const [kind, rank] = key.split('|');
    if (kind === 'obs') addCount(observed, Number(rank), value);
    else addCount(predicted, Number(rank), value);
  }
  const observedTotal = [...observed.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const predictedTotal = [...predicted.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const observedShares = new Map(
    normalizedDistribution(observed, observedTotal),
  );
  const predictedShares = new Map(
    normalizedDistribution(predicted, predictedTotal),
  );

  const byEnemyCount = [];
  const enemyCounts = new Set(
    [...targetByN.keys()]
      .filter((key) => key.startsWith('rows|'))
      .map((key) => Number(key.split('|')[1])),
  );
  for (const enemies of [...enemyCounts].sort(
    (first, second) => first - second,
  )) {
    const obs = new Map();
    const pred = new Map();
    for (let rank = 0; rank < enemies; rank++) {
      addCount(obs, rank, targetByN.get(`obs|${enemies}|${rank}`) ?? 0);
      addCount(pred, rank, targetByN.get(`pred|${enemies}|${rank}`) ?? 0);
    }
    const obsTotal = [...obs.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const predTotal = [...pred.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const obsShares = new Map(normalizedDistribution(obs, obsTotal));
    const predShares = new Map(normalizedDistribution(pred, predTotal));
    byEnemyCount.push({
      enemies,
      rows: targetByN.get(`rows|${enemies}`),
      observed: [...obsShares.entries()],
      predicted: [...predShares.entries()],
      tv: totalVariation(obsShares, predShares),
    });
  }

  const categories = new Set(
    [...targetByCategory.keys()].map((key) => key.split('|')[1]),
  );
  const byCategory = [];
  for (const category of [...categories].sort()) {
    const obs = new Map();
    const pred = new Map();
    let rows = 0;
    const categoryCounts = new Set(
      [...targetByCategory.keys()]
        .filter((key) => key.startsWith(`rows|${category}|`))
        .map((key) => Number(key.split('|')[2])),
    );
    for (const enemies of categoryCounts) {
      rows += targetByCategory.get(`rows|${category}|${enemies}`) ?? 0;
      for (let rank = 0; rank < enemies; rank++) {
        addCount(
          obs,
          rank,
          targetByCategory.get(
            `obs|${category}|${enemies}|${rank}`,
          ) ?? 0,
        );
        addCount(
          pred,
          rank,
          targetByCategory.get(
            `pred|${category}|${enemies}|${rank}`,
          ) ?? 0,
        );
      }
    }
    const obsTotal = [...obs.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const predTotal = [...pred.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    const obsShares = new Map(normalizedDistribution(obs, obsTotal));
    const predShares = new Map(normalizedDistribution(pred, predTotal));
    byCategory.push({
      category,
      rows,
      observed: [...obsShares.entries()],
      predicted: [...predShares.entries()],
      tv: totalVariation(obsShares, predShares),
    });
  }

  return {
    rows: observedTotal,
    observed: [...observedShares.entries()],
    predicted: [...predictedShares.entries()],
    tv: totalVariation(observedShares, predictedShares),
    byEnemyCount,
    byCategory,
  };
}

// ---------------------------------------------------------------------------
// Attack, prayer, defense, Buy, Sell
// ---------------------------------------------------------------------------

const attackByCategory = new Map();
const attackByAbility = new Map();
const attackProbabilities = [];
const attackExcluded = new Map();
let attackRows = 0;
let attackTop1 = 0;
const attackLengthCounts = new Map();
const healCounts = new Map();
const prayerRates = new Map();
const prayerByLegalCount = new Map();
const prayerByWeapon = new Map();
const selfTargetCounts = new Map();
const tearSelfCounts = new Map();
const defenseCounts = new Map();
const defenseExcluded = new Map();
const defenseChoice = { rows: 0, negativeLogLikelihood: 0, chosenProbability: 0 };
const defensePrediction = { negativeLogLikelihood: 0, brierScore: 0 };
const defenseDataPath = process.argv.find((argument) => argument.startsWith('--defense-data='))
  ?.slice('--defense-data='.length);
const defenseData = [];
const defenseByDamage = new Map();
const defenseByLegalCount = new Map();
const defenseByCategory = new Map();
const defenseByDepth = new Map();
const defenseByCoverage = new Map();
const buyCounts = new Map();
const buyByCategory = new Map();
const buyByAffordability = new Map();
const buyByAbility = new Map();
let unaffordableBuyOffersExcluded = 0;
const sellCounts = new Map();
const sellPartner = new Map();
const confusedCounts = new Map();

const seenEpisodeKeys = new Set();
for await (const episode of readGzipLines(episodePath)) {
  const episodeKey = `${episode.file}|${episode.updateCount}|${episode.eventIndex}`;
  if (!belongsToSplit(episode) || seenEpisodeKeys.has(episodeKey)) {
    continue;
  }
  seenEpisodeKeys.add(episodeKey);
  if (episode.confused === true) {
    if (episode.kind === 'attack') {
      addCount(confusedCounts, 'attackRows');
      addCount(
        confusedCounts,
        'attackSelf',
        episode.target?.selfTarget === true ? 1 : 0,
      );
      const confusedTargetCount = episode.target?.targetCount;
      if (Number.isInteger(confusedTargetCount) && confusedTargetCount > 0) {
        addCount(
          confusedCounts,
          'attackSelfPredicted',
          1 / (confusedTargetCount + 1),
        );
      }
      const category = episode.chosen?.firstCategory ?? 'unknown';
      addCount(confusedCounts, `category|${category}`);
      const handCategories = new Map();
      for (const item of episode.hand ?? []) {
        if (
          (item.modelId ?? 0) > 0 &&
          item.used !== true &&
          item.category !== 'armor'
        ) {
          addCount(handCategories, item.category ?? 'unknown');
        }
      }
      const totalItems = [...handCategories.values()].reduce(
        (sum, value) => sum + value,
        0,
      );
      for (const [handCategory, count] of handCategories) {
        addCount(
          confusedCounts,
          `predictedCategory|${handCategory}`,
          count / Math.max(1, totalItems),
        );
      }
    }
    if (episode.kind === 'defense') {
      addCount(confusedCounts, 'defenseRows');
      addCount(
        confusedCounts,
        'defenseForgive',
        episode.chosen?.forgive === true ? 1 : 0,
      );
    }
    continue;
  }
  if (episode.handCertain !== true) {
    continue;
  }

  if (episode.kind === 'attack') {
    const player = actorPlayer(episode);
    const legal = (episode.legalFirst ?? []).filter(
      (candidate) =>
        candidate.source === 'hand' &&
        !['discard', 'sacrifice'].includes(candidate.seedAbility ?? ''),
    );
    const candidates = legal.map((candidate) => {
      const definition = getItemDefinition(candidate.seedModelId);
      return {
        candidate,
        definition,
        weight: botAttackWeight(player, definitionItem(definition)),
      };
    }).filter((entry) => entry.definition.isItemTargetingCommand());
    const prayerAllowed =
      !episode.hasWeapon && episode.prayerLegal !== false;
    const prayerWeight = prayerAllowed
      ? botPrayerWeight(candidates.length)
      : 0;
    const totalWeight =
      prayerWeight +
      candidates.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) {
      continue;
    }
    const chosen = episode.chosen ?? {};
    const chosenExists = chosen.prayer === true
      ? prayerAllowed
      : candidates.some((entry) => entry.candidate.seedSlotIndex === chosen.firstSlotIndex);
    if (!chosenExists) {
      addCount(attackExcluded, 'inconsistent-command');
      continue;
    }
    attackRows++;
    if (chosen.prayer === true) {
      addCount(attackByCategory, 'prayer');
      attackProbabilities.push(prayerWeight / totalWeight);
    } else {
      const chosenCandidate = candidates.find(
        (entry) =>
          entry.candidate.seedSlotIndex === chosen.firstSlotIndex,
      );
      if (!chosenCandidate) {
        continue;
      }
      addCount(attackByCategory, chosenCandidate.definition.category.key);
      attackProbabilities.push(
        chosenCandidate.weight / totalWeight,
      );
      const bestWeight = Math.max(
        prayerWeight,
        ...candidates.map((entry) => entry.weight),
      );
      if (chosenCandidate.weight >= bestWeight) {
        attackTop1++;
      }
    }
    for (const entry of candidates) {
      addCount(
        attackByCategory,
        `predicted|${entry.definition.category.key}`,
        entry.weight / totalWeight,
      );
      addCount(
        attackByAbility,
        `predicted|${entry.definition.ability || '(plain)'}`,
        entry.weight / totalWeight,
      );
    }
    addCount(
      attackByCategory,
      'predicted|prayer',
      prayerWeight / totalWeight,
    );
    addCount(attackByAbility, 'predicted|prayer', prayerWeight / totalWeight);
    const chosenAbility = chosen.prayer
      ? 'prayer'
      : candidates.find(
          (entry) =>
            entry.candidate.seedSlotIndex === chosen.firstSlotIndex,
        )?.definition.ability || '(plain)';
    addCount(attackByAbility, `observed|${chosenAbility}`);
    if (!chosen.prayer) {
      addCount(attackLengthCounts, chosen.itemCount ?? 1);
    }
    if (!episode.hasWeapon) {
      addCount(prayerRates, 'rows');
      addCount(prayerRates, 'observed', chosen.prayer === true ? 1 : 0);
      addCount(prayerRates, 'predicted', prayerWeight / totalWeight);
      const legalBucket =
        candidates.length >= 5 ? '5+' : String(candidates.length);
      addCount(prayerByLegalCount, `rows|${legalBucket}`);
      addCount(
        prayerByLegalCount,
        `observed|${legalBucket}`,
        chosen.prayer === true ? 1 : 0,
      );
      addCount(
        prayerByLegalCount,
        `predicted|${legalBucket}`,
        prayerWeight / totalWeight,
      );
    }
    const weaponBucket = episode.hasWeapon ? 'weapon' : 'unarmed';
    addCount(prayerByWeapon, `rows|${weaponBucket}`);
    addCount(
      prayerByWeapon,
      `observed|${weaponBucket}`,
      chosen.prayer === true ? 1 : 0,
    );
    addCount(
      prayerByWeapon,
      `predicted|${weaponBucket}`,
      prayerWeight / totalWeight,
    );

    if (candidates.some((entry) => entry.definition.ability === 'boostHP')) {
      const healBucket = episode.hpBucket;
      const healWeight = candidates
        .filter((entry) => entry.definition.ability === 'boostHP')
        .reduce((sum, entry) => sum + entry.weight, 0);
      addCount(healCounts, `rows|${healBucket}`);
      addCount(
        healCounts,
        `observed|${healBucket}`,
        chosen.firstAbility === 'boostHP' ? 1 : 0,
      );
      addCount(healCounts, `predicted|${healBucket}`, healWeight / totalWeight);
    }

    if (!chosen.prayer) {
      const ability = chosen.firstAbility || '(plain)';
      const observedSelf = episode.target?.selfTarget === true;
      const predictedSelf =
        ability === 'boostHPOrDealDamage'
          ? botTearSelfPercent(episode.livingPlayers) / 100
          : ability === 'boostMPAndAddCurse'
            ? 1
            : ability === 'danger' || ability === 'callPhenomenon'
              ? 1 / Math.max(1, episode.livingPlayers)
              : 0;
      addCount(selfTargetCounts, `rows|${ability}`);
      addCount(selfTargetCounts, `observed|${ability}`, observedSelf ? 1 : 0);
      addCount(selfTargetCounts, `predicted|${ability}`, predictedSelf);
      if (ability === 'boostHPOrDealDamage') {
        const livingBucket = episode.livingPlayers <= 5 ? '2-5' : '6+';
        addCount(tearSelfCounts, `rows|${livingBucket}`);
        addCount(tearSelfCounts, `observed|${livingBucket}`, observedSelf ? 1 : 0);
        addCount(tearSelfCounts, `predicted|${livingBucket}`, predictedSelf);
      }
    }
  }

  const recordedDefenseSlot = episode.chosen?.slots?.[0]?.slotIndex;
  const hasRecordedDefense = episode.chosen?.forgive === true
    || (episode.legalDefense ?? []).some((candidate) => candidate.seedSlotIndex === recordedDefenseSlot);
  if (episode.kind === 'defense' && (episode.chosenLegal !== true || !hasRecordedDefense)) {
    addCount(defenseExcluded, 'inconsistent-command');
    continue;
  }

  if (episode.kind === 'defense') {
    const context = projectDefenseEpisode(episode);
    if (context.reason) {
      addCount(defenseExcluded, context.reason);
      continue;
    }
    const candidates = context.candidates;
    const bestDefense = Math.max(0, ...candidates.map((candidate) => candidate.defense));
    const hasSpecialDefense = candidates.some((candidate) => candidate.definition.ability !== '');
    const lethal = context.damage > 0 && context.damage >= episode.hp;
    const chance = botDefenseForgivePercent(
      context.damage, candidates.length, hasSpecialDefense, lethal, bestDefense,
      context.category, context.element,
    );
    if (defenseDataPath) {
      const hash = createHash('sha256').update(episode.gameId ?? episode.file).digest().readUInt32BE(0);
      defenseData.push({
        gameId: episode.gameId, file: episode.file, split: hash % 5,
        damage: context.damage, legal: candidates.length, response: hasSpecialDefense,
        best: bestDefense, lethal, category: context.category,
        element: context.element,
        attackModelIds: episode.attack.itemModelIds,
        chosenDefense: episode.chosen?.totalDefense ?? 0,
        chosenItemIds: episode.chosen?.items?.map((item) => item.modelId) ?? [],
        fullyCovered: bestDefense >= context.damage,
        forgive: episode.chosen?.forgive === true,
      });
    }
    if (episode.chosen?.forgive !== true) {
      const weights = candidates.map((candidate) =>
        botDefenseChoiceWeight(candidate.definition, context.damage, candidate.response),
      );
      const totalWeight = weights.reduce((total, weight) => total + weight, 0);
      const chosenSlot = episode.chosen?.slots?.[0]?.slotIndex;
      const chosenIndex = candidates.findIndex((candidate) => candidate.command.itemIds[0] === chosenSlot);
      if (chosenIndex >= 0 && totalWeight > 0) {
        const probability = weights[chosenIndex] / totalWeight;
        defenseChoice.rows++;
        defenseChoice.negativeLogLikelihood -= Math.log(Math.max(probability, Number.EPSILON));
        defenseChoice.chosenProbability += probability;
      }
    }
    const observed = episode.chosen?.forgive === true;
    addCount(defenseCounts, 'rows');
    addCount(defenseCounts, 'observed', observed ? 1 : 0);
    addCount(defenseCounts, 'predicted', chance / 100);
    const probability = Math.max(1e-9, Math.min(1 - 1e-9, chance / 100));
    const outcome = observed ? 1 : 0;
    defensePrediction.negativeLogLikelihood -= outcome * Math.log(probability)
      + (1 - outcome) * Math.log1p(-probability);
    defensePrediction.brierScore += (outcome - probability) ** 2;
    const bucket = String(episode.incomingDamage ?? 0);
    addCount(defenseByDamage, `rows|${bucket}`);
    addCount(defenseByDamage, `observed|${bucket}`, observed ? 1 : 0);
    addCount(defenseByDamage, `predicted|${bucket}`, chance / 100);
    const legalBucket = String(
      (episode.legalDefense ?? []).filter(
        (candidate) => candidate.source !== 'forgive',
      ).length,
    );
    addCount(defenseByLegalCount, `rows|${legalBucket}`);
    addCount(defenseByLegalCount, `observed|${legalBucket}`, observed ? 1 : 0);
    addCount(defenseByLegalCount, `predicted|${legalBucket}`, chance / 100);
    const category = episode.attack?.firstCategory ?? 'unknown';
    addCount(defenseByCategory, `rows|${category}`);
    addCount(defenseByCategory, `observed|${category}`, observed ? 1 : 0);
    addCount(defenseByCategory, `predicted|${category}`, chance / 100);
    const coverage =
      bestDefense <= 0
        ? 'none'
        : bestDefense >= context.damage
          ? 'full'
          : 'partial';
    addCount(defenseByCoverage, `rows|${coverage}`);
    addCount(defenseByCoverage, `observed|${coverage}`, observed ? 1 : 0);
    addCount(defenseByCoverage, `predicted|${coverage}`, chance / 100);
  }

  if (episode.kind === 'defense') {
    const depth = String(episode.defenseDepth ?? 0);
    addCount(defenseByDepth, `rows|${depth}`);
    addCount(
      defenseByDepth,
      `observed|${depth}`,
      episode.chosen?.forgive === true ? 1 : 0,
    );
  }

  if (episode.kind === 'buy') {
    const definition = getItemDefinition(episode.offeredItemModelId);
    const observed = episode.bought === true;
    const replayedBalance = buyBalances.get(buyDecisionKey(
      episode.file, episode.updateCount, episode.eventIndex, episode.actor, definition.id,
    ));
    let affordable;
    if (replayedBalance !== undefined) {
      buyBalanceAudit.replayed++;
      affordable = replayedBalance >= definition.price;
      if (!affordable) buyBalanceAudit.replayedUnaffordable++;
    } else if (observed) {
      buyBalanceAudit.inferredFromAcceptance++;
      affordable = true;
    } else {
      buyBalanceAudit.legacy++;
      affordable = episode.affordableByCp === true;
    }
    if (!affordable) {
      unaffordableBuyOffersExcluded++;
      continue;
    }
    const predicted = botShouldAcceptBuy(definitionItem(definition));
    addCount(buyCounts, 'rows');
    addCount(buyCounts, 'observed', observed ? 1 : 0);
    addCount(buyCounts, 'predicted', predicted ? 1 : 0);
    addCount(buyCounts, 'deterministic');
    addCount(buyCounts, 'disagreements', observed !== predicted ? 1 : 0);
    const key = `${definition.category.key}|${episode.priceBucket}`;
    addCount(buyByCategory, `rows|${key}`);
    addCount(buyByCategory, `observed|${key}`, observed ? 1 : 0);
    addCount(buyByCategory, `predicted|${key}`, predicted ? 1 : 0);
    addCount(buyByAffordability, 'rows|yes');
    addCount(buyByAffordability, 'observed|yes', observed ? 1 : 0);
    addCount(buyByAffordability, 'predicted|yes', predicted ? 1 : 0);
    const offeredAbility = episode.offeredAbility || '(plain)';
    addCount(buyByAbility, `rows|${offeredAbility}`);
    addCount(buyByAbility, `observed|${offeredAbility}`, observed ? 1 : 0);
    addCount(buyByAbility, `predicted|${offeredAbility}`, predicted ? 1 : 0);
  }

  if (episode.kind === 'attack') {
    const ability = episode.chosen?.firstAbility ?? '';
    const rank = episode.target?.targetHpRank;
    const targetCount = episode.target?.targetCount;
    if (
      ability === 'sell' &&
      Number.isInteger(rank) &&
      Number.isInteger(targetCount) &&
      targetCount > 0
    ) {
      addCount(sellCounts, `rows|${targetCount}`);
      addCount(sellCounts, `obs|${targetCount}|${rank}`);
      const totalWeight = Array.from(
        { length: targetCount },
        (unusedValue, index) => botSellTargetWeight(index),
      ).reduce((sum, value) => sum + value, 0);
      for (let candidateRank = 0; candidateRank < targetCount; candidateRank++) {
        addCount(
          sellCounts,
          `pred|${targetCount}|${candidateRank}`,
          botSellTargetWeight(candidateRank) / totalWeight,
        );
      }

      const sellSlot = episode.chosen?.slots?.[0]?.slotIndex;
      const partnerSlot = episode.chosen?.slots?.[1]?.slotIndex;
      const eligible = (episode.hand ?? []).filter(
        (item) =>
          item.slotIndex !== sellSlot &&
          item.used !== true &&
          item.category !== 'miracles',
      );
      const partner = eligible.find(
        (item) => item.slotIndex === partnerSlot,
      );
      const maxPrice = eligible.reduce(
        (max, item) => Math.max(max, item.price ?? 0),
        0,
      );
      addCount(sellPartner, 'rows');
      addCount(
        sellPartner,
        'observed',
        partner && (partner.price ?? 0) >= maxPrice ? 1 : 0,
      );
      addCount(sellPartner, 'predicted', 1);
    }
  }
}


function attackSummary() {
  const observed = new Map();
  const predicted = new Map();
  for (const [key, value] of attackByCategory) {
    if (key.startsWith('predicted|')) {
      addCount(predicted, key.slice('predicted|'.length), value);
    } else {
      addCount(observed, key, value);
    }
  }
  const observedTotal = [...observed.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const predictedTotal = [...predicted.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const observedShares = new Map(
    normalizedDistribution(observed, observedTotal),
  );
  const predictedShares = new Map(
    normalizedDistribution(predicted, predictedTotal),
  );
  const probabilityTotal = attackProbabilities.reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    rows: attackRows,
    excluded: Object.fromEntries(attackExcluded),
    negativeLogLikelihood: -attackProbabilities.reduce((total, probability) => total + Math.log(Math.max(probability, Number.EPSILON)), 0) / Math.max(1, attackProbabilities.length),
    meanChosenProbability:
      probabilityTotal / Math.max(1, attackProbabilities.length),
    top1Rate: attackTop1 / Math.max(1, attackRows),
    observed: [...observedShares.entries()],
    predicted: [...predictedShares.entries()],
    tv: totalVariation(observedShares, predictedShares),
    byAbility: prefixedDistribution(attackByAbility),
    commandLength: [...attackLengthCounts.entries()]
      .sort(([first], [second]) => first - second)
      .map(([length, count]) => [length, count]),
    healByHpBucket: groupedRates(healCounts),
    prayerByLegalCount: groupedRates(prayerByLegalCount),
    prayerByWeapon: groupedRates(prayerByWeapon),
    selfTargetByAbility: groupedRates(selfTargetCounts),
    tearSelfByLivingCount: groupedRates(tearSelfCounts),
    prayer: {
      rows: prayerRates.get('rows') ?? 0,
      observed:
        (prayerRates.get('observed') ?? 0) /
        Math.max(1, prayerRates.get('rows') ?? 1),
      predicted:
        (prayerRates.get('predicted') ?? 0) /
        Math.max(1, prayerRates.get('rows') ?? 1),
    },
  };
}

function prefixedDistribution(counts) {
  const observed = new Map();
  const predicted = new Map();
  for (const [key, value] of counts) {
    if (key.startsWith('predicted|')) {
      addCount(predicted, key.slice('predicted|'.length), value);
    } else if (key.startsWith('observed|')) {
      addCount(observed, key.slice('observed|'.length), value);
    }
  }
  const observedTotal = [...observed.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const predictedTotal = [...predicted.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const observedShares = new Map(
    normalizedDistribution(observed, observedTotal),
  );
  const predictedShares = new Map(
    normalizedDistribution(predicted, predictedTotal),
  );
  return {
    observed: [...observedShares.entries()],
    predicted: [...predictedShares.entries()],
    tv: totalVariation(observedShares, predictedShares),
  };
}

function depthRates(counts) {
  const groups = new Set(
    [...counts.keys()].map((key) =>
      key.split('|').slice(1).join('|'),
    ),
  );
  return [...groups]
    .map((group) => {
      const rows = counts.get(`rows|${group}`) ?? 0;
      return {
        group,
        rows,
        observed: (counts.get(`observed|${group}`) ?? 0) / Math.max(1, rows),
      };
    })
    .filter((entry) => entry.rows > 0)
    .sort((first, second) =>
      first.group.localeCompare(second.group, undefined, {
        numeric: true,
      }),
    );
}

function confusedSummary() {
  const attackRows = confusedCounts.get('attackRows') ?? 0;
  const categoryObserved = new Map();
  const categoryPredicted = new Map();
  for (const [key, value] of confusedCounts) {
    if (key.startsWith('category|')) {
      addCount(categoryObserved, key.slice('category|'.length), value);
    } else if (key.startsWith('predictedCategory|')) {
      addCount(
        categoryPredicted,
        key.slice('predictedCategory|'.length),
        value,
      );
    }
  }
  const observedTotal = [...categoryObserved.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const predictedTotal = [...categoryPredicted.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const observedShares = new Map(
    normalizedDistribution(categoryObserved, observedTotal),
  );
  const predictedShares = new Map(
    normalizedDistribution(categoryPredicted, predictedTotal),
  );
  return {
    attackRows,
    observedSelfRate:
      (confusedCounts.get('attackSelf') ?? 0) / Math.max(1, attackRows),
    predictedSelfRate:
      (confusedCounts.get('attackSelfPredicted') ?? 0) /
      Math.max(1, attackRows),
    categoryObserved: [...observedShares.entries()],
    categoryPredicted: [...predictedShares.entries()],
    categoryTv: totalVariation(observedShares, predictedShares),
    defenseRows: confusedCounts.get('defenseRows') ?? 0,
    observedDefenseForgive:
      (confusedCounts.get('defenseForgive') ?? 0) /
      Math.max(1, confusedCounts.get('defenseRows') ?? 1),
  };
}

function rateSummary(counts) {
  const rows = counts.get('rows') ?? 0;
  return {
    rows,
    observed: (counts.get('observed') ?? 0) / Math.max(1, rows),
    predicted: (counts.get('predicted') ?? 0) / Math.max(1, rows),
  };
}

function groupedRates(counts) {
  const groups = new Set(
    [...counts.keys()].map((key) =>
      key.split('|').slice(1).join('|'),
    ),
  );
  return [...groups]
    .map((group) => {
      const rows = counts.get(`rows|${group}`) ?? 0;
      return {
        group,
        rows,
        observed: (counts.get(`observed|${group}`) ?? 0) / Math.max(1, rows),
        predicted:
          (counts.get(`predicted|${group}`) ?? 0) / Math.max(1, rows),
      };
    })
    .filter((entry) => entry.rows > 0)
    .sort((first, second) =>
      first.group.localeCompare(second.group, undefined, {
        numeric: true,
      }),
    );
}

function sellSummary() {
  const observed = new Map();
  const predicted = new Map();
  const enemyCounts = new Set(
    [...sellCounts.keys()]
      .filter((key) => key.startsWith('rows|'))
      .map((key) => Number(key.split('|')[1])),
  );
  for (const enemies of enemyCounts) {
    for (let rank = 0; rank < enemies; rank++) {
      addCount(observed, rank, sellCounts.get(`obs|${enemies}|${rank}`) ?? 0);
      addCount(predicted, rank, sellCounts.get(`pred|${enemies}|${rank}`) ?? 0);
    }
  }
  const observedTotal = [...observed.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const predictedTotal = [...predicted.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const observedShares = new Map(
    normalizedDistribution(observed, observedTotal),
  );
  const predictedShares = new Map(
    normalizedDistribution(predicted, predictedTotal),
  );
  return {
    rows: observedTotal,
    observed: [...observedShares.entries()],
    predicted: [...predictedShares.entries()],
    tv: totalVariation(observedShares, predictedShares),
  };
}

const report = {
  split,
  target: {
    ...targetSummary(),
    decisionLikelihood: {
      ...targetLikelihood,
      boundary: targetBoundary,
      targetProvenance,
      sharedCutoffDisplacement,
      fullStatReplayBoundary,
      targetStatusReplay,
      guardianBoundary,
      actorRelativeBoundary,
      directionConflicts,
      statusPartitionConflicts,
      runtimeTargetSupport,
      negativeLogLikelihood: targetLikelihood.negativeLogLikelihood / Math.max(1, targetLikelihood.rows),
      previousNegativeLogLikelihood: targetLikelihood.previousNegativeLogLikelihood / Math.max(1, targetLikelihood.rows),
    },
  },
  attack: attackSummary(),
  defense: {
    ...rateSummary(defenseCounts),
    excluded: Object.fromEntries(defenseExcluded),
    negativeLogLikelihood: defensePrediction.negativeLogLikelihood / Math.max(1, defenseCounts.get('rows') ?? 0),
    brierScore: defensePrediction.brierScore / Math.max(1, defenseCounts.get('rows') ?? 0),
    firstItemChoice: {
      rows: defenseChoice.rows,
      negativeLogLikelihood: defenseChoice.negativeLogLikelihood / Math.max(1, defenseChoice.rows),
      meanChosenProbability: defenseChoice.chosenProbability / Math.max(1, defenseChoice.rows),
    },
    byDamage: groupedRates(defenseByDamage),
    byLegalCount: groupedRates(defenseByLegalCount),
    byAttackCategory: groupedRates(defenseByCategory),
    byCoverage: groupedRates(defenseByCoverage),
    byDepth: depthRates(defenseByDepth),
  },
  buy: {
    ...rateSummary(buyCounts),
    deterministicChoices: {
      rows: buyCounts.get('deterministic') ?? 0,
      disagreements: buyCounts.get('disagreements') ?? 0,
    },
    unaffordableOffersExcluded: unaffordableBuyOffersExcluded,
    balanceAudit: buyBalanceAudit,
    byCategoryAndPrice: groupedRates(buyByCategory),
    byAffordability: groupedRates(buyByAffordability),
    byOfferedAbility: groupedRates(buyByAbility),
  },
  sell: {
    ...sellSummary(),
    partnerTopPrice: {
      rows: sellPartner.get('rows') ?? 0,
      observed:
        (sellPartner.get('observed') ?? 0) /
        Math.max(1, sellPartner.get('rows') ?? 1),
      predicted: 1,
    },
  },
  confused: confusedSummary(),
};

if (defenseDataPath) {
  await writeFile(defenseDataPath, `${JSON.stringify(defenseData)}\n`);
}

if (reportPath) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
