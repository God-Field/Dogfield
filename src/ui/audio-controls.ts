import {opacity} from './theme';
import {colors} from './palette';
import {MUTED_ICON, LOW_VOLUME_ICON, HIGH_VOLUME_ICON, HIDDEN_CHAT_ICON} from './icons';
import { AnimatedElement, InteractiveElement, ImageContainer, createImageContainer, createInteractiveElement } from './elements';
import { state, getApplication } from '../app/runtime';
import {sounds, initializeVolumeControls, applyMuteSetting, playSound} from '../services/audio';
import { RoomController } from '../rooms/room-controller';
export class VolumeSlider extends InteractiveElement {
  constructor(public image: ImageContainer, element: HTMLDivElement) {
    super(element);
  }
}
export class VolumeBar extends InteractiveElement {
  constructor(public barWidget: AnimatedElement<HTMLDivElement>, element: HTMLDivElement) {
    super(element);
  }
}
export class VolumeControl extends AnimatedElement<HTMLDivElement> {
  constructor(public volumeIcon: VolumeSlider, public volumeBars: VolumeBar[], element: HTMLDivElement) {
    super(element);
  }
  initializeVolumeControl(): void {
    this.volumeIcon.setActionHandler(() => {
      state.isMuted = !state.isMuted;
      applyMuteSetting();
      this.updateVolumeIcon();
    });
    this.domElement.append(this.volumeIcon.domElement);
    for (let index = 0; index < 10; index++) {
      const fillElement = document.createElement('div'),
        fill = new AnimatedElement(fillElement);
      fill.applyElementStyles(fillElement, null, null, null, null);
      const element = document.createElement('div'),
        bar = new VolumeBar(fill, element);
      bar.applyElementStyles(element, 30, null, null, 12);
      fill.setBounds(20, 1, 5, 10);
      fill.setBackgroundColor(colors.mintLight);
      element.append(fillElement);
      bar.initializeClickable();
      element.style.left = `${30 + index * 12}px`;
      bar.setActionHandler(() => {
        state.volume = (index + 1) * 10;
        state.isMuted = false;
        applyMuteSetting();
        this.updateVolumeIcon();
      });
      this.domElement.append(element);
      this.volumeBars.push(bar);
    }
    initializeVolumeControls();
    this.updateVolumeIcon();
  }
  updateVolumeIcon(): void {
    const icon = this.volumeIcon.image;
    if (state.isMuted) {
      icon.domElement.innerHTML = MUTED_ICON;
      icon.setOpacity(opacity.faint);
    } else {
      icon.domElement.innerHTML = state.volume <= 50 ? LOW_VOLUME_ICON : HIGH_VOLUME_ICON;
      icon.setOpacity(opacity.visible);
    }
    icon.setOpacity(state.isMuted ? opacity.faint : opacity.visible);
    this.volumeBars.forEach((bar, index) => bar.barWidget.setOpacity(state.isMuted || state.volume <= index * 10 ? opacity.faint : opacity.visible));
  }
}
export function createVolumeControl(): VolumeControl {
  const icon = createImageContainer(null, 30, null, null, 30);
  icon.domElement.style.color = colors.mintLight;
  const iconElement = document.createElement('div'),
    slider = new VolumeSlider(icon, iconElement);
  slider.applyElementStyles(iconElement, 30, null, null, 30);
  iconElement.append(icon.domElement);
  slider.initializeClickable();
  const element = document.createElement('div'),
    control = new VolumeControl(slider, [], element);
  control.applyElementStyles(element, 30, 920, null, 190);
  control.initializeVolumeControl();
  return control;
}
export class ChatVisibilityToggle extends InteractiveElement {
  constructor(public hiddenChatButton: InteractiveElement, public visibleChatButton: InteractiveElement, element: HTMLDivElement) {
    super(element);
  }
  renderChatVisibilityToggle(): void {
    const mutedImage = createImageContainer(HIDDEN_CHAT_ICON, 26, 2, 2, 26);
    mutedImage.domElement.style.color = colors.mintLight;
    mutedImage.setOpacity(opacity.faint);
    this.hiddenChatButton.domElement.append(mutedImage.domElement);
    this.hiddenChatButton.initializeClickable();
    this.hiddenChatButton.setActionHandler(() => {
      playSound(sounds.click);
      this.setChatHidden(true);
    });
    const soundImage = createImageContainer(HIDDEN_CHAT_ICON, 26, 2, 2, 26);
    soundImage.domElement.style.color = colors.mintLight;
    this.visibleChatButton.domElement.append(soundImage.domElement);
    this.visibleChatButton.initializeClickable();
    this.visibleChatButton.setActionHandler(() => {
      playSound(sounds.click);
      this.setChatHidden(false);
    });
    this.setChatHidden(false);
  }
  setChatHidden(hidden: boolean): void {
    if (hidden) {
      this.hiddenChatButton.dispose(0);
      this.domElement.append(this.visibleChatButton.domElement);
    } else {
      this.visibleChatButton.dispose(0);
      this.domElement.append(this.hiddenChatButton.domElement);
    }
    const room = getApplication().dialog;
    if (!(room instanceof RoomController) || room.chatPanel == null) return;
    const chat = room.chatPanel;
    for (const widget of [chat.audienceBackground, chat.input, chat.audienceButton, chat.historyButton, chat.floatingMessages, chat.history]) widget.domElement.style.visibility = hidden ? 'hidden' : '';
  }
}
export function createChatVisibilityToggle(): ChatVisibilityToggle {
  const muted = createInteractiveElement(30, null, null, 30),
    sound = createInteractiveElement(30, null, null, 30);
  const element = document.createElement('div'),
    toggle = new ChatVisibilityToggle(muted, sound, element);
  toggle.applyElementStyles(element, 30, null, null, 30);
  toggle.renderChatVisibilityToggle();
  return toggle;
}
