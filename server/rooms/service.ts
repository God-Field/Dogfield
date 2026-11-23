import type { Room, RoomPayload, Game, DuelRecord } from '../types.ts';
import { Store } from '../store.ts';
import { isDeepStrictEqual } from 'node:util';
import { engine } from '../engine.ts';
import { openBattle, startBattle, type Battle } from '../battle/battle.ts';
import {
  makeEntry,
  selectGameUsers,
  setTiebreak,
  shuffleTeams,
} from './lobby.ts';
import { Random } from '../random.ts';
import { requireValue, HttpError } from '../errors.ts';
import { createRandomId } from '../ids.ts';
import {
  ownerOnlyActions,
  parseRoomPayload,
  requireModeAction,
} from './requests.ts';
import { matchDuel, recordDuel } from './duel.ts';
import {
  DUEL_TURN_TIMEOUT_MS,
  PRIVATE_TURN_TIMEOUT_MS,
} from '../../src/domain/turn-timing.ts';

/** The official user-count document is refreshed by a minute-level aggregate. */
export const USER_COUNT_REFRESH_INTERVAL_MS = 60 * 1000;
/** Fits the live 48–52 second bracket; see tools/live-games/PLAYER_COUNTS.md. */
export const TRAINING_COUNT_ACTIVITY_WINDOW_MS = 50 * 1000;
/** Best fit for the Royal Duel probe; see tools/live-games/PLAYER_COUNTS.md. */
export const DUEL_COUNT_ACTIVITY_WINDOW_MS = 50 * 1000;
/** Fits the live 198–203 second private room activity bracket. */
export const PRIVATE_COUNT_ACTIVITY_WINDOW_MS = 200 * 1000;
export const TURN_TIMEOUT_GRACE_MS = 2 * 1000;
const MAX_CHAT_MESSAGE_CODE_POINTS = 50;
const CHAT_MESSAGE_EDGE_WHITESPACE = /^[\s\u0085]|[\s\u0085]$/u;

function touchMember(
  member: Room['users'][number],
  mode: string = 'private',
): void {
  if (mode === 'private') {
    member.updatedAt = new Date().toISOString();
  } else {
    delete member.updatedAt;
  }
}

function isRoomActive(room: Room, now: number, windowMs: number): boolean {
  const updatedAt = Date.parse(room.updatedAt ?? '');
  return Number.isFinite(updatedAt) && updatedAt > now - windowMs;
}

function sameUserCounts(
  previous: Record<string, number> | null,
  next: Record<string, number>,
): boolean {
  if (previous === null) {
    return false;
  }
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  return (
    previousKeys.length === nextKeys.length &&
    nextKeys.every((modeName) => previous[modeName] === next[modeName])
  );
}

function roomActivityState(room: Room) {
  const activityState = structuredClone(room);
  delete activityState.updatedAt;
  delete activityState.userCount;
  for (const user of activityState.users) {
    delete user.updatedAt;
  }
  return activityState;
}

function roomActivityChanged(previousRoom: Room, nextRoom: Room): boolean {
  return !isDeepStrictEqual(
    roomActivityState(previousRoom),
    roomActivityState(nextRoom),
  );
}

export class RoomService {
  constructor(
    readonly store: Store,
    {
      random = new Random(),
    }: {
      random?: Random;
    } = {},
  ) {
    this.random = random;
    this.publishUserCounts();
  }

  readonly random: Random;
  lastUserCountPublishAt = 0;

  path(mode: string, roomId: string) {
    return `modes/${mode}/rooms/${roomId}`;
  }

  publish(
    mode: string,
    roomId: string,
    room: Room,
    refreshRoomActivity = true,
  ) {
    const path = this.path(mode, roomId);
    room.userCount = room.users.length;
    if (refreshRoomActivity) {
      room.updatedAt = new Date().toISOString();
    }
    const deniedUserIds = this.store.rooms.get(path)?.banned ?? [];
    if (deniedUserIds.length) {
      room.deniedUserIds = [...deniedUserIds];
    } else {
      delete room.deniedUserIds;
    }
    this.store.set(path, room);
    this.store.save();
  }

