import {surfaceSize, radius, screen, referenceLayout} from '../ui/theme';
import {colors} from '../ui/palette';
import {REFERENCE_ICON} from '../ui/icons';
import { AnimatedElement, createAnimatedContainer, createImageContainer } from '../ui/elements';
import { ActionCard, Card, applySurface, appendLabel } from '../ui/components';
import { getApplication, state } from '../app/runtime';
import {sounds, preloadSound, playSound} from '../services/audio';
import { Category, CategoryTrade, CategoryWeapons, CategoryArmor, CategorySundries, CategoryMiracles, CategoryDevils, CategoryPhenomena } from '../domain/enums';
import { ReferenceContent, ElementReference, StatusEffectsReference, createItemReference, createGuardianReference } from './pages';

const referenceCategories: ReadonlyMap<number, Category> = new Map([
  [2, CategoryTrade],
  [3, CategoryWeapons],
  [4, CategoryArmor],
  [5, CategorySundries],
  [6, CategoryMiracles],
  [7, CategoryDevils],
  [9, CategoryPhenomena],
]);

export class ReferenceButton extends ActionCard {
  renderReferenceButton(): void {
    const background = createAnimatedContainer(24, 10, 3, 180);
    applySurface(background, {...surfaceSize.headerButton, left: 10, top: 3, radius: radius.small, background: colors.mintLight});
    const icon = createImageContainer(REFERENCE_ICON, 24, 10, null, 24);
    icon.domElement.style.color = colors.brand;
    background.domElement.append(icon.domElement);
    appendLabel(background, {
      text: state.translations.getReferenceText('reference'),
      height: 24, left: 40, top: null, width: 100,
      size: 20, color: colors.brand, fit: true
    });
    this.domElement.append(background.domElement);
    this.applyAction(async () => {
      preloadSound(sounds.reference);
      playSound(sounds.click);
      const application = getApplication();
      application.setReferenceMenuVisible(!application.referenceMenu.domElement.isConnected);
      return null;
    });
  }
}
export function createReferenceButton(): ReferenceButton {
  const element = document.createElement('div'),
    button = new ReferenceButton(element);
  button.applyElementStyles(element, 30, 880, null, 200);
  button.renderReferenceButton();
  return button;
}
export class ReferencePageKey {
  constructor(public key: string, public index: number) {}
  createReferencePage(): ReferenceContent {
    if (this.index === 0 || this.index === 1) {
      const element = document.createElement('div'),
        page = this.index === 0 ? new ElementReference(element) : new StatusEffectsReference(element);
      applySurface(page, {height: screen.height, left: referenceLayout.pageLeft, width: referenceLayout.pageWidth});
      if (page instanceof ElementReference) {
        page.renderElementReference();
      } else {
        page.renderStatusEffectsReference();
      }
      return page;
    }
    if (this.index === 8) return createGuardianReference();
    const category = referenceCategories.get(this.index);
    if (category === undefined) throw new Error('Unknown reference page');
    return createItemReference(category);
  }
}
export const referencePages = ['elements', 'curses', 'trade', 'weapons', 'armor', 'sundries', 'miracles', 'devils', 'guardians', 'phenomena'].map((key, index) => new ReferencePageKey(key, index));
export class ItemCategoryButton extends ActionCard {
  constructor(public page: ReferencePageKey, element: HTMLDivElement) {
    super(element);
  }
}
export class ItemReferenceMenu extends Card {
  selectedCategory: ItemCategoryButton | null = null;
  contentWidget: ReferenceContent | null = null;
  renderedItemsVersion = -1;
  renderItemReferenceMenu(): void {
    const background = createAnimatedContainer(this.getHeight(), null, null, this.getWidth());
    applySurface(background, {height: this.getHeight(), width: this.getWidth(), background: colors.chatGreen});
    this.domElement.append(background.domElement);
    const border = createAnimatedContainer(this.getHeight(), null, null, this.getWidth());
    border.setBorderLeft(10, colors.brand);
    border.setBorderRight(10, colors.brand);
    this.domElement.append(border.domElement);
    for (const page of referencePages) {
      const large = page.index < 2,
        height = large ? 70 : 50,
        element = document.createElement('div'),
        button = new ItemCategoryButton(page, element);
      button.renderCard({
        height, left: 20, width: 220, radius: radius.small,
        background: colors.blue,
        insetBorder: {width: 1, color: colors.lavender, inset: 2},
        label: {
          text: state.translations.getReferenceText(page.key),
          height, left: 10, top: null, width: 200,
          size: large ? 40 : 30, color: colors.lavender, fit: true
        }
      });
      const top = large ? 15 + page.index * 75 : page.index < 7 ? 180 + (page.index - 2) * 55 : page.index === 7 ? 465 : page.index === 8 ? 530 : 595;
      element.style.top = `${top}px`;
      button.applyAction(() => {
        playSound(sounds.reference);
        this.selectItemReferenceCategory(button);
      });
      if (page.index === 0) this.selectItemReferenceCategory(button);
      this.domElement.append(element);
    }
  }
  selectItemReferenceCategory(button: ItemCategoryButton): void {
    if (this.selectedCategory !== null) {
      this.selectedCategory.setBackgroundColor(colors.blue);
      this.selectedCategory.domElement.style.pointerEvents = '';
    }
    button.setBackgroundColor(colors.blueLight);
    button.domElement.style.pointerEvents = 'none';
    this.selectedCategory = button;
    this.contentWidget?.dispose(0);
    this.contentWidget = button.page.createReferencePage();
    this.domElement.append(this.contentWidget.domElement);
    this.renderedItemsVersion = state.referenceItemsVersion;
  }
  refreshItemsIfNeeded(): void {
    if (
      this.selectedCategory === null ||
      this.renderedItemsVersion === state.referenceItemsVersion
    ) {
      return;
    }
    this.contentWidget?.dispose(0);
    this.contentWidget = this.selectedCategory.page.createReferencePage();
    this.domElement.append(this.contentWidget.domElement);
    this.renderedItemsVersion = state.referenceItemsVersion;
  }
}
export function createItemReferenceMenu(): ItemReferenceMenu {
  const element = document.createElement('div'),
    menu = new ItemReferenceMenu(element);
  menu.applySurface({height: screen.height, width: screen.width});
  menu.renderItemReferenceMenu();
  return menu;
}
