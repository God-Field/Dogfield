import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { StoredDocument, Room, DuelRecord, Game } from './types.ts';
interface SavedState {
  docs: [string, StoredDocument][];
  accounts: [
    string,
    {
      uid: string;
    },
  ][];
  rooms: [
    string,
    {
      owner: string;
      banned: string[];
    },
  ][];
  gameStates?: [string, Game['serverTurn']][];
}

const isRoomPath = (path: string) =>
  /^modes\/[^/]+\/rooms\/[^/]+$/.test(path);
export class Store extends EventEmitter {
  private docs = new Map<string, StoredDocument>();
  accounts = new Map<
    string,
    {
      uid: string;
    }
  >();
  rooms = new Map<
    string,
    {
      owner: string;
      banned: string[];
    }
  >();
  private gameStates = new Map<string, Game['serverTurn']>();
  constructor(readonly file: string | null = null) {
    super();
    if (file) {
      try {
        const data: SavedState = JSON.parse(readFileSync(file, 'utf8'));
        this.docs = new Map(data.docs);
        this.accounts = new Map(data.accounts);
        this.rooms = new Map(data.rooms);
        this.gameStates = new Map(data.gameStates ?? []);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )) {
          throw error;
        }
      }
    }
  }

  get<Document extends StoredDocument = StoredDocument>(
    path: string,
  ): Document | null {
    const document = this.docs.get(path);
    return document === undefined ? null : structuredClone(document) as Document;
  }

  /** Store and publish a snapshot without mutating the supplied document. */
  set(path: string, value: StoredDocument) {
    const snapshot = structuredClone(value);
    if (isRoomPath(path)) {
      const room = snapshot as Room;
      if (room.game?.serverTurn === undefined) {
        this.gameStates.delete(path);
      } else {
        this.gameStates.set(path, structuredClone(room.game.serverTurn));
        delete room.game.serverTurn;
      }
      if (room.game?.attacks) {
        for (const attack of room.game.attacks) {
          delete (attack as { serverTurn?: unknown }).serverTurn;
        }
      }
    }
    this.docs.set(path, snapshot);
    this.emit(path, structuredClone(snapshot));
  }

  /** Returns an isolated room snapshot with its private battle scheduler restored. */
  getRoomForUpdate(path: string): Room | null {
    const room = this.get<Room>(path);
    if (!room) {
      return null;
    }
    const gameState = this.getGameState(path);
    if (room.game && gameState !== undefined) {
      room.game.serverTurn = gameState;
    }
    return room;
  }

  getGameState(path: string): Game['serverTurn'] | undefined {
    const gameState = this.gameStates.get(path);
    return gameState === undefined ? undefined : structuredClone(gameState);
  }

  delete(path: string) {
    this.gameStates.delete(path);
    this.docs.delete(path);
    this.emit(path, null);
  }

  *roomDocuments(): Generator<[string, Room]> {
    for (const [path, value] of this.docs) {
      if (isRoomPath(path)) {
        yield [path, structuredClone(value) as Room];
      }
    }
  }

  *recordDocuments(): Generator<[string, DuelRecord]> {
    for (const [path, value] of this.docs) {
      if (path.startsWith('records/')) {
        yield [path, structuredClone(value) as DuelRecord];
      }
    }
  }

  save() {
    if (!this.file) {
      return;
    }
    mkdirSync(dirname(this.file), {
      recursive: true,
    });
    writeFileSync(
      this.file + '.tmp',
      JSON.stringify({
        docs: [...this.docs],
        accounts: [...this.accounts],
        rooms: [...this.rooms],
        gameStates: [...this.gameStates],
      }),
      {
        mode: 0o600,
      },
    );
    renameSync(this.file + '.tmp', this.file);
  }
}
