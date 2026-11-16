import {roomAction} from '../services/protocol';
import {surfaceSize, radius, opacity, layer} from '../ui/theme';
import {colors} from '../ui/palette';
import {ROOM_LOCK_ICON} from '../ui/icons';
import { AnimatedElement, InteractiveElement, ImageContainer, TextElement, createTextElement, createImageContainer } from '../ui/elements';
import { ActionCard, Card } from '../ui/components';
import { RoomUser } from '../domain/models';
import { getApplication, state } from '../app/runtime';
import { RoomController } from './room-controller';
import {sounds, playSound} from '../services/audio';
export class LobbyUserEntry extends ActionCard {
  constructor(public user: RoomUser, public label: TextElement, element: HTMLDivElement) {
    super(element);
  }
  renderUserEntry(_user: RoomUser, canKick: boolean): void {
    this.applySurface({...surfaceSize.smallBadge, radius: radius.medium, background: colors.brand});
    this.label.setHeightLeftWidth(20, 2, 116);
    this.label.domElement.textContent = this.user.displayName;
    this.label.applyNormalTextStyle(16, colors.mintLight);
    this.label.fitFontSize();
    this.domElement.append(this.label.domElement);
    if (canKick) {
      this.initializeClickable();
      this.setActionHandler(() => this.openUserDialog());
    }
  }
  private openUserDialog(): void {
    playSound(sounds.click);
    const element = document.createElement('div'),
      dialog = new LobbyUserDialog(this.user, element);
    dialog.applySurface({...surfaceSize.dialog, radius: radius.large, background: colors.mintLight});
    dialog.appendLabel({
      text: this.user.displayName,
      height: 70, left: 10, top: 40, width: 460,
      size: 60, color: colors.brand, bold: true, fit: true
    });
    element.append(createKickUserAction(this.user.userId).domElement);
    getApplication().createHomeDimmer(dialog);
  }
}
export function createLobbyUserEntry(user: RoomUser, canKick: boolean): LobbyUserEntry {
  const label = createTextElement('', null, null, null, null),
    element = document.createElement('div'),
    entry = new LobbyUserEntry(user, label, element);
  entry.applyElementStyles(element, 20, null, null, 120);
  entry.renderUserEntry(user, canKick);
  return entry;
}
export class LobbyUserDialog extends Card {
  constructor(public user: RoomUser, element: HTMLDivElement) {
    super(element);
  }
}
export class LobbyUserList extends AnimatedElement<HTMLDivElement> {
  renderUsers(users: RoomUser[]): void {
    this.domElement.style.zIndex = layer.raised;
    const ownerId = users[0]!.userId;
    for (const user of users) {
      const index = users.indexOf(user),
        entry = createLobbyUserEntry(user, getApplication().userId === ownerId && user.userId !== ownerId);
      entry.domElement.style.left = `${index < 6 ? 125 : 0}px`;
      entry.domElement.style.top = `${132 - ((users.length <= 6 || index >= 6 ? users.length : 6) - index) * 22}px`;
      this.domElement.append(entry.domElement);
    }
  }
}
export class KickUserAction extends ActionCard {
  renderKickUserAction(userId: string): void {
    this.renderCard({
      ...surfaceSize.action, left: 20, top: 150, radius: radius.large,
      background: colors.brand,
      insetBorder: {width: 2, color: colors.mintLight, inset: 4},
      label: {
        text: state.translations.getPrivateText('kick'),
        height: 100, left: 10, top: null, width: 420,
        size: 60, color: colors.mintLight, bold: true, fit: true
      }
    });
    this.applyAction(submitKickUserRequest(userId));
  }
}
export function createKickUserAction(userId: string): KickUserAction {
  const element = document.createElement('div'),
    button = new KickUserAction(element);
  button.renderKickUserAction(userId);
  return button;
}
export function submitKickUserRequest(userId: string): () => Promise<null> {
  return async () => {
    playSound(sounds.click);
    const application = getApplication();
    application.setHomeBanner(null);
    const room = application.dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    await room.sendRoomActionWithPayload(roomAction.kickUser, new Map([['userId', userId]]));
    return null;
  };
}
export class RoomLockAction extends ActionCard {
  renderLockAction(isLocked: boolean): void {
    const color = isLocked ? colors.roseWhisper : colors.gray;
    this.applySurface({
      ...surfaceSize.action, left: 20, top: 100, radius: radius.large,
      background: isLocked ? colors.red : undefined,
      border: isLocked ? undefined : {width: 2, color}
    });
    const icon = createImageContainer(ROOM_LOCK_ICON, 60, 20, 20, 60);
    icon.domElement.style.color = color;
    this.domElement.append(icon.domElement);
    this.appendLabel({
      text: state.translations.getPrivateText('roomLocked'),
      height: 100, left: 100, top: null, width: 320,
      size: 60, color, bold: true, fit: true
    });
    this.applyAction(submitRoomLockRequest(isLocked));
  }
}
export function createRoomLockAction(isLocked: boolean): RoomLockAction {
  const element = document.createElement('div'),
    button = new RoomLockAction(element);
  button.renderLockAction(isLocked);
  return button;
}
export class RoomLockDialog extends Card {
  private action: RoomLockAction | null = null;
  renderLockDialog(isLocked: boolean): void {
    this.setBackgroundColor(isLocked ? colors.roseWhisper : colors.mintLight);
    this.action?.dispose(0);
    this.action = createRoomLockAction(isLocked);
    this.domElement.append(this.action.domElement);
  }
}
export class RoomLockToggle extends InteractiveElement {
  isLocked = false;
  isInitialized = false;
  constructor(public image: ImageContainer, public dialog: RoomLockDialog, element: HTMLDivElement) {
    super(element);
  }
  updateLockState(isLocked: boolean): void {
    this.isLocked = isLocked;
    this.image.setOpacity(isLocked ? opacity.visible : opacity.faint);
    this.dialog.renderLockDialog(isLocked);
  }
  enableLockControl(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;
    this.initializeClickable();
    this.setActionHandler(() => {
      playSound(sounds.click);
      const application = getApplication();
      if (this.dialog.domElement.isConnected) {
        application.setHomeBanner(null);
      } else {
        application.setReferenceMenuVisible(false);
        this.dialog.renderLockDialog(this.isLocked);
        application.createHomeDimmer(this.dialog);
      }
    });
  }
}
export function submitRoomLockRequest(wasLocked: boolean): () => Promise<null> {
  return async () => {
    playSound(sounds.click);
    const room = getApplication().dialog;
    if (!(room instanceof RoomController)) throw new Error('No active room');
    const isLocked = !wasLocked;
    room.lockToggle!.updateLockState(isLocked);
    await room.sendRoomActionWithPayload(roomAction.setRoomLocked, new Map([['isLocked', isLocked]]));
    return null;
  };
}
