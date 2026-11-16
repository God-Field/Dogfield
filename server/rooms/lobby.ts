import type { Room, RoomPayload, StartUser } from '../types.ts';
import type { Random } from '../random.ts';
import { engine } from '../engine.ts';
import { requireValue } from '../errors.ts';
import { createTrainingBots } from './training-bots.ts';

export const allowedTiebreakValues = new Set<number | null>([
  null,
  ...engine.TIEBREAK_VALUES,
]);

export function makeEntry(room: Room, userId: string, team = 0): void {
  requireValue(
    Number.isInteger(team) &&
      team >= 0 &&
      team <= engine.MAX_TEAMS,
  );
  if (room.game) {
    return;
  }
  room.entries ??= [];
  const existingEntry = room.entries.find((entry) => entry.userId === userId);
  if (existingEntry) {
    if (existingEntry.team > 0 && team > 0) {
      existingEntry.team = team;
    }
    return;
  }
  requireValue(room.entries.length < engine.MAX_PLAYERS);
  room.entries.push({ userId, team });
}

export function shuffleTeams(room: Room, random: Random): void {
  requireValue(!room.game);
  const entryCount = (room.entries ?? []).length;
  const teamCount = Math.min(
    engine.MAX_TEAMS,
    Math.max(
      engine.MIN_TEAMS,
      Math.floor(entryCount / 2),
    ),
  );
  const shuffledEntries = random.shuffle(
    'teams',
    room.entries ?? [],
  );
  for (const [entryIndex, entry] of shuffledEntries.entries()) {
    entry.team = (entryIndex % teamCount) + 1;
  }
}

export function setTiebreak(room: Room, tiebreakGF: number): void {
  requireValue(
    !room.game &&
      (tiebreakGF === 0 || allowedTiebreakValues.has(tiebreakGF)),
  );
  if (tiebreakGF === 0) {
    delete room.tiebreakGF;
  } else {
    room.tiebreakGF = tiebreakGF;
  }
}

export function selectGameUsers(
  room: Room,
  mode: string,
  member: Room['users'][number],
  payload: RoomPayload,
  random: Random,
): StartUser[] | null {
  const userId = member.id;
  if (mode === 'training') {
    requireValue(
      typeof payload.playerCount === 'number' &&
        Number.isInteger(payload.playerCount) &&
        payload.playerCount >= engine.MIN_PLAYERS &&
        payload.playerCount <= engine.MAX_PLAYERS &&
        allowedTiebreakValues.has(payload.gf ?? null),
    );
    const existingUsers: StartUser[] = [
      {
        userId: userId,
        name: member.name,
      },
    ];
    const language =
      typeof payload.lang === 'string' ? payload.lang : 'en';
    return [
      ...existingUsers,
      ...createTrainingBots(
        payload.playerCount - 1,
        existingUsers.map((user) => user.name),
        random,
        language,
      ),
    ];
  }

  const entries = room.entries ?? [];
  if (entries.length < engine.MIN_PLAYERS) {
    return null;
  }
  const teams = new Set(entries.map((entry) => entry.team));
  const hasSoloEntry = teams.has(0);
  const hasValidSoloEntries = teams.size === 1;
  const hasValidTeamEntries =
    teams.size >= engine.MIN_TEAMS &&
    teams.size !== entries.length;
  const canStart = hasSoloEntry
    ? hasValidSoloEntries
    : hasValidTeamEntries;
  if (!canStart) {
    return null;
  }
  return entries.map((entry) => ({
    userId: entry.userId,
    name: room.users.find((user) => user.id === entry.userId)!.name,
    ...(entry.team
      ? {
          team: entry.team,
        }
      : {}),
  }));
}
