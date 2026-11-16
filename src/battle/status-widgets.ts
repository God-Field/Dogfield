import {surfaceSize, radius, layer, opacity, duration} from '../ui/theme';
import {TRIANGLE_ICON, SQUARE_ICON, CIRCLE_ICON, MIRACLES_ICON} from '../ui/icons';
import { AnimatedElement, TextElement, createAnimatedContainer, createImageContainer, createTextElement } from '../ui/elements';
import { ActionCard, Card, applySurface, appendLabel } from '../ui/components';
import { ItemImage } from '../ui/decorative';
import { getApplication, state } from '../app/runtime';
import { PlayerStatus, ItemDefinition } from '../domain/models';
import { Team, Curse, Guardian, CurseFog, CurseFlash, CurseDream, CurseDarkcloud, allTeams } from '../domain/enums';
import {colors, teamBackgroundColor, teamBorderColor} from '../ui/palette';
import { createItemArtwork, createCurseArtwork, createGuardianArtwork } from '../ui/assets';
import { RoomController } from '../rooms/room-controller';
import {sounds, playSound} from '../services/audio';
import { createCurseMediumIcon, createGuardianMediumIcon, createCombatCounterDetails } from './item-details';
function getGamePage() {
  const room = getApplication().dialog;
  if (!(room instanceof RoomController) || room.gamePage === null) throw new Error('No active battle');
  return room.gamePage;
}
export class PlayerNameRow extends Card {
  alias: string | null = null;
  constructor(public valueWidget: TextElement, element: HTMLDivElement) {
    super(element);
  }
  setDisabled(): void {
    this.valueWidget.domElement.style.color = colors.text;
    this.valueWidget.setOpacity(opacity.disabled);
  }
}
export function createPlayerNameRow(player: PlayerStatus, width: number): PlayerNameRow {
  const value = createTextElement('', null, null, null, null),
    element = document.createElement('div'),
    row = new PlayerNameRow(value, element);
  row.applySurface({
    height: 40, width,
    corners: {topLeft: 20, bottomLeft: 20},
    background: teamBackgroundColor(player.team),
    border: {width: 1, color: teamBorderColor(player.team)!}
  });
  const icon = createSmallTeamIcon(player.team);
  icon.domElement.style.left = '7px';
  icon.domElement.style.top = '10px';
  icon.domElement.style.zIndex = layer.raised;
  element.append(icon.domElement);
  value.setHeightLeftWidth(40, 30, 135);
  value.domElement.textContent = player.name;
  value.applyTextStyle(25, player.userId === null ? colors.indigo : colors.brand, true);
  value.fitFontSize();
  element.append(value.domElement);
  return row;
}
export class StatGainRow extends AnimatedElement<HTMLDivElement> {
  constructor(public nameRow: PlayerNameRow, public ratingLabel: TextElement, public gainLabel: TextElement, element: HTMLDivElement) {
    super(element);
  }
}
export class CurseIcon extends AnimatedElement<HTMLDivElement> {
  renderCurseIcon(curse: Curse): void {
    const left = curse === CurseFog ? 223 : curse === CurseFlash ? 252 : curse === CurseDream ? 281 : curse === CurseDarkcloud ? 310 : 194;
    this.domElement.style.left = `${left}px`;
    this.domElement.style.top = '24px';
    const image = createCurseArtwork(curse, 'small');
    this.setSize(image.getHeight(), image.getWidth());
    this.domElement.append(image.domElement);
    this.setMouseOverHandler(() => getGamePage().showTurnOverlay(createCurseMediumIcon(curse)));
  }
}
export function createCurseIconWidget(curse: Curse): CurseIcon {
  const element = document.createElement('div'),
    icon = new CurseIcon(element);
  icon.applyElementStyles(element, null, null, null, null);
  icon.renderCurseIcon(curse);
  return icon;
}
export class GuardianIcon extends AnimatedElement<HTMLDivElement> {
  constructor(public guardian: Guardian, element: HTMLDivElement) {
    super(element);
  }
  renderGuardianIcon(_guardian: Guardian): void {
    this.domElement.style.left = '340px';
    const image = createGuardianArtwork(this.guardian, 'small');
    this.setSize(image.getHeight(), image.getWidth());
    this.domElement.append(image.domElement);
    this.setMouseOverHandler(() => getGamePage().showTurnOverlay(createGuardianMediumIcon(this.guardian)));
  }
}
export function createGuardianIconWidget(guardian: Guardian): GuardianIcon {
  const element = document.createElement('div'),
    icon = new GuardianIcon(guardian, element);
  icon.applyElementStyles(element, null, null, null, null);
  icon.renderGuardianIcon(guardian);
  return icon;
}
export class ElementBadge extends AnimatedElement<HTMLDivElement> {
  constructor(public model: ItemDefinition, element: HTMLDivElement) {
    super(element);
  }
  // The supplied reference exposes the model through this accessor. Base DOM
  // operations use the stored DOM node (`domElement`) so this override remains safe.
  override get element(): ItemDefinition {
    return this.model;
  }
  override set element(value: ItemDefinition) {
    this.model = value;
  }
  renderElementBadge(_model: ItemDefinition): void {
    const artwork = createItemArtwork(this.model);
    artwork.setSize(this.getHeight(), this.getWidth());
    this.domElement.append(artwork.domElement);
    this.setMouseOverHandler(() => getGamePage().showTurnOverlay(createCombatCounterDetails(this.model, 0, false, 0, null, false, 0, 0)));
  }
}
export function createElementBadge(model: ItemDefinition): ElementBadge {
  const element = document.createElement('div'),
    badge = new ElementBadge(model, element);
  badge.applyElementStyles(element, 40, null, null, 40);
  badge.renderElementBadge(model);
  return badge;
}
export class UsedMiraclesCounter extends ActionCard {
  renderUsedMiraclesCounter(): void {
    this.applySurface({
      ...surfaceSize.usedMiracles, left: 90, top: 360, radius: radius.medium,
      background: colors.neutral,
      border: {width: 2, color: colors.slate}
    });
    const icon = createImageContainer(MIRACLES_ICON, 30, 10, 5, 30);
    icon.domElement.style.color = colors.slate;
    this.domElement.append(icon.domElement);
    this.appendLabel({
      text: state.translations.getGameText('usedMiracles'),
      height: 40, left: 50, top: null, width: 190,
      size: 30, color: colors.slate, align: 'left', fit: true
    });
    this.applyAction(async () => {
      playSound(sounds.click);
      for (const player of getGamePage().playerRoster.players) {
        const miracles = player.usedMiracles!,
          visible = miracles.domElement.isConnected;
        player.outerContainer.domElement.style.visibility = visible ? '' : 'hidden';
        if (!visible) {
          player.ratingGainRow?.dispose(0);
          player.domElement.append(miracles.domElement);
        } else {
          miracles.dispose(0);
          player.ratingGainRow?.dispose(0);
        }
      }
      return null;
    });
  }
}
export function createUsedMiraclesCounter(): UsedMiraclesCounter {
  const element = document.createElement('div'),
    button = new UsedMiraclesCounter(element);
  button.renderUsedMiraclesCounter();
  return button;
}
export class RatingBadge extends ActionCard {
  renderRatingBadge(): void {
    this.applySurface({
      ...surfaceSize.ratingBadge, radius: radius.large,
      background: colors.lavender,
      border: {width: 4, color: colors.blue}
    });
    this.appendLabel({
      text: state.translations.getDuelText('rating'),
      height: this.getHeight(), left: 10, top: null, width: this.getWidth() - 20,
      size: 60, color: colors.blue, bold: true, fit: true
    });
    this.applyAction(async () => {
      playSound(sounds.click);
      for (const player of getGamePage().playerRoster.players) {
        const visible = player.ratingGainRow!.domElement.isConnected;
        player.outerContainer.domElement.style.visibility = visible ? '' : 'hidden';
        player.usedMiracles!.dispose(0);
        if (!visible) {
          player.domElement.append(player.ratingGainRow!.domElement);
        } else {
          player.ratingGainRow?.dispose(0);
        }
      }
      return null;
    });
  }
}
export function createRatingBadge(): RatingBadge {
  const element = document.createElement('div'),
    button = new RatingBadge(element);
  button.renderRatingBadge();
  return button;
}
export class TeamIconRenderer extends AnimatedElement<HTMLDivElement> {
  renderTeamIcon(team: Team, large: boolean): void {
    const size = large ? 60 : 20;
    this.domElement.style.width = `${size}px`;
    this.domElement.style.height = `${this.getWidth()}px`;
    this.domElement.style.pointerEvents = 'none';
    const color = teamBorderColor(team);
    if (!allTeams.some((knownTeam) => knownTeam.index === team.index)) return;
    const square = team.index >= 3,
      width = team.index === 3 ? large ? 50 : 18 : this.getWidth(),
      offset = team.index === 3 ? Math.trunc((this.getWidth() - width) / 2) : null;
    const image = createImageContainer(team.index === 0 ? CIRCLE_ICON : square ? SQUARE_ICON : TRIANGLE_ICON, width, offset, offset, width);
    image.domElement.style.color = color!;
    if (team.index === 2) {
      image.rotateElement(180);
    } else if (team.index === 3) {
      image.rotateElement(45);
    }
    this.domElement.append(image.domElement);
  }
}
export class SmallTeamIcon extends TeamIconRenderer {}
export class LargeTeamIcon extends TeamIconRenderer {}
export function createSmallTeamIcon(team: Team): SmallTeamIcon {
  const element = document.createElement('div'),
    icon = new SmallTeamIcon(element);
  icon.applyElementStyles(element, null, null, null, null);
  icon.renderTeamIcon(team, false);
  return icon;
}
export function createItemImage(name: string, team: Team, isCurrentPlayer: boolean, isBot: boolean): ItemImage {
  const element = document.createElement('div'),
    row = new ItemImage(element);
  row.applySurface({
    ...surfaceSize.itemRow, radius: radius.badge,
    background: teamBackgroundColor(team),
    border: {width: 1, color: teamBorderColor(team)!}
  });
  const icon = createSmallTeamIcon(team);
  icon.domElement.style.left = '7px';
  icon.domElement.style.top = '5px';
  element.append(icon.domElement);
  row.appendLabel({
    text: name,
    height: 30, left: 30, top: null, width: 220,
    size: 20, color: isBot ? colors.indigo : isCurrentPlayer ? colors.brandBlue : colors.brand, bold: true, fit: true
  });
  return row;
}
export class LoadingDots extends AnimatedElement<HTMLDivElement> {
  constructor(public dots: TextElement, element: HTMLDivElement) {
    super(element);
  }
  async animateLoadingDots(): Promise<null> {
    for (let second = 0; second < 10; second++) {
      if (second >= 2) {
        this.domElement.style.visibility = '';
        this.dots.domElement.style.visibility = second % 2 === 0 ? '' : 'hidden';
      }
      await this.animateAsync(duration.long);
    }
    return null;
  }
}
