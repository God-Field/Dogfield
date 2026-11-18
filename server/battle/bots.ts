import type { Stat, Attack, Command, Player, Slot } from '../types.ts';
import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Battle } from './battle.ts';
import { engine } from '../engine.ts';
import {
  botAttackWeight as botItemAttackWeight,
  botBuyAcceptancePercent,
  botDefenseChoiceWeight,
  botDefenseFollowUpPercent,
  botDefenseForgivePercent,
  botFollowUpWeight,
  botPrayerWeight,
  botSellTargetWeight,
  botTargetProbabilities,
  botTearSelfPercent,
} from './bot-policy.ts';
import { areEnemies } from './targets.ts';
import { getOccupiedItemSlots } from './inventory.ts';

/**
 * Calm bots fill HP to 30 before Apocalypse and 50 during Apocalypse, then
 * MP to 30 and CP to 15. Remaining points fill HP to 50, then MP and CP.
 */
function allocateBotExchange(totalStats: number, apocalypse = false) {
  let remaining = totalStats;
  const allocation = {
    hp: Math.min(remaining, apocalypse ? 50 : 30),
    mp: 0,
    cp: 0,
  };
  remaining -= allocation.hp;
  allocation.mp = Math.min(remaining, 30);
  remaining -= allocation.mp;
  allocation.cp = Math.min(remaining, 15);
  remaining -= allocation.cp;

  const hpAddition = Math.min(remaining, 50 - allocation.hp);
  allocation.hp += hpAddition;
  remaining -= hpAddition;
  const mpAddition = Math.min(remaining, engine.MAX_STAT - allocation.mp);
  allocation.mp += mpAddition;
  remaining -= mpAddition;
  const cpAddition = Math.min(remaining, engine.MAX_STAT - allocation.cp);
  allocation.cp += cpAddition;
  remaining -= cpAddition;

  for (const stat of ['hp', 'mp', 'cp'] as Stat[]) {
    if (remaining === 0) {
      break;
    }
    const addition = Math.min(remaining, engine.MAX_STAT - allocation[stat]);
    allocation[stat] += addition;
    remaining -= addition;
  }
  return allocation;
}

const confusedExchangeDistributions = new Map<number, {
  minimumHp: number;
  cumulativeCounts: number[];
}>();

function confusedExchangeDistribution(totalStats: number) {
  const cached = confusedExchangeDistributions.get(totalStats);
  if (cached) {
    return cached;
  }
  const maximumStat = engine.MAX_STAT;
  const minimumHp = Math.max(0, totalStats - maximumStat * 2);
  const maximumHp = Math.min(maximumStat, totalStats);
  const cumulativeCounts = [];
  let partitionCount = 0;
  for (let hp = minimumHp; hp <= maximumHp; hp++) {
    const remaining = totalStats - hp;
    const minimumMp = Math.max(0, remaining - maximumStat);
    const maximumMp = Math.min(maximumStat, remaining);
    partitionCount += maximumMp - minimumMp + 1;
    cumulativeCounts.push(partitionCount);
  }
  const distribution = { minimumHp, cumulativeCounts };
  confusedExchangeDistributions.set(totalStats, distribution);
  return distribution;
}

function allocateConfusedExchange(battle: Battle, totalStats: number) {
  // Cache the weights for each total (0..297), then find the selected HP
  // bucket without building options or scanning them on every Exchange.
  const { minimumHp, cumulativeCounts } = confusedExchangeDistribution(totalStats);
  const partitionCount = cumulativeCounts[cumulativeCounts.length - 1];
  const position = battle.random.value('confusionExchangeHp') * partitionCount;
  let lowerIndex = 0;
  let upperIndex = cumulativeCounts.length - 1;
  while (lowerIndex < upperIndex) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    if (position < cumulativeCounts[middleIndex]) {
      upperIndex = middleIndex;
    } else {
      lowerIndex = middleIndex + 1;
    }
  }
  const hp = minimumHp + lowerIndex;
  const remaining = totalStats - hp;
  const minimumMp = Math.max(0, remaining - engine.MAX_STAT);
  const maximumMp = Math.min(engine.MAX_STAT, remaining);
  const mp = minimumMp + Math.floor(
    battle.random.value('confusionExchangeMp') * (maximumMp - minimumMp + 1),
  );
  return { hp, mp, cp: remaining - mp };
}

