import {surfaceSize, radius, opacity, screen, duration} from '../ui/theme';
import {colors} from '../ui/palette';
import {LOCK_ICON} from '../ui/icons';
import {
  createAnimatedContainer,
  createImageContainer,
  createTextElement,
  runScheduledCallback,
} from '../ui/elements';
import {BattleBoard} from '../battle/board';
import {BattleEffects} from '../battle/effects';
import {CommandRules} from '../battle/command-rules';
import {GamePageController} from '../battle/game-page';
import {ItemActionPanel, ItemCommandOverlay} from '../battle/item-commands';
import {PlayerRoster} from '../battle/player-roster';
import {TurnController} from '../battle/turn-controller';
import {LoadingDots, createUsedMiraclesCounter} from '../battle/status-widgets';
import {createTiebreakBadge} from '../ui/stat-widgets';
import {createChatPanel} from '../chat/chat';
import {LobbyUserList, RoomLockDialog, RoomLockToggle} from './lobby-controls';
import {createMatchmakingPage} from './matchmaking-page';
import {createTrainingLobbyPanel} from './training-lobby';
import type {GameState, RoomState} from '../domain/models';
import {first} from '../shared/collections';
import {notNull, UNSET} from '../shared/values';
import {createScreenBackground} from '../ui/assets';
import {RoomController} from './room-controller';
import type {HomePage} from '../app/home-page';

export function renderLobbyView(room: RoomController, lobby: RoomState, application: HomePage): boolean {
  room.gamePage?.dispose(0);
  room.gamePage = null;

  switch (room.mode.index) {
    case 0:
      if (room.trainingLobby === null) {
        room.trainingLobby = createTrainingLobbyPanel();
        room.domElement.append(room.trainingLobby.domElement);
      }
      return true;
    case 1:
      if (room.matchmakingPage === null) {
        room.matchmakingPage = createMatchmakingPage();
        room.matchmakingPage.renderMatchmakingTeams(lobby, true);
        room.domElement.append(room.matchmakingPage.domElement);
      } else {
        room.matchmakingPage.updateMatchmakingTeams(lobby);
      }
      return true;
    case 2:
      if (room.loadingIndicator === null) {
        createRoomLoadingIndicator(room, application);
      }
      return false;
    default:
      return true;
  }
}

export function renderGameView(room: RoomController, game: GameState): GamePageController {
  room.trainingLobby?.dispose(0);
  room.trainingLobby = null;
  room.matchmakingPage?.dispose(0);
  room.matchmakingPage = null;
  room.loadingIndicator?.dispose(0);
  room.loadingIndicator = null;

  const gamePage = room.gamePage ?? createGamePage(room, game);
  gamePage.applyUpdate(game);
  return gamePage;
}

export function renderPrivateRoomControls(room: RoomController, lobby: RoomState, application: HomePage): void {
  room.userList?.dispose(0);
  const listElement = document.createElement('div');
  const lobbyUsers = new LobbyUserList(listElement);
  lobbyUsers.applyElementStyles(listElement, 132, 825, 528, 245);
  lobbyUsers.renderUsers(room.users);
  room.userList = lobbyUsers;
  room.domElement.append(listElement);

  if (room.lockToggle === null) {
    room.lockToggle = createRoomLockToggle(application);
  }
  room.lockToggle.updateLockState(lobby.isLocked);
  if (application.userId === first(room.users).userId) {
    room.lockToggle.enableLockControl();
  }

  if (room.chatPanel === null) {
    room.chatPanel = createChatPanel();
    application.footer.domElement.append(room.chatPanel.domElement);
  }
  room.chatPanel.refreshTeamChatSubscription();
}

export function createRoomTimeout(room: RoomController, application: HomePage): () => Promise<null> {
  return async () => {
    await room.animateAsync(duration.roomTimeout);
    const current = application.dialog;
    const activeRoom = current instanceof RoomController ? current : null;
    if (activeRoom !== null && activeRoom.gamePage === null) {
      application.openHomePage(room.mode);
    }
    return null;
  };
}

