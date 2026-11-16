#!/usr/bin/env node
/**
 * Plays one real Hidden Melee (private) game with several bots that we control.
 *
 * Each bot has its own anonymous Firebase account, its own transport, and its
 * own JSONL log. Every bot's Firestore subscription is logged independently, so
 * the logs show exactly which room document each player received. The
 * coordinator log holds the decoded shared state, events, stat changes,
 * eliminations, and apocalypse transition.
 *
 * All bots share one short room password, generated fresh for each run unless
 * supplied. The room supports solo and team entries, specific/automatic
 * targeting, AOE attacks, and the Apocalypse tiebreak setting.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadEngine, root} from './engine.mjs';
import {LiveTransport, HttpError, toPlain, stableStringify} from './transport.mjs';
import {JsonlLogger} from './log.mjs';
import {createRng, parseSeed} from './rng.mjs';
import {
  loadCatalog,
  decodeRoom,
  serializeRoom,
  serializeGame,
  serializePlayer,
  serializeAttack,
  diffPlayerSnapshots,
  worldChanges,
} from './state.mjs';
import {ExplorationPolicy, MODEL_IDS} from './policy.mjs';
import {
  emptyCoverage,
  loadCoverage,
  mergeCoverage,
  writeCoverage,
  collectEvent,
  collectDecision,
  collectStatChange,
} from './coverage.mjs';

const TIERBREAK_CHOICES = [null, 1, 50, 75, 100, 150];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

function parseArguments(argv) {
  const options = {
    bots: 4,
    mode: 'solo',
    teams: null,
    password: null,
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
    selfTargetChance: 0,
    declineBuyChance: 0.25,
    userName: 'e',
    lang: 'en',
    logDir: null,
    coverage: null,
    accountPool: null,
    accountOffset: 0,
    seed: null,
    maxSeconds: 0,
    turnTimeoutMs: 20000,
    stallSeconds: 45,
    pollMs: 300,
    logPolls: 'summary',
    lockRoom: true,
    botDocMode: 'full',
    removal: null,
    removalAfterFog: false,
    danger: false,
    prayer: false,
    guardian: false,
    earthTrade: false,
    discardAll: false,
    broomExperiment: false,
    broomEdge: false,
    soapExperiment: false,
    reuseMiracles: false,
    leaveBotIndex: null,
    leaveBotIndices: [],
    disconnectBotIndices: [],
    leaveAfterUpdates: 4,
    rejoinAfterMs: 8000,
    rejoinAfterUpdates: 0,
    scenario: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      return value;
    };
    switch (argument) {
      case '--bots': options.bots = Number(next()); break;
      case '--mode': options.mode = next(); break;
      case '--teams': options.teams = Number(next()); break;
      case '--password': options.password = next(); break;
      case '--apocalypse': {
        const value = next();
        options.apocalypse = value === 'none' || value === 'null' ? null : Number(value);
        break;
      }
      case '--target-mode': options.targetMode = next(); break;
      case '--target-player': options.targetPlayer = Number(next()); break;
      case '--prefer-command': options.preferCommands = next().split(',').filter(Boolean); break;
      case '--focus': options.focus = next().split(',').filter(Boolean).map(Number); break;
      case '--defense-focus': options.defenseFocus = next().split(',').filter(Boolean).map(Number); break;
      case '--dream-focus': options.dreamFocus = true; break;
      case '--aoe': options.aoe = true; break;
      case '--fog': options.fog = true; break;
      case '--passive': options.passive = true; break;
      case '--self-target-chance': options.selfTargetChance = Number(next()); break;
      case '--decline-buy-chance': options.declineBuyChance = Number(next()); break;
      case '--user-name': options.userName = next(); break;
      case '--lang': options.lang = next(); break;
      case '--log-dir': options.logDir = next(); break;
      case '--coverage': options.coverage = next(); break;
      case '--account-pool': options.accountPool = next(); break;
      case '--account-offset': options.accountOffset = Number(next()); break;
      case '--seed': options.seed = next(); break;
      case '--max-seconds': options.maxSeconds = Number(next()); break;
      case '--no-global-limit': options.maxSeconds = 0; break;
      case '--turn-timeout-ms': options.turnTimeoutMs = Number(next()); break;
      case '--stall-seconds': options.stallSeconds = Number(next()); break;
      case '--poll-ms': options.pollMs = Number(next()); break;
      case '--log-polls': options.logPolls = next(); break;
      case '--unlock-room': options.lockRoom = false; break;
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
      case '--leave-bot': options.leaveBotIndex = Number(next()); break;
      case '--leave-bots': options.leaveBotIndices = next().split(',').filter(Boolean).map(Number); break;
      case '--disconnect-bots': options.disconnectBotIndices = next().split(',').filter(Boolean).map(Number); break;
      case '--leave-after-updates': options.leaveAfterUpdates = Number(next()); break;
      case '--rejoin-after-ms': options.rejoinAfterMs = Number(next()); break;
      case '--rejoin-after-updates': options.rejoinAfterUpdates = Number(next()); break;
      case '--scenario': options.scenario = next(); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function expectedPlayerId(game) {
  const attack = game?.attack ?? game?.attacks?.[0];
  if (attack) {
    return attack.buyingItemModelId ? attack.playerId : attack.targetPlayerId;
  }
  return game?.attackTurnPlayerId;
}

function makePassword(rng) {
  let password = '';
  for (let index = 0; index < 9; index++) password += ALPHABET[rng.int(ALPHABET.length)];
  return password;
}

function documentHash(document) {
  return crypto.createHash('sha256').update(stableStringify(document)).digest('hex');
}

async function roomSnapshot(engine, catalog, transport, roomId) {
  const result = await transport.readRoom(roomId, {log: false});
  if (!result.exists) return {exists: false, status: result.status};
  const room = decodeRoom(engine, result.raw);
  return {
    exists: true,
    status: result.status,
    users: result.raw.users?.map(user => ({id: user.id, name: user.name})) ?? [],
    userCount: result.raw.userCount ?? null,
    game: result.raw.game === null || result.raw.game === undefined ? null : {
      updateCount: result.raw.game.updateCount ?? null,
      isOver: result.raw.game.isOver === true,
      attackTurnPlayerId: result.raw.game.attackTurnPlayerId ?? null,
      players: (result.raw.game.players ?? []).map(player => ({
        id: player.id,
        userId: player.userId,
        name: player.name,
        team: player.team ?? 0,
        hp: player.hp,
        dead: player.dead === true,
      })),
    },
    room: serializeRoom(room, catalog),
  };
}

class SnapshotFeed {
  constructor() {
    this.latest = null;
    this.delivered = null;
    this.waiters = [];
  }
  push(snapshot) {
    this.latest = snapshot;
    while (this.waiters.length !== 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      this.delivered = snapshot;
      waiter.resolve(snapshot);
    }
  }
  next(timeoutMs) {
    if (this.latest !== null && this.latest !== this.delivered) {
      this.delivered = this.latest;
      return Promise.resolve(this.latest);
    }
    return new Promise(resolve => {
      const waiter = {resolve, timer: null};
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

// These curated model groups use 1-based IDs from public/i18n/en.json.
const MIRACLE_ATTACK_IDS = [210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230];
const RESPONSE_IDS = [189, 233, 234, 42, 50, 55, 56, 165, 171, 177, 179, 114, 125, 137, 151, 156, 164, 167, 174, 21, 38, 190];
const BLOCK_MIRACLE_IDS = [42, 50, 55, 56, 165, 171, 177, 179];
const BOUNCE_MIRACLE_IDS = [114, 125, 137, 151, 164, 234, 34];
const REFLECT_MIRACLE_IDS = [156, 167, 174, 39];
const PLAIN_WEAPON_IDS = [6, 7, 8, 10, 13, 14, 16, 19, 23, 24, 26, 29, 32, 35, 37, 40, 44, 47, 49, 52, 54, 57];
const TYPED_WEAPON_AND_PLUS_IDS = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
const WATER_TYPED_IDS = [60, 72, 79, 83, 90, 97, 101, 104, 109];
const DARKNESS_TYPED_IDS = [64, 76, 81, 86, 87, 92, 96];
const FOG_SOURCE_IDS = [72, 77, 97, 183, 185, 186, 221, 224];
const DREAM_SELL_IDS = [4, 36, 38, 80, 156, 167, 174, 178, 222];
const MULTI_PLUS_IDS = [MODEL_IDS.dangerousPestle, 231, 232];
const SOAP_IDS = [206, 178, 36, 80, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230];
const POSTAPOC_REVIVE_IDS = [208, 178, 36, 80, 201, 239];
const MOON_REFLECT_FOCUS_IDS = [38, 156, 167, 174, 189, 190, 201, 239];
const MOON_REFLECT_DEFENSE_IDS = [38, 156, 167, 174, 189, 190];

function addIds(options, key, ids) {
  const existing = options[key] ?? [];
  options[key] = [...new Set([...existing, ...ids])];
}

function applyScenario(options) {
  if (options.scenario === null) return;
  switch (options.scenario) {
    case 'rainbow-miracle':
      options.miracleAttack = true;
      options.rainbowTransfer = true;
      options.rainbowResponseKind = 'miracle';
      options.targetRainbowHolder = true;
      options.rainbowAcquire = true;
      addIds(options, 'focus', [...MIRACLE_ATTACK_IDS, ...RESPONSE_IDS, 4, 5]);
      addIds(options, 'defenseFocus', RESPONSE_IDS);
      break;
    case 'rainbow-blockmiracle':
      options.miracleAttack = true;
      options.rainbowTransfer = true;
      options.rainbowResponseKind = 'blockMiracle';
      options.targetRainbowHolder = true;
      options.rainbowAcquire = true;
      addIds(options, 'focus', [...MIRACLE_ATTACK_IDS, ...BLOCK_MIRACLE_IDS, 4, 5]);
      addIds(options, 'defenseFocus', [189, ...BLOCK_MIRACLE_IDS]);
      break;
    case 'rainbow-bouncemiracle':
      options.miracleAttack = true;
      options.rainbowTransfer = true;
      options.rainbowResponseKind = 'bounceMiracle';
      options.targetRainbowHolder = true;
      options.rainbowAcquire = true;
      addIds(options, 'focus', [...MIRACLE_ATTACK_IDS, ...BOUNCE_MIRACLE_IDS, 4, 5]);
      addIds(options, 'defenseFocus', [189, ...BOUNCE_MIRACLE_IDS]);
      break;
    case 'rainbow-reflectmiracle':
      options.miracleAttack = true;
      options.focusAcquire = true;
      options.rainbowTransfer = true;
      options.rainbowResponseKind = 'reflectMiracle';
      options.targetRainbowHolder = true;
      options.rainbowAcquire = true;
      addIds(options, 'focus', [...MIRACLE_ATTACK_IDS, ...REFLECT_MIRACLE_IDS, 4, 5]);
      addIds(options, 'defenseFocus', [189, ...REFLECT_MIRACLE_IDS]);
      break;
    case 'rainbow-blockweapon':
      options.plainWeaponAttack = true;
      options.rainbowTransfer = true;
      options.rainbowResponseKind = 'weapon';
      options.targetRainbowHolder = true;
      options.rainbowAcquire = true;
      addIds(options, 'focus', [...PLAIN_WEAPON_IDS, 4, 5, 233]);
      addIds(options, 'defenseFocus', [189, 233, 234]);
      break;
    case 'typed-same':
      options.sameElementPlus = true;
      addIds(options, 'focus', TYPED_WEAPON_AND_PLUS_IDS);
      break;
    case 'typed-water':
      options.focusAcquire = true;
      options.sameElementPlus = true;
      options.apocalypse = null;
      addIds(options, 'focus', WATER_TYPED_IDS);
      break;
    case 'typed-dark':
      options.focusAcquire = true;
      options.sameElementPlus = true;
      options.apocalypse = null;
      addIds(options, 'focus', DARKNESS_TYPED_IDS);
      break;
    case 'multi-plus':
      options.focusAcquire = true;
      options.aoe = true;
      options.apocalypse = null;
      addIds(options, 'focus', MULTI_PLUS_IDS);
      break;
    case 'dream-sell':
      options.focusAcquire = true;
      options.dreamFocus = true;
      options.apocalypse = null;
      addIds(options, 'focus', DREAM_SELL_IDS);
      break;
    case 'fog-discard':
      options.fog = true;
      options.removal = 'discard';
      options.removalAfterFog = true;
      options.apocalypse = null;
      addIds(options, 'focus', FOG_SOURCE_IDS);
      break;
    case 'fog-sacrifice':
      options.fog = true;
      options.removal = 'sacrifice';
      options.removalAfterFog = true;
      options.apocalypse = 1;
      addIds(options, 'focus', FOG_SOURCE_IDS);
      break;
    case 'soap-3':
      options.soapExperiment = true;
      options.apocalypse = null;
      addIds(options, 'focus', SOAP_IDS);
      break;
    case 'postapoc-revive':
      options.apocalypse = 1;
      addIds(options, 'focus', POSTAPOC_REVIVE_IDS);
      break;
    case 'moon-reflect':
      options.apocalypse = 1;
      options.guardian = true;
      options.aoe = true;
      addIds(options, 'focus', MOON_REFLECT_FOCUS_IDS);
      addIds(options, 'defenseFocus', MOON_REFLECT_DEFENSE_IDS);
      break;
    case 'full-hand-buy':
      options.focusAcquire = true;
      options.apocalypse = null;
      options.passive = true;
      options.prayer = true;
      options.declineBuyChance = 0;
      addIds(options, 'focus', [5, 3, 4, 178, 36, 80, 222]);
      break;
    case 'trickster':
      options.apocalypse = 1;
      options.reuseMiracles = true;
      options.passive = true;
      addIds(options, 'focus', MIRACLE_ATTACK_IDS);
      break;
    case 'dream-thin':
      options.dreamFocus = true;
      addIds(options, 'focus', [46, 189, 190, 204, 208, 209, 178, 36, 80, 222, 207, 295, 289]);
      break;
    case 'magnetic-dream':
      options.dreamFocus = true;
      addIds(options, 'focus', [207, 295, 289, 201, 239, 204, 208, 209, 178, 36, 80, 222]);
      break;
    default:
      throw new Error(`Unknown scenario: ${options.scenario}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`God Field Hidden Melee multi-bot runner\n\n` +
      `  --bots N                number of our bots (2-9, default 4)\n` +
      `  --mode solo|teams       room entry mode (default solo)\n` +
      `  --teams N               team count in teams mode; balanced round-robin\n` +
      `  --password TEXT         room password (max 9 letters; random per run by default)\n` +
      `  --apocalypse N          tiebreak/Apocalypse GF: none,1,50,75,100,150\n` +
      `  --target-mode MODE      auto|random|weakest|strongest|self|teammate|specific\n` +
      `  --target-player ID      player id for --target-mode specific\n` +
      `  --prefer-command LIST   comma-separated command types to prefer\n` +
      `  --focus LIST            comma-separated item model ids to strongly prefer\n` +
      `  --defense-focus LIST    comma-separated item model ids to prioritize on defense (Rainbow Curtain always first)\n` +
      `  --dream-focus           chase the Dream curse and use disguised items\n` +
      `  --aoe                   prefer attackEveryEnemy add-ons (e.g. <Mirage>)\n` +
      `  --fog                   prefer fog-inflicting items and piece actions\n` +
      `  --passive               avoid damage; useful for climbing Apocalypse GF\n` +
      `  --self-target-chance P  chance to target self with economic commands\n` +
      `  --decline-buy-chance P  chance to decline our own Buy offer\n` +
      `  --user-name NAME        player name (default e)\n` +
      `  --log-dir DIR          coordinator and per-player JSONL logs\n` +
      `  --coverage FILE        shared coverage JSON\n` +
      `  --account-pool FILE    reusable anonymous account refresh tokens\n` +
      `  --account-offset N     first account-pool index for this game\n` +
      `  --seed VALUE            deterministic RNG seed\n` +
      `  --max-seconds N         global limit; 0 means no global limit (default 0)\n` +
      `  --turn-timeout-ms N    abort a turn with no state response (default 20000)\n` +
      `  --stall-seconds N      abort after no channel updates (default 45)\n` +
      `  --poll-ms N            Firestore poll interval (default 300)\n` +
      `  --unlock-room           do not lock the room after all bots join\n` +
      `  --bot-doc-mode full|summary  full channel docs for every bot, or hashes/summaries\n` +
      `  --removal MODE          use slot-0 discard|sacrifice|both before normal attacks\n` +
      `  --danger                prefer Dangerous Pestle and preserve Dangerous Mortar holders\n` +
      `  --prayer                stall by selling weapons and praying (empty command) when unarmed\n` +
      `  --guardian              spawn guardians with jars/miracles and make weak attacks to bait them\n` +
      `  --earth-trade           spawn guardians until Earth appears, then stall and keep spawning for other players\n` +
      `  --discard-all           discard the entire hand when every card is discardable\n` +
      `  --broom-experiment      perform one miracle per bot, stall safely, then sweep performed-miracle holders with Nocturnal Broom\n` +
      `  --broom-edge            like broom experiment, but target fewer-than-three removable or full-hand holders\n` +
      `  --soap-experiment       stack three performed miracles per bot, then wash a three-miracle holder with Goddess's Soap\n` +
      `  --reuse-miracles        reuse already-performed miracles and record the effect\n` +
      `  --scenario NAME         rainbow-miracle|rainbow-blockmiracle|rainbow-bouncemiracle|rainbow-reflectmiracle|rainbow-blockweapon|typed-same|typed-water|typed-dark|multi-plus|dream-sell|fog-discard|fog-sacrifice|soap-3|postapoc-revive|moon-reflect|trickster|full-hand-buy|dream-thin|magnetic-dream\n` +
      `  --leave-bot INDEX        leave the game with this bot (0-based) and log what happens\n` +
      `  --leave-bots LIST        leave with several bots (comma-separated indices)\n` +
      `  --disconnect-bots LIST   close several clients and let the turn watchdog hand off control\n` +
      `  --leave-after-updates N leave once the game reaches this update (default 4)\n` +
      `  --rejoin-after-ms N     rejoin the left bot after this delay (default 8000)\n` +
      `  --rejoin-after-updates N rejoin after N further game updates (0 = use the delay)\n`);
    return;
  }
  applyScenario(options);

  if (!Number.isInteger(options.bots) || options.bots < 2 || options.bots > 9) {
    throw new Error('--bots must be an integer from 2 to 9');
  }
  if (options.mode !== 'solo' && options.mode !== 'teams') {
    throw new Error('--mode must be solo or teams');
  }
  if (!TIERBREAK_CHOICES.includes(options.apocalypse)) {
    throw new Error(`--apocalypse must be one of ${TIERBREAK_CHOICES.map(value => value === null ? 'none' : value).join(',')}`);
  }
  if (options.password !== null && !/^[a-z]{1,9}$/i.test(options.password)) {
    throw new Error('--password must be 1-9 letters');
  }
  if (options.bots === 2 && options.mode === 'teams') {
    throw new Error('teams mode needs at least 3 bots (two teams cannot both be singletons)');
  }
  if (options.leaveBotIndex !== null && (!Number.isInteger(options.leaveBotIndex) || options.leaveBotIndex < 0 || options.leaveBotIndex >= options.bots)) {
    throw new Error('--leave-bot must be a 0-based bot index inside the bot count');
  }
  const invalidLeaveBotIndices = options.leaveBotIndices.some(index => !Number.isInteger(index) || index < 0 || index >= options.bots);
  if (invalidLeaveBotIndices || new Set(options.leaveBotIndices).size !== options.leaveBotIndices.length) {
    throw new Error('--leave-bots must contain unique 0-based indices inside the bot count');
  }
  const invalidDisconnectBotIndices = options.disconnectBotIndices.some(index => !Number.isInteger(index) || index < 0 || index >= options.bots);
  if (invalidDisconnectBotIndices || new Set(options.disconnectBotIndices).size !== options.disconnectBotIndices.length) {
    throw new Error('--disconnect-bots must contain unique 0-based indices inside the bot count');
  }

  const engine = await loadEngine();
  const {catalog, itemCount, catalogHash} = await loadCatalog(engine);
  let accountPool = null;
  if (options.accountPool !== null) {
    try {
      accountPool = JSON.parse(await fs.readFile(path.resolve(options.accountPool), 'utf8'));
    } catch (error) {
      accountPool = null;
    }
  }
  const seed = parseSeed(options.seed);
  const rng = createRng(seed);
  const runId = `melee-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-${process.pid.toString(36)}`;
  const logDir = path.resolve(options.logDir ?? path.join('logs/live', runId));
  await fs.mkdir(logDir, {recursive: true});
  const password = options.password ?? makePassword(rng);
  const coverageFile = options.coverage ? path.resolve(options.coverage) : null;
  const coverage = coverageFile ? await loadCoverage(coverageFile) : emptyCoverage();
  const localCoverage = emptyCoverage();
  localCoverage.playerCounts[String(options.bots)] = 1;

  const teamCount = options.mode === 'solo'
    ? 1
    : Math.min(options.teams ?? Math.max(2, Math.min(4, Math.floor(options.bots / 2))), options.bots - 1);
  if (options.mode === 'teams' && (teamCount < 2 || teamCount >= options.bots)) {
    throw new Error('teams mode needs between 2 and bots-1 teams');
  }
  const assignTeam = index => options.mode === 'solo' ? 0 : (index % teamCount) + 1;
  // Hidden Melee rejects duplicate display names (HTTP 403), so each bot gets
  // a unique suffixed name based on the requested name.
  const nameFor = index => `${options.userName}${index + 1}`;

  const coordinatorLogger = new JsonlLogger(path.join(logDir, 'coordinator.jsonl'), {
    gameId: runId,
    playerCount: options.bots,
    seed,
    mode: options.mode,
    roomPassword: password,
  });

  const bots = [];
  let roomId = null;
  let watchers = [];
  let stopped = false;
  let result = 'timeout';
  const eliminations = [];
  let apocalypseLogged = false;
  let maxGF = 0;
  let devilEvents = 0;
  const earthGuardian = {
    seen: false,
    actions: 0,
    tradeActions: {discard: 0, sacrifice: 0, exchange: 0, sell: 0, buy: 0},
    recentActions: [],
  };
  let fogTargetingConfigured = false;
  let lastChangeAt = Date.now();
  const startedAt = Date.now();
  const shared = {buyOffer: null, lastDecision: null};
  let latest = null;
  let previousGame = null;
  let previousRaw = null;
  let missingRoom = false;

  try {
    for (let index = 0; index < options.bots; index++) {
      const team = assignTeam(index);
      const botName = nameFor(index);
      const logger = new JsonlLogger(path.join(logDir, `bot-${index}.jsonl`), {
        gameId: runId,
        playerCount: options.bots,
        seed,
        botIndex: index,
        mode: options.mode,
        roomPassword: password,
        team,
      });
      logger.record('meta', {
        type: 'meta',
        role: 'player',
        botIndex: index,
        playerName: botName,
        team,
        roomId: null,
        itemCount,
        catalogHash,
      });
      const transport = new LiveTransport({
        logger,
        roomMode: 'private',
        pollIntervalMs: options.pollMs,
        logPolls: options.logPolls,
        logChannelDocument: index === 0 || options.botDocMode === 'full',
      });
      const savedAccount = accountPool?.[options.accountOffset + index] ?? null;
      let userId = null;
      if (savedAccount?.refreshToken) {
        transport.refreshToken = savedAccount.refreshToken;
        transport.userId = savedAccount.userId;
        try {
          await transport.refreshAuth();
          userId = transport.userId;
        } catch (error) {
          userId = null;
        }
      }
      if (userId === null) {
        userId = await transport.signIn();
      }
      logger.record('identity', {userId, team, roomId: null, accountSource: savedAccount?.refreshToken ? 'pool' : 'signup'});
      bots.push({
        index,
        userId,
        name: botName,
        team,
        transport,
        logger,
        latest: null,
        previousGame: null,
        previousRaw: null,
        policy: new ExplorationPolicy({
          engine,
          catalog,
          rng: createRng(seed ^ (index + 1) * 0x9e3779b9),
          coverage,
          options: {
            focus: options.focus ?? [],
            defenseFocus: options.defenseFocus ?? [],
            dreamFocus: options.dreamFocus,
            targetMode: options.targetMode,
            targetPlayerId: options.targetPlayer,
            selfTargetChance: options.selfTargetChance,
            declineBuyChance: options.earthTrade ? 0 : options.declineBuyChance,
            passive: options.passive || options.broomExperiment || options.soapExperiment || options.earthTrade,
            broomExperiment: options.broomExperiment,
            broomEdge: options.broomEdge,
            soapExperiment: options.soapExperiment,
            reuseMiracles: options.reuseMiracles,
            preferCommands: [
              ...(options.preferCommands ?? []),
              ...(options.aoe ? ['attackEveryEnemy'] : []),
              ...(options.fog ? ['addCurse'] : []),
            ],
            aoeFocus: options.aoe,
            fogFocus: options.fog,
            removalMode: options.removal,
            removalAfterFog: options.removalAfterFog,
            dangerFocus: options.danger,
            prayerMode: options.prayer,
            guardianFocus: options.guardian || options.earthTrade,
            earthTradeFocus: options.earthTrade,
            discardAllMode: options.discardAll,
            miracleAttack: options.miracleAttack,
            plainWeaponAttack: options.plainWeaponAttack,
            sameElementPlus: options.sameElementPlus,
            rainbowTransfer: options.rainbowTransfer,
            rainbowResponseKind: options.rainbowResponseKind,
            targetRainbowHolder: options.targetRainbowHolder,
            rainbowAcquire: options.rainbowAcquire,
            focusAcquire: options.focusAcquire,
          },
        }),
      });
    }

    const leaveState = {
      bot: options.leaveBotIndex === null ? null : bots[options.leaveBotIndex],
      left: false,
      leftAt: 0,
      leftUpdate: 0,
      rejoined: false,
    };

    const owner = bots[0];
    const ownerName = owner.name;
    const createPayload = new Map([
      ['mode', 'private'],
      ['userName', ownerName],
      ['password', password],
      ['lang', options.lang],
    ]);
    const created = await owner.transport.call(engine.cloudFunction.createRoom, createPayload);
    roomId = created?.roomId;
    if (typeof roomId !== 'string') throw new Error(`create-room did not return a room id: ${JSON.stringify(created)}`);
    coordinatorLogger.record('meta', {
      type: 'meta',
      role: 'coordinator',
      gameId: runId,
      roomId,
      password,
      playerCount: options.bots,
      mode: options.mode,
      teams: options.mode === 'teams' ? teamCount : null,
      apocalypse: options.apocalypse,
      targetMode: options.targetMode,
      targetPlayer: options.targetPlayer,
      aoe: options.aoe,
      fog: options.fog,
      passive: options.passive,
      earthTrade: options.earthTrade,
      discardAll: options.discardAll,
      broomExperiment: options.broomExperiment,
      broomEdge: options.broomEdge,
      soapExperiment: options.soapExperiment,
      reuseMiracles: options.reuseMiracles,
      scenario: options.scenario,
      focus: options.focus,
      defenseFocus: options.defenseFocus,
      dreamFocus: options.dreamFocus,
      seed,
      itemCount,
      catalogHash,
      node: process.version,
      cwd: root,
    });
    for (const bot of bots) bot.logger.record('identity', {userId: bot.userId, team: bot.team, roomId});

    // Join every other bot. create-room with the same password resolves to the
    // owner's room; join-room then adds the user to its user list.
    for (const bot of bots.slice(1)) {
      const joinPayload = new Map([
        ['mode', 'private'],
        ['userName', bot.name],
        ['password', password],
        ['lang', options.lang],
      ]);
      const joined = await bot.transport.call(engine.cloudFunction.createRoom, joinPayload);
      if (joined?.roomId !== roomId) {
        bot.logger.record('warn', {message: 'create-room returned a different room; joining owner room', joinedRoomId: joined?.roomId, ownerRoomId: roomId});
      }
      await bot.transport.call(engine.roomAction.joinRoom, new Map([
        ['mode', 'private'],
        ['roomId', roomId],
        ['userName', bot.name],
      ]));
    }

    const waitFor = async (predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(150);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    // Start each bot's own room subscription. Each one logs its own channel.
    const feed = new SnapshotFeed();
    watchers = bots.map(bot => (async () => {
      for (;;) {
        if (stopped || bot.left) return;
        try {
          await bot.transport.watchRoom(roomId, async message => {
            try {
              const room = decodeRoom(engine, message.document);
              const game = room.game;
              let serializedRoom = null;
              try {
                serializedRoom = serializeRoom(room, catalog);
              } catch (error) {
                bot.logger.record('error', {stage: 'serializeRoom', message: String(error?.message ?? error), stack: error?.stack});
              }
              const self = game?.players.find(player => player.userId === bot.userId) ?? null;
              const receive = {
                channelSequence: message.sequence,
                updateTime: message.updateTime,
                updateCount: game?.updateCount ?? null,
                gf: game?.gf ?? null,
                tiebreakGF: game?.tiebreakGF ?? null,
                myPlayerId: self?.id ?? null,
                myTeam: self?.team?.key ?? null,
                myHp: self?.hp ?? null,
                myMp: self?.mp ?? null,
                myCp: self?.cp ?? null,
                myCurses: self ? [...self.curses].map(curse => curse.key) : null,
                self: self ? serializePlayer(self, catalog) : null,
                attack: game ? serializeAttack(game.attack, catalog) : null,
                documentHash: documentHash(message.document),
                gameHash: documentHash(message.document.game ?? null),
              };
              bot.logger.record('receive', receive);
              bot.latest = {raw: message.document, room, game, serializedRoom};
              bot.previousRaw = message.document;
              bot.previousGame = game;
              lastChangeAt = Date.now();
              if (bot.index === 0) {
                latest = bot.latest;
                processCoordinator(engine, catalog, coordinatorLogger, message, room, game, serializedRoom, {
                  bots, localCoverage, eliminations,
                  getPreviousGame: () => previousGame,
                  getPreviousRaw: () => previousRaw,
                  setPreviousGame: value => { previousGame = value; },
                  setPreviousRaw: value => { previousRaw = value; },
                  onApocalypse: record => {
                    apocalypseLogged = true;
                    coordinatorLogger.record('apocalypse', record);
                  },
                  isApocalypseLogged: () => apocalypseLogged,
                  onMaxGF: gf => { maxGF = Math.max(maxGF, gf ?? 0); },
                  onDevilEvent: count => { devilEvents += count; },
                  onGuardianAction: record => {
                    if (record.attack?.guardian !== 'earth') return;
                    earthGuardian.seen = true;
                    earthGuardian.actions++;
                    const tradeNames = {1: 'discard', 2: 'sacrifice', 3: 'exchange', 4: 'sell', 5: 'buy'};
                    for (const modelId of record.attack?.itemModelIds ?? []) {
                      const tradeName = tradeNames[modelId];
                      if (tradeName !== undefined) earthGuardian.tradeActions[tradeName]++;
                    }
                    if (earthGuardian.recentActions.length < 50) {
                      earthGuardian.recentActions.push({
                        updateCount: record.updateCount,
                        playerId: record.attack?.playerId ?? null,
                        itemModelIds: record.attack?.itemModelIds ?? [],
                        items: record.attack?.items ?? [],
                      });
                    }
                  },
                  onBuyOffer: value => { shared.buyOffer = value; },
                  getLastDecision: () => shared.lastDecision,
                });
                feed.push(bot.latest);
              }
            } catch (error) {
              bot.logger.record('error', {stage: 'channel', message: String(error?.message ?? error), stack: error?.stack});
            }
          }, {
            intervalMs: options.pollMs,
            onMissing: () => {
              missingRoom = true;
              if (bot.index === 0) coordinatorLogger.record('channelMissing', {roomId});
            },
          });
          if (stopped) return;
        } catch (error) {
          bot.logger.record('error', {stage: 'watch', message: String(error?.message ?? error), stack: error?.stack});
          if (stopped) return;
          await sleep(1000);
        }
      }
    })());

    await waitFor(() => latest?.room && latest.room.users.length >= options.bots
      && bots.every(bot => latest.room.users.some(user => user.userId === bot.userId)), 20000, 'all bots in the room');

    // Set the Apocalypse/tiebreak value before entries and start.
    await owner.transport.call(engine.roomAction.setTiebreak, new Map([
      ['mode', 'private'],
      ['roomId', roomId],
      ['gf', options.apocalypse],
    ]));

    for (const bot of bots) {
      await bot.transport.call(engine.roomAction.makeEntry, new Map([
        ['mode', 'private'],
        ['roomId', roomId],
        ['team', bot.team],
      ]));
    }
    await waitFor(() => latest?.room && latest.room.entries.length === options.bots, 15000, 'all team entries');
    coordinatorLogger.record('entries', {
      entries: latest.room.entries.map(entry => ({userId: entry.userId, team: entry.team?.key ?? 0})),
      teams: options.mode === 'teams' ? teamCount : null,
    });

    if (options.lockRoom) {
      try {
        await owner.transport.call(engine.roomAction.setRoomLocked, new Map([
          ['mode', 'private'],
          ['roomId', roomId],
          ['isLocked', true],
        ]));
      } catch (error) {
        coordinatorLogger.record('lockFailed', {message: String(error?.message ?? error), status: error?.status, body: error?.body});
      }
    }

    await owner.transport.call(engine.roomAction.startGame, new Map([
      ['mode', 'private'],
      ['roomId', roomId],
    ]));
    await waitFor(() => latest?.game != null, 30000, 'game start');
    coordinatorLogger.record('gameStart', {updateCount: latest.game.updateCount, game: serializeGame(latest.game, catalog)});

    let lastSubmit = null;
    let rejectedInState = 0;
    let updatesSeen = 0;
    const disconnectedBotIndices = new Set();
    let disconnectedTurnKey = null;
    let disconnectedTurnStartedAt = null;
    const kickAfterMs = 75000;
    const globalDeadline = options.maxSeconds > 0 ? startedAt + options.maxSeconds * 1000 : Infinity;
    const turnTimeoutMs = options.turnTimeoutMs;
    const stallMs = options.stallSeconds * 1000;

    while (Date.now() < globalDeadline) {
      if (missingRoom && latest?.game == null) {
        result = 'roomMissing';
        break;
      }
      if (lastSubmit && Date.now() - lastSubmit.at > turnTimeoutMs) {
        coordinatorLogger.record('turnTimeout', {
          updateCount: lastSubmit.updateCount,
          actor: lastSubmit.actor,
          phase: lastSubmit.phase,
          kind: lastSubmit.kind,
          elapsedMs: Date.now() - lastSubmit.at,
        });
        result = 'turnTimeout';
        break;
      }
      const snapshot = await feed.next(1000);
      const current = snapshot ?? latest;
      if (current === null || current?.game == null) {
        if (Date.now() - lastChangeAt > stallMs) {
          coordinatorLogger.record('stallTimeout', {waitingFor: 'game state', elapsedMs: Date.now() - lastChangeAt});
          result = 'stalled';
          break;
        }
        continue;
      }
      const game = current.game;
      if (game.updateCount !== updatesSeen) {
        updatesSeen = game.updateCount;
        rejectedInState = 0;
        if (lastSubmit && game.updateCount > lastSubmit.updateCount) lastSubmit = null;
      }
      if (game.isOver === true) {
        result = 'over';
        break;
      }
      const playerIdFor = bot => game.players.find(player => player.userId === bot.userId)?.id ?? null;

      if (leaveState.bot !== null && !leaveState.left && !leaveState.rejoined && game.updateCount >= options.leaveAfterUpdates) {
        const bot = leaveState.bot,
          playerId = playerIdFor(bot),
          pendingTarget = game.attack?.targetPlayerId ?? null;
        // Leave while somebody else is acting, so the remaining bots have a
        // chance to play turns before the absent player is needed.
        if (playerId !== null && game.attackTurnPlayerId !== playerId && pendingTarget !== playerId) {
          leaveState.left = true;
          leaveState.leftAt = Date.now();
          leaveState.leftUpdate = game.updateCount;
          bot.left = true;
          lastSubmit = null;
          let error = null;
          try {
            await bot.transport.call(engine.roomAction.leaveRoom, new Map([
              ['mode', 'private'],
              ['roomId', roomId],
            ]));
          } catch (failure) {
            error = {message: String(failure?.message ?? failure), status: failure?.status ?? null, body: failure?.body ?? null};
          }
          const snapshot = await roomSnapshot(engine, catalog, bot.transport, roomId);
          coordinatorLogger.record('leave', {
            botIndex: bot.index,
            userId: bot.userId,
            playerId,
            updateCount: game.updateCount,
            attackTurnPlayerId: game.attackTurnPlayerId,
            error,
            room: snapshot,
          });
          for (const other of bots) {
            if (other === bot) continue;
            other.logger.record('peerLeft', {
              updateCount: game.updateCount,
              peerIndex: bot.index,
              peerUserId: bot.userId,
              room: snapshot,
            });
          }
        }
      }

      for (const botIndex of options.leaveBotIndices) {
        const bot = bots[botIndex];
        const playerId = playerIdFor(bot);
        const isAlreadyLeft = bot.left === true;
        const isExpectedActor = playerId === game.attackTurnPlayerId;
        const isPendingTarget = playerId === (game.attack?.targetPlayerId ?? null);
        const canLeaveNow = playerId !== null && !isAlreadyLeft && !isExpectedActor && !isPendingTarget;
        if (game.updateCount < options.leaveAfterUpdates || !canLeaveNow) {
          continue;
        }
        bot.left = true;
        lastSubmit = null;
        let error = null;
        try {
          await bot.transport.call(engine.roomAction.leaveRoom, new Map([
            ['mode', 'private'],
            ['roomId', roomId],
          ]));
        } catch (failure) {
          error = {message: String(failure?.message ?? failure), status: failure?.status ?? null, body: failure?.body ?? null};
        }
        const snapshot = await roomSnapshot(engine, catalog, bot.transport, roomId);
        coordinatorLogger.record('leave', {
          botIndex: bot.index,
          userId: bot.userId,
          playerId,
          updateCount: game.updateCount,
          attackTurnPlayerId: game.attackTurnPlayerId,
          error,
          room: snapshot,
        });
        for (const other of bots) {
          if (other === bot) {
            continue;
          }
          other.logger.record('peerLeft', {
            updateCount: game.updateCount,
            peerIndex: bot.index,
            peerUserId: bot.userId,
            room: snapshot,
          });
        }
      }

      for (const botIndex of options.disconnectBotIndices) {
        const bot = bots[botIndex];
        const playerId = playerIdFor(bot);
        const isExpectedActor = playerId === expectedPlayerId(game);
        const canDisconnectNow = playerId !== null && !bot.left && !isExpectedActor;
        if (game.updateCount < options.leaveAfterUpdates || !canDisconnectNow) {
          continue;
        }
        bot.left = true;
        disconnectedBotIndices.add(bot.index);
        bot.transport.stop();
        coordinatorLogger.record('disconnect', {
          botIndex: bot.index,
          playerId,
          team: bot.team,
          updateCount: game.updateCount,
          gameHash: documentHash(current.raw?.game ?? null),
        });
      }

      const currentExpectedPlayerId = expectedPlayerId(game);
      const expectedBot = bots.find(bot => playerIdFor(bot) === currentExpectedPlayerId) ?? null;
      const expectedPlayer = game.players.find(player => player.id === currentExpectedPlayerId) ?? null;
      const expectedBotIsDisconnected = expectedBot !== null
        && disconnectedBotIndices.has(expectedBot.index)
        && expectedPlayer?.isBot !== true;
      if (expectedBotIsDisconnected) {
        const turnKey = `${game.updateCount}:${currentExpectedPlayerId}`;
        if (disconnectedTurnKey !== turnKey) {
          disconnectedTurnKey = turnKey;
          disconnectedTurnStartedAt = Date.now();
        }
        const turnElapsedMs = Date.now() - disconnectedTurnStartedAt;
        if (turnElapsedMs >= kickAfterMs) {
          try {
            await owner.transport.call(engine.roomAction.kickUser, new Map([
              ['mode', 'private'],
              ['roomId', roomId],
            ]));
            coordinatorLogger.record('watchdogKick', {
              callerBotIndex: owner.index,
              expectedBotIndex: expectedBot.index,
              expectedPlayerId: currentExpectedPlayerId,
              updateCount: game.updateCount,
              turnElapsedMs,
              payload: {},
            });
          } catch (error) {
            coordinatorLogger.record('watchdogKickError', {
              callerBotIndex: owner.index,
              expectedBotIndex: expectedBot.index,
              expectedPlayerId: currentExpectedPlayerId,
              updateCount: game.updateCount,
              turnElapsedMs,
              status: error?.status ?? null,
              message: String(error?.message ?? error),
            });
          }
          disconnectedTurnStartedAt = Date.now();
        }
        continue;
      }
      disconnectedTurnKey = null;
      disconnectedTurnStartedAt = null;

      if (leaveState.left && !leaveState.rejoined && !leaveState.rejoinTried) {
        const dueByTime = Date.now() - leaveState.leftAt >= options.rejoinAfterMs;
        const dueByUpdates = options.rejoinAfterUpdates > 0 && game.updateCount >= leaveState.leftUpdate + options.rejoinAfterUpdates;
        if (dueByTime || dueByUpdates) {
          leaveState.rejoinTried = true;
          const bot = leaveState.bot;
          const attempts = [];
          let rejoined = false;
          try {
            await bot.transport.call(engine.roomAction.joinRoom, new Map([
              ['mode', 'private'],
              ['roomId', roomId],
              ['userName', bot.name],
            ]));
            attempts.push({action: 'join-room', status: 200});
            rejoined = true;
          } catch (failure) {
            attempts.push({action: 'join-room', status: failure?.status ?? null, body: failure?.body ?? null});
          }
          if (!rejoined) {
            try {
              await bot.transport.call(engine.cloudFunction.createRoom, new Map([
                ['mode', 'private'],
                ['userName', bot.name],
                ['password', password],
                ['lang', options.lang],
              ]));
              attempts.push({action: 'create-room', status: 200});
              await bot.transport.call(engine.roomAction.joinRoom, new Map([
                ['mode', 'private'],
                ['roomId', roomId],
                ['userName', bot.name],
              ]));
              attempts.push({action: 'join-room-after-create', status: 200});
              rejoined = true;
            } catch (failure) {
              attempts.push({action: 'create-room-or-join', status: failure?.status ?? null, body: failure?.body ?? null});
            }
          }
          if (rejoined) {
            leaveState.left = false;
            leaveState.rejoined = true;
            bot.left = false;
            lastSubmit = null;
            rejectedInState = 0;
          }
          const snapshot = await roomSnapshot(engine, catalog, bot.transport, roomId);
          coordinatorLogger.record('rejoin', {
            botIndex: bot.index,
            userId: bot.userId,
            updateCount: game.updateCount,
            elapsedMs: Date.now() - leaveState.leftAt,
            attempts,
            rejoined,
            room: snapshot,
          });
          for (const other of bots) {
            if (other === bot) continue;
            other.logger.record('peerRejoined', {
              updateCount: game.updateCount,
              peerIndex: bot.index,
              peerUserId: bot.userId,
              rejoined,
              room: snapshot,
            });
          }
        }
      }
      if (options.guardian || options.earthTrade) {
        const guardianIds = Array.isArray(current.raw?.game?.guardianPlayerIds) ? current.raw.game.guardianPlayerIds : [];
        const signature = guardianIds.join(',');
        if (shared.guardianSignature !== signature) {
          shared.guardianSignature = signature;
          coordinatorLogger.record('guardianTargets', {updateCount: game.updateCount, guardianPlayerIds: guardianIds});
        }
        const guardianRoster = game.players
          .filter(player => !player.dead && player.guardian)
          .map(player => ({playerId: player.id, playerName: player.name, guardian: player.guardian?.key ?? null}));
        const rosterSignature = guardianRoster.map(entry => `${entry.playerId}:${entry.guardian}`).join(',');
        if (shared.guardianRosterSignature !== rosterSignature) {
          shared.guardianRosterSignature = rosterSignature;
          coordinatorLogger.record('guardianRoster', {updateCount: game.updateCount, guardians: guardianRoster});
        }
        if (options.earthTrade) {
          const earthGuardians = guardianRoster.filter(entry => entry.guardian === 'earth');
          if (earthGuardians.length !== 0 && !shared.earthGuardianSeen) {
            shared.earthGuardianSeen = true;
            coordinatorLogger.record('earthGuardianSeen', {updateCount: game.updateCount, guardians: earthGuardians});
          }
        }
        for (const bot of bots) bot.policy.guardianTargets = new Set(guardianIds);
      }
      if (options.danger) {
        if (!shared.dangerSeen) shared.dangerSeen = new Set();
        for (const player of game.players) {
          for (const slot of player.items) {
            if (slot.modelId !== MODEL_IDS.dangerousPestle && slot.modelId !== MODEL_IDS.dangerousMortar) continue;
            const key = `${player.id}:${slot.modelId}`;
            if (shared.dangerSeen.has(key)) continue;
            shared.dangerSeen.add(key);
            coordinatorLogger.record('dangerItem', {
              updateCount: game.updateCount,
              playerId: player.id,
              playerName: player.name,
              team: player.team?.key ?? 0,
              modelId: slot.modelId,
              itemName: slot.modelId === MODEL_IDS.dangerousPestle ? 'Dangerous Pestle' : 'Dangerous Mortar',
            });
          }
        }
      }
      if (options.fog && !fogTargetingConfigured) {
        const fogged = game.players.filter(player => !player.dead && [...player.curses].some(curse => curse.key === 'fog'));
        if (fogged.length !== 0) {
          fogTargetingConfigured = true;
          for (const bot of bots) {
            const self = game.players.find(player => player.userId === bot.userId) ?? null;
            if (self === null) continue;
            const target = game.players.find(player => !player.dead && player.id !== self.id) ?? null;
            bot.policy.targetMode = 'specific';
            bot.policy.targetPlayerId = target?.id ?? null;
            coordinatorLogger.record('fogTargeting', {
              updateCount: game.updateCount,
              botIndex: bot.index,
              playerId: self.id,
              fogged: [...self.curses].some(curse => curse.key === 'fog'),
              targetPlayerId: target?.id ?? null,
            });
          }
        }
      }
      const attacks = decodePendingAttacks(engine, current.raw, game);
      let action = null;

      // A pending exchange first asks the target to respond. If the target and
      // attacker are ours, both sides of a Buy are handled by their own bots.
      for (const attack of attacks) {
        const targetBot = bots.find(bot => !bot.left && playerIdFor(bot) === attack.targetPlayerId) ?? null;
        const attackerBot = bots.find(bot => !bot.left && playerIdFor(bot) === attack.playerId) ?? null;
        if (targetBot === null) continue;
        const targetPlayer = game.players.find(player => player.id === attack.targetPlayerId) ?? null;
        if (targetPlayer === null || targetPlayer.dead === true) continue;
        const attackModels = attack.itemModelIds.map(id => catalog.findByIndex(id - 1)).filter(Boolean);
        const first = attackModels[0] ?? null;
        if (first?.ability === 'buy') {
          if (attack.playerId === attack.targetPlayerId) continue; // server resolves self-Buy as canNotBuy
          const currentOffer = latestBuyOffer(game.events)
            ?? (shared.buyOffer
              && shared.buyOffer.attackerPlayerId === attack.playerId
              && shared.buyOffer.targetPlayerId === attack.targetPlayerId
              ? shared.buyOffer
              : null);
          if (currentOffer !== null && attackerBot !== null) {
            const attackerPlayer = game.players.find(player => player.id === attack.playerId) ?? null;
            if (attackerPlayer !== null) {
              const actionDecision = attackerBot.policy.decideBuyConfirmation(game, attackerPlayer, attack);
              if (actionDecision !== null) {
                action = {bot: attackerBot, player: attackerPlayer, decision: actionDecision, attack};
                break;
              }
            }
          }
          // No item has been offered yet: the seller's empty defense lets the
          // server reveal an item, after which the buyer confirms.
          action = {
            bot: targetBot,
            player: targetPlayer,
            decision: {
              phase: 'defense',
              kind: 'forgive',
              command: engine.createCommandPayload({}),
              reason: 'incoming Buy: empty defense advances to the buyer confirmation',
            },
            attack,
          };
          break;
        }
        const self = targetPlayer;
        const decision = targetBot.policy.decideDefense(game, self, attack);
        if (decision !== null) {
          action = {bot: targetBot, player: self, decision, attack};
          break;
        }
      }

      if (action === null && attacks.length === 0) {
        const turnPlayerId = game.attackTurnPlayerId;
        const turnBot = bots.find(bot => !bot.left && playerIdFor(bot) === turnPlayerId) ?? null;
        if (turnBot !== null) {
          const self = game.players.find(player => player.id === turnPlayerId) ?? null;
          if (self !== null && self.dead !== true) {
            const decision = turnBot.policy.decideAttack(game, self);
            if (decision !== null) action = {bot: turnBot, player: self, decision, attack: null};
          }
        }
      }

      if (action === null) {
        if (Date.now() - lastChangeAt > stallMs) {
          coordinatorLogger.record('stallTimeout', {updateCount: game.updateCount, waitingFor: 'another bot action', elapsedMs: Date.now() - lastChangeAt});
          result = 'stalled';
          break;
        }
        continue;
      }
      if (lastSubmit && lastSubmit.updateCount === game.updateCount) continue;

      const {bot, player, decision, attack} = action;
      bot.policy.noteDecision(decision);
      collectDecision(localCoverage, decision, catalog);
      const actor = {botIndex: bot.index, userId: bot.userId, playerId: player.id, team: player.team?.key ?? 0};
      const loggedDecision = {
        updateCount: game.updateCount,
        actor,
        gf: game.gf,
        attackTurnPlayerId: game.attackTurnPlayerId,
        phase: decision.phase,
        kind: decision.kind,
        reason: decision.reason,
        selected: decision.selected,
        summary: decision.summary,
        attack: decision.attack,
        seedModelId: decision.seedModelId,
        command: toPlain(decision.command),
        fogged: [...player.curses].some(curse => curse.key === 'fog'),
        requestedTargetPlayerId: decision.command?.get?.('targetPlayerId') ?? null,
        attackContext: attack === null ? null : serializeAttack(attack, catalog),
      };
      shared.lastDecision = loggedDecision;
      coordinatorLogger.record('decision', loggedDecision);
      bot.logger.record('decision', loggedDecision);
      if (loggedDecision.requestedTargetPlayerId !== null) {
        coordinatorLogger.record('targeting', {
          updateCount: game.updateCount,
          actor,
          requestedTargetPlayerId: loggedDecision.requestedTargetPlayerId,
          fogged: loggedDecision.fogged,
          targetMode: options.targetMode,
          itemModelIds: decision.selected?.map(item => item.modelId) ?? [],
        });
      }

      try {
        await bot.transport.call(engine.roomAction.submitCommand, new Map([
          ['mode', 'private'],
          ['roomId', roomId],
          ['command', toPlain(decision.command)],
        ]));
        lastSubmit = {
          updateCount: game.updateCount,
          at: Date.now(),
          phase: decision.phase,
          kind: decision.kind,
          actor,
        };
        rejectedInState = 0;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        coordinatorLogger.record('rejected', {
          updateCount: game.updateCount,
          actor,
          phase: decision.phase,
          kind: decision.kind,
          status: error.status,
          body: error.body,
          selected: decision.selected,
          command: toPlain(decision.command),
        });
        if (decision.seedModelId) bot.policy.block(decision.seedModelId);
        if (decision.phase === 'defense') bot.policy.blockDefense();
        if (decision.kind === 'confirmBuy') bot.policy.alternateBuyChoice();
        lastSubmit = null;
        rejectedInState++;
        if (rejectedInState >= 4) {
          result = 'rejected';
          break;
        }
        await sleep(350);
      }
    }

    const finalGame = latest?.serializedRoom?.game ?? null;
    const winnerIds = result === 'over' && finalGame !== null
      ? finalGame.players.filter(player => player.dead !== true && player.hp > 0).map(player => player.id)
      : [];
    coordinatorLogger.record('end', {
      result,
      roomId,
      password,
      playerCount: options.bots,
      mode: options.mode,
      teams: options.mode === 'teams' ? teamCount : null,
      apocalypse: options.apocalypse,
      apocalypseReached: apocalypseLogged,
      maxGF,
      devilEvents,
      earthGuardian: {
        ...earthGuardian,
        seen: earthGuardian.seen || shared.earthGuardianSeen === true,
      },
      winnerIds,
      eliminations,
      durationMs: Date.now() - startedAt,
      game: finalGame,
    });
    localCoverage.games += 1;
    if (result === 'over' && finalGame !== null) {
      const winners = new Set(winnerIds);
      for (const bot of bots) {
        const player = finalGame.players.find(entry => entry.userId === bot.userId);
        if (player && winners.has(player.id)) localCoverage.wins += 1;
      }
    }
  } catch (error) {
    result = 'error';
    coordinatorLogger.record('error', {
      stage: 'melee',
      message: String(error?.message ?? error),
      stack: error?.stack,
      status: error?.status,
      body: error?.body,
    });
  } finally {
    stopped = true;
    for (const bot of bots) bot.transport.stop();
    await Promise.race([Promise.allSettled(watchers), sleep(2000)]);
    if (roomId !== null && bots.length !== 0) {
      for (const bot of bots) {
        try {
          await bot.transport.call(engine.roomAction.leaveRoom, new Map([
            ['mode', 'private'],
            ['roomId', roomId],
          ]));
        } catch (error) {
          bot.logger.record('leaveFailed', {message: String(error?.message ?? error), status: error?.status, body: error?.body});
        }
      }
    }
    coordinatorLogger.record('coverage', {data: localCoverage});
    await coordinatorLogger.flush();
    for (const bot of bots) await bot.logger.flush();
    if (coverageFile) {
      try {
        const global = await loadCoverage(coverageFile);
        mergeCoverage(global, localCoverage);
        await writeCoverage(coverageFile, global);
      } catch (error) {
        coordinatorLogger.record('coverageWriteFailed', {message: String(error?.message ?? error)});
      }
    }
  }

  process.exitCode = result === 'over' || result === 'timeout' ? 0 : 1;
  process.stdout.write(`${JSON.stringify({
    gameId: runId,
    roomId,
    password,
    result,
    bots: options.bots,
    mode: options.mode,
    teams: options.mode === 'teams' ? teamCount : null,
    apocalypse: options.apocalypse,
    apocalypseReached: apocalypseLogged,
    maxGF,
    logDir,
  })}\n`);
}

function decodePendingAttacks(engine, raw, game) {
  const values = raw?.game?.attacks ?? [];
  if (Array.isArray(values) && values.length !== 0) {
    return values.map(value => engine.decodeCommandPayload(engine.decodeJson(value)));
  }
  return game.attack === null || game.attack === undefined ? [] : [game.attack];
}

function latestBuyOffer(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].action === 'buy') return events[index];
    if (events[index].action === 'setBought') return null;
  }
  return null;
}

function processCoordinator(engine, catalog, logger, message, room, game, serializedRoom, context) {
  const priorGame = context.getPreviousGame();
  const priorRaw = context.getPreviousRaw();
  context.setPreviousGame(game);
  context.setPreviousRaw(message.document);
  if (game === null || game === undefined) {
    logger.record('lobby', {updateCount: 0, room: serializedRoom});
    return;
  }
  const serializedGame = serializeGame(game, catalog);
  logger.record('state', {
    channelSequence: message.sequence,
    updateTime: message.updateTime,
    updateCount: game.updateCount,
    game: serializedGame,
  });
  context.onMaxGF(game.gf);
  if (game.tiebreakGF !== null && game.tiebreakGF !== undefined && game.gf >= game.tiebreakGF && !context.isApocalypseLogged()) {
    context.onApocalypse({
      updateCount: game.updateCount,
      gf: game.gf,
      tiebreakGF: game.tiebreakGF,
      players: serializedGame.players,
      note: 'Apocalypse threshold reached; devils can now replace regular gifts',
    });
  }
  if (priorGame === null || game.updateCount !== priorGame.updateCount) {
    const deadSet = new Set((priorGame?.players ?? game.players).filter(player => player.dead === true).map(player => player.id));
    const deathPlayers = new Set();
    let exchangeStart = 0;
    let devils = 0;
    for (const [index, record] of serializedGame.events.entries()) {
      logger.record('event', record);
      collectEvent(context.localCoverage, record, catalog);
      if (record.action === 'useDevilItem') devils++;
      if (record.action === 'attackByGuardian') context.onGuardianAction?.(record);
      if (record.action === 'buy') {
        context.onBuyOffer({
          updateCount: game.updateCount,
          attackerPlayerId: game.attack?.playerId ?? null,
          targetPlayerId: game.attack?.targetPlayerId ?? null,
          itemModelId: record.itemModelId,
          itemName: record.itemName,
        });
      }
      if (record.action === 'setBought') context.onBuyOffer(null);
      if (record.action === 'setTargetPlayer') {
        logger.record('targetResolution', {
          updateCount: game.updateCount,
          eventIndex: index,
          requestedTargetPlayerId: context.getLastDecision()?.requestedTargetPlayerId ?? null,
          actualTargetPlayerId: record.playerId,
          fogged: context.getLastDecision()?.fogged ?? null,
          actor: context.getLastDecision()?.actor ?? null,
        });
      }
      if (record.action === 'advanceGF') exchangeStart = index + 1;
      if (record.action === 'revive') deadSet.delete(record.playerId);
      if (record.action === 'die') {
        deadSet.add(record.playerId);
        deathPlayers.add(record.playerId);
        const elimination = {
          updateCount: game.updateCount,
          eventIndex: index,
          playerId: record.playerId,
          playerName: game.players.find(player => player.id === record.playerId)?.name ?? null,
          team: game.players.find(player => player.id === record.playerId)?.team?.key ?? null,
          remainingPlayers: game.players.length - deadSet.size,
          cause: serializedGame.events.slice(exchangeStart, index + 1).map(event => event.action),
        };
        logger.record('elimination', elimination);
        context.eliminations.push(elimination);
      }
    }
    if (devils !== 0) context.onDevilEvent(devils);
    if (priorGame !== null) {
      const changes = diffPlayerSnapshots(priorGame, game, catalog);
      for (const change of changes) {
        logger.record('stat', {updateCount: game.updateCount, cause: game.events.map(event => event.action), ...change});
        collectStatChange(context.localCoverage, change, catalog);
        for (const curse of change.cursesAdded ?? []) {
          if (curse === 'fog') {
            logger.record('fog', {
              updateCount: game.updateCount,
              playerId: change.playerId,
              playerName: change.playerName,
              team: game.players.find(player => player.id === change.playerId)?.team?.key ?? null,
              note: 'Fog acquired; the raw room document still contains all items and stats',
            });
          }
        }
        if (change.fields?.dead?.to === true && !deathPlayers.has(change.playerId)) {
          const elimination = {
            updateCount: game.updateCount,
            eventIndex: null,
            playerId: change.playerId,
            playerName: change.playerName,
            remainingPlayers: game.players.filter(player => player.dead !== true).length,
            cause: serializedGame.events.slice(-8).map(event => event.action),
            source: 'stat fallback (death event was outside the captured update)',
          };
          logger.record('elimination', elimination);
          context.eliminations.push(elimination);
        }
      }
    }
    const world = worldChanges(priorRaw, message.document);
    if (world !== null) logger.record('world', {updateCount: game.updateCount, changes: world});
  }
}

await main();