export function botDefenseCandidates(
  battle: Battle,
  player: Player,
  selectedItemIds: number[] = [],
) {
  const attack = battle.attack;
  if (!attack) {
    return [];
  }
  const incomingDefinitions = battle.attackDefinitions(attack);
  const initialDefinition = incomingDefinitions[0];
  const attackCategory = initialDefinition?.ability === 'categoryWeapons'
    ? engine.CategoryWeapons
    : initialDefinition?.category;
  const selectedDefinitions = selectedItemIds.map((itemId) => {
    const itemSlot = player.items.find((candidate) => candidate.id === itemId)!;
    return battle.getSlotDefinition(itemSlot);
  });
  const context = battle.commandSelectionContext(
    player,
    'defense',
    incomingDefinitions,
  );
  const candidates = [];
  for (const itemSlot of getOccupiedItemSlots(player)) {
    if (itemSlot.used || selectedItemIds.includes(itemSlot.id)) {
      continue;
    }
    const definition = battle.getSlotDefinition(itemSlot);
    if (!engine.canApplyCommand(selectedDefinitions, definition, context)) {
      continue;
    }
    const definitions = [...selectedDefinitions, definition];
    const validationError = engine.validateItemAction({
      models: definitions,
      availableMp: player.mp,
      mode: context.mode,
      hasSpecialItemCommand: false,
    });
    if (validationError !== null) {
      continue;
    }
    const filters = definitions.filter((item) => item.ability === 'filterAtkElement');
    const incomingElement = engine.getAttackElement([...incomingDefinitions, ...filters]);
    const response = attackCategory !== undefined
      && engine.findDefenseResponse(definitions, attackCategory, incomingElement) !== null;
    candidates.push({
      command: { itemIds: [...selectedItemIds, itemSlot.id] },
      definition,
      defense: definitions.reduce((total, item) => total + item.defense, 0),
      response,
    });
  }
  return candidates;
}

export function chooseBotDefense(
  battle: Battle,
  player: Player,
): Command {
  const attack = battle.attack;
  if (attack === undefined) {
    return {};
  }
  const attackDefinitions = battle.attackDefinitions(attack);
  const initialDefinition = attackDefinitions[0];
  if (initialDefinition === undefined) {
    return {};
  }
  const candidates = botDefenseCandidates(battle, player);
  if (candidates.length === 0) {
    return {};
  }
  const damage = engine.calculateAttackDamage(attackDefinitions, attack.atk ?? 0);
  const bestDefense = Math.max(...candidates.map((candidate) => candidate.defense));
  const hasSpecialDefense = candidates.some((candidate) => candidate.definition.ability !== '');
  const lethal = damage > 0 && damage >= player.hp;
  const forgivePercent = botDefenseForgivePercent(
    damage, candidates.length, hasSpecialDefense, lethal, bestDefense,
    initialDefinition.category.key,
  );
  if (battle.random.chance('botDefenseForgive', forgivePercent)) {
    return {};
  }
  let chosen = battle.random.pick('botDefenseChoice', candidates, (candidate) =>
    botDefenseChoiceWeight(candidate.definition, damage, candidate.response),
  );
  while (true) {
    const followUpPercent = botDefenseFollowUpPercent(damage, chosen.defense, chosen.response);
    if (followUpPercent === 0) {
      break;
    }
    const followUps = botDefenseCandidates(battle, player, chosen.command.itemIds);
    if (followUps.length === 0 || !battle.random.chance('botDefenseFollowUp', followUpPercent)) {
      break;
    }
    const remainingDamage = Math.max(0, damage - chosen.defense);
    chosen = battle.random.pick('botDefenseFollowUpItem', followUps, (candidate) =>
      botDefenseChoiceWeight(candidate.definition, remainingDamage, candidate.response),
    );
  }
  return chosen.command;
}

export function chooseBotBuyDecision(
  battle: Battle,
  offerModelId: number,
): boolean {
  const definition = battle.getItemDefinition(offerModelId);
  // The creator confirmed that each card has a fixed acceptance decision.
  return botBuyAcceptancePercent(definition) === 100;
}

export function chooseBotTarget(
  battle: Battle,
  enemies: Player[],
  definition?: ItemDefinition,
): number {
  const rankedEnemies = [...enemies].sort(
    (firstEnemy, secondEnemy) =>
      firstEnemy.hp - secondEnemy.hp ||
      firstEnemy.id - secondEnemy.id,
  );
  const actor = battle.game.players.find(
    (player) => player.id === battle.game.attackTurnPlayerId,
  );
  const targetContext = actor
    ? { actor, players: battle.alive, targets: rankedEnemies }
    : undefined;
  const probabilities = botTargetProbabilities(
    rankedEnemies.map((enemy) => enemy.hp),
    definition?.ability ?? '',
    targetContext,
  );
  const candidates = rankedEnemies.map((enemy, rank) => ({
    enemy: enemy,
    weight: probabilities[rank],
  }));
  return battle.random.pick(
    'botTarget',
    candidates,
    (candidate) => candidate.weight,
  ).enemy.id;
}

