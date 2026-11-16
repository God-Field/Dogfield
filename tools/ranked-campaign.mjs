#!/usr/bin/env node
/**
 * Runs a local Royal Duel campaign with freshly created accounts.
 *
 * Each account plays `--games` matchmade duel games. Matches are arranged in
 * rounds so every account is active in every round, and every move is chosen by
 * the authoritative server's own bot policy (`Battle.botCommand`). The runner
 * talks to the local HTTP server, so rejected commands are logged with the
 * server's HTTP status code.
 *
 * Usage:
 *   node --import tsx tools/ranked-campaign.mjs
 *   node --import tsx tools/ranked-campaign.mjs --accounts 30 --games 30
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server/http/server.ts';
import { Store } from '../server/store.ts';
import { Battle } from '../server/battle/battle.ts';
import { Random } from '../server/random.ts';
import { JsonlLogger } from './live-games/log.mjs';

const DEFAULT_ACCOUNT_COUNT = 30;
const DEFAULT_GAMES_PER_ACCOUNT = 30;
const DEFAULT_POLL_MS = 15;
const MAX_REJECTIONS_PER_UPDATE = 8;

function parseArguments(argv) {
  const options = {
    accounts: DEFAULT_ACCOUNT_COUNT,
    games: DEFAULT_GAMES_PER_ACCOUNT,
    pollMs: DEFAULT_POLL_MS,
    seed: Date.now(),
    output: null,
    state: null,
    help: false,
  };
  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex++) {
    const argument = argv[argumentIndex];
    const next = () => {
      const value = argv[++argumentIndex];
      if (value === undefined) {
        throw new Error(`Missing value for ${argument}`);
      }
      return value;
    };
    switch (argument) {
      case '--accounts':
        options.accounts = Number(next());
        break;
      case '--games':
        options.games = Number(next());
        break;
      case '--poll-ms':
        options.pollMs = Number(next());
        break;
      case '--seed':
        options.seed = Number(next());
        break;
      case '--output':
        options.output = path.resolve(next());
        break;
      case '--state':
        options.state = path.resolve(next());
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function stamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function accountName(accountIndex) {
  return `rank${String(accountIndex + 1).padStart(2, '0')}`;
}

async function performRequest(baseUrl, request) {
  const headers = {};
  if (request.token) {
    headers.authorization = `Bearer ${request.token}`;
  }
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${request.pathName}`, {
    method: request.method ?? 'GET',
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const text = await response.text();
  let responseBody = null;
  if (text.length > 0) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }
  const result = {
    status: response.status,
    ok: response.ok,
    body: responseBody,
    durationMs: Date.now() - startedAt,
  };
  if (!response.ok) {
    const error = new Error(
      `${request.method ?? 'GET'} ${request.pathName} returned ${response.status}`,
    );
    error.status = response.status;
    error.body = responseBody;
    error.durationMs = result.durationMs;
    throw error;
  }
  return result;
}

async function readDocument(baseUrl, token, documentPath) {
  const result = await performRequest(baseUrl, {
    token,
    pathName: `/api/doc?path=${encodeURIComponent(documentPath)}`,
  });
  return result.body;
}

function rankingRecords(rankingDocument) {
  if (Array.isArray(rankingDocument?.records)) {
    return rankingDocument.records;
  }
  if (Array.isArray(rankingDocument?.ranking)) {
    return rankingDocument.ranking;
  }
  return [];
}

async function loadRankingSnapshot(baseUrl, token) {
  const rankingDocument = await readDocument(baseUrl, token, 'rankings/duel');
  const records = rankingRecords(rankingDocument);
  const sortedRecords = [...records].sort(
    (firstRecord, secondRecord) =>
      (secondRecord.rating ?? 0) - (firstRecord.rating ?? 0) ||
      String(firstRecord.userId).localeCompare(String(secondRecord.userId)),
  );
  const recordsByUserId = new Map();
  const positionByUserId = new Map();
  for (const [recordIndex, record] of sortedRecords.entries()) {
    recordsByUserId.set(record.userId, record);
    positionByUserId.set(record.userId, recordIndex + 1);
  }
  return {
    recordsByUserId,
    positionByUserId,
    recordCount: sortedRecords.length,
    updatedAt: rankingDocument?.updatedAt ?? null,
  };
}

function rankingEntry(snapshot, account) {
  const record = snapshot.recordsByUserId.get(account.userId);
  return {
    userId: account.userId,
    name: account.name,
    rating: record?.rating ?? 0,
    position: snapshot.positionByUserId.get(account.userId) ?? null,
    gameCount: record?.gameCount ?? 0,
  };
}

function rankDelta(beforeEntry, afterEntry) {
  return {
    rating: afterEntry.rating - beforeEntry.rating,
    position:
      beforeEntry.position === null || afterEntry.position === null
        ? null
        : beforeEntry.position - afterEntry.position,
  };
}

async function createAccounts({ baseUrl, count, logger }) {
  const accounts = [];
  for (let accountIndex = 0; accountIndex < count; accountIndex++) {
    const result = await performRequest(baseUrl, {
      method: 'POST',
      pathName: '/api/auth',
    });
    const account = {
      userId: result.body.uid,
      token: result.body.token,
      name: accountName(accountIndex),
    };
    accounts.push(account);
    logger.record('account', {
      accountIndex,
      userId: account.userId,
      name: account.name,
      creationStatus: result.status,
    });
  }
  return accounts;
}

async function createDuelRoom(baseUrl, account, logger, context) {
  const result = await performRequest(baseUrl, {
    method: 'POST',
    pathName: '/api/functions/create-room',
    token: account.token,
    body: {
      mode: 'duel',
      userName: account.name,
      lang: 'en',
    },
  });
  if (typeof result.body?.roomId !== 'string') {
    throw new Error(
      `create-room did not return a room id for ${account.name}: ${JSON.stringify(result.body)}`,
    );
  }
  logger.record('request', {
    action: 'create-room',
    ...context,
    userId: account.userId,
    name: account.name,
    status: result.status,
    durationMs: result.durationMs,
    roomId: result.body.roomId,
  });
  return result.body.roomId;
}

async function submitCommand({
  baseUrl,
  account,
  roomId,
  command,
  updateCount,
}) {
  return performRequest(baseUrl, {
    method: 'POST',
    pathName: '/api/functions/submit-command',
    token: account.token,
    body: {
      mode: 'duel',
      roomId,
      command,
      updateCount,
    },
  });
}

async function leaveRoom({ baseUrl, account, roomId }) {
  return performRequest(baseUrl, {
    method: 'POST',
    pathName: '/api/functions/leave-room',
    token: account.token,
    body: {
      mode: 'duel',
      roomId,
    },
  });
}

function expectedCommandPlayerId(game) {
  const pendingAttack = game.attacks?.[0];
  if (!pendingAttack) {
    return game.attackTurnPlayerId;
  }
  if (pendingAttack.buyingItemModelId) {
    return pendingAttack.playerId;
  }
  return pendingAttack.targetPlayerId;
}

/**
 * Ask the authoritative server battle implementation for a command. The wire
 * game stays untouched; only a clone marks the acting account seat as a bot so
 * `botCommand` applies the same policy used by server-controlled seats.
 */