  publishUserCounts(now = Date.now()) {
    let trainingCount = 0;
    let privateCount = 0;
    const usersByMode: Record<string, Set<string>> = {
      duel: new Set(),
    };
    for (const [path, storedRoom] of this.store.roomDocuments()) {
      const roomPathMatch =
        /^modes\/(training|private|duel)\/rooms\/[^/]+$/.exec(path);
      if (roomPathMatch) {
        const mode = roomPathMatch[1];
        if (mode === 'training') {
          if (!isRoomActive(storedRoom, now, TRAINING_COUNT_ACTIVITY_WINDOW_MS)) {
            continue;
          }
          trainingCount += storedRoom.users.length;
          continue;
        }
        if (mode === 'private') {
          if (!isRoomActive(storedRoom, now, PRIVATE_COUNT_ACTIVITY_WINDOW_MS)) {
            continue;
          }
          privateCount += storedRoom.users.length;
          continue;
        }
        if (!isRoomActive(storedRoom, now, DUEL_COUNT_ACTIVITY_WINDOW_MS)) {
          continue;
        }
        for (const user of storedRoom.users) {
          usersByMode[roomPathMatch[1]].add(user.id);
        }
      }
    }
    const counts = {
      training: trainingCount,
      private: privateCount,
      ...Object.fromEntries(
        Object.entries(usersByMode).map(([modeName, users]) => [
          modeName,
          users.size,
        ]),
      ),
    };
    this.lastUserCountPublishAt = now;
    const previous = this.store.get<Record<string, number>>(
      'status/user_count',
    );
    if (sameUserCounts(previous, counts)) {
      return false;
    }
    this.store.set('status/user_count', counts);
    this.store.save();
    return true;
  }

  refreshUserCounts(now = Date.now()) {
    if (
      now - this.lastUserCountPublishAt <
      USER_COUNT_REFRESH_INTERVAL_MS
    ) {
      return false;
    }
    this.publishUserCounts(now);
    return true;
  }

  invoke(action: string, userId: string, input: unknown = {}) {
    const payload = parseRoomPayload(action, input);
    if (action === 'update-account') {
      return null;
    }
    if (action === 'get-record') {
      const record = this.store.get<DuelRecord>(`records/${userId}`);
      return {
        rating: typeof record?.rating === 'number' ? record.rating : 0,
        gameCount: typeof record?.gameCount === 'number' ? record.gameCount : 0,
      };
    }
    if (action === 'create-room') {
      return this.createRoom(userId, payload);
    }
    const { mode, roomId } = payload;
    requireValue(typeof mode === 'string');
    requireValue(typeof roomId === 'string');
    const path = this.path(mode, roomId);
    const room = this.store.getRoomForUpdate(path);
    requireValue(room, 404);
    const previousRoom = structuredClone(room);
    const roomMetadata = structuredClone(this.store.rooms.get(path));
    requireValue(roomMetadata, 404);
    requireModeAction(mode, action);
    if (action === 'leave-room') {
      const isRoomMember = room.users.some((user) => user.id === userId);
      if (!isRoomMember) {
        return null;
      }
    }
    if (action === 'join-room') {
      this.joinRoom(room, mode, userId, payload, roomMetadata.banned);
    } else {
      const member = room.users.find((user) => user.id === userId);
      requireValue(member, 403);
      if (ownerOnlyActions.has(action)) {
        requireValue(roomMetadata.owner === userId, 403);
      }
      if (action === 'kick-user' && this.hasExplicitKickTarget(payload)) {
        requireValue(roomMetadata.owner === userId, 403);
      }
      switch (action) {
        case 'leave-room':
          this.removeMember(room, userId);
          break;
        case 'keep-alive':
          touchMember(member, mode);
          break;
        case 'kick-user': {
          if (this.hasExplicitKickTarget(payload)) {
            const kickedUserId = payload.userId as string;
            this.removeMember(room, kickedUserId);
            roomMetadata.banned.push(kickedUserId);
            break;
          }
          if (!this.kickTimedOutPlayer(room, mode, userId)) {
            return null;
          }
          break;
        }
        case 'make-entry':
          makeEntry(room, userId, payload.team ?? 0);
          touchMember(member);
          break;
        case 'cancel-entry':
          if (!room.game) {
            room.entries = (room.entries ?? []).filter(
              (entry) => entry.userId !== userId,
            );
          }
          touchMember(member);
          break;
        case 'shuffle-teams':
          shuffleTeams(room, this.random);
          break;
        case 'set-tiebreak':
          setTiebreak(room, payload.gf ?? 0);
          break;
        case 'set-room-locked':
          if (payload.isLocked === true) {
            room.isLocked = true;
          } else {
            delete room.isLocked;
          }
          break;
        case 'reset-game':
          requireValue(room.game?.isOver, 403);
          delete room.game;
          break;
        case 'start-game':
          if (mode === 'training' && room.game) {
            return null;
          }
          this.startGame(room, mode, member, payload);
          break;
        case 'submit-command': {
          requireValue(room.game, 403);
          if (payload.updateCount !== undefined) {
            requireValue(payload.updateCount === room.game.updateCount);
          }
          this.openRoomBattle(room.game).submit(userId, payload.command, true);
          touchMember(member, mode);
          if (mode === 'duel' && room.game.isOver) {
            this.recordDuel(room.game);
          }
          break;
        }
        case 'post-message':
          this.postMessage(path, room, userId, payload);
          break;
        default:
          throw new HttpError(400);
      }
    }
    if (
      !room.users.some((user) => user.id === roomMetadata.owner) &&
      room.users.length
    ) {
      roomMetadata.owner = room.users[0].id;
    }
    this.store.rooms.set(path, roomMetadata);
    this.publish(
      mode,
      roomId,
      room,
      roomActivityChanged(previousRoom, room),
    );
    return null;
  }

