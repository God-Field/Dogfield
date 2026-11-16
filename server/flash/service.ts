import { FlashAccounts, account2013, canEnterDuel2013, chargeDuel2013, duelStraightBonus, spiritModes, spiritCharges, spiritBonuses } from './accounts.ts';
import { encode2010Message } from './wire-2010.ts';
import type { FlashVersion } from './catalog.ts';
import { Random } from '../random.ts';
import { requireValue } from '../errors.ts';
import { FlashBattle, newFlashPlayer, playerXml, type FlashPlayer } from './battle.ts';
import { element, field, has, parseXml, tag, type XmlNode } from './xml.ts';

export interface FlashSession {
  send: (xml: string) => void;
  name: string;
  language: string;
  mode: string;
  scope: string;
  version: FlashVersion;
  room?: FlashRoom;
  filtered: Set<string>;
  accountToken?: string;
}

export interface FlashRoom {
  id: number;
  scope: string;
  version: FlashVersion;
  name: string;
  password: string;
  language: string;
  limit: number;
  fast: boolean;
  time: number;
  users: Set<FlashSession>;
  players: FlashPlayer[];
  battle?: FlashBattle;
  finished: Set<string>;
  mode: string;
  needsCharge?: boolean;
  participants?: Map<string, string>;
  straights?: Map<string, number>;
  scoreBonuses?: Map<string, number>;
  bookParticipants?: Map<string, string>;
  bookSettled?: boolean;
  settled?: boolean;
  recoveryUntil?: Map<string, number>;
}

const maximumUserNameLength = 16;
const flashNameCharacterMaximum = 255;
const trainingPlayerCount = 4;
const maximumRoomNameLength = 40;
const minimumRoomPlayerLimit = 2;
const maximumRoomPlayerLimit = 9;
const maximumPasswordLength = 16;
const maximumCommentLength = 100;
const legacyFreeFightEntryCost = 125;
const minimumTeamRoomPlayerCount = 4;
const excludedShufflePlayerCounts = [5, 7];
const teamCounts = [2, 3, 4];
const fallbackMinimumTeamCount = 3;
const legacyNinePlayerTeamCount = 3;
const standardTeamCount = 2;
const duelEntryCost = 50;
const spiritUnlockScore = 10;
const spiritUnlockGames = 100;
const duelRoundLength = 15;
const duelWinScore = 2;
const duelRoundBonusThreshold = 16;
const duelRoundBonus = 10;
const duelWinnerReward = 50;
const freeFightWinnerReward = 100;
const spiritRoundLength = 100;
const seedRange = 0x100000000;

export const flashSpiritRecoveryInterval = 30 * 60 * 1000;

const teams = ['SINGLE', 'TEAM1', 'TEAM2', 'TEAM3', 'TEAM4'];

type ModeEntryRejection = 'loginRequired' | 'alreadyInGame' | 'userExists' | 'insufficientFunds'
  | 'invalidRequest' | 'caveLocked' | 'paymentRequired' | 'opponentUnavailable';

/** cc.charin.utils.Strings counts UTF-16 units above 255 as two characters. */
function flashTextLength(value: string): number {
  let length = 0;
  for (let characterIndex = 0; characterIndex < value.length; characterIndex++) {
    length += value.charCodeAt(characterIndex) <= flashNameCharacterMaximum ? 1 : 2;
  }
  return length;
}