export function addBotAttackFollowUps(
  battle: Battle,
  player: Player,
  command: Command,
  definition: ItemDefinition,
): void {
  if (
    definition.category !== engine.CategoryWeapons &&
    definition.category !== engine.CategoryMiracles
  ) {
    return;
  }
  if (
    ['sell', 'buy', 'exchange', 'discard', 'sacrifice'].includes(
      definition.ability ?? '',
    )
  ) {
    return;
  }
  const selectedIds = new Set(command.itemIds ?? []);
  let extraChance = 12;
  while (
    (command.itemIds?.length ?? 0) < 7 &&
    battle.random.chance('botAttackExtraItem', extraChance)
  ) {
    const candidates = getOccupiedItemSlots(player)
      .filter((itemSlot) => !itemSlot.used && !selectedIds.has(itemSlot.id))
      .map((itemSlot) => ({
        itemSlot,
        definition: battle.getSlotDefinition(itemSlot),
      }))
      .filter((candidate) => {
        const tentativeCommand: Command = {
          ...command,
          itemIds: [...(command.itemIds ?? []), candidate.itemSlot.id],
        };
        return isValidBotCommand(battle, player, tentativeCommand);
      });
    if (candidates.length === 0) {
      break;
    }
    const chosen = battle.random.pick(
      'botAttackFollowUp',
      candidates,
      (candidate) =>
        botFollowUpWeight(player, candidate.definition),
    );
    command.itemIds = [...(command.itemIds ?? []), chosen.itemSlot.id];
    selectedIds.add(chosen.itemSlot.id);
    extraChance = 8;
  }
}

export function buildConfusedBotCommand(
  battle: Battle,
  player: Player,
  itemSlot: Slot,
  definition: ItemDefinition,
  occupiedSlots: readonly Slot[],
): Command | null {
  const command: Command = {
    itemIds: [itemSlot.id],
  };
  if (
    definition.ability === 'discard' ||
    definition.ability === 'sacrifice'
  ) {
    command.itemIds = [0, itemSlot.id];
    return command;
  }
  if (definition.ability === 'sell') {
    const customers = occupiedSlots.filter(
      (candidateSlot) => candidateSlot.id !== itemSlot.id,
    );
    if (customers.length === 0) {
      return null;
    }
    const customerSlot = battle.random.pick('confusionCustomer', customers);
    command.itemIds = [itemSlot.id, customerSlot.id];
    command.targetPlayerId = battle.random.pick(
      'confusionTarget',
      battle.alive,
    ).id;
    return command;
  }
  if (definition.ability === 'exchange') {
    const allocation = allocateConfusedExchange(
      battle,
      player.hp + player.mp + player.cp,
    );
    command.mp = allocation.mp;
    command.cp = allocation.cp;
    return command;
  }
  command.targetPlayerId = battle.random.pick(
    'confusionTarget',
    battle.alive,
  ).id;
  return command;
}

function choosePendingBotCommand(
  battle: Battle,
  player: Player,
  pendingAttack: Attack | undefined,
): { player: Player; command: Command } | null {
  if (pendingAttack?.buyingItemModelId) {
    return {
      player,
      command: {
        bought: chooseBotBuyDecision(battle, pendingAttack.buyingItemModelId),
      },
    };
  }
  if (pendingAttack) {
    return {
      player,
      command: chooseBotDefense(battle, player),
    };
  }
  return null;
}

export function chooseBotConfusedCommand(
  battle: Battle,
  player: Player,
  pendingAttack: Attack | undefined,
) {
  const pendingCommand = choosePendingBotCommand(battle, player, pendingAttack);
  if (pendingCommand) {
    return pendingCommand;
  }
  const occupiedSlots = getOccupiedItemSlots(player).filter((itemSlot) => !itemSlot.used);
  const legalCandidates: Command[] = [];
  for (const itemSlot of occupiedSlots) {
    const definition = battle.getSlotDefinition(itemSlot);
    const command = buildConfusedBotCommand(
      battle,
      player,
      itemSlot,
      definition,
      occupiedSlots,
    );
    if (command === null) {
      continue;
    }
    addBotAttackFollowUps(battle, player, command, definition);
    if (isValidBotCommand(battle, player, command)) {
      legalCandidates.push(command);
    }
  }
  if (legalCandidates.length > 0) {
    return {
      player: player,
      command: battle.random.pick('confusionItem', legalCandidates),
    };
  }
  const prayerCommand: Command = {};
  if (isValidBotCommand(battle, player, prayerCommand)) {
    return {
      player: player,
      command: prayerCommand,
    };
  }
  throw new Error('No legal confused bot command found');
}