function createRoomLoadingIndicator(room: RoomController, application: HomePage): void {
  const label = createTextElement('...', 100, null, null, 600);
  const element = document.createElement('div');
  const dots = new LoadingDots(label, element);
  dots.applyElementStyles(element, surfaceSize.playerCountButton.height, 240, 280, surfaceSize.playerCountButton.width);
  dots.setBorderRadius(radius.large);
  dots.setBackgroundColor(colors.pink);
  label.applyTextStyle(70, colors.roseWhisper, true);
  label.fitFontSize();
  element.append(label.domElement);
  element.style.visibility = 'hidden';
  runScheduledCallback(dots.animateLoadingDots());
  room.loadingIndicator = dots;
  room.domElement.append(element);
  runScheduledCallback(createRoomTimeout(room, application)());
}

function createRoomLockToggle(application: HomePage): RoomLockToggle {
  const icon = createImageContainer(LOCK_ICON, 26, 2, 2, 26);
  icon.domElement.style.color = colors.mintLight;
  const dialogElement = document.createElement('div');
  const dialog = new RoomLockDialog(dialogElement);
  dialog.applyElementStyles(dialogElement, surfaceSize.dialog.height, null, null, surfaceSize.dialog.width);
  dialog.setBorderRadius(radius.large);
  dialog.setBackgroundColor(colors.mintLight);
  const toggleElement = document.createElement('div');
  const toggle = new RoomLockToggle(icon, dialog, toggleElement);
  toggle.applyElementStyles(toggleElement, 30, 890, null, 30);
  toggleElement.append(icon.domElement);
  application.footer.domElement.append(toggleElement);
  return toggle;
}

function createGamePage(room: RoomController, game: GameState): GamePageController {
  const turnMessage = createAnimatedContainer(null, null, null, null);
  const fog = createAnimatedContainer(null, null, null, null);
  const boardElement = document.createElement('div');
  const board = new BattleBoard(new Map(), [], [], new Map(), boardElement);
  board.applyElementStyles(boardElement, screen.battleHeight, null, null, screen.battleWidth);
  const effectsElement = document.createElement('div');
  const effects = new BattleEffects(effectsElement);
  effects.applyElementStyles(effectsElement, screen.battleHeight, null, null, screen.battleWidth);
  effectsElement.style.pointerEvents = 'none';
  const overlayElement = document.createElement('div');
  const overlay = new ItemCommandOverlay(new Set(), overlayElement);
  overlay.applyElementStyles(overlayElement, 20, null, 420, screen.contentWidth);
  overlay.initializeItemCommandOverlay();
  const playersElement = document.createElement('div');
  const players = new PlayerRoster([], playersElement);
  players.applyElementStyles(playersElement, 400, 680, null, 390);
  playersElement.append(createUsedMiraclesCounter().domElement);
  const itemsElement = document.createElement('div');
  const items = new ItemActionPanel([], itemsElement);
  items.applyElementStyles(itemsElement, 292, 10, 367, 736);
  const tiebreak = createTiebreakBadge(game.tiebreakGF);
  const pageElement = document.createElement('div');
  const page = new GamePageController(turnMessage, fog, tiebreak, board, effects, overlay, players, items, pageElement);
  page.applyElementStyles(pageElement, screen.height, null, null, screen.width);
  if (page.turnController !== UNSET) {
    notNull('eventHandler');
  }
  page.turnController = new TurnController(page, []);
  tiebreak.domElement.style.left = `${game.tiebreakGF == null ? 480 : 460}px`;
  tiebreak.domElement.style.top = '1px';
  if (page.commandRules !== UNSET) {
    notNull('command');
  }
  page.commandRules = new CommandRules(page, []);
  turnMessage.setElementBounds({height: page.getHeight(), width: page.getWidth()});
  turnMessage.domElement.append(createScreenBackground('tiebreak').domElement);
  turnMessage.domElement.style.visibility = 'hidden';
  pageElement.append(turnMessage.domElement);
  fog.setElementBounds({height: page.getHeight(), width: page.getWidth()});
  fog.setOpacity(opacity.hidden);
  fog.domElement.append(createScreenBackground('fog').domElement);
  pageElement.append(fog.domElement);
  pageElement.append(boardElement);
  pageElement.append(effectsElement);
  pageElement.append(overlayElement);
  players.renderPlayerStats(game.players);
  room.gamePage = page;
  room.domElement.append(pageElement);
  return page;
}
