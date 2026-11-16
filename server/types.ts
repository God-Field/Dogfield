
export type Stat = 'hp' | 'mp' | 'cp';

export interface Slot {
  id: number;
  modelId: number;
  fakeModelId?: number;
  used?: boolean;
}
export interface StartUser {
  name: string;
  userId?: string;
  team?: number;
  isBot?: boolean;
  alias?: string;
  rating?: number;
}
export interface Player extends StartUser {
  id: number;
  hp: number;
  mp: number;
  cp: number;
  items: Slot[];
  curses?: string[];
  guardian?: string;
  dead?: boolean;
  confusionCount?: number;
  ratingGain?: number;
}
export interface AttackItemSummary {
  modelId: number;
  name?: string;
  category?: string;
  commandType?: string;
}

export interface Attack {
  playerId: number;
  itemModelIds: number[];
  items?: AttackItemSummary[];
  targetPlayerId?: number;
  guardian?: string;
  atk?: number;
  hitRate?: number;
  mp?: number;
  cp?: number;
  buyingItemModelId?: number;
  buyingItemId?: number;
  reversed?: boolean;
}
export interface GameEvent {
  action: string;
  [field: string]: unknown;
}
export interface DyingAttack {
  playerId: number;
  itemId: number;
  modelId: number;
}
export interface Game {
  players: Player[];
  gf: number;
  attackTurnPlayerId: number;
  events: GameEvent[];
  updateCount: number;
  attacks?: Attack[];
  tiebreakGF?: number;
  isOver?: boolean;
  updatedAt?: string;
  diseasePlayerId?: number;
  guardianPlayerIds?: number[];
  dyingPlayerIds?: number[];
  serverTurn?: {
    diseaseDone?: boolean;
    guardians?: number[];
    dyingAttacks?: DyingAttack[];
    turnDeaths?: number[];
    buyingItemId?: number;
    sellingItemId?: number;
  };
}
export interface Command {
  itemIds?: number[];
  targetPlayerId?: number;
  bought?: boolean;
  mp?: number;
  cp?: number;
}
export interface Room {
  users: {
    id: string;
    name: string;
    updatedAt?: string;
  }[];
  entries?: {
    userId: string;
    team: number;
  }[];
  game?: Game;
  password?: string;
  tiebreakGF?: number | null;
  isLocked?: boolean;
  deniedUserIds?: string[];
  userCount?: number;
  updatedAt?: string;
}
export interface RoomPayload {
  mode?: string;
  roomId?: string;
  lang?: string;
  userName?: string;
  password?: string;
  userId?: string;
  team?: number;
  gf?: number | null;
  isLocked?: boolean;
  playerCount?: number;
  updateCount?: number;
  text?: string;
  command?: Command;
}
export interface DuelRecord {
  userName: string;
  rating: number;
  gameCount: number;
  matchedUserIds: (string | undefined)[];
  updatedAt: string;
  rankingExpireAt: string;
}
export type StoredDocument =
  | Room
  | DuelRecord
  | {
      [field: string]: unknown;
    };