function chooseServerBotCommand(game, random) {
  const candidateGame = structuredClone(game);
  const expectedPlayerId = expectedCommandPlayerId(candidateGame);
  const expectedPlayer = candidateGame.players.find(
    (player) => player.id === expectedPlayerId,
  );
  if (!expectedPlayer) {
    throw new Error(
      `No player ${expectedPlayerId} for update ${game.updateCount}`,
    );
  }
  expectedPlayer.isBot = true;
  const battle = new Battle(candidateGame, random);
  const choice = battle.botCommand();
  if (!choice) {
    throw new Error(
      `Server bot policy declined player ${expectedPlayerId} at update ${game.updateCount}`,
    );
  }
  return choice;
}

function decisionSummary(choice) {
  let phase = 'prayOrForgive';
  if (choice.command.bought !== undefined) {
    phase = 'confirmBuy';
  } else if (
    choice.command.itemIds !== undefined ||
    choice.command.mp !== undefined ||
    choice.command.cp !== undefined
  ) {
    phase = 'play';
  }
  return {
    playerId: choice.player.id,
    playerName: choice.player.name,
    userId: choice.player.userId,
    command: choice.command,
    phase,
  };
}

function winnerIdsFor(game) {
  return game.players
    .filter((player) => player.dead !== true && player.hp > 0)
    .map((player) => player.id);
}

