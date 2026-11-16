import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { engine, itemCatalog } from '../../server/engine.ts';
import { readJsonl } from './log-files.mjs';

const statFields = ['hp', 'mp', 'cp'];
const statValues = (player) => statFields.map((field) => player?.[field] ?? 0);
const statTotal = (values) => values.reduce((total, value) => total + value, 0);
const definitionFor = (modelId) => itemCatalog.findById(modelId);

export function expectedExchangeAllocation(total, apocalypse) {
  const allocation = { hp: 0, mp: 0, cp: 0 };
  const priorities = [
    ['hp', apocalypse ? 50 : 30], ['mp', 30], ['cp', 15],
    ['hp', 50], ['mp', engine.MAX_STAT], ['cp', engine.MAX_STAT],
    ['hp', engine.MAX_STAT],
  ];
  for (const [field, ceiling] of priorities) {
    const addition = Math.min(total, ceiling - allocation[field]);
    allocation[field] += addition;
    total -= addition;
  }
  return statValues(allocation);
}

class ExchangeTrace {
  constructor(previous, current, metadata) {
    this.previous = previous;
    this.current = current;
    this.metadata = metadata;
    this.players = new Map(previous.players.map((player) => [player.id, structuredClone(player)]));
    this.turnPlayerId = previous.attackTurnPlayerId;
    this.gf = previous.gf;
    this.play = null;
    this.records = [];
    this.setAttack(previous.attacks?.[0] ?? previous.attack);
  }

  get livingPlayers() {
    return [...this.players.values()].filter((player) => !player.dead);
  }

  setAttack(attack) {
    this.attack = attack ? structuredClone(attack) : { playerId: this.turnPlayerId };
    this.effectTargetId = this.attack.targetPlayerId || this.attack.playerId;
  }

