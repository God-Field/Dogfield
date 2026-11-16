import {surfaceSize, radius, opacity, duration} from '../ui/theme';
import {colors, itemCommandElementColor} from '../ui/palette';
import {AnimatedElement, createAnimatedContainer} from '../ui/elements';
import {Card, applySurface} from '../ui/components';
import { ItemImage, ItemImageLayer, PlayerItemPlaceholder } from '../ui/decorative';
import { EasingEaseIn } from '../domain/enums';
import { getApplication } from '../app/runtime';
import { RoomController } from '../rooms/room-controller';
import { CounterState, createCombatCounterDetails } from './item-details';
import { createItemImage } from './status-widgets';
import type { PlayerStatusPanel } from './player-panels';
export class PlayerBadge extends Card {
  placeholder: PlayerItemPlaceholder | null = null;
  constructor(public player: PlayerStatusPanel, public image: ItemImage, element: HTMLDivElement) {
    super(element);
  }
  async showItem(): Promise<null> {
    this.placeholder ??= createItemPlaceholder();
    this.domElement.append(this.placeholder.domElement);
    this.image.setOpacity(opacity.hidden);
    this.domElement.append(this.image.domElement);
    await this.animateAsync(duration.fast);
    await this.image.fadeIn(duration.fast, EasingEaseIn);
    this.placeholder.dispose(0);
    this.placeholder = null;
    return null;
  }
}
export function createPlayerBadge(player: PlayerStatusPanel, hidden: boolean): PlayerBadge {
  const alias = player.nameRow.alias,
    name = alias ?? player.name,
    image = createItemImage(name, player.team, alias !== null, player.userId === null),
    element = document.createElement('div'),
    badge = new PlayerBadge(player, image, element);
  badge.applySurface({...surfaceSize.itemRow});
  if (hidden) {
    badge.placeholder = createItemPlaceholder();
    element.append(badge.placeholder.domElement);
  } else element.append(image.domElement);
  return badge;
}
export function createItemPlaceholder(): PlayerItemPlaceholder {
  const element = document.createElement('div'),
    placeholder = new PlayerItemPlaceholder(element);
  placeholder.applySurface({...surfaceSize.itemRow, radius: radius.badge, background: colors.violet, opacity: opacity.placeholder});
  return placeholder;
}
export class ItemDetailSlot extends Card {
  placeholderWidget: ItemImageLayer | null = null;
  constructor(public itemWidget: CounterState | null, element: HTMLDivElement) {
    super(element);
  }
  renderPlayerItem(_details: CounterState | null, hidden: boolean): void {
    if (this.itemWidget === null) return;
    if (hidden) {
      const element = document.createElement('div'),
        placeholder = new ItemImageLayer(element);
      placeholder.applySurface({...surfaceSize.detail, radius: radius.small, background: colors.violet, opacity: opacity.placeholder});
      this.placeholderWidget = placeholder;
      this.domElement.append(element);
    } else this.domElement.append(this.itemWidget.domElement);
    this.setMouseOverHandler(() => {
      const details = this.placeholderWidget === null ? this.itemWidget : null;
      if (details === null) return;
      const room = getApplication().dialog;
      if (!(room instanceof RoomController) || room.gamePage === null) throw new Error('No active battle');
      room.gamePage.showTurnOverlay(createCombatCounterDetails(details.model, 0, false, 0, null, false, 0, 0));
    });
  }
  async showItem(): Promise<null> {
    if (this.placeholderWidget !== null) {
      this.itemWidget!.setOpacity(opacity.hidden);
      this.domElement.append(this.itemWidget!.domElement);
      await this.itemWidget!.fadeIn(duration.normal, EasingEaseIn);
      this.placeholderWidget.dispose(0);
      this.placeholderWidget = null;
      this.domElement.append(this.itemWidget!.domElement);
    }
    return null;
  }
  async swapPlayerItem(details: CounterState, slow: boolean): Promise<null> {
    this.domElement.append(details.domElement);
    this.itemWidget!.setOpacity(opacity.visible);
    this.domElement.append(this.itemWidget!.domElement);
    await this.itemWidget!.fadeOut(slow ? duration.slow : duration.fast, EasingEaseIn);
    this.itemWidget!.dispose(0);
    this.itemWidget = details;
    return null;
  }
  async showItemDamage(damage: number): Promise<null> {
    const overlay = createAnimatedContainer(this.getHeight(), null, null, this.getWidth());
    applySurface(overlay, {height: this.getHeight(), width: this.getWidth(), radius: radius.small, background: colors.mint, opacity: opacity.hidden});
    this.domElement.append(overlay.domElement);
    await overlay.fadeInWithDefaults(duration.fast);
    this.itemWidget!.dispose(0);
    this.itemWidget = createCombatCounterDetails(this.itemWidget!.model, damage, true, 0, null, false, 0, 0);
    this.domElement.append(this.itemWidget.domElement);
    this.domElement.append(overlay.domElement);
    await overlay.fadeOutWithDefaults(duration.fast);
    overlay.dispose(0);
    return null;
  }
  async pulsePlayerItem(): Promise<null> {
    const overlay = createAnimatedContainer(this.getHeight(), null, null, this.getWidth());
    applySurface(overlay, {height: this.getHeight(), width: this.getWidth(), radius: radius.small, background: itemCommandElementColor(this.itemWidget!.model), opacity: opacity.hidden});
    this.domElement.append(overlay.domElement);
    await overlay.fadeInWithDefaults(duration.normal);
    await overlay.fadeOutWithDefaults(duration.normal);
    overlay.dispose(0);
    return null;
  }
}
export function createItemDetailSlot(details: CounterState | null, hidden: boolean): ItemDetailSlot {
  const element = document.createElement('div'),
    slot = new ItemDetailSlot(details, element);
  slot.applySurface({...surfaceSize.detail});
  slot.renderPlayerItem(details, hidden);
  return slot;
}
