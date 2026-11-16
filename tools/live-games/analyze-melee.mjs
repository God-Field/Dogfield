#!/usr/bin/env node
/**
 * Summarizes a Hidden Melee run directory.
 *
 * Reads coordinator.jsonl and every bot-*.jsonl, then reports:
 *  - per-player send/receive counts and game-payload hash agreement,
 *  - decisions by actor, targeting agreements/disagreements, Fog effects,
 *  - AOE uses, Apocalypse transition, devil activity, eliminations.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { findMatchingLogFiles, findNamedLog, readJsonl } from './log-files.mjs';

function parseArguments(argv) {
  const options = {run: null, json: null};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--run': options.run = next(); break;
      case '--json': options.json = next(); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

const TRADE_CARD_NAMES = {1: 'discard', 2: 'sacrifice', 3: 'exchange', 4: 'sell', 5: 'buy'};

function bump(map, key) {
  if (key === undefined || key === null || key === '') return;
  map[key] = (map[key] ?? 0) + 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: analyze-melee.mjs --run DIR [--json FILE]\n');
    return;
  }
  if (!options.run) throw new Error('--run DIR is required');
  const directory = path.resolve(options.run);
  const coordinatorFile = await findNamedLog(directory, 'coordinator');
  if (coordinatorFile === null) {
    throw new Error(`No coordinator.jsonl or coordinator.jsonl.gz in ${directory}`);
  }
  const coordinator = await readJsonl(coordinatorFile);
  const meta = coordinator.find(record => record.type === 'meta') ?? {};
  const end = coordinator.find(record => record.type === 'end') ?? null;
  const analysis = {
    run: directory,
    meta,
    end: end === null ? null : {
      result: end.result,
      maxGF: end.maxGF,
      apocalypse: end.apocalypse,
      apocalypseReached: end.apocalypseReached,
      devilEvents: end.devilEvents,
      earthGuardian: end.earthGuardian ?? null,
      winnerIds: end.winnerIds,
      eliminations: end.eliminations,
      durationMs: end.durationMs,
    },
    eventActions: {},
    guardianActions: [],
    earthGuardian: {
      seen: false,
      actions: 0,
      tradeActions: {discard: 0, sacrifice: 0, exchange: 0, sell: 0, buy: 0},
      tradeExamples: [],
    },
    decisions: {},
    decisionsByActor: {},
    eliminations: coordinator.filter(record => record.type === 'elimination'),
    apocalypse: coordinator.filter(record => record.type === 'apocalypse'),
    aoeDecisions: [],
    aoeUses: coordinator.filter(record => record.type === 'event' && record.action === 'useAttackItems' && record.items?.some(item => item.commandType === 'attackEveryEnemy')),
    buys: {offered: 0, bought: 0, declined: 0, sell: 0, canNotBuy: 0},
    targeting: coordinator.filter(record => record.type === 'targeting'),
    targetResolutions: coordinator.filter(record => record.type === 'targetResolution'),
    fogTargeting: coordinator.filter(record => record.type === 'fogTargeting'),
    fogAcquired: coordinator.filter(record => record.type === 'fog'),
    errors: coordinator.filter(record => record.type === 'error' || record.type === 'rejected' || record.type === 'turnTimeout' || record.type === 'stallTimeout'),
    players: [],
  };
  for (const [recordIndex, record] of coordinator.entries()) {
    if (record.type === 'event') {
      bump(analysis.eventActions, record.action);
      if (record.action === 'buy') analysis.buys.offered++;
      if (record.action === 'setBought') record.bought ? analysis.buys.bought++ : analysis.buys.declined++;
      if (record.action === 'sell') analysis.buys.sell++;
      if (record.action === 'canNotBuy') analysis.buys.canNotBuy++;
      if (record.action === 'attackByGuardian' && record.attack?.guardian) {
        const guardianAction = {
          updateCount: record.updateCount,
          guardian: record.attack.guardian,
          playerId: record.attack.playerId ?? null,
          itemModelIds: record.attack.itemModelIds ?? [],
          items: record.attack.items ?? [],
        };
        analysis.guardianActions.push(guardianAction);
        if (guardianAction.guardian === 'earth') {
          analysis.earthGuardian.seen = true;
          analysis.earthGuardian.actions++;
          const tradeNames = guardianAction.itemModelIds
            .map(modelId => TRADE_CARD_NAMES[modelId])
            .filter(Boolean);
          for (const tradeName of tradeNames) {
            analysis.earthGuardian.tradeActions[tradeName]++;
          }
          if (tradeNames.length !== 0 && analysis.earthGuardian.tradeExamples.length < 30) {
            const followUp = coordinator
              .slice(recordIndex + 1)
              .filter(candidateRecord => candidateRecord.type === 'event')
              .slice(0, 8)
              .map(candidateRecord => candidateRecord.action);
            analysis.earthGuardian.tradeExamples.push({
              ...guardianAction,
              tradeNames,
              followUp,
            });
          }
        }
      }
    } else if (record.type === 'decision') {
      bump(analysis.decisions, `${record.phase}:${record.kind}`);
      const actor = `bot${record.actor?.botIndex} player${record.actor?.playerId} team${record.actor?.team}`;
      bump(analysis.decisionsByActor, actor);
      if (record.summary?.aoe) analysis.aoeDecisions.push({updateCount: record.updateCount, actor: record.actor, selected: record.selected, command: record.command, summary: record.summary});
    }
  }
  analysis.targetMismatches = analysis.targetResolutions.filter(record => record.requestedTargetPlayerId !== null && record.actualTargetPlayerId !== record.requestedTargetPlayerId);
  analysis.foggedResolutions = analysis.targetResolutions.filter(record => record.fogged === true);

  const botFiles = await findMatchingLogFiles(directory, /^bot-\d+\.jsonl(?:\.gz)?$/);
  botFiles.sort((left, right) => left.localeCompare(right, undefined, {numeric: true}));
  const hashesByUpdate = new Map();
  for (const file of botFiles) {
    const records = await readJsonl(file);
    const counts = {files: 1, requests: 0, requestActions: {}, channels: 0, receives: 0, decisions: 0, errors: 0};
    const identity = records.find(record => record.type === 'identity') ?? {};
    const metaRecord = records.find(record => record.type === 'meta') ?? {};
    for (const record of records) {
      if (record.type === 'request') {
        counts.requests++;
        bump(counts.requestActions, record.action);
      }
      if (record.type === 'decision') counts.decisions++;
      if (record.type === 'channel' || record.type === 'channelSummary') {
        counts.channels++;
        const update = record.document?.game?.updateCount ?? record.updateCount ?? null;
        const hash = record.gameHash ?? null;
        if (update !== null && hash !== null) {
          if (!hashesByUpdate.has(update)) hashesByUpdate.set(update, {hashes: new Set(), samples: 0});
          const entry = hashesByUpdate.get(update);
          entry.hashes.add(hash);
          entry.samples++;
        }
      }
      if (record.type === 'receive') counts.receives++;
      if (record.type === 'error' || record.type === 'rejected') counts.errors++;
    }
    analysis.players.push({
      file: path.relative(directory, file),
      botIndex: metaRecord.botIndex ?? null,
      team: metaRecord.team ?? null,
      userId: identity.userId ?? metaRecord.userId ?? null,
      ...counts,
    });
  }
  let compared = 0;
  const mismatched = [];
  for (const [update, entry] of hashesByUpdate) {
    if (entry.samples < 2) continue;
    compared++;
    if (entry.hashes.size !== 1) mismatched.push({update, hashes: [...entry.hashes]});
  }
  analysis.gamePayload = {updatesCompared: compared, mismatched};
  analysis.hasMismatchedTargets = analysis.targetMismatches.length !== 0;

  const print = (label, value) => process.stdout.write(`${label}: ${JSON.stringify(value)}\n`);
  print('Run', analysis.run);
  print('Room', meta.roomId);
  print('Password', meta.password);
  print('Players/mode/teams', {players: meta.playerCount, mode: meta.mode, teams: meta.teams, apocalypse: meta.apocalypse});
  print('Result', analysis.end);
  print('Event actions', analysis.eventActions);
  print('Decisions', analysis.decisions);
  print('Decisions by actor', analysis.decisionsByActor);
  print('Eliminations', analysis.eliminations.map(elimination => ({update: elimination.updateCount, player: elimination.playerName, team: elimination.team, remaining: elimination.remainingPlayers})));
  print('AOE decision count', analysis.aoeDecisions.length);
  for (const decision of analysis.aoeDecisions) print('  AOE', {update: decision.updateCount, actor: decision.actor, selected: decision.selected?.map(item => item.name), command: decision.command, summary: decision.summary});
  print('AOE uses', analysis.aoeUses.map(event => ({update: event.updateCount, items: event.items?.map(item => item.name)})));
  print('Apocalypse', analysis.apocalypse.map(record => ({update: record.updateCount, gf: record.gf, tiebreakGF: record.tiebreakGF})));
  print('Buy/sell', analysis.buys);
  print('Guardian actions', {total: analysis.guardianActions.length, byGuardian: analysis.guardianActions.reduce((counts, action) => {
    counts[action.guardian] = (counts[action.guardian] ?? 0) + 1;
    return counts;
  }, {})});
  print('Earth guardian', analysis.earthGuardian);
  print('Targeting records', analysis.targeting.length);
  print('Target resolutions', analysis.targetResolutions.length, 'mismatches', analysis.targetMismatches.length);
  for (const mismatch of analysis.targetMismatches.slice(0, 20)) {
    print('  mismatch', {update: mismatch.updateCount, requested: mismatch.requestedTargetPlayerId, actual: mismatch.actualTargetPlayerId, fogged: mismatch.fogged, actor: mismatch.actor});
  }
  print('Fog acquired', analysis.fogAcquired.map(record => ({update: record.updateCount, player: record.playerName, team: record.team})));
  print('Fogged resolutions', analysis.foggedResolutions.length);
  print('Game payload hash agreement', {updatesCompared: compared, mismatched: mismatched.length});
  print('Players', analysis.players.map(player => ({bot: player.botIndex, team: player.team, userId: player.userId, requests: player.requests, channels: player.channels, receives: player.receives, decisions: player.decisions, errors: player.errors})));
  print('Issues', analysis.errors.length);

  if (options.json) {
    await fs.writeFile(options.json, `${JSON.stringify(analysis, null, 2)}\n`);
    process.stdout.write(`Wrote ${options.json}\n`);
  }
}

await main();