  changeStat(playerId, field, amount) {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error(`Unknown stat recipient ${playerId}`);
    }
    if (field === 'hp') {
      Object.assign(player, engine.changeHp(player.hp, amount));
    } else if (field === 'mp') {
      Object.assign(player, engine.changeMp(player.hp, player.mp, amount));
    } else {
      Object.assign(player, engine.changeCp(player.hp, player.mp, player.cp, amount));
    }
  }

  spendItemCost(playerId, items) {
    const definitions = items.map((item) => definitionFor(item.fakeModelId || item.modelId));
    if (definitions.some((definition) => !definition)) {
      throw new Error('Unknown selected item');
    }
    this.changeStat(playerId, 'mp', -engine.calculateMpCost(definitions));
  }

  beginPlay(event) {
    const player = this.players.get(this.turnPlayerId);
    const items = event.items ?? [];
    this.play = {
      actor: player.id,
      confusionCount: Math.max(0, player.confusionCount ?? 0),
      before: statValues(player),
      turnItems: items.map((item) => item.modelId),
    };
    this.setAttack({ playerId: player.id, itemModelIds: this.play.turnItems });
    this.spendItemCost(player.id, items);
    if (definitionFor(this.play.turnItems[0])?.ability === 'atkBy2xMP') {
      player.mp = 0;
    }
    if ((player.confusionCount ?? 0) > 0) {
      player.confusionCount--;
    }
  }

  recordExchange(event, eventIndex) {
    const player = this.players.get(event.playerId || this.effectTargetId);
    const result = statValues(event);
    const isPlayerExchange = this.play && !this.attack.guardian
      && this.attack.playerId === this.play.actor
      && definitionFor(this.play.turnItems[0])?.ability === 'exchange';
    if (isPlayerExchange) {
      const threshold = this.previous.tiebreakGF;
      const apocalypse = threshold !== null && threshold !== undefined && this.gf >= threshold;
      const before = statValues(player);
      this.records.push({
        kind: 'player_exchange',
        ...this.metadata,
        updateCount: this.current.updateCount,
        eventIndex,
        actor: player.id,
        isBot: player.isBot === true,
        confusionCount: this.play.confusionCount,
        snapshotConfusionCount: this.previous.players.find((candidate) => candidate.id === player.id)?.confusionCount ?? 0,
        snapshotBefore: statValues(this.previous.players.find((candidate) => candidate.id === player.id)),
        before,
        result,
        total: statTotal(result),
        statsConserved: statTotal(before) === statTotal(result),
        gf: this.gf,
        tiebreakGF: threshold ?? null,
        apocalypse,
        turnItems: this.play.turnItems,
      });
      this.play = null;
    }
    Object.assign(player, { hp: result[0], mp: result[1], cp: result[2] });
  }

  recordOtherAction(event, eventIndex) {
    const actor = this.players.get(this.turnPlayerId);
    this.records.push({
      kind: event.action,
      ...this.metadata,
      updateCount: this.current.updateCount,
      eventIndex,
      actor: actor.id,
      isBot: actor.isBot === true,
      confusionCount: this.play?.confusionCount ?? Math.max(0, actor.confusionCount ?? 0),
      target: this.attack.targetPlayerId ?? null,
      selfTarget: this.attack.targetPlayerId === actor.id,
      turnItems: this.play?.turnItems ?? [],
      ...(event.item ? { item: event.item } : {}),
    });
  }

  apply(event, eventIndex) {
    const explicitPlayerId = event.playerId || null;
    switch (event.action) {
      case 'advanceGF':
        this.turnPlayerId = event.playerId;
        this.gf++;
        this.play = null;
        this.setAttack(null);
        break;
      case 'useAttackItems':
        this.beginPlay(event);
        break;
      case 'useDefenseItems':
        this.spendItemCost(this.attack.targetPlayerId || this.effectTargetId, event.items ?? []);
        break;
      case 'attackByGuardian':
        this.setAttack(event.attack);
        if (definitionFor(this.attack.itemModelIds?.[0])?.ability === 'atkBy2xMP') {
          this.players.get(this.attack.playerId).mp = 0;
        }
        break;
      case 'attackDyingly':
      case 'nextAttack':
        this.setAttack(event.attack);
        break;
      case 'phenomenon':
        this.setAttack({ playerId: this.attack.playerId, itemModelIds: [event.itemModelId] });
        break;
      case 'setTargetPlayer':
      case 'hit':
      case 'miss':
      case 'attractDanger':
        this.attack.targetPlayerId = event.playerId;
        this.effectTargetId = event.playerId;
        break;
      case 'reflect': {
        const previousAttackerId = this.attack.playerId;
        this.attack.playerId = this.attack.targetPlayerId;
        this.attack.targetPlayerId = previousAttackerId;
        this.effectTargetId = previousAttackerId;
        break;
      }
      case 'bounce':
        this.attack.playerId = this.attack.targetPlayerId;
        this.attack.targetPlayerId = event.playerId;
        this.effectTargetId = event.playerId;
        break;
      case 'disease':
      case 'useDevilItem':
        this.effectTargetId = event.playerId;
        break;
      case 'dealDamage':
        this.changeStat(explicitPlayerId ?? this.effectTargetId, 'hp', -(event.damage ?? 0));
        break;
      case 'dealDarkDamage':
        this.players.get(explicitPlayerId ?? this.effectTargetId).hp = 0;
        break;
      case 'boostHP':
      case 'boostMP':
      case 'boostCP': {
        const field = event.action.slice(5).toLowerCase();
        this.changeStat(explicitPlayerId ?? this.effectTargetId, field, event[field] ?? 0);
        break;
      }
      case 'exchange':
        this.recordExchange(event, eventIndex);
        break;
      case 'confuseEverybody':
        for (const player of this.livingPlayers) {
          player.confusionCount = (player.confusionCount ?? 0) + engine.CONFUSION_TURNS;
        }
        break;
      case 'die': {
        const player = this.players.get(event.playerId);
        player.hp = 0;
        player.dead = true;
        player.confusionCount = 0;
        break;
      }
      case 'revive':
        this.players.get(event.playerId).dead = false;
        break;
      case 'setHPOfEverybody':
        for (const player of this.livingPlayers) {
          player.hp = event.hp ?? 0;
        }
        break;
      case 'boostCPOfEverybody':
        for (const player of this.livingPlayers) {
          this.changeStat(player.id, 'cp', event.cp ?? 0);
        }
        break;
      case 'collectCPOfEverybody': {
        const totalCoins = this.livingPlayers.reduce((total, player) => total + player.cp, 0);
        for (const player of this.livingPlayers) {
          player.cp = 0;
        }
        this.changeStat(event.playerId, 'cp', totalCoins);
        break;
      }
      case 'takeCP':
        this.changeStat(this.attack.targetPlayerId, 'cp', -(event.cp ?? 0));
        this.changeStat(this.attack.playerId, 'cp', event.cp ?? 0);
        break;
      case 'sell':
      case 'setBought': {
        if (event.action === 'sell') {
          this.recordOtherAction(event, eventIndex);
        }
        if (event.action === 'sell' || event.bought) {
          const price = definitionFor(event.item.modelId).price;
          const buyer = event.action === 'sell' ? this.attack.targetPlayerId : this.attack.playerId;
          const seller = event.action === 'sell' ? this.attack.playerId : this.attack.targetPlayerId;
          this.changeStat(buyer, 'cp', -price);
          this.changeStat(seller, 'cp', price);
        }
        break;
      }
      case 'canNotBuy':
      case 'discard':
      case 'sacrifice':
        this.recordOtherAction(event, eventIndex);
        break;
    }
  }
}

