#!/usr/bin/env node
/**
 * Launches several real training games in parallel, each with its own JSONL
 * log file, then merges their scenarios into the shared coverage file.
 *
 * Example:
 *   node tools/live-games/run-parallel.mjs --games 6 --players-list 2,3,4,5 \
 *     --seconds 180 --concurrency 6
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadEngine, root} from './engine.mjs';
import {loadCatalog} from './state.mjs';
import {createRng, parseSeed} from './rng.mjs';
import {
  loadCoverage,
  writeCoverage,
  emptyCoverage,
  mergeCoverage,
  summarizeCoverage,
  collectEvent,
  collectDecision,
  collectStatChange,
} from './coverage.mjs';

function parseArguments(argv) {
  const options = {
    games: 4,
    concurrency: null,
    players: 2,
    playersList: null,
    seconds: 180,
    noGlobalLimit: false,
    turnTimeoutMs: 20000,
    stallSeconds: 45,
    pollMs: 250,
    coverage: 'logs/live/coverage.json',
    output: null,
    seed: null,
    aimPrayerFraction: 0.25,
    passive: false,
    accountPool: null,
    accountOffset: 0,
    preferCommands: null,
    selfTargetChance: 0.15,
    declineBuyChance: 0.25,
    respondIncomingBuy: false,
    incomingBuyMode: 'forgive',
    gfChoices: 'none,1,50,75,100,150',
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--games': options.games = Number(next()); break;
      case '--concurrency': options.concurrency = Number(next()); break;
      case '--players': options.players = Number(next()); break;
      case '--players-list': options.playersList = next().split(',').filter(Boolean).map(Number); break;
      case '--seconds': options.seconds = Number(next()); break;
      case '--no-global-limit': options.noGlobalLimit = true; options.seconds = 0; break;
      case '--turn-timeout-ms': options.turnTimeoutMs = Number(next()); break;
      case '--stall-seconds': options.stallSeconds = Number(next()); break;
      case '--poll-ms': options.pollMs = Number(next()); break;
      case '--coverage': options.coverage = next(); break;
      case '--output': options.output = next(); break;
      case '--seed': options.seed = next(); break;
      case '--aim-prayer-fraction': options.aimPrayerFraction = Number(next()); break;
      case '--passive': options.passive = true; break;
      case '--account-pool': options.accountPool = next(); break;
      case '--account-offset': options.accountOffset = Number(next()); break;
      case '--prefer-commands': options.preferCommands = next(); break;
      case '--self-target-chance': options.selfTargetChance = Number(next()); break;
      case '--decline-buy-chance': options.declineBuyChance = Number(next()); break;
      case '--respond-incoming-buy': options.respondIncomingBuy = true; break;
      case '--incoming-buy-mode': options.incomingBuyMode = next(); break;
      case '--gf-choices': options.gfChoices = next(); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function readJsonl(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A killed process can leave a partial final line; ignore it.
    }
  }
  return records;
}

async function aggregateLogs(logFiles, catalog, coverage) {
  const gameSummaries = [];
  for (const file of logFiles) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const records = readJsonl(text);
    const meta = records.find(record => record.type === 'meta') ?? null;
    const end = records.find(record => record.type === 'end') ?? null;
    const decisions = records.filter(record => record.type === 'decision').length;
    const events = records.filter(record => record.type === 'event').length;
    for (const record of records) {
      if (record.type === 'event') collectEvent(coverage, record, catalog);
      else if (record.type === 'decision') collectDecision(coverage, record, catalog);
      else if (record.type === 'stat') collectStatChange(coverage, record, catalog);
    }
    if (meta) {
      coverage.playerCounts[String(meta.playerCount)] = (coverage.playerCounts[String(meta.playerCount)] ?? 0) + 1;
    }
    if (end) {
      coverage.games += 1;
      if (end.result === 'over' && end.game && end.userId) {
        const self = end.game.players.find(player => player.userId === end.userId);
        if (self && self.dead !== true && self.hp > 0) coverage.wins += 1;
      }
    }
    gameSummaries.push({
      gameId: meta?.gameId ?? path.basename(file, '.jsonl'),
      log: file,
      players: meta?.playerCount ?? null,
      seed: meta?.seed ?? null,
      roomId: meta?.roomId ?? null,
      result: end?.result ?? 'incomplete',
      durationMs: end?.durationMs ?? null,
      decisions,
      events,
      updates: end?.game?.updateCount ?? null,
    });
  }
  return gameSummaries;
}

function scenarioDiff(before, after) {
  const categories = ['eventActions', 'itemModels', 'commandTypes', 'categories', 'curses', 'guardians', 'decisionKinds'];
  const output = {};
  for (const category of categories) {
    const previous = new Set(Object.keys(before[category] ?? {}));
    output[category] = Object.keys(after[category] ?? {}).filter(key => !previous.has(key));
  }
  return output;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`God Field parallel live-game runner\n\n` +
      `  --games N              number of games (default 4)\n` +
      `  --concurrency N        simultaneous games (default min(games, 6))\n` +
      `  --players N            single player count (default 2)\n` +
      `  --players-list A,B,C   cycle player counts across games\n` +
      `  --seconds N            per-game global limit; 0 disables it (default 180)\n` +
      `  --no-global-limit      let each game run to game over\n` +
      `  --turn-timeout-ms N    abort a turn that gets no state response (default 20000)\n` +
      `  --stall-seconds N      abort after no channel updates while waiting (default 45)\n` +
      `  --poll-ms N            Firestore poll interval (default 250)\n` +
      `  --coverage FILE        shared coverage JSON (default logs/live/coverage.json)\n` +
      `  --output DIR           run log directory\n` +
      `  --seed VALUE           seed prefix\n` +
      `  --aim-prayer-fraction  fraction of games that discard weapons to reach prayer (default 0.25)\n` +
      `  --passive              keep our seat on non-attacking coverage actions\n` +
      `  --account-pool FILE    reuse anonymous accounts across runs\n` +
      `  --account-offset N     first pool index for this run\n` +
      `  --prefer-commands LIST comma-separated command types all games prefer (buy,sell,...)\n` +
      `  --self-target-chance P chance to target yourself with an economic command (default 0.15)\n` +
      `  --decline-buy-chance P chance to decline our own Buy offer (default 0.25)\n` +
      `  --respond-incoming-buy  experimentally answer a bot Buy targeting us\n` +
      `  --gf-choices LIST      training tiebreak choices (default none,1,50,75,100,150)\n`);
    return;
  }

  const engine = await loadEngine();
  const {catalog, itemCount, catalogHash} = await loadCatalog(engine);
  const runId = `run-${stamp()}-${process.pid.toString(36)}`;
  const output = path.resolve(options.output ?? path.join('logs/live', runId));
  await fs.mkdir(output, {recursive: true});
  const coverageFile = path.resolve(options.coverage);
  const before = await loadCoverage(coverageFile);
  const players = options.playersList && options.playersList.length !== 0
    ? options.playersList
    : Array(options.games).fill(options.players);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? Math.min(options.games, 6), options.games));
  const gfChoices = options.gfChoices.split(',').map(value => value === 'none' || value === 'null' ? null : Number(value));
  const rng = createRng(parseSeed(options.seed ?? runId));
  const script = path.join(import.meta.dirname, 'play-game.mjs');

  const jobs = [];
  for (let index = 0; index < options.games; index++) {
    const gameId = `${runId}-g${index}`;
    const playerCount = players[index % players.length];
    const aimPrayer = options.aimPrayerFraction > 0 && (index % Math.max(2, Math.round(1 / options.aimPrayerFraction)) === 0);
    const gf = gfChoices[rng.int(gfChoices.length)];
    jobs.push({
      index,
      gameId,
      playerCount,
      gf,
      aimPrayer,
      log: path.join(output, `${gameId}.jsonl`),
      seed: `${options.seed ?? runId}-${index}`,
      shard: `${index % concurrency}/${concurrency}`,
    });
  }

  const startedAt = Date.now();
  const children = new Map();
  const summaries = [];
  let interrupted = false;

  const stopAll = () => {
    interrupted = true;
    for (const child of children.values()) child.kill('SIGTERM');
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  const runJob = job => new Promise(resolve => {
    const args = [
      script,
      '--players', String(job.playerCount),
      '--gf', job.gf === null ? 'none' : String(job.gf),
      '--seed', job.seed,
      '--log', job.log,
      '--coverage', coverageFile,
      '--shard', job.shard,
      '--max-seconds', String(options.seconds),
      '--turn-timeout-ms', String(options.turnTimeoutMs),
      '--stall-seconds', String(options.stallSeconds),
      '--poll-ms', String(options.pollMs),
      '--game-id', job.gameId,
      '--self-target-chance', String(options.selfTargetChance),
      '--decline-buy-chance', String(options.declineBuyChance),
      '--incoming-buy-mode', options.incomingBuyMode,
    ];
    if (options.preferCommands) args.push('--prefer-command', options.preferCommands);
    if (options.respondIncomingBuy) args.push('--respond-incoming-buy');
    if (job.aimPrayer) args.push('--aim-prayer');
    if (options.passive) args.push('--passive');
    if (options.accountPool) {
      args.push('--account-pool', options.accountPool);
      args.push('--account-offset', String(options.accountOffset + job.index));
    }
    const child = spawn(process.execPath, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    children.set(job.gameId, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    process.stdout.write(`[start] ${job.gameId} players=${job.playerCount} gf=${job.gf ?? 'none'} seed=${job.seed}\n`);
    child.on('close', async code => {
      children.delete(job.gameId);
      if (stderr.trim() !== '') await fs.writeFile(path.join(output, `${job.gameId}.stderr.log`), stderr);
      let summary = null;
      for (const line of stdout.trim().split('\n')) {
        try {
          summary = JSON.parse(line);
        } catch {
          // Child progress output, not a summary.
        }
      }
      const completed = summary ?? {gameId: job.gameId, result: code === 0 ? 'incomplete' : 'failed'};
      completed.exitCode = code;
      summaries.push(completed);
      process.stdout.write(`[done]  ${job.gameId} result=${completed.result} events=${completed.events ?? '?'} items=${completed.items ?? '?'}\n`);
      resolve();
    });
  });

  const queue = jobs.slice();
  const running = new Set();
  const launch = () => {
    while (!interrupted && running.size < concurrency && queue.length !== 0) {
      const job = queue.shift();
      const promise = runJob(job).finally(() => {
        running.delete(promise);
        launch();
      });
      running.add(promise);
    }
  };
  launch();
  while (running.size !== 0) await Promise.race([...running, sleep(500)]);

  const durationMs = Date.now() - startedAt;
  const coverage = emptyCoverage();
  mergeCoverage(coverage, before);
  const logFiles = jobs.map(job => job.log);
  const gameSummaries = await aggregateLogs(logFiles, catalog, coverage);
  const afterSummary = summarizeCoverage(coverage);
  const newScenarios = scenarioDiff(before, coverage);
  await writeCoverage(coverageFile, coverage);

  const manifest = {
    schema: 'godfield-live-run/1',
    runId,
    startedAt: new Date(startedAt - durationMs).toISOString(),
    durationMs,
    interrupted,
    options: {...options, output, coverage: coverageFile},
    itemCount,
    catalogHash,
    concurrency,
    games: gameSummaries,
    coverage: {before: summarizeCoverage(before), after: afterSummary},
    newScenarios,
  };
  await fs.writeFile(path.join(output, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`\nRun ${runId} (${gameSummaries.length} games, ${(durationMs / 1000).toFixed(1)}s)\n`);
  for (const game of gameSummaries) {
    process.stdout.write(`  ${game.gameId} players=${game.players ?? '?'} result=${game.result} decisions=${game.decisions} events=${game.events}\n`);
  }
  process.stdout.write(`Coverage: ${JSON.stringify(afterSummary)}\n`);
  const changed = Object.entries(newScenarios).filter(([, values]) => values.length !== 0);
  if (changed.length === 0) process.stdout.write('New scenarios: none\n');
  else {
    process.stdout.write('New scenarios:\n');
    for (const [category, values] of changed) process.stdout.write(`  ${category}: ${values.join(', ')}\n`);
  }
  process.stdout.write(`Logs: ${output}\nCoverage: ${coverageFile}\n`);
}

await main();