async function runMatch({
  baseUrl,
  roomId,
  firstAccount,
  secondAccount,
  beforeEntries,
  roundIndex,
  matchIndex,
  matchSeed,
  pollMs,
  outputDirectory,
  campaignLogger,
}) {
  const gameId = `round-${String(roundIndex + 1).padStart(2, '0')}-match-${String(matchIndex + 1).padStart(2, '0')}`;
  const logger = new JsonlLogger(path.join(outputDirectory, `${gameId}.jsonl`), {
    gameId,
    playerCount: 2,
    seed: matchSeed,
  });
  const random = new Random(matchSeed);
  const accountByUserId = new Map([
    [firstAccount.userId, firstAccount],
    [secondAccount.userId, secondAccount],
  ]);
  let finalGame = null;
  let result = 'error';
  let rejectionCount = 0;
  let matchError = null;
  const startedAt = Date.now();

  logger.record('meta', {
    type: 'meta',
    schemaVersion: 1,
    mode: 'duel',
    round: roundIndex + 1,
    match: matchIndex + 1,
    roomId,
    seed: matchSeed,
    policy: 'server.actions.battle.Battle.botCommand',
    players: [
      {
        userId: firstAccount.userId,
        name: firstAccount.name,
        rankingBefore: beforeEntries.get(firstAccount.userId),
      },
      {
        userId: secondAccount.userId,
        name: secondAccount.name,
        rankingBefore: beforeEntries.get(secondAccount.userId),
      },
    ],
  });

  try {
    let room = null;
    while (room?.game === null || room?.game === undefined) {
      room = await readDocument(
        baseUrl,
        firstAccount.token,
        `modes/duel/rooms/${roomId}`,
      );
      if (room?.game === null || room?.game === undefined) {
        await sleep(pollMs);
      }
    }
    logger.record('gameStart', {
      updateCount: room.game.updateCount,
      game: room.game,
    });

    let lastLoggedUpdate = -1;
    let lastSubmittedUpdate = -1;
    let rejectionsAtUpdate = 0;

    for (;;) {
      const currentRoom = await readDocument(
        baseUrl,
        firstAccount.token,
        `modes/duel/rooms/${roomId}`,
      );
      if (!currentRoom?.game) {
        throw new Error(`Duel room ${roomId} lost its game state`);
      }
      const game = currentRoom.game;
      if (game.updateCount !== lastLoggedUpdate) {
        lastLoggedUpdate = game.updateCount;
        rejectionsAtUpdate = 0;
        logger.record('state', {
          updateCount: game.updateCount,
          attackTurnPlayerId: game.attackTurnPlayerId,
          attacks: game.attacks ?? [],
          events: game.events ?? [],
          players: game.players,
        });
      }
      if (game.isOver === true) {
        finalGame = game;
        result = 'over';
        break;
      }
      if (game.updateCount === lastSubmittedUpdate) {
        await sleep(pollMs);
        continue;
      }

      const expectedPlayerId = expectedCommandPlayerId(game);
      const expectedPlayer = game.players.find(
        (player) => player.id === expectedPlayerId,
      );
      if (!expectedPlayer?.userId) {
        throw new Error(
          `No account seat for expected player ${expectedPlayerId} at update ${game.updateCount}`,
        );
      }
      const actingAccount = accountByUserId.get(expectedPlayer.userId);
      if (!actingAccount) {
        throw new Error(
          `Expected player ${expectedPlayerId} does not belong to this match`,
        );
      }

      const choice = chooseServerBotCommand(game, random);
      const summary = decisionSummary(choice);
      logger.record('decision', {
        updateCount: game.updateCount,
        actingUserId: actingAccount.userId,
        actingName: actingAccount.name,
        policy: 'server.actions.battle.Battle.botCommand',
        ...summary,
      });

      const submittedUpdate = game.updateCount;
      try {
        const submission = await submitCommand({
          baseUrl,
          account: actingAccount,
          roomId,
          command: choice.command,
          updateCount: submittedUpdate,
        });
        logger.record('request', {
          action: 'submit-command',
          updateCount: submittedUpdate,
          playerId: expectedPlayerId,
          status: submission.status,
          durationMs: submission.durationMs,
          command: choice.command,
        });
        lastSubmittedUpdate = submittedUpdate;
      } catch (error) {
        if (typeof error.status !== 'number') {
          throw error;
        }
        rejectionCount++;
        rejectionsAtUpdate++;
        logger.record('rejected', {
          updateCount: submittedUpdate,
          playerId: expectedPlayerId,
          userId: actingAccount.userId,
          name: actingAccount.name,
          command: choice.command,
          status: error.status,
          errorCode: `HTTP_${error.status}`,
          body: error.body,
          durationMs: error.durationMs ?? null,
        });
        if (rejectionsAtUpdate >= MAX_REJECTIONS_PER_UPDATE) {
          throw new Error(
            `Server rejected ${MAX_REJECTIONS_PER_UPDATE} consecutive commands at update ${submittedUpdate}`,
          );
        }
        await sleep(50);
      }
    }
  } catch (error) {
    matchError = {
      message: String(error?.message ?? error),
      status: error?.status ?? null,
      body: error?.body ?? null,
      stack: error?.stack,
    };
    result = 'error';
    logger.record('error', matchError);
  } finally {
    const finishedAt = Date.now();
    for (const account of [firstAccount, secondAccount]) {
      try {
        const leaveResult = await leaveRoom({ baseUrl, account, roomId });
        logger.record('request', {
          action: 'leave-room',
          userId: account.userId,
          name: account.name,
          status: leaveResult.status,
          durationMs: leaveResult.durationMs,
        });
      } catch (error) {
        logger.record('leaveFailed', {
          userId: account.userId,
          name: account.name,
          status: error?.status ?? null,
          body: error?.body ?? null,
          message: String(error?.message ?? error),
        });
      }
    }

    if (result === 'over' && finalGame !== null) {
      let rankingAfter;
      try {
        rankingAfter = await loadRankingSnapshot(baseUrl, firstAccount.token);
      } catch (error) {
        logger.record('error', {
          stage: 'rankingAfter',
          message: String(error?.message ?? error),
          status: error?.status ?? null,
        });
        rankingAfter = null;
      }
      const firstAfter = rankingAfter === null
        ? {
            ...rankEntryFromGame(finalGame, firstAccount),
          }
        : rankingEntry(rankingAfter, firstAccount);
      const secondAfter = rankingAfter === null
        ? {
            ...rankEntryFromGame(finalGame, secondAccount),
          }
        : rankingEntry(rankingAfter, secondAccount);
      const firstBefore = beforeEntries.get(firstAccount.userId);
      const secondBefore = beforeEntries.get(secondAccount.userId);
      const winners = winnerIdsFor(finalGame);
      const firstWon = finalGame.players.some(
        (player) => player.userId === firstAccount.userId && winners.includes(player.id),
      );

      logger.record('rankingUpdate', {
        perspective: firstAccount.name,
        result: firstWon ? 'win' : 'loss',
        playerId: finalGame.players.find(
          (player) => player.userId === firstAccount.userId,
        )?.id ?? null,
        enemyId: finalGame.players.find(
          (player) => player.userId === secondAccount.userId,
        )?.id ?? null,
        playerRankBefore: firstBefore,
        playerRankAfter: firstAfter,
        playerRankDelta: rankDelta(firstBefore, firstAfter),
        enemyRankBefore: secondBefore,
        enemyRankAfter: secondAfter,
        enemyRankDelta: rankDelta(secondBefore, secondAfter),
      });
      logger.record('rankingUpdate', {
        perspective: secondAccount.name,
        result: firstWon ? 'loss' : 'win',
        playerId: finalGame.players.find(
          (player) => player.userId === secondAccount.userId,
        )?.id ?? null,
        enemyId: finalGame.players.find(
          (player) => player.userId === firstAccount.userId,
        )?.id ?? null,
        playerRankBefore: secondBefore,
        playerRankAfter: secondAfter,
        playerRankDelta: rankDelta(secondBefore, secondAfter),
        enemyRankBefore: firstBefore,
        enemyRankAfter: firstAfter,
        enemyRankDelta: rankDelta(firstBefore, firstAfter),
      });
      logger.record('end', {
        result,
        roomId,
        durationMs: finishedAt - startedAt,
        updateCount: finalGame.updateCount,
        winnerIds: winners,
        winnerUserIds: finalGame.players
          .filter((player) => winners.includes(player.id))
          .map((player) => player.userId),
        players: finalGame.players.map((player) => ({
          id: player.id,
          userId: player.userId,
          name: player.name,
          hp: player.hp,
          mp: player.mp,
          cp: player.cp,
          dead: player.dead === true,
          ratingBefore: player.rating ?? 0,
          ratingGain: player.ratingGain ?? 0,
        })),
        rejectionCount,
      });
    } else {
      logger.record('end', {
        result,
        roomId,
        durationMs: finishedAt - startedAt,
        rejectionCount,
        error: matchError,
      });
    }
    await logger.flush();

    campaignLogger.record('matchResult', {
      round: roundIndex + 1,
      match: matchIndex + 1,
      gameId,
      roomId,
      result,
      rejectionCount,
      updateCount: finalGame?.updateCount ?? null,
      durationMs: finishedAt - startedAt,
      players: [firstAccount.name, secondAccount.name],
    });
  }

  return {
    gameId,
    roomId,
    result,
    rejectionCount,
    finalGame,
    firstAccount,
    secondAccount,
  };
}