export function scanExchangeTransition(previous, current, metadata = {}) {
  const trace = new ExchangeTrace(previous, current, metadata);
  for (const [eventIndex, event] of (current.events ?? []).entries()) {
    trace.apply(event, eventIndex);
  }
  const statMismatches = [];
  for (const expectedPlayer of current.players ?? []) {
    const reconstructed = statValues(trace.players.get(expectedPlayer.id));
    const expected = statValues(expectedPlayer);
    if (JSON.stringify(reconstructed) !== JSON.stringify(expected)) {
      statMismatches.push({ playerId: expectedPlayer.id, reconstructed, expected });
    }
  }
  return {
    records: trace.records,
    statMismatches,
    gfMatches: trace.gf === current.gf,
  };
}

async function main(argumentsList) {
  const options = {};
  for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex++) {
    const flag = argumentsList[argumentIndex];
    const value = argumentsList[++argumentIndex];
    if (!['--manifest', '--logs-root', '--output', '--report'].includes(flag) || !value) {
      throw new Error(`Invalid argument ${flag}`);
    }
    options[flag.slice(2)] = value;
  }
  if (!options.manifest || !options['logs-root'] || !options.output) {
    throw new Error('Required: --manifest PATH --logs-root DIRECTORY --output PATH [--report PATH]');
  }
  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'));
  const records = [];
  const diagnostics = [];
  let gamesScanned = 0;
  let unreadableFiles = 0;
  let transitionsScanned = 0;
  for (const entry of manifest.files) {
    let snapshots;
    try {
      snapshots = (await readJsonl(resolve(options['logs-root'], entry.file)))
        .filter((record) => record.type === 'state' && record.game)
        .sort((first, second) => first.updateCount - second.updateCount);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      unreadableFiles++;
      continue;
    }
    gamesScanned++;
    for (let snapshotIndex = 1; snapshotIndex < snapshots.length; snapshotIndex++) {
      const previous = snapshots[snapshotIndex - 1].game;
      const current = snapshots[snapshotIndex].game;
      const result = scanExchangeTransition(previous, current, { file: entry.file, gameId: entry.gameId });
      transitionsScanned++;
      records.push(...result.records);
      if (!result.gfMatches || result.statMismatches.length > 0) {
        diagnostics.push({ file: entry.file, updateCount: current.updateCount, ...result, records: undefined });
      }
    }
  }
  const bots = records.filter((record) => record.kind === 'player_exchange' && record.isBot);
  const calm = bots.filter((record) => record.confusionCount === 0);
  const confused = bots.filter((record) => record.confusionCount > 0);
  const allocationMatches = (record) => JSON.stringify(record.result)
    === JSON.stringify(expectedExchangeAllocation(record.total, record.apocalypse));
  const summary = {
    gamesScanned,
    unreadableFiles,
    transitionsScanned,
    botExchanges: bots.length,
    calm: calm.length,
    calmOrdinary: calm.filter((record) => !record.apocalypse).length,
    calmApocalypse: calm.filter((record) => record.apocalypse).length,
    calmAllocationMismatches: calm.filter((record) => !allocationMatches(record)).length,
    confused: confused.length,
    changedConfusionLabels: bots.filter((record) => (record.confusionCount > 0) !== (record.snapshotConfusionCount > 0)).length,
    exchangeConservationFailures: bots.filter((record) => !record.statsConserved).length,
    transitionsWithStatMismatches: diagnostics.filter((diagnostic) => diagnostic.statMismatches.length > 0).length,
    transitionsWithGfMismatches: diagnostics.filter((diagnostic) => !diagnostic.gfMatches).length,
  };
  await mkdir(dirname(options.output), { recursive: true });
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(options.output, options.output.endsWith('.gz') ? gzipSync(text) : text);
  if (options.report) {
    await writeFile(options.report, JSON.stringify({ summary, confused, diagnostics }, null, 2) + '\n');
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
