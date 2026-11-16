import { GameMode, allGameModes as allGameModes } from '../domain/enums';
import { Timestamp, parseTimestamp } from '../shared/timestamp';
import { asMap, decodeJson } from '../shared/collections';
import { isInteger } from '../shared/values';

export class UserSettings {
  isMuted = false;
  volume: number | null = null;
  userName: string | null = null;
  trainingPlayerCount: number | null = null;
  trainingTiebreakGF: number | null = null;
  roomPassword: string | null = null;
  lastGameUpdatedAt: Timestamp | null = null;
  lastMode: GameMode | null = null;
  lastRoomId: string | null = null;

  loadSavedSettings(): void {
    const serialized = window.localStorage.getItem('godfield');
    if (serialized === null) return;
    const data = asMap(decodeJson(JSON.parse(serialized)));
    this.isMuted = data.get('isMute') === true;
    const integer = (key: string): number | null => {
      const value = data.get(key);
      return isInteger(value) ? value : null;
    };
    const text = (key: string): string | null => {
      const value = data.get(key);
      return typeof value === 'string' ? value : null;
    };
    this.volume = integer('volume');
    this.userName = text('userName');
    this.trainingPlayerCount = integer('trainingPlayerCount');
    this.trainingTiebreakGF = integer('trainingTiebreakGF');
    this.roomPassword = text('roomPassword');
    this.lastGameUpdatedAt = parseTimestamp(text('lastGameUpdatedAt') ?? '');
    this.lastMode = allGameModes.find(mode => mode.key === text('lastMode')) ?? null;
    this.lastRoomId = text('lastRoomId');
  }
  saveSettings(): void {
    const data: Record<string, string | number | boolean> = {};
    if (this.isMuted) data.isMute = true;
    if (this.volume !== null) data.volume = this.volume;
    if (this.userName !== null) data.userName = this.userName;
    if (this.trainingPlayerCount !== null) data.trainingPlayerCount = this.trainingPlayerCount;
    if (this.trainingTiebreakGF !== null) data.trainingTiebreakGF = this.trainingTiebreakGF;
    if (this.roomPassword !== null) data.roomPassword = this.roomPassword;
    if (this.lastGameUpdatedAt !== null) data.lastGameUpdatedAt = this.lastGameUpdatedAt.toString();
    if (this.lastMode !== null) data.lastMode = this.lastMode.key;
    if (this.lastRoomId !== null) data.lastRoomId = this.lastRoomId;
    window.localStorage.setItem('godfield', JSON.stringify(data));
  }
  clearRoomHistorySettings(): void {
    this.lastGameUpdatedAt = null;
    this.lastMode = null;
    this.lastRoomId = null;
  }
}