/**
 * Runs a candidate bot command through the same command validation used by a
 * submitted client command. Buy confirmations are scalar decisions; every
 * item command goes through `selectCommandItems`, which delegates to the
 * shared engine validation.
 */
export function isValidBotCommand(
  battle: Battle,
  player: Player,
  command: Command,
): boolean {
  const pendingAttack = battle.attack;
  if (pendingAttack?.buyingItemModelId) {
    return typeof command.bought === 'boolean' &&
      (command.itemIds === undefined || command.itemIds.length === 0);
  }
  try {
    battle.selectCommandItems(player, command, pendingAttack !== undefined);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error)) {
      throw error;
    }
    return false;
  }
}

function getBotTeammates(battle: Battle, player: Player): Player[] {
  if (!player.team) {
    return [];
  }

  return battle.alive.filter(
    (candidatePlayer) =>
      candidatePlayer.id !== player.id &&
      candidatePlayer.team === player.team,
  );
}

function hasCurseRemovableBy(definition: ItemDefinition, player: Player): boolean {
  if (definition.ability === 'removeAllCurses') {
    return (player.curses?.length ?? 0) > 0;
  }

  if (definition.ability !== 'removeMildCurses') {
    return false;
  }

  return (player.curses ?? []).some((curse) => engine.isMildCurse(curse));
}

export function buildBotAttackCommand(
  battle: Battle,
  player: Player,
  itemSlot: Slot,
  definition: ItemDefinition,
  enemies: Player[],
): Command | null {
  const command: Command = {
    itemIds: [itemSlot.id],
  };
  const teammates = getBotTeammates(battle, player);
  if (definition.ability === 'boostHP' && teammates.length > 0) {
    const [lowestHpTeammate] = [...teammates].sort(
      (firstPlayer, secondPlayer) =>
        firstPlayer.hp - secondPlayer.hp || firstPlayer.id - secondPlayer.id,
    );
    if (lowestHpTeammate.hp < player.hp) {
      command.targetPlayerId = lowestHpTeammate.id;
    }
  } else if (definition.ability === 'boostMP' && teammates.length > 0) {
    command.targetPlayerId = battle.random.pick(
      'botTeammateMpBoostTarget',
      teammates,
    ).id;
  } else if (
    (definition.ability === 'removeAllCurses' ||
      definition.ability === 'removeMildCurses') &&
    teammates.length > 0
  ) {
    const teammatesWithRemovableCurses = teammates.filter((teammate) =>
      hasCurseRemovableBy(definition, teammate),
    );
    if (teammatesWithRemovableCurses.length > 0) {
      command.targetPlayerId = battle.random.pick(
        'botTeammateCurseRemovalTarget',
        teammatesWithRemovableCurses,
      ).id;
    }
  }
  if (definition.ability === 'sell') {
    const customers = getOccupiedItemSlots(player)
      .filter(
        (candidateSlot) =>
          candidateSlot.id !== itemSlot.id &&
          candidateSlot.used !== true,
      )
      .sort(
        (firstSlot, secondSlot) =>
          battle.getSlotDefinition(secondSlot).price -
          battle.getSlotDefinition(firstSlot).price,
      );
    if (customers.length === 0) {
      return null;
    }
    const customer = customers[0];
    const sellTargets = battle.alive.filter(
      (targetPlayer) => targetPlayer.id !== player.id,
    );
    if (sellTargets.length === 0) {
      return null;
    }
    const rankedSellTargets = [...sellTargets].sort(
      (firstTarget, secondTarget) =>
        firstTarget.hp - secondTarget.hp ||
        firstTarget.id - secondTarget.id,
    );
    const weightedSellTargets = rankedSellTargets.map(
      (targetPlayer, rank) => ({
        targetPlayer: targetPlayer,
        weight: botSellTargetWeight(rank),
      }),
    );
    command.itemIds = [itemSlot.id, customer.id];
    command.targetPlayerId = battle.random.pick(
      'botSellTarget',
      weightedSellTargets,
      (candidate) => candidate.weight,
    ).targetPlayer.id;
    return command;
  }
  const needsEnemyTarget =
    definition.isDirectTargetCommand() ||
    definition.ability === 'boostHPOrDealDamage';
  if (needsEnemyTarget) {
    if (definition.ability === 'boostHPOrDealDamage') {
      if (
        battle.random.chance(
          'botTearSelf',
          botTearSelfPercent(battle.alive.length),
        )
      ) {
        command.targetPlayerId = player.id;
      } else {
        if (enemies.length === 0) {
          return null;
        }
        command.targetPlayerId = battle.random.pick(
          'botTearTarget',
          enemies,
        ).id;
      }
    } else if (definition.ability === 'buy') {
      if (enemies.length === 0) {
        return null;
      }
      command.targetPlayerId = battle.random.pick(
        'botBuyTarget',
        enemies,
      ).id;
    } else {
      if (enemies.length === 0) {
        return null;
      }
      command.targetPlayerId = chooseBotTarget(
        battle,
        enemies,
        definition,
      );
    }
  }
  if (definition.ability === 'exchange') {
    const allocation = allocateBotExchange(
      player.hp + player.mp + player.cp,
      battle.apocalypse,
    );
    command.mp = allocation.mp;
    command.cp = allocation.cp;
  }
  return command;
}