function rankEntryFromGame(game, account) {
  const player = game.players.find(
    (candidatePlayer) => candidatePlayer.userId === account.userId,
  );
  return {
    userId: account.userId,
    name: account.name,
    rating: (player?.rating ?? 0) + (player?.ratingGain ?? 0),
    position: null,
    gameCount: null,
  };
}

function roundRobinRounds(accounts, roundCount) {
  const rounds = [];
  let order = [...accounts];
  for (let roundIndex = 0; roundIndex < roundCount; roundIndex++) {
    const pairs = [];
    for (
      let pairIndex = 0;
      pairIndex < Math.floor(order.length / 2);
      pairIndex++
    ) {
      pairs.push([
        order[pairIndex],
        order[order.length - 1 - pairIndex],
      ]);
    }
    rounds.push(pairs);
    order = [order[0], order.at(-1), ...order.slice(1, -1)];
  }
  return rounds;
}

async function runRound({
  baseUrl,
  pairs,
  beforeEntries,
  roundIndex,
  matchSeedBase,
  pollMs,
  outputDirectory,
  campaignLogger,
}) {
  const startedMatches = [];
  for (const [firstAccount, secondAccount] of pairs) {
    const matchIndex = startedMatches.length;
    const firstRoomId = await createDuelRoom(
      baseUrl,
      firstAccount,
      campaignLogger,
      {
        round: roundIndex + 1,
        match: matchIndex + 1,
        role: 'first',
      },
    );
    const secondRoomId = await createDuelRoom(
      baseUrl,
      secondAccount,
      campaignLogger,
      {
        round: roundIndex + 1,
        match: matchIndex + 1,
        role: 'second',
      },
    );
    if (secondRoomId !== firstRoomId) {
      throw new Error(
        `Matchmaking paired ${secondAccount.name} into ${secondRoomId} instead of ${firstRoomId}`,
      );
    }
    startedMatches.push(
      runMatch({
        baseUrl,
        roomId: firstRoomId,
        firstAccount,
        secondAccount,
        beforeEntries,
        roundIndex,
        matchIndex,
        matchSeed: matchSeedBase + roundIndex * 10_000 + matchIndex,
        pollMs,
        outputDirectory,
        campaignLogger,
      }),
    );
  }
  return Promise.all(startedMatches);
}