  private joinRoom(
    room: Room,
    mode: string,
    userId: string,
    payload: RoomPayload,
    bannedUserIds: readonly string[],
  ): void {
    requireValue(
      typeof payload.userName === 'string' && payload.userName.length > 0,
    );
    requireValue(
      !bannedUserIds.includes(userId) &&
        !room.isLocked &&
        !room.users.some(
          (user) => user.id !== userId && user.name === payload.userName,
        ),
      403,
    );
    let joinedMember = room.users.find((user) => user.id === userId);
    if (!joinedMember) {
      joinedMember = { id: userId, name: payload.userName };
      room.users.push(joinedMember);
    }
    touchMember(joinedMember, mode);
    const player = room.game?.players.find(
      (candidatePlayer) => candidatePlayer.userId === userId,
    );
    if (player) {
      delete player.isBot;
    }
  }

  private removeMember(room: Room, userId: string): void {
    room.users = room.users.filter((user) => user.id !== userId);
    room.entries = room.entries?.filter((entry) => entry.userId !== userId);
    const player = room.game?.players.find(
      (candidatePlayer) => candidatePlayer.userId === userId,
    );
    if (!player) {
      return;
    }
    player.isBot = true;
    if (!room.game || room.game.isOver) {
      return;
    }
    const battle = this.openRoomBattle(room.game);
    if (battle.expectedCommandPlayerId === player.id && room.users.length > 0) {
      this.stepRoomBots(battle);
    }
  }

  private hasExplicitKickTarget(payload: RoomPayload): boolean {
    return typeof payload.userId === 'string' && payload.userId.length > 0;
  }

  private kickTimedOutPlayer(
    room: Room,
    mode: string,
    requestingUserId: string,
  ): boolean {
    const game = room.game;
    if (!game || game.isOver || mode === 'training') {
      return false;
    }
    let turnTimeoutMs: number;
    if (mode === 'private') {
      turnTimeoutMs = PRIVATE_TURN_TIMEOUT_MS;
    } else if (mode === 'duel') {
      turnTimeoutMs = DUEL_TURN_TIMEOUT_MS;
    } else {
      return false;
    }
    const turnStartedAt = Date.parse(game.updatedAt ?? '');
    const elapsedTurnMs = Date.now() - turnStartedAt;
    if (
      !Number.isFinite(turnStartedAt) ||
      elapsedTurnMs < turnTimeoutMs + TURN_TIMEOUT_GRACE_MS
    ) {
      return false;
    }
    const battle = this.openRoomBattle(game);
    const expectedPlayer = battle.findPlayer(battle.expectedCommandPlayerId);
    if (
      !expectedPlayer?.userId ||
      expectedPlayer.isBot ||
      expectedPlayer.userId === requestingUserId ||
      !room.users.some((member) => member.id === expectedPlayer.userId)
    ) {
      return false;
    }
    this.removeMember(room, expectedPlayer.userId);
    return true;
  }

  private openRoomBattle(game: Game): Battle {
    return openBattle(game, this.random);
  }

