import {MAX_PLAYERS} from '../domain/constants';
import {roomAction} from '../services/protocol';
import {surfaceSize, radius, screen} from '../ui/theme';
import { AnimatedElement } from '../ui/elements';
import { EmptyPlayerRow, LobbyPlayerRow, MessageBar, MessageBox } from '../ui/decorative';
import { RoomPlayer, RoomState } from '../domain/models';
import { Team, TeamSolo, allTeams } from '../domain/enums';
import { getApplication, state } from '../app/runtime';
import { RoomController } from './room-controller';
import {sounds, playSound} from '../services/audio';
import {colors, teamBackgroundColor, teamBorderColor} from '../ui/palette';
import { createItemImage, LargeTeamIcon } from '../battle/status-widgets';
import { createMessageBar } from '../ui/panels';
import { DrawTiebreakPanel, createDrawTiebreakPanel, createTiebreakPanel } from './tiebreak-controls';
export class LobbyPlayerList extends AnimatedElement<HTMLDivElement> {
  constructor(public playerRows: ReturnType<typeof createItemImage>[], public placeholderRows: EmptyPlayerRow[], element: HTMLDivElement) {
    super(element);
  }
  renderPlayerList(entries: RoomPlayer[]): void {
    for (const row of new Set([...this.playerRows, ...this.placeholderRows])) row.dispose(0);
    this.playerRows.length = 0;
    this.placeholderRows.length = 0;
    const room = getApplication().dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    for (let index = 0; index < MAX_PLAYERS; index++) {
      const entry = entries[index];
      if (entry) {
        const user = room.findRoomUser(entry.userId);
        if (user === null) throw new Error('Entry has no room user');
        const row = createItemImage(user.displayName, entry.team, false, false);
        row.domElement.style.top = `${index * 35}px`;
        this.domElement.append(row.domElement);
        this.playerRows.push(row);
      } else {
        const element = document.createElement('div'),
          row = new EmptyPlayerRow(element);
        row.applySurface({...surfaceSize.itemRow, radius: radius.badge, edgeBorder: {width: 1, color: colors.brand}});
        element.style.top = `${index * 35}px`;
        this.domElement.append(element);
        this.placeholderRows.push(row);
      }
    }
  }
}
export class MatchmakingPage extends AnimatedElement<HTMLDivElement> {
  shuffleButton: MessageBar | null = null;
  startButton: MessageBar | null = null;
  constructor(public entries: RoomPlayer[], public teamButtons: Map<Team, LobbyPlayerRow>, public players: LobbyPlayerList, public tiebreak: DrawTiebreakPanel, element: HTMLDivElement) {
    super(element);
  }
  renderModeChoices(): void {
    const solo = createGreenMessageLabel(state.translations.getPrivateText('solo'));
    solo.setPosition(120, 30);
    this.domElement.append(solo.domElement);
    const teams = createGreenMessageLabel(state.translations.getPrivateText('teams'));
    teams.setPosition(760, 30);
    this.domElement.append(teams.domElement);
    for (const team of allTeams) {
      const element = document.createElement('div'),
        button = new LobbyPlayerRow(element);
      button.applySurface({
        ...surfaceSize.playerRow, radius: radius.large,
        background: teamBackgroundColor(team),
        border: {width: 1, color: teamBorderColor(team)!}
      });
      const iconElement = document.createElement('div'),
        icon = new LargeTeamIcon(iconElement);
      icon.applyElementStyles(iconElement, null, null, null, null);
      icon.renderTeamIcon(team, true);
      iconElement.style.left = '70px';
      iconElement.style.top = '5px';
      element.append(iconElement);
      element.style.left = team === TeamSolo ? '120px' : '760px';
      element.style.top = `${team === TeamSolo ? 100 : 100 + (team.index - 1) * 80}px`;
      button.applyAction(toggleLobbyEntry(this, team));
      this.domElement.append(element);
      this.teamButtons.set(team, button);
    }
    this.domElement.append(this.tiebreak.domElement);
  }
  findTeamEntryById(userId: string): RoomPlayer | null {
    return this.entries.find(entry => entry.userId === userId) ?? null;
  }
  playLobbyChangeSound(update: RoomState): void {
    if (update.teamsShuffled === true) {
      playSound(sounds.shuffleTeams);
      return;
    }
    let changedTeams = 0;
    for (const entry of update.entries) {
      const previous = this.findTeamEntryById(entry.userId);
      if (previous === null) break;
      if (entry.team !== previous.team && ++changedTeams >= 2) {
        playSound(sounds.shuffleTeams);
        return;
      }
    }
    if (update.tiebreakGF !== this.tiebreak.selectedGf) {
      playSound(sounds.increase);
      return;
    }
    for (const entry of update.entries) {
      const previous = this.findTeamEntryById(entry.userId);
      if (previous === null || previous.team !== entry.team) {
        playSound(sounds.makeEntry);
        return;
      }
    }
    if (update.entries.length < this.players.playerRows.length) playSound(sounds.cancelEntry);
  }
  renderMatchmakingTeams(update: RoomState, initial: boolean): void {
    if (!initial) this.playLobbyChangeSound(update);
    this.entries.length = 0;
    this.entries.push(...update.entries);
    this.players.renderPlayerList(this.entries);
    this.domElement.append(this.players.domElement);
    const application = getApplication();
    if (update.entries.length === 0) {
      for (const button of this.teamButtons.values()) {
        button.setDisabled(false);
      }
    } else {
      const solo = update.entries[0]!.team === TeamSolo,
        hasEntry = update.entries.some(entry => entry.userId === application.userId);
      for (const [team, button] of this.teamButtons) button.setDisabled(team === TeamSolo === solo ? !hasEntry && update.entries.length >= MAX_PLAYERS : true);
    }
    this.tiebreak.updateTiebreak(update.tiebreakGF);
    const room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    if (application.userId !== (room.users[0]?.userId ?? null)) return;
    this.tiebreak.setActionHandler(() => {
      playSound(sounds.click);
      application.createHomeDimmer(createTiebreakPanel(async (gf: number | null) => {
        if (gf !== this.tiebreak.selectedGf) {
          const currentRoom = application.dialog;
          if (!(currentRoom instanceof RoomController)) throw new Error('No active room');
          await currentRoom.sendRoomActionWithPayload(roomAction.setTiebreak, new Map([['gf', gf]]));
        }
        return null;
      }));
    });
    if (this.shuffleButton === null) {
      this.shuffleButton = createMessageBar(state.translations.getPrivateText('shuffleTeams'), true);
      this.shuffleButton.setPosition(350, 440);
      this.shuffleButton.setActionHandler(shuffleLobbyTeams(application));
      this.domElement.append(this.shuffleButton.domElement);
    }
    if (this.startButton === null) {
      this.startButton = createMessageBar(state.translations.getPrivateText('startGame'), false);
      this.startButton.setPosition(300, 550);
      this.startButton.setActionHandler(startLobbyGame(application));
      this.domElement.append(this.startButton.domElement);
    }
    this.shuffleButton.setDisabled(update.entries.length < 3);
    const teamCount = new Set(update.entries.map(entry => entry.team)).size;
    const canStart = update.entries.length >= 2 && (update.entries[0]!.team === TeamSolo || teamCount >= 2 && teamCount < update.entries.length);
    this.startButton.setDisabled(!canStart);
  }
  override dispose(unused?: unknown): void {
    super.dispose(unused);
  }
  updateMatchmakingTeams(update: RoomState): void {
    this.renderMatchmakingTeams(update, false);
  }
}
export function createMatchmakingPage(): MatchmakingPage {
  const playersElement = document.createElement('div'),
    players = new LobbyPlayerList([], [], playersElement);
  players.applyElementStyles(playersElement, 310, 400, 100, 280);
  const tiebreak = createDrawTiebreakPanel();
  tiebreak.setPosition(120, 340);
  const element = document.createElement('div'),
    page = new MatchmakingPage([], new Map(), players, tiebreak, element);
  page.applyElementStyles(element, screen.height, null, null, screen.width);
  page.renderModeChoices();
  return page;
}
export function createGreenMessageLabel(text: string): MessageBox {
  const element = document.createElement('div'),
    label = new MessageBox(element);
  label.renderCard({
    ...surfaceSize.greenLabel, radius: radius.medium,
    background: colors.brand,
    label: {
      text, height: 60, left: 10, top: null, width: 180,
      size: 40, color: colors.mintLight, bold: true, fit: true
    }
  });
  return label;
}
export function toggleLobbyEntry(page: MatchmakingPage, team: Team): () => Promise<null> {
  return async () => {
    playSound(sounds.click);
    const application = getApplication(),
      userId = application.userId;
    if (userId === null) throw new Error('No signed-in user');
    const entry = page.findTeamEntryById(userId),
      room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    if (entry === null || entry.team !== team) {
      await room.updateRoomState(roomAction.makeEntry, true, new Map([['team', team.key]]));
    } else {
      await room.sendRoomActionAndRefreshActivity(roomAction.cancelEntry, true);
    }
    return null;
  };
}
function sendLobbyAction(application: ReturnType<typeof getApplication>, action: string): () => Promise<null> {
  return async () => {
    playSound(sounds.click);
    const room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    await room.sendRoomAction(action);
    return null;
  };
}
export function shuffleLobbyTeams(application: ReturnType<typeof getApplication>): () => Promise<null> {
  return sendLobbyAction(application, roomAction.shuffleTeams);
}
export function startLobbyGame(application: ReturnType<typeof getApplication>): () => Promise<null> {
  return sendLobbyAction(application, roomAction.startGame);
}
