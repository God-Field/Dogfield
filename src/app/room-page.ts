import {roomAction} from '../services/protocol';
import {screen} from '../ui/theme';
import {RoomController} from '../rooms/room-controller';
import {GameModePrivate, type GameMode} from '../domain/enums';
import type {RoomUser} from '../domain/models';
import {decodeLobbyState} from '../domain/decode';
import {appendAll} from '../shared/collections';
import {Timestamp} from '../shared/timestamp';
import {getApplication, getSettings} from './runtime';
import type {HomePage} from './home-page';
import {renderGameView, renderLobbyView, renderPrivateRoomControls} from '../rooms/room-views';

type LobbyData = Map<string, unknown> & {documentState?: unknown};

export function createRoomController(mode: GameMode, roomId: string): RoomController {
  const users: RoomUser[] = [];
  const element = document.createElement('div');
  const room = new RoomController(mode, roomId, users, new Timestamp(Date.now(), 0, false), element);
  room.applyElementStyles(element, screen.height, null, 30, screen.width);
  room.openRoom();
  return room;
}

function hasRoomUser(users: {userId: string}[], userId: string | null): boolean {
  return users.some(user => user.userId === userId);
}

export function handleRoomEvent(room: RoomController): (data: LobbyData) => void {
  return data => {
    const application = getApplication();
    if (data.documentState === 0) {
      window.location.reload();
      return;
    }

    const lobby = decodeLobbyState(data);
    const users = lobby.users;
    if (!hasRoomUser(users, application.userId)) {
      handleMissingRoomUser(room, application);
      return;
    }

    room.users.length = 0;
    appendAll(room.users, users);

    const game = lobby.game;
    if (game === null) {
      const shouldContinue = renderLobbyView(room, lobby, application);
      if (!shouldContinue) {
        return;
      }
    } else {
      renderGameView(room, game);
    }

    application.isRestoringRoom = false;
    updateRoomHistory(room, application);
    if (room.mode === GameModePrivate) {
      renderPrivateRoomControls(room, lobby, application);
    }
  };
}

function handleMissingRoomUser(room: RoomController, application: HomePage): void {
  const wasRoomMember = room.findRoomUser(application.userId) !== null;
  if (wasRoomMember || application.isRestoringRoom) {
    application.isRestoringRoom = false;
    application.openHomePage(null);
    return;
  }

  if (room.isJoining) {
    return;
  }
  room.isJoining = true;
  room.updateRoomState(
    roomAction.joinRoom,
    true,
    new Map<string, unknown>([['userName', application.userName]]),
  ).catch(() => {
    room.isJoining = false;
  });
}

function updateRoomHistory(room: RoomController, application: HomePage): void {
  const settings = getSettings();
  const gamePage = room.gamePage;
  const isActivePlayer = gamePage !== null
    && gamePage.playerRoster.findPlayerStatById(application.userId) !== null
    && !gamePage.isOver;

  if (isActivePlayer) {
    settings.lastMode = room.mode;
    settings.lastRoomId = room.roomId;
    settings.lastGameUpdatedAt = new Timestamp(Date.now(), 0, false);
    settings.saveSettings();
  } else if (settings.lastRoomId !== null) {
    settings.clearRoomHistorySettings();
    settings.saveSettings();
  }
}