  private stepRoomBots(battle: Battle): void {
    const game = battle.game;
    const previousEvents = game.events;
    game.events = [];
    battle.stepBots();
    if (game.events.length > 0) {
      game.updateCount++;
      game.updatedAt = new Date().toISOString();
    } else {
      game.events = previousEvents;
    }
  }

  private startGame(
    room: Room,
    mode: string,
    member: Room['users'][number],
    payload: RoomPayload,
  ): void {
    if (room.game) {
      requireValue(mode === 'training');
      return;
    }
    const users = selectGameUsers(room, mode, member, payload, this.random);
    if (users === null) {
      return;
    }
    room.tiebreakGF =
      mode === 'training'
        ? (payload.gf ?? null)
        : (room.tiebreakGF ?? null);
    room.game = startBattle(users, {
      random: this.random,
      tiebreakGF: room.tiebreakGF,
      stepBots: true,
    });
    delete room.entries;
  }

  private postMessage(
    path: string,
    room: Room,
    userId: string,
    payload: RoomPayload,
  ): void {
    requireValue(typeof payload.text === 'string');
    const text = payload.text;
    const textCodePointCount = Array.from(text).length;
    const hasEdgeWhitespace = CHAT_MESSAGE_EDGE_WHITESPACE.test(text);
    requireValue(
      text.length > 0 &&
        textCodePointCount <= MAX_CHAT_MESSAGE_CODE_POINTS &&
        !hasEdgeWhitespace,
    );
    const team = payload.team ?? 0;
    requireValue(
      Number.isInteger(team) &&
        team >= 0 &&
        team <= engine.MAX_TEAMS,
    );
    if (team !== 0) {
      const player = room.game?.players.find(
        (candidatePlayer) => candidatePlayer.userId === userId,
      );
      if (!player || player.team !== team) {
        return;
      }
    }
    const channel = team === 0 ? 'all' : `team${team}`;
    this.store.set(`${path}/messages/${channel}`, {
      userId,
      text,
      updatedAt: new Date().toISOString(),
    });
  }

  createRoom(userId: string, { mode, userName, password }: RoomPayload) {
    requireValue(typeof mode === 'string');
    requireValue(
      typeof userName === 'string' &&
        userName.length > 0 &&
        userName.length <= 100,
    );
    if (mode === 'private') {
      requireValue(typeof password === 'string' && password.length > 0);
      for (const [path, room] of this.store.roomDocuments()) {
        if (
          path.startsWith('modes/private/rooms/') &&
          !path.includes('/messages/') &&
          room.password === password
        ) {
          return {
            roomId: path.split('/')[3],
          };
        }
      }
    }
    if (mode === 'duel') {
      const match = matchDuel(this.store, userId, userName, this.random);
      if (match) {
        this.publish('duel', match.roomId, match.room);
        return { roomId: match.roomId };
      }
    }
    const roomId = createRandomId(20);
    const path = this.path(mode, roomId);
    const creator: Room['users'][number] = {
      id: userId,
      name: userName,
    };
    touchMember(creator, mode);
    const room: Room = {
      users: [creator],
    };
    if (mode === 'private') {
      Object.assign(room, {
        password,
        entries: [],
        tiebreakGF: 100,
      });
    }
    this.store.rooms.set(path, {
      owner: userId,
      banned: [],
    });
    this.publish(mode, roomId, room);
    return {
      roomId: roomId,
    };
  }

  recordDuel(game: Game) {
    recordDuel(this.store, game);
  }

  advanceBotTurns() {
    for (const [path, storedRoom] of this.store.roomDocuments()) {
      try {
        if (!storedRoom.game || storedRoom.game.isOver) {
          continue;
        }
        const room = this.store.getRoomForUpdate(path);
        if (!room?.game) {
          continue;
        }
        const game = room.game;
        const battle = this.openRoomBattle(game);
        const botChoice = battle.botCommand();
        if (!botChoice) {
          continue;
        }
        try {
          battle.submitPlayerCommand(botChoice.player.id, botChoice.command);
        } catch (error) {
          if (!(error instanceof HttpError)) {
            console.error(`Error executing bot command in ${path}:`, error);
          }
          continue;
        }
        if (path.startsWith('modes/duel/') && game.isOver) {
          this.recordDuel(game);
        }
        const [, mode, , roomId] = path.split('/');
        this.publish(mode, roomId, room);
      } catch (error) {
        console.error(`Error advancing bot turns for room ${path}:`, error);
      }
    }
  }
}
