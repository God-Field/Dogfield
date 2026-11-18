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
  botAttackWeight,
  botShouldAcceptBuy,
  botDefenseForgivePercent,
  botDefenseChoiceWeight,
  botPrayerWeight,
  botSellTargetWeight,
  botTargetProbabilities,
  botTearSelfPercent,
} from './battle/bot-policy.ts';
import { engine, getItemDefinition } from './engine.ts';
import { Battle } from './battle/battle.ts';

const refactorRoot = process.env.REFACTOR_ROOT ?? '../godfield-refactor';
const episodePath = resolve(
  refactorRoot,
  'logs/live/campaigns/bot-policy/raw/episodes.jsonl.gz',
);
const targetArgument = process.argv.find((argument) => argument.startsWith('--targets='));
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
  return { candidates, damage, category: definitions[0].category.key };
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
  if (decision.rank_agree && decision.target != null && decision.enemies_fwd >= 2) {
    targetLookupKeys.add(`${decision.file}|${decision.updateCount}|${decision.event_index}`);
  }
}
const episodes = new Map();
for await (const episode of readGzipLines(episodePath)) {
  const key = `${episode.file}|${episode.updateCount}|${episode.eventIndex}`;
  if (!belongsToSplit(episode) || !targetLookupKeys.has(key)) {
    continue;
  }
  episodes.set(key, {
    handCertain: episode.handCertain,
    confused: episode.confused,
    curses: episode.curses,
    chosen: { firstAbility: episode.chosen?.firstAbility, items: episode.chosen?.items },
  });
}
targetLookupKeys.clear();

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

const targetLikelihood = { rows: 0, groupContextRows: 0, negativeLogLikelihood: 0, previousNegativeLogLikelihood: 0 };
const targetByRank = new Map();
const targetByN = new Map();
const targetByCategory = new Map();

for await (const decision of readGzipLines(targetPath)) {
  if (
    !decision.rank_agree ||
    decision.target == null ||
    decision.enemies_fwd < 2
  ) {
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
      context.damage, candidates.length, hasSpecialDefense, lethal, bestDefense, context.category,
    );
    if (defenseDataPath) {
      const hash = createHash('sha256').update(episode.gameId ?? episode.file).digest().readUInt32BE(0);
      defenseData.push({
        gameId: episode.gameId, file: episode.file, split: hash % 5,
        damage: context.damage, legal: candidates.length, response: hasSpecialDefense,
        best: bestDefense, lethal, category: context.category,
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
    const predicted = botShouldAcceptBuy(definitionItem(definition));
    const observed = episode.bought === true;
    addCount(buyCounts, 'rows');
    addCount(buyCounts, 'observed', observed ? 1 : 0);
    addCount(buyCounts, 'predicted', predicted ? 1 : 0);
    addCount(buyCounts, 'deterministic');
    addCount(buyCounts, 'disagreements', observed !== predicted ? 1 : 0);
    const key = `${definition.category.key}|${episode.priceBucket}`;
    addCount(buyByCategory, `rows|${key}`);
    addCount(buyByCategory, `observed|${key}`, observed ? 1 : 0);
    addCount(buyByCategory, `predicted|${key}`, predicted ? 1 : 0);
    const affordable = episode.affordableByCp === true ? 'yes' : 'no';
    addCount(buyByAffordability, `rows|${affordable}`);
    addCount(buyByAffordability, `observed|${affordable}`, observed ? 1 : 0);
    addCount(buyByAffordability, `predicted|${affordable}`, chance / 100);
    const offeredAbility = episode.offeredAbility || '(plain)';
    addCount(buyByAbility, `rows|${offeredAbility}`);
    addCount(buyByAbility, `observed|${offeredAbility}`, observed ? 1 : 0);
    addCount(buyByAbility, `predicted|${offeredAbility}`, chance / 100);
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
