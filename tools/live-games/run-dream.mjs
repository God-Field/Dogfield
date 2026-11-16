#!/usr/bin/env node
/**
 * Runs repeated dream-focused training games and grows one shared catalog.
 *
 * Every game uses the ordinary training autoplay flow with `--dream`, which
 * chases the Dream curse and uses disguised items. Each child updates the
 * shared dream catalog under a lock, so parallel games cannot overwrite each
 * other's discoveries.
 *
 * Example:
 *   node tools/live-games/run-dream.mjs --rounds 10 --concurrency 4 \
 *     --players 2 --seconds 90 --catalog logs/live/dream/dream-catalog.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadEngine, root} from './engine.mjs';
import {loadCatalog} from './state.mjs';
import {loadDreamCatalog, summarizeDreamCatalog} from './dream.mjs';
import {createRng, parseSeed} from './rng.mjs';

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function parseArguments(argv) {
  const options = {
    rounds: 10,
    concurrency: 4,
    players: 2,
    seconds: 120,
    noGlobalLimit: false,
    staggerMs: 250,
    catalog: path.join(root, 'logs', 'live', 'dream', 'dream-catalog.json'),
    output: null,
    seed: null,
    coverage: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--rounds': options.rounds = Number(next()); break;
      case '--concurrency': options.concurrency = Number(next()); break;
      case '--players': options.players = Number(next()); break;
      case '--seconds': options.seconds = Number(next()); break;
      case '--no-global-limit': options.noGlobalLimit = true; options.seconds = 0; break;
      case '--stagger-ms': options.staggerMs = Number(next()); break;
      case '--catalog': options.catalog = path.resolve(next()); break;
      case '--output': options.output = next(); break;
      case '--seed': options.seed = next(); break;
      case '--coverage': options.coverage = next(); break;
      case '--help':
        process.stdout.write('Usage: node run-dream.mjs [--rounds N] [--concurrency N] [--players N] [--seconds N | --no-global-limit] [--catalog FILE] [--output DIR] [--seed VALUE]\n');
        return null;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function runGame(job, options) {
  return new Promise(resolve => {
    const args = [
      path.join(import.meta.dirname, 'play-game.mjs'),
      '--players', String(options.players),
      '--dream',
      '--passive',
      '--aim-prayer',
      '--dream-catalog', options.catalog,
      '--max-seconds', String(options.seconds),
      '--turn-timeout-ms', '20000',
      '--stall-seconds', '45',
      '--seed', job.seed,
      '--game-id', job.gameId,
      '--log', job.log,
    ];
    if (options.coverage) args.push('--coverage', options.coverage);
    const child = spawn(process.execPath, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    process.stdout.write(`[start] ${job.gameId}\n`);
    child.on('close', code => {
      let summary = null;
      for (const line of stdout.trim().split('\n')) {
        try {
          summary = JSON.parse(line);
        } catch {
          // Child progress output, not a summary line.
        }
      }
      if (stderr.trim() !== '') process.stderr.write(`${job.gameId}: ${stderr.trim()}\n`);
      const result = summary ?? {gameId: job.gameId, result: code === 0 ? 'incomplete' : 'failed'};
      result.exitCode = code;
      process.stdout.write(`[done]  ${job.gameId} result=${result.result} dreamGames=${result.dream?.dreamGames ?? '?'} used=${result.dream?.itemsUsedInDream ?? '?'}\n`);
      resolve(result);
    });
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) return;
  if (!Number.isInteger(options.rounds) || options.rounds < 1) throw new Error('--rounds must be a positive integer');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  if (!Number.isInteger(options.players) || options.players < 2 || options.players > 9) throw new Error('--players must be from 2 to 9');

  const engine = await loadEngine();
  const {catalog} = await loadCatalog(engine);
  const runId = `dream-run-${stamp()}-${process.pid.toString(36)}`;
  const output = path.resolve(options.output ?? path.join(root, 'logs', 'live', 'dream', runId));
  await fs.mkdir(output, {recursive: true});
  await fs.mkdir(path.dirname(options.catalog), {recursive: true});
  const rng = createRng(parseSeed(options.seed ?? runId));
  const games = [];
  let jobIndex = 0;

  for (let round = 1; round <= options.rounds; round++) {
    const jobs = [];
    for (let slot = 0; slot < options.concurrency; slot++) {
      const index = jobIndex++;
      const gameId = `${runId}-g${index}`;
      jobs.push({
        index,
        gameId,
        seed: `${options.seed ?? runId}-${index}-${rng.int(1_000_000)}`,
        log: path.join(output, `${gameId}.jsonl`),
      });
    }
    const results = await Promise.all(jobs.map(async (job, position) => {
      if (options.staggerMs > 0) await new Promise(resolve => setTimeout(resolve, position * options.staggerMs));
      return runGame(job, options);
    }));
    games.push(...results);
    const dreamCatalog = await loadDreamCatalog(options.catalog);
    const summary = summarizeDreamCatalog(dreamCatalog, catalog.models);
    process.stdout.write(`round ${round}/${options.rounds}: ${JSON.stringify(summary)}\n`);
  }

  const dreamCatalog = await loadDreamCatalog(options.catalog);
  const summary = summarizeDreamCatalog(dreamCatalog, catalog.models);
  const manifest = {
    schema: 'godfield-dream-run/1',
    runId,
    startedAt: new Date().toISOString(),
    options,
    catalog: summary,
    games,
  };
  await fs.writeFile(path.join(output, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`\nDream catalog: ${options.catalog}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`Logs: ${output}\n`);
}

await main();