function hasIllegalNameCharacter(value: string): boolean {
  return /[!"#$%&=^~|`;:,<>/\\?\u3000\r\n\t\x00-\x1f]/.test(value);
}

/** Flash sessions are intentionally isolated from the modern JSON room format. */
export class FlashService {
  readonly sessions = new Set<FlashSession>();
  readonly rooms = new Map<number, FlashRoom>();
  private nextRoomId = 1;
  readonly duelQueue = new Set<FlashSession>();
  maintenance = false;

  constructor(readonly random = new Random(), readonly accounts = new FlashAccounts()) {}

  connect(send: (xml: string) => void): FlashSession {
    const session: FlashSession = {
      send: (xml) => send(session.version === '2010' ? encode2010Message(xml) : xml),
      name: '', language: 'ENGLISH', mode: '', scope: '', version: '2013', filtered: new Set(),
    };
    return session;
  }

  receive(session: FlashSession, source: string): void {
    const request = parseXml(source);
    if (request.name === 'ERROR') {
      return;
    }
    if (request.name === 'LOGIN') {
      requireValue(!session.name);
      this.expireSpiritRecoveries();
      const name = field(request, 'name');
      const language = field(request, 'language');
      const mode = field(request, 'mode') || 'FREE_FIGHT';
      requireValue(name.length > 0 && flashTextLength(name) <= maximumUserNameLength && !hasIllegalNameCharacter(name));
      requireValue(!name.startsWith(' ') && !name.endsWith(' '));
      requireValue(['ENGLISH', 'JAPANESE'].includes(language));

      const version = field(request, 'version') || '2013';
      requireValue(version === '2010' || version === '2013');
      const paidMode = mode === 'DUEL' || mode === 'SPIRIT';
      requireValue(['TRAINING', 'FREE_FIGHT'].includes(mode) || paidMode);
      const accountToken = version === '2013' ? field(request, 'userID') : field(request, 'fcauth');
      if (paidMode && version === '2010') {
        requireValue(this.accounts.validToken(accountToken));
      }
      const versionPrefix = version === '2010' ? '2010:' : '';
      const scope = `${versionPrefix}${language}:${mode}:${has(request, 'isPrivate') ? 'PRIVATE' : 'PUBLIC'}`;
      const duplicateFreeFightName = mode === 'FREE_FIGHT'
        && [...this.sessions].some((other) => other.scope === scope && other.name === name);
      if (duplicateFreeFightName) {
        // The original client ignores ERROR while waiting for its first ENTER.
        // Initialize an empty lobby so it can show the error and use Back.
        // The rejected connection remains outside the authenticated sessions.
        session.send(element('ENTER', tag('lobby')));
        session.send(element('ERROR', tag('message', 'userExists')));
        return;
      }
      Object.assign(session, { name, language, mode, scope, version });
      this.sessions.add(session);
      if (this.accounts.validToken(accountToken)) {
        session.accountToken = accountToken;
      }
      const resumableRoom = mode === 'FREE_FIGHT' ? [...this.rooms.values()].find((room) =>
        room.scope === scope && room.battle && !room.battle.over
        && room.players.some((player) => player.name === name && player.bot)) : undefined;
      if (resumableRoom) {
        this.join(session, resumableRoom);
        return;
      }
      const spiritRecovery = mode === 'SPIRIT' && version === '2013' ? [...this.rooms.values()].find((room) =>
        room.scope === scope && room.battle && !room.battle.over
        && room.participants?.get(name) === session.accountToken
        && (room.recoveryUntil?.get(name) ?? 0) > Date.now()) : undefined;
      if (spiritRecovery) {
        spiritRecovery.recoveryUntil!.delete(name);
        this.join(session, spiritRecovery);
        return;
      }
      if (paidMode) {
        session.send(this.modeLobby(session));
        this.duelUsers(session.scope);
        return;
      }
      this.lobbyBroadcast(scope, element('ADD_USER', element('user', tag('name', name))), session);
      if (mode === 'TRAINING') {
        const room = this.createRoom(session, 'Training', '', trainingPlayerCount, false);
        room.players = [newFlashPlayer(name), ...['Princess Kaguya', 'Sinbad', 'Odin']
          .filter((botName) => botName !== name).map((botName) => newFlashPlayer(botName, 'SINGLE', true))];
        while (room.players.length < trainingPlayerCount) {
          room.players.push(newFlashPlayer(`Bot ${room.players.length}`, 'SINGLE', true));
        }
        for (const player of room.players) {
          player.ready = true;
        }
        this.join(session, room);
        if (this.maintenance) {
          session.send(element('ERROR', tag('message', 'isLocked')));
        } else {
          this.start(room);
        }
      } else {
        session.send(this.lobby(session));
      }
      return;
    }
    requireValue(this.sessions.has(session));
    if (this.receiveMode(session, request)) {
      return;
    }
    if (request.name === 'ENTER') {
      requireValue(!session.room && session.mode === 'FREE_FIGHT');
      let room: FlashRoom;
      const roomName = field(request, 'name');
      if (roomName) {
        requireValue(flashTextLength(roomName) <= maximumRoomNameLength && !hasIllegalNameCharacter(roomName));
        if ([...this.rooms.values()].some((existing) => existing.scope === session.scope && existing.name === roomName)) {
          session.send(element('ERROR', tag('message', 'nameExists')));
          return;
        }
        const limitText = field(request, 'playersLimit');
        const limit = Number(limitText || 2);
        requireValue(Number.isInteger(limit) && limit >= minimumRoomPlayerLimit && limit <= maximumRoomPlayerLimit);
        const password = field(request, 'password');
        requireValue(flashTextLength(password) <= maximumPasswordLength && !hasIllegalNameCharacter(password));
        room = this.createRoom(session, roomName, password, limit, has(request, 'isFast'));
      } else {
        const roomId = field(request, 'id');
        requireValue(/^\d+$/.test(roomId));
        const existing = this.rooms.get(Number(roomId));
        requireValue(existing && existing.scope === session.scope);
        room = existing;
        if (room.password !== field(request, 'password')) {
          session.send(element('ERROR', tag('message', 'passwordIncorrect')));
          return;
        }
      }
      this.join(session, room);
      return;
    }
    if (request.name === 'DRAW_BOOK') {
      requireValue(session.version === '2010' && session.mode === 'FREE_FIGHT' && session.accountToken);
      const index = this.accounts.drawBook2010(session.accountToken,
        (maximum) => Math.floor(this.random.value('flash2010BookDraw') * maximum));
      session.send(element('DRAW_BOOK', tag('index', index)));
      return;
    }
    const room = session.room;
    requireValue(room);
    const player = room.players.find((candidate) => candidate.name === session.name);
    switch (request.name) {
      case 'EXIT':
        this.leave(session);
        session.send(this.lobby(session));
        break;
      case 'CHAT': {
        requireValue(session.mode !== 'DUEL');
        const comment = field(request, 'comment');
        requireValue(comment.length <= maximumCommentLength);
        if (!comment.trim()) {
          return;
        }
        const teamOnly = has(request, 'toTeam');
        requireValue(!teamOnly || (player && player.team !== 'SINGLE'));
        const message = element('CHAT', tag('name', session.name) + tag('comment', comment) + (teamOnly ? tag('toTeam') : ''));
        for (const recipient of room.users) {
          const teammate = room.players.find((candidate) => candidate.name === recipient.name);
          const acceptsChat = !recipient.filtered.has(session.name);
          if (acceptsChat && (!teamOnly || teammate?.team === player?.team)) {
            recipient.send(message);
          }
        }
        break;
      }
      case 'FILTER': {
        const name = field(request, 'user');
        const target = [...room.users].find((user) => user.name === name);
        requireValue(target);
        if (has(request, 'isFiltered')) {
          session.filtered.add(name);
        } else {
          session.filtered.delete(name);
        }
        const voters = [...room.users].filter((user) => room.players.some((candidate) => candidate.name === user.name));
        const filteredVotes = voters.filter((user) => user.filtered.has(name)).length;
        const majorityVotes = Math.floor(room.players.length / 2) + 1;
        if (filteredVotes >= majorityVotes) {
          target.send(element('KICKED'));
          this.leave(target);
          target.send(this.lobby(target));
          target.send(element('ERROR', tag('message', 'kicked')));
        }
        break;
      }
      case 'SET_CHARGE': {
        requireValue(session.version === '2010' && room.mode === 'FREE_FIGHT' && !room.battle && room.players.length === 0);
        const needsCharge = has(request, 'needsCharge');
        if (needsCharge && (!session.accountToken || this.accounts.get(session.accountToken).credits < legacyFreeFightEntryCost)) {
          this.rejectModeEntry(session, session.accountToken ? 'insufficientFunds' : 'loginRequired');
          return;
        }
        room.needsCharge = needsCharge;
        this.roomBroadcast(room, element('SET_CHARGE', needsCharge ? tag('needsCharge') : ''));
        this.lobbyBroadcast(room.scope, element('SET_CHARGE', tag('roomID', room.id) + (needsCharge ? tag('needsCharge') : '')));
        break;
      }
      case 'ENTER_GAME': {
        requireValue(!room.battle && (player || room.players.length < room.limit));
        if (room.needsCharge && (!session.accountToken || this.accounts.get(session.accountToken).credits < legacyFreeFightEntryCost)) {
          this.rejectModeEntry(session, session.accountToken ? 'insufficientFunds' : 'loginRequired');
          return;
        }
        const team = field(request, 'team');
        requireValue(teams.includes(team));
        const other = room.players.find((candidate) => candidate !== player);
        requireValue(!other || (team === 'SINGLE') === (other.team === 'SINGLE'));
        if (player) {
          player.team = team;
        } else {
          room.players.push(newFlashPlayer(session.name, team));
        }
        this.roomBroadcast(room, element('ADD_PLAYER', element('player', tag('name', session.name) + tag('team', team))));
        this.lobbyBroadcast(room.scope, element('ADD_PLAYER', tag('roomID', room.id) + element('player', tag('name', session.name) + tag('team', team))));
        break;
      }
      case 'EXIT_GAME':
        requireValue(!room.battle && player);
        room.players.splice(room.players.indexOf(player), 1);
        this.roomBroadcast(room, element('REMOVE_PLAYER', element('player', tag('name', session.name))));
        this.lobbyBroadcast(room.scope, element('REMOVE_PLAYER', tag('roomID', room.id) + element('player', tag('name', session.name))));
        break;
      case 'READY': {
        requireValue(!room.battle && player);
        const ready = has(request, 'isReady');
        if (ready && this.maintenance) {
          this.rejectModeEntry(session, 'isLocked');
          return;
        }
        if (ready && room.needsCharge && (!session.accountToken || this.accounts.get(session.accountToken).credits < legacyFreeFightEntryCost)) {
          this.rejectModeEntry(session, session.accountToken ? 'insufficientFunds' : 'loginRequired');
          return;
        }
        if (player.ready !== ready) {
          player.ready = ready;
          this.roomBroadcast(room, element('ADD_PLAYER', element('player', tag('name', session.name) + tag('isReady'))));
        }
        const hasOpponents = room.players.some((candidate) => candidate !== player
          && (player.team === 'SINGLE' || candidate.team !== player.team));
        const teamSizes = new Map<string, number>();
        for (const candidate of room.players) {
          teamSizes.set(candidate.team, (teamSizes.get(candidate.team) ?? 0) + 1);
        }
        const unequalTeams = player.team !== 'SINGLE' && new Set(teamSizes.values()).size > 1;
        const allowsUnequalTeams = room.version === '2010' || room.scope.endsWith(':PRIVATE');
        const validTeams = !unequalTeams || allowsUnequalTeams;
        if (room.players.length >= minimumRoomPlayerLimit && hasOpponents && validTeams && room.players.every((candidate) => candidate.ready)) {
          this.start(room);
        }
        break;
      }
      case 'SHUFFLE_TEAM': {
        requireValue(!room.battle && player && room.players.length >= minimumTeamRoomPlayerCount && player.team !== 'SINGLE');
        const unevenPrivateTeams = session.scope.endsWith(':PRIVATE');
        requireValue(unevenPrivateTeams || !excludedShufflePlayerCounts.includes(room.players.length));
        requireValue(room.players.every((candidate) => !candidate.ready && candidate.team === player.team));
        const shuffled = this.random.shuffle('flashTeams', room.players);
        const counts = teamCounts.filter((count) => count <= room.players.length);
        const equalCounts = counts.filter((count) => room.players.length % count === 0);
        const availableCounts = equalCounts.length ? equalCounts : counts.filter((count) => count >= fallbackMinimumTeamCount);
        const teamCount = room.version === '2010'
          ? (room.players.length === maximumRoomPlayerLimit ? legacyNinePlayerTeamCount : standardTeamCount)
          : this.random.pick('flashTeamCount', availableCounts);
        for (const [index, candidate] of shuffled.entries()) {
          candidate.team = `TEAM${index % teamCount + 1}`;
          this.roomBroadcast(room, element('ADD_PLAYER', element('player', tag('name', candidate.name) + tag('team', candidate.team))));
          this.lobbyBroadcast(room.scope, element('ADD_PLAYER', tag('roomID', room.id)
            + element('player', tag('name', candidate.name) + tag('team', candidate.team))));
        }
        break;
      }
      case 'COMMAND':
      case 'BUY':
        requireValue(room.battle && player);
        this.submit(room, session.name, request);
        break;
      case 'FINISH_GAME':
        requireValue(session.mode === 'FREE_FIGHT');
        requireValue(room.battle?.over && player);
        room.finished.add(session.name);
        player.finished = true;
        this.roomBroadcast(room, element('ADD_PLAYER', element('player', tag('name', session.name) + tag('isFinished'))));
        this.finishIfReady(room);
        break;
      default:
        throw new Error(`Unsupported Flash request ${request.name}`);
    }
  }

  private modeLobby(session: FlashSession): string {
    const account = session.accountToken ? this.accounts.get(session.accountToken) : undefined;
    if (session.mode !== 'DUEL') {
      return element('ENTER');
    }
    if (session.version === '2010') {
      return element('ENTER', tag('straight', account!.straight));
    }
    const modern = account ? account2013(account) : undefined;
    const result = modern?.duel ?? { game: 0, win: 0, draw: 0 };
    return element('ENTER', tag('win', result.win) + tag('draw', result.draw)
      + tag('lose', result.game - result.win - result.draw) + tag('scoreBonus', modern?.scoreBonus ?? 0));
  }

  private duelUsers(scope: string): void {
    const users = [...this.sessions].filter((session) => session.scope === scope && session.mode === 'DUEL');
    const playing = users.filter((session) => session.room?.battle && !session.room.battle.over).length;
    const waiting = users.filter((session) => this.duelQueue.has(session)).length;
    const message = element('USERS', tag('playing', playing) + tag('waiting', waiting) + tag('others', users.length - playing - waiting));
    for (const session of users.filter((user) => !user.room)) {
      session.send(message);
    }
  }

  private accountBusy(session: FlashSession): boolean {
    return [...this.sessions].some((other) => {
      const sharesAccount = Boolean(session.accountToken) && other.accountToken === session.accountToken;
      const sharesName = other.scope === session.scope && other.name === session.name;
      const isQueuedOrPlaying = this.duelQueue.has(other) || Boolean(other.room?.battle && !other.room.battle.over);
      return other !== session && (sharesAccount || sharesName) && isQueuedOrPlaying;
    });
  }

  private receiveMode(session: FlashSession, request: XmlNode): boolean {
    const paidMode = session.mode === 'DUEL' || session.mode === 'SPIRIT';
    if (!paidMode || !['ENTER', 'EXIT'].includes(request.name)) {
      return false;
    }
    if (request.name === 'EXIT') {
      if (session.room) {
        const player = session.room.battle?.player(session.name);
        requireValue(session.room.battle?.over || player?.dead);
        if (session.mode === 'SPIRIT' && !session.room.settled) {
          this.settleMode(session.room, session.name);
        }
        this.leave(session);
        session.send(this.modeLobby(session));
      } else {
        requireValue(session.mode === 'DUEL');
        this.duelQueue.delete(session);
      }
      this.duelUsers(session.scope);
      return true;
    }
    if (!session.room && session.mode === 'DUEL' && this.duelQueue.has(session)) {
      this.duelUsers(session.scope);
      return true;
    }
    if (this.maintenance) {
      return this.rejectModeEntry(session, 'isLocked');
    }
    if (!session.accountToken) {
      return this.rejectModeEntry(session, 'loginRequired');
    }
    if (session.room) {
      return this.rejectModeEntry(session, 'alreadyInGame');
    }
    if (this.accountBusy(session)) {
      return this.rejectModeEntry(session, 'userExists');
    }
    const account = this.accounts.get(session.accountToken);
    if (session.mode === 'DUEL') {
      const canPay = session.version === '2013' ? canEnterDuel2013(account) : account.credits >= duelEntryCost;
      if (!canPay) {
        return this.rejectModeEntry(session, 'insufficientFunds');
      }
      this.duelQueue.add(session);
      this.matchDuel(session.scope);
      this.duelUsers(session.scope);
    } else {
      const playerCount = Number(field(request, 'playerCount'));
      const modeIndex = spiritModes.findIndex((count) => count === playerCount);
      if (modeIndex < 0) {
        return this.rejectModeEntry(session, 'invalidRequest');
      }
      const spirit = session.version === '2013' ? account2013(account).spirit : account.spirit;
      const previous = modeIndex > 0 ? spirit[spiritModes[modeIndex - 1]!] : undefined;
      const caveUnlocked = modeIndex === 0
        || Boolean(previous && (previous.score >= spiritUnlockScore || previous.game >= spiritUnlockGames || previous.completed || previous.best > 0));
      if (!caveUnlocked) {
        return this.rejectModeEntry(session, 'caveLocked');
      }
      if (session.version === '2010' && !account.hasPaid) {
        return this.rejectModeEntry(session, 'paymentRequired');
      }
      const canPay = account.credits >= spiritCharges[modeIndex]!;
      if (!canPay) {
        return this.rejectModeEntry(session, 'insufficientFunds');
      }
      account.credits -= spiritCharges[modeIndex]!;
      this.accounts.set(session.accountToken, account);
      const room = this.createRoom(session, `Cave${playerCount}`, '', playerCount, false);
      room.players = [newFlashPlayer(session.name)];
      for (let botIndex = 1; botIndex < playerCount; botIndex++) {
        const name = session.name === `Spirit ${botIndex}` ? `Guardian ${botIndex}` : `Spirit ${botIndex}`;
        room.players.push(newFlashPlayer(name, 'SINGLE', true));
      }
      room.participants = new Map([[session.name, session.accountToken]]);
      this.join(session, room);
      this.start(room);
    }
    return true;
  }

  private rejectModeEntry(session: FlashSession, message: ModeEntryRejection | 'isLocked'): boolean {
    // ENTER resets pending controls; ERROR re-enables input in the original clients.
    // isLocked is reserved for server maintenance and must not describe an entry rejection.
    if (session.room) {
      this.sendRoomSnapshot(session, session.room);
    } else {
      session.send(this.modeLobby(session));
    }
    session.send(element('ERROR', tag('message', message)));
    this.duelUsers(session.scope);
    return true;
  }

  private canMatchDuel(first: FlashSession, second: FlashSession): boolean {
    if (first.version === '2010') {
      return true;
    }
    if (first.accountToken === second.accountToken) {
      return false;
    }
    const firstAccount = account2013(this.accounts.get(first.accountToken!));
    const secondAccount = account2013(this.accounts.get(second.accountToken!));
    return !firstAccount.duelOpponents?.includes(second.accountToken!)
      && !secondAccount.duelOpponents?.includes(first.accountToken!);
  }

  private matchDuel(scope: string): void {
    const queued = [...this.duelQueue].filter((session) => session.scope === scope);
    while (queued.length >= 2) {
      const firstIndex = queued.findIndex((candidate, index) => queued.slice(index + 1)
        .some((opponent) => this.canMatchDuel(candidate, opponent)));
      if (firstIndex < 0) {
        break;
      }
      const first = queued.splice(firstIndex, 1)[0]!;
      const secondIndex = queued.findIndex((candidate) => this.canMatchDuel(first, candidate));
      const second = queued.splice(secondIndex, 1)[0]!;
      const participants = [first, second];
      const accounts = participants.map((session) => this.accounts.get(session.accountToken!));
      const canPay = accounts.every((account) => first.version === '2013' ? canEnterDuel2013(account) : account.credits >= duelEntryCost);
      for (const session of participants) {
        this.duelQueue.delete(session);
      }
      if (!canPay) {
        for (const [participantIndex, session] of participants.entries()) {
          const account = accounts[participantIndex]!;
          const participantCanPay = session.version === '2013' ? canEnterDuel2013(account) : account.credits >= duelEntryCost;
          const reason = participantCanPay ? 'opponentUnavailable' : 'insufficientFunds';
          this.rejectModeEntry(session, reason);
        }
        continue;
      }
      const room = this.createRoom(first, 'Duel', '', 2, false);
      room.players = participants.map((session) => newFlashPlayer(session.name));
      room.participants = new Map(participants.map((session) => [session.name, session.accountToken!]));
      if (first.version === '2013') {
        room.scoreBonuses = new Map(participants.map((session, index) => [session.name, account2013(accounts[index]!).scoreBonus]));
      }
      room.straights = new Map(participants.map((session, index) => [session.name, accounts[index]!.straight]));
      for (const [index, session] of participants.entries()) {
        const account = accounts[index]!;
        if (session.version === '2013') {
          chargeDuel2013(account);
          const opponent = participants.find((candidate) => candidate !== session)!;
          (account2013(account).duelOpponents ??= []).push(opponent.accountToken!);
        } else {
          account.credits -= duelEntryCost;
        }
        this.accounts.set(session.accountToken!, account);
        room.users.add(session);
        session.room = room;
      }
      // Both entrants receive the complete room, without Free Fight lobby
      // notifications leaking into the Duel receiver during pairing.
      for (const session of participants) {
        this.sendRoomSnapshot(session, room);
      }
      for (const session of participants) {
        const opponent = participants.find((other) => other !== session)!;
        if (session.version === '2013') {
          session.send(element('SCORE_BONUS', tag('scoreBonus', room.scoreBonuses!.get(session.name)!)
            + tag('anotherScoreBonus', room.scoreBonuses!.get(opponent.name)!)));
        } else {
          session.send(element('STRAIGHT', tag('straight', room.straights.get(opponent.name)!)));
        }
      }
      this.start(room);
    }
  }

  private settleMode(room: FlashRoom, forfeitedName?: string): void {
    if (!room.participants || room.settled) {
      return;
    }
    room.settled = true;
    const winners = room.players.filter((player) => !player.lost);
    const winnerCount = Math.max(1, winners.length);
    for (const [name, token] of room.participants) {
      const account = this.accounts.get(token);
      const won = name !== forfeitedName && winners.some((player) => player.name === name);
      if (room.mode === 'DUEL' && room.version === '2013') {
        const modern = account2013(account);
        const bonus = [...room.scoreBonuses!.values()].reduce((sum, value) => sum + value, duelWinnerReward);
        if (won) {
          modern.coin += Math.floor(bonus / winnerCount);
        }
        const draw = won && winnerCount > 1;
        const win = won && !draw;
        const date = new Date().toISOString().slice(0, 10);
        const year = date.slice(0, 4);
        const yearly = modern.years[year] ??= { result: { game: 0, win: 0, draw: 0 }, rounds: [] };
        if (modern.duel.game >= duelRoundLength) {
          modern.duel = { game: 0, win: 0, draw: 0 };
        }
        for (const result of [modern.duel, yearly.result]) {
          result.game++;
          result.win += Number(win);
          result.draw += Number(draw);
        }
        if (modern.duel.game === duelRoundLength) {
          yearly.rounds.push({ ...modern.duel, date });
          const roundScore = modern.duel.win * duelWinScore + modern.duel.draw;
          modern.scoreBonus = roundScore + (roundScore >= duelRoundBonusThreshold ? duelRoundBonus : 0);
          modern.duelOpponents = [];
        }
      } else if (room.mode === 'DUEL') {
        const bonus = winnerCount === 1
          ? [...room.straights!.values()].reduce((sum, straight) => sum + duelStraightBonus(straight), 0) : 0;
        if (won) {
          account.credits += Math.floor(duelWinnerReward / winnerCount) + bonus;
        }
        account.straight = won && winnerCount === 1 ? account.straight + 1 : 0;
      } else if (room.mode === 'FREE_FIGHT') {
        if (won) {
          account.credits += Math.floor(freeFightWinnerReward * room.players.length / winnerCount);
        }
      } else {
        const modeIndex = spiritModes.findIndex((count) => count === room.limit);
        const spirit = room.version === '2013' ? account2013(account).spirit : account.spirit;
        const previous = spirit[room.limit] ?? { game: 0, score: 0, best: 0 };
        const record = previous.game >= spiritRoundLength ? { ...previous, game: 0, score: 0 } : previous;
        record.game++;
        if (won) {
          record.score += Math.floor(room.limit / winnerCount);
          account.credits += Math.floor(spiritBonuses[modeIndex]! / winnerCount);
        }
        if (record.game === spiritRoundLength) {
          record.best = Math.max(record.best, record.score);
          if (room.version === '2013') {
            record.completed = true;
          }
        }
        spirit[room.limit] = record;
      }
      this.accounts.set(token, account);
    }
    this.duelUsers(room.scope);
  }

  private submit(room: FlashRoom, name: string, request: XmlNode): void {
    const battle = room.battle!;
    try {
      battle.submit(name, request);
    } finally {
      room.players = battle.players;
    }
    this.flush(room);
  }

  private expireSpiritRecoveries(): void {
    for (const room of this.rooms.values()) {
      for (const [name, deadline] of room.recoveryUntil ?? []) {
        if (Date.now() >= deadline) {
          room.recoveryUntil!.delete(name);
          const player = room.players.find((candidate) => candidate.name === name)!;
          player.lost = true;
          player.dead = true;
          room.battle!.over = true;
          this.settleMode(room, name);
        }
      }
    }
  }

  tick(): void {
    this.expireSpiritRecoveries();
    for (const room of this.rooms.values()) {
      if (!room.users.size && room.battle?.over) {
        this.rooms.delete(room.id);
        continue;
      }
      if (room.battle && !room.battle.over) {
        try {
          if (room.battle.stepBot()) {
            this.flush(room);
          }
        } catch {
          // A bot may have no valid combination after an illusion changes its hand.
          // Human sessions remain usable; the next tick can select another action.
        }
      }
    }
  }

  disconnect(session: FlashSession): void {
    if (!this.sessions.has(session)) {
      return;
    }
    this.duelQueue.delete(session);
    if (session.mode === 'DUEL' && session.room?.battle && !session.room.battle.over) {
      session.room.battle.forfeit(session.name);
      this.flush(session.room);
    }
    const canRecoverSpirit = session.version === '2013' && session.mode === 'SPIRIT'
      && session.room?.battle && !session.room.battle.over;
    if (canRecoverSpirit) {
      (session.room!.recoveryUntil ??= new Map()).set(session.name, Date.now() + flashSpiritRecoveryInterval);
    } else if (session.mode === 'SPIRIT' && session.room && !session.room.settled) {
      this.settleMode(session.room, session.name);
    }
    this.leave(session, Boolean(canRecoverSpirit));
    this.sessions.delete(session);
    this.duelUsers(session.scope);
    this.lobbyBroadcast(session.scope, element('REMOVE_USER', element('user', tag('name', session.name))));
  }

  resync(session: FlashSession): void {
    if (session.room && this.sessions.has(session)) {
      this.sendRoomSnapshot(session, session.room);
    }
  }

  private createRoom(session: FlashSession, name: string, password: string, limit: number, fast: boolean): FlashRoom {
    const room: FlashRoom = {
      id: this.nextRoomId++, scope: session.scope, name, password, limit, fast, language: session.language, version: session.version,
      time: Date.now(), users: new Set(), players: [], finished: new Set(), mode: session.mode,
    };
    this.rooms.set(room.id, room);
    return room;
  }

  private join(session: FlashSession, room: FlashRoom): void {
    room.users.add(session);
    session.room = room;
    const player = room.players.find((candidate) => candidate.name === session.name);
    if (player) {
      player.bot = false;
      player.finished = false;
      room.finished.delete(player.name);
    }
    this.sendRoomSnapshot(session, room);
    const newUser = element('user', tag('name', session.name));
    for (const user of room.users) {
      if (user !== session) {
        user.send(element('ADD_USER', newUser));
      }
    }
    if (room.users.size === 1 && !room.battle) {
      this.lobbyBroadcast(room.scope, element('ADD_USER', newUser + this.roomXml(room)));
    } else {
      this.lobbyBroadcast(room.scope, element('ADD_USER', newUser + tag('roomID', room.id)));
    }
  }

  private sendRoomSnapshot(session: FlashSession, room: FlashRoom): void {
    const needsUserListUpdate = room.mode === 'FREE_FIGHT';
    session.send(this.roomSnapshot(session, room, needsUserListUpdate));
    if (needsUserListUpdate) {
      // ENTER stores users without drawing them in the original Flash clients.
      // Add the recipient last so ADD_USER draws the complete list exactly once.
      session.send(element('ADD_USER', element('user', tag('name', session.name))));
    }
  }

  private roomSnapshot(session: FlashSession, room: FlashRoom, excludeRecipient = false): string {
    const player = room.players.find((candidate) => candidate.name === session.name);
    const game = room.battle?.snapshot(player) ?? element('game', element('players', room.players.map(playerXml).join('')));
    const users = [...room.users].filter((user) => !excludeRecipient || user !== session)
      .map((user) => element('user', tag('name', user.name)
      + (session.filtered.has(user.name) ? tag('isFiltered') : ''))).join('');
    return element('ENTER', element('room', tag('name', room.name) + tag('playersLimit', room.limit)
      + (room.fast ? tag('isFast') : '') + (room.needsCharge ? tag('needsCharge') : '') + users + game));
  }

  private leave(session: FlashSession, recovering = false): void {
    const room = session.room;
    if (!room) {
      return;
    }
    room.users.delete(session);
    session.filtered.clear();
    for (const user of room.users) {
      user.filtered.delete(session.name);
    }
    session.room = undefined;
    const player = room.players.find((candidate) => candidate.name === session.name);
    if (player) {
      if (room.battle) {
        player.bot = !recovering;
        if (!recovering) {
          room.finished.add(player.name);
        }
      } else {
        room.players.splice(room.players.indexOf(player), 1);
      }
    }
    if (room.mode === 'FREE_FIGHT' || room.mode === 'TRAINING') {
      this.roomBroadcast(room, element('REMOVE_USER', tag('name', session.name)));
    }
    this.lobbyBroadcast(room.scope, element('REMOVE_USER', tag('roomID', room.id)
      + element('user', tag('name', session.name))));
    const keepsRecoverableGame = recovering || (room.mode === 'FREE_FIGHT' && room.battle && !room.battle.over);
    if (!room.users.size && !keepsRecoverableGame) {
      this.rooms.delete(room.id);
    } else {
      this.finishIfReady(room);
    }
  }

  private chargeFreeFight(room: FlashRoom): boolean {
    const entrants = [...room.users].filter((session) => room.players.some((player) => player.name === session.name));
    const charges = new Map<string, number>();
    for (const entrant of entrants) {
      if (entrant.accountToken) {
        charges.set(entrant.accountToken, (charges.get(entrant.accountToken) ?? 0) + legacyFreeFightEntryCost);
      }
    }
    const missingAccount = entrants.some((entrant) => !entrant.accountToken) || entrants.length !== room.players.length;
    const insufficientFunds = [...charges].some(([token, charge]) => this.accounts.get(token).credits < charge);
    if (missingAccount || insufficientFunds) {
      for (const player of room.players) {
        if (player.ready) {
          player.ready = false;
          this.roomBroadcast(room, element('ADD_PLAYER', element('player', tag('name', player.name) + tag('isReady'))));
        }
      }
      for (const entrant of entrants) {
        const token = entrant.accountToken;
        const cannotPay = token && this.accounts.get(token).credits < charges.get(token)!;
        let reason: ModeEntryRejection = 'opponentUnavailable';
        if (!token) {
          reason = 'loginRequired';
        } else if (cannotPay) {
          reason = 'insufficientFunds';
        }
        this.rejectModeEntry(entrant, reason);
      }
      return false;
    }
    for (const [token, charge] of charges) {
      const account = this.accounts.get(token);
      account.credits -= charge;
      this.accounts.set(token, account);
    }
    room.participants = new Map(entrants.map((session) => [session.name, session.accountToken!]));
    room.settled = false;
    return true;
  }

  private start(room: FlashRoom): void {
    if (room.mode === 'FREE_FIGHT') {
      room.participants = undefined;
      if (room.needsCharge && !this.chargeFreeFight(room)) {
        return;
      }
    }
    room.bookSettled = false;
    room.bookParticipants = new Map([...room.users]
      .filter((session) => session.accountToken
        && room.players.some((player) => player.name === session.name && !player.bot))
      .map((session) => [session.name, session.accountToken!]));
    room.battle = new FlashBattle(room.players, new Random(Math.floor(this.random.value('flashBattleSeed') * seedRange)), room.version);
    room.battle.start();
    room.players = room.battle.players;
    room.time = Date.now();
    this.lobbyBroadcast(room.scope, element('START_GAME', tag('roomID', room.id) + tag('time', room.time)));
    this.flush(room);
  }

  private settleBook(room: FlashRoom): void {
    const awardsBookScore = room.mode === 'DUEL' || room.mode === 'SPIRIT'
      || (room.version === '2010' && room.needsCharge);
    if (!awardsBookScore || room.bookSettled || !room.battle?.over) {
      return;
    }
    room.bookSettled = true;
    const winners = room.players.filter((player) => !player.lost);
    if (!winners.length) {
      return;
    }
    const score = Math.floor(room.players.length / winners.length);
    for (const winner of winners.filter((player) => !player.bot)) {
      const token = room.bookParticipants?.get(winner.name);
      if (token) {
        if (room.version === '2010') {
          this.accounts.addBook2010Score(token, score);
        } else {
          this.accounts.addBookScore(token, score);
        }
      }
    }
  }

  private flush(room: FlashRoom): void {
    if (room.battle!.over) {
      this.settleMode(room);
      this.settleBook(room);
    }
    for (const message of room.battle!.drain()) {
      for (const session of room.users) {
        const intendedRecipient = !message.recipient || session.name === message.recipient;
        const excludedRecipient = message.exceptRecipients?.includes(session.name) ?? false;
        if (intendedRecipient && !excludedRecipient) {
          session.send(message.xml);
        }
      }
      if (!message.recipient && message.xml.startsWith('<DIE>')) {
        this.lobbyBroadcast(room.scope, message.xml.replace('<DIE>', `<DIE>${tag('roomID', room.id)}`));
      }
    }
  }

  private finishIfReady(room: FlashRoom): void {
    if (room.mode === 'DUEL' || room.mode === 'SPIRIT') {
      return;
    }
    if (!room.battle?.over || !room.players.every((player) => player.bot || room.finished.has(player.name))) {
      return;
    }
    room.battle = undefined;
    room.players = [];
    room.finished.clear();
    room.time = Date.now();
    this.roomBroadcast(room, element('FINISH_GAME'));
    this.lobbyBroadcast(room.scope, element('FINISH_GAME', tag('roomID', room.id) + tag('time', room.time)));
  }

  private roomXml(room: FlashRoom): string {
    return element('room', tag('id', room.id) + tag('name', room.name) + tag('language', room.language)
      + tag('playersLimit', room.limit) + tag('time', room.time)
      + (room.password ? tag('hasPassword') : '') + (room.fast ? tag('isFast') : '')
      + (room.needsCharge ? tag('needsCharge') : '')
      + (room.battle && !room.battle.over ? tag('gamePlaying') : '') + room.players.map(playerXml).join(''));
  }

  private lobby(session: FlashSession): string {
    return element('ENTER', tag('lobby') + [...this.sessions].filter((user) => user.scope === session.scope)
      .map((user) => element('user', tag('name', user.name) + (user.room ? tag('roomID', user.room.id) : ''))).join('')
      + [...this.rooms.values()].filter((room) => room.scope === session.scope).map((room) => this.roomXml(room)).join(''));
  }

  private roomBroadcast(room: FlashRoom, xml: string): void {
    for (const session of room.users) {
      session.send(xml);
    }
  }

  private lobbyBroadcast(scope: string, xml: string, except?: FlashSession): void {
    for (const session of this.sessions) {
      const roomLobby = session.mode === 'FREE_FIGHT' || session.mode === 'TRAINING';
      if (roomLobby && session.scope === scope && !session.room && session !== except) {
        session.send(xml);
      }
    }
  }
}
