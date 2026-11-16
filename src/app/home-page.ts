import {cloudFunction} from '../services/protocol';
import {layer, opacity, screen} from '../ui/theme';
import {colors} from '../ui/palette';
import {LANGUAGE_ICON} from '../ui/icons';
import { createUserNameEditor } from '../ui/name-editor';
import { AnimatedElement, TextElement, createImageElement, createLinkElement, createImageContainer, createInteractiveElement } from '../ui/elements';
import { FullScreenPanel, StoreBadges, DisposablePanel } from '../ui/decorative';
import { GameMode, GameModeDuel, Language } from '../domain/enums';
import { state } from './state';
import { getFirebaseUserId, signInAnonymously, deleteFirebaseUser, callCloudFunction } from '../services/firebase';
import { preloadGameArtwork, createScreenBackground, createStoreBadge } from '../ui/assets';
import {sounds, playSound, preloadAllSounds} from '../services/audio';
import { truncateDivide } from '../shared/values';
import { RoomController } from '../rooms/room-controller';
import { createRoomController } from './room-page';
import { createDuelMenu } from '../rooms/duel-menu';
import { createBackButton, createSettingsButton, createLanguageDropdown, HomePageLayer, LanguageSelectionMenu, ScrollablePage, CreditsPage, HomeDialogLayer } from '../ui/home-controls';
import type { ItemReferenceMenu } from '../reference/menu';
import type { BackButton } from '../ui/home-controls';
export class HomePage extends AnimatedElement<HTMLDivElement> {
  backButton: BackButton | null = null;
  dialog: DisposablePanel | null = null;
  banner: AnimatedElement | null = null;
  userId: string | null = null;
  userName: string | null = null;
  mode: GameMode | null | undefined = null;
  roomId: string | null = null;
  isRestoringRoom = false;
  hasSubmittedAccountUpdate = false;
  hasPreloadedAssets = false;
  constructor(
    public header: FullScreenPanel,
    public footer: FullScreenPanel,
    public titleLabel: TextElement,
    public userNameLabel: TextElement,
    public referenceMenu: ItemReferenceMenu,
    element: HTMLDivElement,
  ) {
    super(element);
  }
  async ensureFirebaseUser(): Promise<void | null> {
    let result: void | null = null;
    if (this.userId == null) {
      const userId = getFirebaseUserId();
      if (userId !== null) {
        this.userId = userId;
      } else {
        result = await signInAnonymously();
        this.userId = getFirebaseUserId();
      }
    }
    return result;
  }
  async deleteFirebaseUser(): Promise<null> {
    this.userId = null;
    await deleteFirebaseUser();
    return null;
  }
  submitAccountAction(): void {
    if (this.hasSubmittedAccountUpdate) return;
    this.hasSubmittedAccountUpdate = true;
    void callCloudFunction(cloudFunction.updateAccount, new Map());
  }
  preloadGameAssets(): void {
    if (this.hasPreloadedAssets) return;
    this.hasPreloadedAssets = true;
    preloadGameArtwork();
    preloadAllSounds();
  }
  clearHomeOverlay(): void {
    this.backButton?.dispose(0);
    this.backButton = null;
  }
  refreshHomeBackButton(): void {
    const show = this.userName != null || this.banner != null || this.referenceMenu.domElement.isConnected || this.dialog instanceof ScrollablePage;
    this.clearHomeOverlay();
    if (show) {
      const back = createBackButton();
      this.backButton = back;
      this.header.domElement.append(back.domElement);
    }
  }
  setHomeTitle(name: string | null): void {
    this.userName = name;
    this.userNameLabel.domElement.textContent = name ?? '';
    if (name != null) this.userNameLabel.fitFontSize();
  }
  setHomeDialog(panel: DisposablePanel): void {
    if (panel === this.dialog) return;
    this.dialog?.dispose(0);
    this.dialog = panel;
    this.domElement.append(panel.domElement);
    this.refreshHomeBackButton();
    this.refreshHomeTitle();
  }
  renderHomePage(mode: GameMode | null | undefined, roomId: string | null): void {
    this.mode = mode;
    this.roomId = roomId;
    this.setHomeBanner(null);
    if (mode != null) {
      if (roomId == null) {
        if (mode === GameModeDuel) {
          this.setHomeDialog(createDuelMenu());
          return;
        }
      } else {
        this.setHomeDialog(createRoomController(mode, roomId));
        return;
      }
    }
    this.mode = null;
    this.roomId = null;
    if (this.userName == null) {
      const settings = createSettingsButton(),
        element = document.createElement('div'),
        panel = new HomePageLayer(settings, element);
      panel.applyElementStyles(element, screen.height, null, 30, screen.width);
      element.append(createScreenBackground('home').domElement);
      const logo = createImageElement('logo', 190, 590).domElement;
      logo.style.left = '240px';
      logo.style.top = '90px';
      element.append(logo);
      element.append(createUserNameEditor().domElement);
      const badges = document.createElement('div');
      new StoreBadges(badges).applyElementStyles(badges, 100, 320, 530, 440);
      const apple = createLinkElement(`https://apps.apple.com/${state.language.getLanguageCode()}/app/id1536427424?l=${state.language.key}`, 70, null, 10, 180).domElement;
      apple.append(createStoreBadge('app-store', state.language.key, 180).domElement);
      badges.append(apple);
      const google = createLinkElement(`https://play.google.com/store/apps/details?id=net.godfield&hl=${state.language.key}`, 70, 240, 10, 200).domElement;
      google.append(createStoreBadge('google-play', state.language.key, 200).domElement);
      badges.append(google);
      element.append(badges);
      this.footer.domElement.append(settings.domElement);
      this.setHomeDialog(panel);
    } else {
      const element = document.createElement('div'),
        panel = new LanguageSelectionMenu([], element);
      panel.applyElementStyles(element, screen.height, null, 30, screen.width);
      panel.renderLanguageMenu();
      this.setHomeDialog(panel);
    }
  }
  openHomePage(mode: GameMode | null | undefined): void {
    this.renderHomePage(mode, null);
  }
  showCreditsPage(show: boolean): void {
    if (!show) {
      this.openHomePage(null);
      return;
    }
    const settings = createSettingsButton(),
      element = document.createElement('div'),
      panel = new ScrollablePage(settings, element);
    panel.applyElementStyles(element, screen.height, null, 30, screen.width);
    element.style.overflowY = 'scroll';
    panel.setBackgroundColor(colors.cream);
    const icon = createImageContainer(LANGUAGE_ICON, 40, 390, 50, 40).domElement;
    icon.style.color = colors.olive;
    element.append(icon);
    const languages = createLanguageDropdown().domElement;
    languages.style.top = '50px';
    element.append(languages);
    const creditsElement = document.createElement('div'),
      credits = new CreditsPage(creditsElement);
    credits.applyElementStyles(creditsElement, null, null, null, screen.width);
    credits.renderCreditsPage();
    creditsElement.style.top = '200px';
    element.append(creditsElement);
    this.footer.domElement.append(settings.domElement);
    this.setHomeDialog(panel);
  }
  refreshHomeTitle(): void {
    const text = state.translations;
    this.titleLabel.domElement.textContent = this.referenceMenu.domElement.isConnected ? text.getReferenceText('reference') : this.dialog instanceof ScrollablePage ? text.getSettingsText('settings') : this.mode != null ? text.getModeNamesText(this.mode.key) : '';
  }
  setHomeBanner(overlay: AnimatedElement | null): void {
    this.banner?.dispose(0);
    this.banner = null;
    if (overlay != null) {
      overlay.domElement.style.top = '30px';
      overlay.domElement.style.zIndex = layer.raised;
      this.banner = overlay;
      this.domElement.append(overlay.domElement);
    }
    this.refreshHomeBackButton();
  }
  createHomeDimmer(content: AnimatedElement): void {
    const dimmer = createInteractiveElement(null, null, null, null),
      element = document.createElement('div'),
      overlay = new HomeDialogLayer(dimmer, element);
    overlay.applyElementStyles(element, screen.height, null, null, screen.width);
    dimmer.domElement.style.width = `${overlay.getWidth()}px`;
    dimmer.domElement.style.height = `${overlay.getHeight()}px`;
    dimmer.setBackgroundColor(colors.black);
    dimmer.setOpacity(opacity.dim);
    element.append(dimmer.domElement);
    content.domElement.style.left = `${truncateDivide(overlay.getWidth() - content.getWidth(), 2)}px`;
    content.domElement.style.top = `${truncateDivide(overlay.getHeight() - content.getHeight(), 2)}px`;
    element.append(content.domElement);
    dimmer.setActionHandler(() => {
      playSound(sounds.click);
      this.setHomeBanner(null);
    });
    this.setHomeBanner(overlay);
  }
  setReferenceMenuVisible(show: boolean): void {
    if (show) {
      this.referenceMenu.refreshItemsIfNeeded();
      this.referenceMenu.domElement.style.top = '30px';
      this.referenceMenu.domElement.style.zIndex = layer.overlay;
      this.domElement.append(this.referenceMenu.domElement);
    } else this.referenceMenu.dispose(0);
    this.refreshHomeBackButton();
    this.refreshHomeTitle();
    const room = this.dialog instanceof RoomController ? this.dialog : null;
    if (room?.gamePage) room.gamePage.tiebreakBadge.domElement.style.visibility = show ? 'hidden' : '';
  }
  createRoomWithDefaults(mode: GameMode): Promise<null> {
    return this.createRoom(mode, null, null);
  }
  createRoomWithPassword(mode: GameMode, password: string): Promise<null> {
    return this.createRoom(mode, null, password);
  }
  createRoomWithLanguage(mode: GameMode, language: Language): Promise<null> {
    return this.createRoom(mode, language, null);
  }
  async createRoom(mode: GameMode, language: Language | null, password: string | null): Promise<null> {
    if (this.dialog !== null) this.dialog.domElement.style.pointerEvents = 'none';
    const payload = new Map<string, unknown>([['mode', mode.key], ['userName', this.userName]]);
    if (password !== null) payload.set('password', password);
    if (language !== null) payload.set('lang', language.key);
    const response = await callCloudFunction(cloudFunction.createRoom, payload),
      roomId = response.get('roomId');
    if (typeof roomId === 'string') this.renderHomePage(mode, roomId);
    return null;
  }
}