export function botCommand(battle: Battle) {
  const pendingAttack = battle.attack;
  const player = battle.findPlayer(battle.expectedCommandPlayerId);
  if (!player || player.dead) {
    return null;
  }
  const isConfused = (player.confusionCount ?? 0) > 0;

  if (isConfused && !pendingAttack) {
    return chooseBotConfusedCommand(battle, player, pendingAttack);
  }
  // Bots and absent/auto-played seats choose the remaining commands here.
  if (!player.isBot) {
    return null;
  }
  if (isConfused) {
    return chooseBotConfusedCommand(battle, player, pendingAttack);
  }
  const pendingCommand = choosePendingBotCommand(battle, player, pendingAttack);
  if (pendingCommand) {
    return pendingCommand;
  }
  const enemies = battle.alive.filter((targetPlayer) =>
    areEnemies(player, targetPlayer),
  );
  const weightedCandidates = getOccupiedItemSlots(player)
    .filter((itemSlot) => !itemSlot.used)
    .filter((itemSlot) =>
      battle.getSlotDefinition(itemSlot).isItemTargetingCommand(),
    )
    .filter((itemSlot) => {
      const definition = battle.getSlotDefinition(itemSlot);
      return (
        definition.ability !== 'discard' &&
        definition.ability !== 'sacrifice'
      );
    });
  const hasWeapon = getOccupiedItemSlots(player).some(
    (itemSlot) =>
      battle.getSlotDefinition(itemSlot)
        .category === engine.CategoryWeapons,
  );
  const legalCandidates: (Slot & {
    command: Command;
    definition: ItemDefinition;
    weight: number;
  })[] = [];
  for (const itemSlot of weightedCandidates) {
    const definition = battle.getSlotDefinition(itemSlot);
    const command = buildBotAttackCommand(
      battle,
      player,
      itemSlot,
      definition,
      enemies,
    );
    if (
      command === null ||
      !isValidBotCommand(battle, player, command)
    ) {
      continue;
    }
    legalCandidates.push({
      ...itemSlot,
      command: command,
      definition: definition,
      weight: botItemAttackWeight(player, definition),
    });
  }
  const candidateWeightTotal = legalCandidates.reduce(
    (totalWeight, candidate) => totalWeight + candidate.weight,
    0,
  );
  const prayerWeight = botPrayerWeight(legalCandidates.length);
  const canChoosePrayer = !hasWeapon && legalCandidates.length > 0
    && isValidBotCommand(battle, player, {});
  if (canChoosePrayer && battle.random.chance(
    'botPrayer',
    (100 * prayerWeight) / (prayerWeight + candidateWeightTotal),
  )) {
    return { player, command: {} };
  }
  if (legalCandidates.length === 0) {
    const prayerCommand: Command = {};
    if (isValidBotCommand(battle, player, prayerCommand)) {
      return {
        player: player,
        command: prayerCommand,
      };
    }
    throw new Error('No legal bot attack command found');
  }
  const chosenCandidate = battle.random.pick(
    'botAttackItem',
    legalCandidates,
    (candidate) => candidate.weight,
  );
  addBotAttackFollowUps(
    battle,
    player,
    chosenCandidate.command,
    chosenCandidate.definition,
  );
  if (!isValidBotCommand(battle, player, chosenCandidate.command)) {
    throw new Error('Bot attack follow-up produced an invalid command');
  }
  return {
    player: player,
    command: chosenCandidate.command,
  };
}
