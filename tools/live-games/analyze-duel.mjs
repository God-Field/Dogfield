#!/usr/bin/env node
/**
 * Summarizes one or more Royal Duel (mode=duel) logs.
 *
 *   node tools/live-games/analyze-duel.mjs --log logs/live/duel/duel-1.jsonl
 *   node tools/live-games/analyze-duel.mjs --run logs/live/duel
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { findLogFiles, readJsonl } from './log-files.mjs';

process.stdout.on('error', error => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

function parseArguments(argv) {
  const options = {logs: [], run: null, json: null, trace: false};
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
      case '--trace': options.trace = true; break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function filesFor(options) {
  const logs = [...options.logs];
  if (options.run !== null) {
    logs.push(...await findLogFiles(options.run, { recursive: false }));
  }
  return logs.sort();
}

function bump(map, key, amount = 1) {
  if (key === null || key === undefined || key === '') return;
  map[String(key)] = (map[String(key)] ?? 0) + amount;
}

function sortedEntries(map) {
  return Object.entries(map).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function summarize(file, records) {
  const meta = records.find(record => record.type === 'meta') ?? null;
  const matched = records.find(record => record.type === 'matched') ?? null;
  const end = records.find(record => record.type === 'end') ?? null;
  const recordBefore = records.filter(record => record.type === 'duelRecord' && record.phase === 'before').pop() ?? null;
  const recordAfter = records.filter(record => record.type === 'duelRecord' && record.phase === 'after').pop() ?? null;
  const events = records.filter(record => record.type === 'event');
  const decisions = records.filter(record => record.type === 'decision');
  const rejections = records.filter(record => record.type === 'rejected');
  const problems = records.filter(record => ['turnTimeout', 'stallTimeout', 'error', 'roomMissing', 'leaveFailed'].includes(record.type));
  const leaves = records.filter(record => record.type === 'leave');
  const rejoins = records.filter(record => record.type === 'rejoin');
  const matchmaking = records.filter(record => record.type === 'matchmaking');
  const eventActions = {};
  const eventPlayers = {};
  const decisionKinds = {};
  const trace = new Map();
  for (const event of events) {
    bump(eventActions, event.action);
    bump(eventPlayers, event.playerId);
    const updateCount = event.updateCount ?? 0;
    if (!trace.has(updateCount)) trace.set(updateCount, []);
    trace.get(updateCount).push(event.action);
  }
  for (const decision of decisions) bump(decisionKinds, `${decision.phase}:${decision.kind}`);
  const initialPlayers = matched?.game?.players ?? [];
  const finalPlayers = end?.game?.players ?? initialPlayers;
  const initialById = new Map(initialPlayers.map(player => [player.id, player]));
  const firstMatch = matchmaking[0] ?? null;
  const lastMatch = matchmaking[matchmaking.length - 1] ?? null;
  return {
    file,
    gameId: meta?.gameId ?? null,
    roomId: meta?.roomId ?? matched?.roomId ?? end?.roomId ?? null,
    userId: meta?.userId ?? null,
    result: end?.result ?? 'incomplete',
    updateCount: end?.game?.updateCount ?? matched?.game?.updateCount ?? null,
    durationMs: end?.durationMs ?? null,
    matchWaitMs: matched && firstMatch ? Math.max(0, Date.parse(matched.ts) - Date.parse(firstMatch.ts)) : null,
    matchmakingRecords: matchmaking.length,
    lastMatchmakingNote: lastMatch?.note ?? null,
    players: finalPlayers.map(player => ({
      id: player.id,
      userId: player.userId,
      name: player.name,
      alias: player.alias,
      isBot: player.isBot,
      hp: player.hp,
      dead: player.dead,
      initialRating: initialById.get(player.id)?.rating ?? null,
      rating: player.rating,
      ratingGain: player.ratingGain,
    })),
    eventCount: events.length,
    eventActions: sortedEntries(eventActions),
    trace: [...trace.entries()].sort((left, right) => left[0] - right[0]).map(([updateCount, actions]) => ({updateCount, actions})),
    eventsByPlayer: sortedEntries(eventPlayers),
    decisionCount: decisions.length,
    decisionKinds: sortedEntries(decisionKinds),
    rejections: rejections.map(record => ({
      updateCount: record.updateCount,
      phase: record.phase,
      kind: record.kind,
      status: record.status,
      body: record.body,
    })),
    problems: problems.map(record => ({
      type: record.type,
      updateCount: record.updateCount ?? null,
      waitingFor: record.waitingFor ?? null,
      message: record.message ?? null,
      status: record.status ?? null,
    })),
    recordBefore: recordBefore?.record ?? null,
    recordAfter: recordAfter?.record ?? null,
    winnerIds: end?.winnerIds ?? [],
    leaves: leaves.map(record => ({
      updateCount: record.updateCount,
      attackTurnPlayerId: record.attackTurnPlayerId,
      users: record.room?.users?.map(user => user.name) ?? [],
      isBot: record.room?.game?.players?.map(player => ({name: player.name, isBot: player.isBot})) ?? [],
    })),
    rejoins: rejoins.map(record => ({
      updateCount: record.updateCount,
      attempts: record.attempts,
      rejoined: record.rejoined,
      users: record.room?.users?.map(user => user.name) ?? [],
      isBot: record.room?.game?.players?.map(player => ({name: player.name, isBot: player.isBot})) ?? [],
    })),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`God Field Royal Duel log analyzer\n\n` +
      `  --log FILE   one JSONL duel log (repeatable)\n` +
      `  --run DIR    analyze every .jsonl in a directory\n` +
      `  --json FILE  write the summaries as JSON\n` +
      `  --trace      print one line of event actions per update\n`);
    return;
  }
  const files = await filesFor(options);
  if (files.length === 0) throw new Error('No logs; use --log or --run');
  const summaries = [];
  for (const file of files) {
    const records = await readJsonl(file);
    summaries.push(summarize(file, records));
  }
  if (options.json !== null) await fs.writeFile(options.json, `${JSON.stringify(summaries, null, 2)}\n`);
  for (const summary of summaries) {
    process.stdout.write(`\n${summary.file}\n`);
    process.stdout.write(`  result: ${summary.result}  updates: ${summary.updateCount}  duration: ${summary.durationMs ?? '?'}ms\n`);
    process.stdout.write(`  room: ${summary.roomId}  match wait: ${summary.matchWaitMs ?? '?'}ms  matchmaking records: ${summary.matchmakingRecords}\n`);
    for (const player of summary.players) {
      process.stdout.write(`  player ${player.id}: ${player.name} (${player.alias ?? '-'})  ` +
        `hp=${player.hp}${player.dead ? ' dead' : ''}  ` +
        `rating(pre)=${player.rating ?? '-'}  gain=${player.ratingGain ?? '-'}\n`);
    }
    process.stdout.write(`  events: ${summary.eventCount}  decisions: ${summary.decisionCount}  rejections: ${summary.rejections.length}\n`);
    process.stdout.write(`  event actions:\n`);
    for (const [action, count] of summary.eventActions) process.stdout.write(`    ${action}: ${count}\n`);
    if (options.trace) {
      process.stdout.write(`  event trace by update:\n`);
      for (const entry of summary.trace) process.stdout.write(`    u${entry.updateCount}: ${entry.actions.join(', ')}\n`);
    }
    if (summary.recordBefore || summary.recordAfter) {
      process.stdout.write(`  duel record before: ${JSON.stringify(summary.recordBefore)}\n`);
      process.stdout.write(`  duel record after:  ${JSON.stringify(summary.recordAfter)}\n`);
    }
    if (summary.leaves.length !== 0 || summary.rejoins.length !== 0) {
      process.stdout.write(`  leave/rejoin:\n`);
      for (const leave of summary.leaves) process.stdout.write(`    leave u${leave.updateCount}: users=${leave.users.join(',')} isBot=${JSON.stringify(leave.isBot)}\n`);
      for (const rejoin of summary.rejoins) process.stdout.write(`    rejoin u${rejoin.updateCount}: ${JSON.stringify(rejoin.attempts)} rejoined=${rejoin.rejoined} users=${rejoin.users.join(',')}\n`);
    }
    if (summary.problems.length !== 0) {
      process.stdout.write(`  problems:\n`);
      for (const problem of summary.problems) process.stdout.write(`    ${JSON.stringify(problem)}\n`);
    }
  }
}

await main();
