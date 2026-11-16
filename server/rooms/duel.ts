import type { Random } from '../random.ts';
import type { DuelRecord, Game, Room } from '../types.ts';
import type { Store } from '../store.ts';
import { startBattle } from '../battle/battle.ts';

export const DUEL_RATING_DIFFERENCE_LIMIT = 200;
const DUEL_RATING_CENTER = 16;
const DUEL_RATING_SLOPE = 0.0114;

/**
 * Official Royal Duel gain. The live service matches players within a
 * +/-200 rating band and applies a linear approximation of the ELO curve.
 * Clamping the difference keeps direct record updates and test games in the
 * same 14-18 gain range as normal matchmaking.
 */
export function duelWinnerGain(
  winnerRating: number,
  loserRating: number,
): number {
  const ratingDifference = Math.max(
    -DUEL_RATING_DIFFERENCE_LIMIT,
    Math.min(
      DUEL_RATING_DIFFERENCE_LIMIT,
      loserRating - winnerRating,
    ),
  );
  return Math.round(
    DUEL_RATING_CENTER + DUEL_RATING_SLOPE * ratingDifference,
  );
}

/**
 * Official duel updates are exactly zero-sum: one gain is computed for the
 * winner and the loser receives its negation. A win by an auto-played seat
 * leaves both gains at zero, while the games are still counted.
 */
export function applyDuelRatingGains(game: Game): void {
  const winner = game.players.find((player) => !player.dead);
  const loser =
    winner === undefined
      ? undefined
      : game.players.find((player) => player.id !== winner.id);
  const gains = new Map<number, number>();
  if (winner !== undefined && loser !== undefined && !winner.isBot) {
    const winnerGain = duelWinnerGain(
      winner.rating ?? 0,
      loser.rating ?? 0,
    );
    gains.set(winner.id, winnerGain);
    gains.set(loser.id, -winnerGain);
  }
  for (const player of game.players) {
    player.ratingGain = gains.get(player.id) ?? 0;
  }
}

export function recordDuel(store: Store, game: Game): void {
  applyDuelRatingGains(game);
  for (const player of game.players) {
    const opponent = game.players.find(
      (candidateOpponent) => candidateOpponent.id !== player.id,
    )!;
    const previousRecord: Partial<DuelRecord> =
      store.get<DuelRecord>(`records/${player.userId}`) ?? {};
    store.set(`records/${player.userId}`, {
      userName: player.name,
      rating: (previousRecord.rating ?? 0) + (player.ratingGain ?? 0),
      gameCount: (previousRecord.gameCount ?? 0) + 1,
      matchedUserIds: [opponent.userId],
      updatedAt: new Date().toISOString(),
      rankingExpireAt: new Date(Date.now() + 86400000).toISOString(),
    });
  }
  const rankedUsers = [...store.recordDocuments()]
    .map(([path, duelRecord]) => ({
      userId: path.slice(8),
      ...duelRecord,
    }))
    .sort(
      (firstRecord, secondRecord) => secondRecord.rating - firstRecord.rating,
    );
  store.set('rankings/duel', {
    records: rankedUsers,
  });
}

export function matchDuel(
  store: Store,
  userId: string,
  userName: string,
  random: Random,
): { roomId: string; room: Room } | null {
  const joiningRating =
    store.get<DuelRecord>(`records/${userId}`)?.rating ?? 0;
  for (const [path, room] of store.roomDocuments()) {
    if (
      !path.startsWith('modes/duel/rooms/') ||
      room.game ||
      room.users.length !== 1 ||
      room.users[0].id === userId
    ) {
      continue;
    }
    const waitingRating =
      store.get<DuelRecord>(
        `records/${room.users[0].id}`,
      )?.rating ?? 0;
    if (
      Math.abs(waitingRating - joiningRating) >
      DUEL_RATING_DIFFERENCE_LIMIT
    ) {
      continue;
    }
    const roomId = path.split('/')[3];
    const matchedUser: Room['users'][number] = {
      id: userId,
      name: userName,
    };
    room.users.push(matchedUser);
    room.game = startBattle(
      room.users.map((user) => ({
        userId: user.id,
        name: user.name,
        alias: user.name.slice(0, 6),
        rating:
          store.get<DuelRecord>(`records/${user.id}`)?.rating ?? 0,
      })),
      {
        random,
        tiebreakGF: 150,
      },
    );
    return {
      roomId,
      room,
    };
  }
  return null;
}
