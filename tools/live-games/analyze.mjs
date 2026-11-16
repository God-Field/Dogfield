#!/usr/bin/env node
/**
 * Reads one or more JSONL game logs and prints a compact analysis.
 *
 * The same parser is used by the parallel runner, so this doubles as a
 * reference for consuming the log format in other tools.
 *
 *   node tools/live-games/analyze.mjs --run logs/live/run-...
 *   node tools/live-games/analyze.mjs --log game.jsonl --json summary.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {findLogFiles, readJsonl} from './log-files.mjs';
import {loadEngine} from './engine.mjs';
import {loadCatalog} from './state.mjs';
import {
  emptyCoverage,
  mergeCoverage,
  loadCoverage,
  collectEvent,
  collectDecision,
  collectStatChange,
  summarizeCoverage,
} from './coverage.mjs';

function parseArguments(argv) {
  const options = {logs: [], run: null, json: null, coverage: null};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--log': options.logs.push(next()); break;
      case '--run': options.run = next(); break;
      case '--json': options.json = next(); break;
      case '--coverage': options.coverage = next(); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function bump(map, key, amount = 1) {
  if (key === null || key === undefined || key === '') return;
  map[String(key)] = (map[String(key)] ?? 0) + amount;
}

function emptyAnalysis() {
  return {
    files: [],
    records: 0,
    types: {},
    requestActions: {},
    requestFailures: [],
    errors: [],
    decisions: {},
    events: {},
    curses: {},
    guardians: {},
    effects: {},
    buys: {offered: 0, bought: 0, declined: 0, sell: 0, canNotBuy: 0},
    eliminations: [],
    games: [],
  };
}

function analyzeRecords(records, analysis, catalog) {
  const meta = records.find(record => record.type === 'meta') ?? null;
  const end = records.find(record => record.type === 'end') ?? null;
  const decisions = records.filter(record => record.type === 'decision');
  const events = records.filter(record => record.type === 'event');
  const eliminationRecords = records.filter(record => record.type === 'elimination');
  const failures = records.filter(record => record.type === 'rejected' || record.type === 'leaveFailed');
  const errors = records.filter(record => record.type === 'error');
  const requestActions = {};
  for (const record of records) {
    bump(analysis.types, record.type);
    if (record.type === 'request') {
      bump(requestActions, `${record.action}:${record.status}`);
      if (record.ok !== true) analysis.requestFailures.push({action: record.action, status: record.status, url: record.url, error: record.error ?? record.response});
    }
  }
  for (const [key, count] of Object.entries(requestActions)) {
    analysis.requestActions[key] = (analysis.requestActions[key] ?? 0) + count;
  }
  for (const record of records) {
    if (record.type === 'event') {
      bump(analysis.events, record.action);
      if (record.action === 'buy') analysis.buys.offered++;
      if (record.action === 'setBought') record.bought ? analysis.buys.bought++ : analysis.buys.declined++;
      if (record.action === 'sell') analysis.buys.sell++;
      if (record.action === 'canNotBuy') analysis.buys.canNotBuy++;
      for (const curse of record.curses ?? []) bump(analysis.curses, curse);
      if (record.curse) bump(analysis.curses, record.curse);
      for (const guardian of record.guardians ?? []) bump(analysis.guardians, guardian);
      if (record.guardian) bump(analysis.guardians, record.guardian);
      for (const item of record.items ?? []) bump(analysis.effects, item?.category ?? null);
      if (record.item?.category) bump(analysis.effects, record.item.category);
      collectEvent(analysis.coverage, record, catalog);
    } else if (record.type === 'decision') {
      bump(analysis.decisions, `${record.phase}:${record.kind}`);
      collectDecision(analysis.coverage, record, catalog);
    } else if (record.type === 'stat') {
      for (const curse of record.cursesAdded ?? []) bump(analysis.curses, curse);
      if (record.guardian?.to) bump(analysis.guardians, record.guardian.to);
      collectStatChange(analysis.coverage, record, catalog);
    }
  }
  analysis.errors.push(...errors.map(error => ({stage: error.stage, message: error.message})));
  for (const elimination of eliminationRecords) analysis.eliminations.push({...elimination, gameId: meta?.gameId ?? null, players: meta?.playerCount ?? null});
  analysis.requestFailures.push(...failures.map(failure => ({type: failure.type, status: failure.status, message: failure.message ?? failure.body})));
  analysis.games.push({
    gameId: meta?.gameId ?? null,
    roomId: meta?.roomId ?? null,
    players: meta?.playerCount ?? null,
    seed: meta?.seed ?? null,
    result: end?.result ?? 'incomplete',
    durationMs: end?.durationMs ?? null,
    updates: end?.game?.updateCount ?? null,
    decisions: decisions.length,
    events: events.length,
    eliminations: eliminationRecords.length,
    winnerIds: end?.winnerIds ?? [],
    requests: Object.entries(requestActions).reduce((sum, [, count]) => sum + count, 0),
  });
  analysis.records += records.length;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`God Field live-log analyzer\n\n` +
      `  --log FILE      one log file (repeatable)\n` +
      `  --run DIR       a run directory containing *.jsonl game logs\n` +
      `  --json FILE     also write the analysis as JSON\n` +
      `  --coverage FILE compare unseen item models against a global coverage file\n`);
    return;
  }
  const engine = await loadEngine();
  const {catalog} = await loadCatalog(engine);
  const files = [];
  if (options.run) {
    files.push(...await findLogFiles(options.run, { recursive: false }));
  }
  files.push(...options.logs);
  if (files.length === 0) throw new Error('Provide --log FILE or --run DIR');

  const analysis = emptyAnalysis();
  analysis.coverage = emptyCoverage();
  for (const file of files) {
    const records = await readJsonl(file);
    analysis.files.push(file);
    analyzeRecords(records, analysis, catalog);
  }
  analysis.coverage.games = analysis.games.length;
  analysis.coverageSummary = summarizeCoverage(analysis.coverage);
  const globalCoverage = options.coverage ? await loadCoverage(options.coverage) : null;
  const unseenBasis = globalCoverage ?? analysis.coverage;
  const unseenLabel = globalCoverage ? 'global coverage' : 'these logs';
  const seenModels = new Set(Object.keys(unseenBasis.itemModels).map(Number));
  analysis.unseenItemModels = catalog.models
    .filter(model => !seenModels.has(model.id))
    .map(model => ({modelId: model.id, name: model.name, category: model.category?.key ?? null}));

  process.stdout.write(`Files: ${files.length}\n`);
  process.stdout.write(`Records: ${analysis.records}\n`);
  process.stdout.write(`Games: ${JSON.stringify(analysis.games)}\n`);
  process.stdout.write(`Event actions: ${JSON.stringify(analysis.events)}\n`);
  process.stdout.write(`Decisions: ${JSON.stringify(analysis.decisions)}\n`);
  process.stdout.write(`Curses: ${JSON.stringify(analysis.curses)}\n`);
  process.stdout.write(`Guardians: ${JSON.stringify(analysis.guardians)}\n`);
  process.stdout.write(`Effects/categories: ${JSON.stringify(analysis.effects)}\n`);
  process.stdout.write(`Buy/sell: ${JSON.stringify(analysis.buys)}\n`);
  process.stdout.write(`Eliminations: ${analysis.eliminations.length}\n`);
  for (const elimination of analysis.eliminations) {
    process.stdout.write(`  ${elimination.gameId ?? '?'} w${elimination.updateCount} ${elimination.playerName} (#${elimination.playerId}) left ${elimination.remainingPlayers} players\n`);
  }
  process.stdout.write(`Errors: ${analysis.errors.length}  Request failures: ${analysis.requestFailures.length}\n`);
  process.stdout.write(`Coverage: ${JSON.stringify(analysis.coverageSummary)}\n`);
  process.stdout.write(`Unseen item models (${unseenLabel}): ${analysis.unseenItemModels.length}\n`);
  if (analysis.unseenItemModels.length !== 0) {
    process.stdout.write(`  ${analysis.unseenItemModels.map(model => `${model.modelId}:${model.name}`).join(', ')}\n`);
  }

  if (options.json) {
    await fs.writeFile(options.json, `${JSON.stringify(analysis, null, 2)}\n`);
    process.stdout.write(`Wrote ${options.json}\n`);
  }
}

await main();
