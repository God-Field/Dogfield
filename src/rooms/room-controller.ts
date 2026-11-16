import { roomAction, firestoreDocument } from '../services/protocol';
import { timestampWindow, duration } from '../ui/theme';
import { DisposablePanel } from '../ui/decorative';
import { GameMode, GameModePrivate } from '../domain/enums';
import { RoomUser } from '../domain/models';
import { Timestamp } from '../shared/timestamp';
import { assertPresent } from '../shared/values';
import { getApplication, getSettings } from '../app/runtime';
import { callCloudFunction, subscribeToFirestoreDocument } from '../services/firebase';
import { ignoreCancelledAnimation, runScheduledCallback } from '../ui/elements';
import { handleRoomEvent } from '../app/room-page';
import { createScreenBackground } from '../ui/assets';
import type { TrainingLobbyPanel } from './training-lobby';
import type { MatchmakingPage } from './matchmaking-page';
import type { LobbyUserList, RoomLockToggle } from './lobby-controls';
import type { ChatPanel } from '../chat/chat';
import type { LoadingDots } from '../battle/status-widgets';
import type { GamePageController } from '../battle/game-page';

export class RoomController extends DisposablePanel {
  unsubscribe: (() => void) | null = null;
  isClosed = false;
  isJoining = false;
  isLeaving = false;
  trainingLobby: TrainingLobbyPanel | null = null;
  matchmakingPage: MatchmakingPage | null = null;
  userList: LobbyUserList | null = null;
  lockToggle: RoomLockToggle | null = null;
  chatPanel: ChatPanel | null = null;
  loadingIndicator: LoadingDots | null = null;
  gamePage: GamePageController | null = null;

  constructor(
    public mode: GameMode,
    public roomId: string,
    public users: RoomUser[],
    public lastActivity: Timestamp,
    element: HTMLDivElement,
  ) {
    super(element);
  }
  openRoom(): void {
    this.domElement.append(createScreenBackground('room').domElement);
    this.unsubscribe = subscribeToFirestoreDocument(firestoreDocument.room(this.mode.key, this.roomId), handleRoomEvent(this));
    if (this.mode === GameModePrivate) runScheduledCallback(this.keepRoomAlive());
  }
  findRoomUser(userId: string | null): RoomUser | null { return this.users.find(user => user.userId === userId) ?? null; }
  getRoomUserName(userId: string | null): string | null { return this.findRoomUser(userId)?.displayName ?? null; }
  updateRoomState(action: string, refreshActivity: boolean, payload: Map<string, unknown> | null): Promise<null> {
    return this.callRoomAction(action, refreshActivity, payload);
  }
  sendRoomAction(action: string): Promise<null> { return this.updateRoomState(action, false, null); }
  sendRoomActionAndRefreshActivity(action: string, refreshActivity: boolean): Promise<null> { return this.updateRoomState(action, refreshActivity, null); }
  sendRoomActionWithPayload(action: string, payload: Map<string, unknown>): Promise<null> { return this.updateRoomState(action, false, payload); }
  async callRoomAction(action: string, refreshActivity: boolean, payload: Map<string, unknown> | null): Promise<null> {
    if (this.mode === GameModePrivate && refreshActivity) this.lastActivity = new Timestamp(Date.now(), 0, false);
    payload ??= new Map();
    payload.set('mode', this.mode.key);
    payload.set('roomId', this.roomId);
    getApplication();
    try {
      await callCloudFunction(action, payload);
    } catch {
      window.location.reload();
    }
    return null;
  }
  async leaveCurrentRoom(): Promise<null> {
    const settings = getSettings();
    settings.clearRoomHistorySettings();
    settings.saveSettings();
    const application = getApplication(), mode = application.mode;
    assertPresent(mode);
    switch (mode.index) {
      case 0:
        application.openHomePage(null);
        break;
      case 1:
        this.isLeaving = true;
        await this.sendRoomAction(roomAction.leaveRoom);
        break;
      case 2: {
        application.openHomePage(mode);
        const game = this.gamePage;
        if (game !== null && !game.isOver) {
          const player = game.playerRoster.findPlayerStatById(application.userId);
          if (player !== null && !player.dead) await this.sendRoomAction(roomAction.leaveRoom);
        }
        break;
      }
    }
    return null;
  }
  private async keepRoomAlive(): Promise<void> {
    while (!this.isClosed) {
      await ignoreCancelledAnimation(this.animateAsync(duration.roomTimeout));
      if (this.isClosed) break;
      const lastActivity = this.lastActivity, threshold = new Timestamp(Date.now(), 0, false).addMicroseconds(-timestampWindow.roomActivity);
      if (lastActivity.milliseconds < threshold.milliseconds || lastActivity.milliseconds === threshold.milliseconds && lastActivity.microsecondRemainder < threshold.microsecondRemainder) await this.sendRoomActionAndRefreshActivity(roomAction.keepAlive, true);
    }
  }
  override dispose(_unused?: unknown): void {
    this.isClosed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lockToggle?.dispose(0);
    this.chatPanel?.dispose(0);
    this.gamePage?.dispose(0);
    this.disposeElement(0);
  }
}
