#!/usr/bin/env node
/**
 * Launches several Hidden Melee multi-bot games in parallel.
 *
 * Each child process runs one room with its own accounts and its own log
 * directory. The child summary is collected into run.json; per-player logs stay
 * inside each game directory.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadEngine, root} from './engine.mjs';
import {loadCatalog} from './state.mjs';
import {createRng, parseSeed} from './rng.mjs';

function parseArguments(argv) {
  const options = {
    games: 4,
    concurrency: null,
    bots: 4,
    mode: 'teams',
    teams: 2,
    apocalypse: null,
    targetMode: 'auto',
    targetPlayer: null,
    preferCommands: null,
    focus: null,
    defenseFocus: null,
    dreamFocus: false,
    aoe: false,
    fog: false,
    passive: false,
    maxSeconds: 0,
    turnTimeoutMs: 20000,
    stallSeconds: 60,
    pollMs: 300,
    botDocMode: 'summary',
    removal: null,
    danger: false,
    prayer: false,
    guardian: false,
    earthTrade: false,
    discardAll: false,
    broomExperiment: false,
    broomEdge: false,
    soapExperiment: false,
    reuseMiracles: false,
    scenario: null,
    leaveBots: null,
    disconnectBots: null,
    leaveAfterUpdates: 4,
    coverage: 'logs/live/coverage.json',
    gzipGames: false,
    accountPool: null,
    accountOffsetBase: 0,
    output: null,
    seed: null,
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
      case '--bots': options.bots = Number(next()); break;
      case '--mode': options.mode = next(); break;
      case '--teams': options.teams = Number(next()); break;
      case '--apocalypse': {
        const value = next();
        options.apocalypse = value === 'none' || value === 'null' ? null : Number(value);
        break;
      }
      case '--target-mode': options.targetMode = next(); break;
      case '--target-player': options.targetPlayer = Number(next()); break;
      case '--prefer-command': options.preferCommands = next(); break;
      case '--focus': options.focus = next(); break;
      case '--defense-focus': options.defenseFocus = next(); break;
      case '--dream-focus': options.dreamFocus = true; break;
      case '--aoe': options.aoe = true; break;
      case '--fog': options.fog = true; break;
      case '--passive': options.passive = true; break;
      case '--max-seconds': options.maxSeconds = Number(next()); break;
      case '--no-global-limit': options.maxSeconds = 0; break;
      case '--turn-timeout-ms': options.turnTimeoutMs = Number(next()); break;
      case '--stall-seconds': options.stallSeconds = Number(next()); break;
      case '--poll-ms': options.pollMs = Number(next()); break;
      case '--bot-doc-mode': options.botDocMode = next(); break;
      case '--removal': options.removal = next(); break;
      case '--danger': options.danger = true; break;
      case '--prayer': options.prayer = true; break;
      case '--guardian': options.guardian = true; break;
      case '--earth-trade': options.earthTrade = true; break;
      case '--discard-all': options.discardAll = true; break;
      case '--broom-experiment': options.broomExperiment = true; break;
      case '--broom-edge': options.broomEdge = true; break;
      case '--soap-experiment': options.soapExperiment = true; break;
      case '--reuse-miracles': options.reuseMiracles = true; break;
      case '--scenario': options.scenario = next(); break;
      case '--leave-bots': options.leaveBots = next(); break;
      case '--disconnect-bots': options.disconnectBots = next(); break;
      case '--leave-after-updates': options.leaveAfterUpdates = Number(next()); break;
      case '--coverage': options.coverage = next(); break;
      case '--gzip-games': options.gzipGames = true; break;
      case '--account-pool': options.accountPool = next(); break;
      case '--account-offset-base': options.accountOffsetBase = Number(next()); break;
      case '--output': options.output = next(); break;
      case '--seed': options.seed = next(); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`God Field Hidden Melee parallel batch\n\n` +
      `  --games N --concurrency N --bots N --mode solo|teams --teams N\n` +
      `  --apocalypse N --target-mode MODE --target-player ID\n` +
      `  --prefer-command LIST --focus LIST --defense-focus LIST --dream-focus --aoe --fog --passive --removal discard|sacrifice|both --danger --prayer --guardian --earth-trade --discard-all\n` +
      `  --broom-experiment --broom-edge --soap-experiment --reuse-miracles --scenario NAME --max-seconds N|--no-global-limit --turn-timeout-ms N --stall-seconds N\n` +
      `  --leave-bots LIST --disconnect-bots LIST --leave-after-updates N\n` +
      `  --coverage FILE --gzip-games --output DIR --seed VALUE\n` +
      `  --account-pool FILE --account-offset-base N\n`);
    return;
  }
  const engine = await loadEngine();
  const {catalog, itemCount, catalogHash} = await loadCatalog(engine);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const runId = `melee-batch-${stamp}-${process.pid.toString(36)}`;
  const output = path.resolve(options.output ?? path.join('logs/live', runId));
  await fs.mkdir(output, {recursive: true});
  const seed = parseSeed(options.seed ?? runId);
  const rng = createRng(seed);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? Math.min(options.games, 4), options.games));
  const script = path.join(import.meta.dirname, 'play-melee.mjs');
  const jobs = [];
  for (let index = 0; index < options.games; index++) {
    jobs.push({
      index,
      gameId: `${runId}-g${index}`,
      logDir: path.join(output, `game-${index}`),
      seed: `${options.seed ?? runId}-${index}`,
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

  const gzipScript = path.join(import.meta.dirname, 'gzip-logs.mjs');

  const gzipGameLogs = logDir => new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [gzipScript, '--run', logDir, '--min-age-minutes', '0'],
      {cwd: root, stdio: 'ignore'},
    );
    child.on('close', resolve);
  });

  const runJob = job => new Promise(resolve => {
    const args = [
      script,
      '--bots', String(options.bots),
      '--mode', options.mode,
      '--teams', String(options.teams),
      '--apocalypse', options.apocalypse === null ? 'none' : String(options.apocalypse),
      '--target-mode', options.targetMode,
      '--max-seconds', String(options.maxSeconds),
      '--turn-timeout-ms', String(options.turnTimeoutMs),
      '--stall-seconds', String(options.stallSeconds),
      '--leave-after-updates', String(options.leaveAfterUpdates),
      '--poll-ms', String(options.pollMs),
      '--bot-doc-mode', options.botDocMode,
      '--coverage', path.resolve(options.coverage),
      '--log-dir', job.logDir,
      '--seed', job.seed,
      '--account-offset', String(options.accountOffsetBase + job.index * options.bots),
    ];
    if (options.accountPool) args.push('--account-pool', path.resolve(options.accountPool));
    if (options.targetPlayer !== null) args.push('--target-player', String(options.targetPlayer));
    if (options.preferCommands) args.push('--prefer-command', options.preferCommands);
    if (options.focus) args.push('--focus', options.focus);
    if (options.defenseFocus) args.push('--defense-focus', options.defenseFocus);
    if (options.dreamFocus) args.push('--dream-focus');
    if (options.removal) args.push('--removal', options.removal);
    if (options.danger) args.push('--danger');
    if (options.prayer) args.push('--prayer');
    if (options.guardian) args.push('--guardian');
    if (options.earthTrade) args.push('--earth-trade');
    if (options.discardAll) args.push('--discard-all');
    if (options.broomExperiment) args.push('--broom-experiment');
    if (options.broomEdge) args.push('--broom-edge');
    if (options.soapExperiment) args.push('--soap-experiment');
    if (options.reuseMiracles) args.push('--reuse-miracles');
    if (options.scenario) args.push('--scenario', options.scenario);
    if (options.leaveBots) args.push('--leave-bots', options.leaveBots);
    if (options.disconnectBots) args.push('--disconnect-bots', options.disconnectBots);
    if (options.aoe) args.push('--aoe');
    if (options.fog) args.push('--fog');
    if (options.passive) args.push('--passive');
    const child = spawn(process.execPath, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    children.set(job.gameId, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    process.stdout.write(`[start] ${job.gameId} bots=${options.bots} mode=${options.mode} aoe=${options.aoe} fog=${options.fog} passive=${options.passive}\n`);
    child.on('close', async code => {
      children.delete(job.gameId);
      if (stderr.trim() !== '') await fs.writeFile(path.join(job.logDir, 'stderr.log'), stderr);
      let summary = null;
      for (const line of stdout.trim().split('\n')) {
        try { summary = JSON.parse(line); } catch { /* progress output */ }
      }
      const completed = summary ?? {gameId: job.gameId, result: code === 0 ? 'incomplete' : 'failed'};
      completed.exitCode = code;
      summaries.push(completed);
      if (options.gzipGames) {
        await gzipGameLogs(job.logDir);
      }
      process.stdout.write(`[done]  ${job.gameId} result=${completed.result} maxGF=${completed.maxGF ?? '?'} apocalypse=${completed.apocalypseReached ?? '?'}\n`);
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
  while (running.size !== 0) await Promise.race([...running, new Promise(resolve => setTimeout(resolve, 500))]);

  const manifest = {
    schema: 'godfield-live-melee-batch/1',
    runId,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    interrupted,
    options: {...options, output},
    itemCount,
    catalogHash,
    concurrency,
    games: summaries,
  };
  await fs.writeFile(path.join(output, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`\nMelee batch ${runId}: ${summaries.length} games in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
  for (const summary of summaries) {
    process.stdout.write(`  ${summary.gameId} result=${summary.result} maxGF=${summary.maxGF ?? '?'} apocalypse=${summary.apocalypseReached ?? '?'}\n`);
  }
  process.stdout.write(`Logs: ${output}\nCoverage: ${path.resolve(options.coverage)}\n`);
}

await main();