async function writeAccountsFile(outputDirectory, accounts) {
  const accountsPath = path.join(outputDirectory, 'accounts.json');
  await fs.writeFile(
    accountsPath,
    `${JSON.stringify(accounts, null, 2)}\n`,
    { mode: 0o600 },
  );
  return accountsPath;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'God Field local ranked campaign\n\n' +
        '  --accounts N   number of new accounts (default 30)\n' +
        '  --games N      ranked games per account (default 30)\n' +
        '  --poll-ms N    room polling interval (default 15)\n' +
        '  --seed N       campaign RNG seed\n' +
        '  --output DIR   log and state directory\n' +
        '  --state FILE   store file (default OUTPUT/state.json)\n',
    );
    return;
  }
  if (!Number.isInteger(options.accounts) || options.accounts < 2) {
    throw new Error('--accounts must be an integer of at least 2');
  }
  if (options.accounts % 2 !== 0) {
    throw new Error('--accounts must be even so every account plays each round');
  }
  if (!Number.isInteger(options.games) || options.games < 1) {
    throw new Error('--games must be a positive integer');
  }
  if (!Number.isInteger(options.pollMs) || options.pollMs < 1) {
    throw new Error('--poll-ms must be a positive integer');
  }

  const runDirectory =
    options.output ??
    path.resolve('logs', 'ranked', `run-${stamp()}`);
  const statePath = options.state ?? path.join(runDirectory, 'state.json');
  await fs.mkdir(runDirectory, { recursive: true });

  const campaignLogger = new JsonlLogger(
    path.join(runDirectory, 'campaign.jsonl'),
    {
      campaign: path.basename(runDirectory),
      accounts: options.accounts,
      gamesPerAccount: options.games,
      seed: options.seed,
    },
  );

  const { server } = await createServer({
    store: new Store(statePath),
    botInterval: 0,
  });
  await server.listen({
    port: 0,
    host: '127.0.0.1',
  });
  const address = server.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  campaignLogger.record('start', {
    baseUrl,
    state: statePath,
    accounts: options.accounts,
    gamesPerAccount: options.games,
    pollMs: options.pollMs,
    seed: options.seed,
  });

  let exitCode = 0;
  try {
    const accounts = await createAccounts({
      baseUrl,
      count: options.accounts,
      logger: campaignLogger,
    });
    const accountsPath = await writeAccountsFile(runDirectory, accounts);
    campaignLogger.record('accountsReady', {
      path: accountsPath,
      count: accounts.length,
    });

    const schedule = roundRobinRounds(accounts, options.games);
    const totalMatches = schedule.reduce(
      (total, pairs) => total + pairs.length,
      0,
    );
    campaignLogger.record('schedule', {
      rounds: schedule.length,
      matchesPerRound: schedule[0]?.length ?? 0,
      totalMatches,
      totalPlayerGames: totalMatches * 2,
    });

    let totalRejections = 0;
    for (const [roundIndex, pairs] of schedule.entries()) {
      const rankingBeforeRound = await loadRankingSnapshot(
        baseUrl,
        accounts[0].token,
      );
      const beforeEntries = new Map(
        accounts.map((account) => [
          account.userId,
          rankingEntry(rankingBeforeRound, account),
        ]),
      );
      campaignLogger.record('roundStart', {
        round: roundIndex + 1,
        rankingCount: rankingBeforeRound.recordCount,
        matches: pairs.map(([firstAccount, secondAccount]) => [
          firstAccount.name,
          secondAccount.name,
        ]),
      });

      const results = await runRound({
        baseUrl,
        pairs,
        beforeEntries,
        roundIndex,
        matchSeedBase: options.seed + roundIndex * 1_000_000,
        pollMs: options.pollMs,
        outputDirectory: runDirectory,
        campaignLogger,
      });
      totalRejections += results.reduce(
        (total, result) => total + result.rejectionCount,
        0,
      );
      const failedMatches = results.filter((result) => result.result !== 'over');
      const rankingAfterRound = await loadRankingSnapshot(
        baseUrl,
        accounts[0].token,
      );
      campaignLogger.record('roundRanking', {
        round: roundIndex + 1,
        failedMatches: failedMatches.length,
        entries: accounts.map((account) =>
          rankingEntry(rankingAfterRound, account),
        ),
      });
      process.stdout.write(
        `round ${roundIndex + 1}/${schedule.length}: ${results.length} matches, ${failedMatches.length} failed, ${totalRejections} rejected commands\n`,
      );
      if (failedMatches.length > 0) {
        exitCode = 1;
      }
    }

    const finalRanking = await loadRankingSnapshot(baseUrl, accounts[0].token);
    const finalAccounts = accounts.map((account) => {
      const entry = rankingEntry(finalRanking, account);
      return {
        userId: account.userId,
        name: account.name,
        rating: entry.rating,
        position: entry.position,
        gameCount: entry.gameCount,
      };
    });
    const shortGames = finalAccounts.filter(
      (account) => account.gameCount !== options.games,
    );
    campaignLogger.record('campaignSummary', {
      accounts: finalAccounts,
      totalMatches,
      totalPlayerGames: totalMatches * 2,
      totalRejections,
      accountsWithWrongGameCount: shortGames,
      completed: shortGames.length === 0 && exitCode === 0,
    });
    process.stdout.write(
      `${JSON.stringify({
        output: runDirectory,
        state: statePath,
        accounts: options.accounts,
        gamesPerAccount: options.games,
        totalMatches,
        totalPlayerGames: totalMatches * 2,
        totalRejections,
        accountsWithWrongGameCount: shortGames.length,
      })}\n`,
    );
  } catch (error) {
    exitCode = 1;
    campaignLogger.record('error', {
      stage: 'campaign',
      message: String(error?.message ?? error),
      status: error?.status ?? null,
      stack: error?.stack,
    });
    process.stderr.write(`${error?.stack ?? error}\n`);
  } finally {
    await campaignLogger.flush();
    await server.close();
  }
  process.exitCode = exitCode;
}

await main();
