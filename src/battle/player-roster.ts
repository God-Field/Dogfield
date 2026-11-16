import {BASE_RATING} from '../domain/constants';
import {colors} from '../ui/palette';
import { AnimatedElement, createTextElement } from '../ui/elements';
import { PlayerStatus } from '../domain/models';
import { TeamSolo } from '../domain/enums';
import { getApplication } from '../app/runtime';
import { findRequired } from '../shared/collections';
import { StatGainRow, createPlayerNameRow } from './status-widgets';
import { createPlayerStatusPanel } from './player-panels';
import type { PlayerStatusPanel } from './player-panels';
export class PlayerRoster extends AnimatedElement<HTMLDivElement> {
  constructor(public players: PlayerStatusPanel[], element: HTMLDivElement) {
    super(element);
  }
  renderPlayerStats(statuses: PlayerStatus[]): void {
    const count = statuses.length,
      gap = Math.trunc((360 - 40 * count) / (count + 1));
    for (const [index, status] of statuses.entries()) {
      const panel = createPlayerStatusPanel(status);
      panel.domElement.style.top = `${gap + index * (40 + gap)}px`;
      this.domElement.append(panel.domElement);
      this.players.push(panel);
    }
    const current = this.findPlayerStatById(getApplication().userId);
    if (current === null) return;
    current.alias = null;
    for (const player of this.players) {
      const alias = player.alias;
      if (alias === null) continue;
      for (const row of [player.nameRow, player.usedMiracles!.headerWidget]) {
        row.alias = alias;
        const label = row.valueWidget;
        label.domElement.textContent = alias;
        label.applyTextStyle(25, colors.brandBlue, true);
        label.fitFontSize();
      }
    }
  }
  updatePlayerStats(statuses: PlayerStatus[]): void {
    for (const status of statuses) {
      const panel = this.requirePlayer(status.id);
      panel.isBot = status.isBot;
      panel.refreshPlayerStatusColors();
    }
  }
  renderStatGain(statuses: PlayerStatus[]): void {
    for (const status of statuses) {
      const player = this.requirePlayer(status.id);
      if (player.ratingGainRow !== null) continue;
      const rating = createTextElement('', 40, 180, null, 90),
        gain = createTextElement('', 40, 270, null, 60),
        name = createPlayerNameRow(status, 340),
        element = document.createElement('div'),
        row = new StatGainRow(name, rating, gain, element);
      row.applyElementStyles(element, 40, null, null, 390);
      name.domElement.append(rating.domElement);
      name.domElement.append(gain.domElement);
      element.append(name.domElement);
      rating.domElement.textContent = String(BASE_RATING + status.rating);
      rating.applyTextStyle(25, colors.blue, true);
      const delta = status.ratingGain;
      gain.domElement.textContent = delta > 0 ? `+${delta}` : delta === 0 ? `±${delta}` : String(delta);
      gain.applyTextStyle(25, delta > 0 ? colors.greenBright : delta === 0 ? colors.text : colors.redDark, true);
      player.ratingGainRow = row;
    }
  }
  findPlayerStatById(userId: string | null): PlayerStatusPanel | null {
    return this.players.find(player => player.userId == userId) ?? null;
  }
  requirePlayer(id: number): PlayerStatusPanel {
    return findRequired(this.players, player => player.playerId === id);
  }
  getAlivePlayerStats(): PlayerStatusPanel[] {
    return this.players.filter(player => !player.dead);
  }
  getOpponentPlayerStats(player: PlayerStatusPanel | null): PlayerStatusPanel[] {
    return this.getAlivePlayerStats().filter(candidate => candidate.isOpponentStatusPanel(player!));
  }
  getWinningPlayerStats(): PlayerStatusPanel[] {
    const first = this.getAlivePlayerStats()[0];
    return first === undefined ? [] : first.team === TeamSolo ? [first] : this.players.filter(player => player.team === first.team);
  }
}
