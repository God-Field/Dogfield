import {radius, screen, referenceLayout} from '../ui/theme';
import { AnimatedElement, createAnimatedContainer, createTextElement } from '../ui/elements';
import { applySurface, appendLabel } from '../ui/components';
import { NoteBox, ItemRatesContent } from '../ui/decorative';
import { state } from '../app/state';
import { Category, ItemElement, Guardian, CategoryWeapons, CategoryArmor, CategoryGuardians, GuardianMars, GuardianMercury, GuardianJupiter, GuardianSaturn, GuardianUranus, GuardianPluto, GuardianNeptune, GuardianVenus, GuardianEarth, GuardianMoon, CurseDarkcloud, ItemElementDarkness, ItemElementFire, ItemElementWater, ItemElementWood, ItemElementStone, ItemElementLight, allItemElements, allCurses } from '../domain/enums';
import { ItemDefinition } from '../domain/models';
import {colors, elementColor} from '../ui/palette';
import {createItemArtwork, createElementArtwork, createGuardianArtwork} from '../ui/assets';
import { replaceFirst } from '../shared/values';
import { createCombatCounterDetails, createCurseMediumIcon, createGuardianMediumIcon } from '../battle/item-details';
export class ReferenceContent extends AnimatedElement<HTMLDivElement> {
  private details: ItemRatesPanel | null = null;
  setReferenceContent(panel: ItemRatesPanel): void {
    this.details?.dispose(0);
    this.details = panel;
    this.domElement.append(panel.domElement);
  }
}
export function createNoteText(markup: string, height: number, width: number): NoteBox {
  const element = document.createElement('div'),
    note = new NoteBox(element);
  note.applySurface({height, width, radius: radius.small, background: colors.noteGreen, border: {width: 1, color: colors.brand}});
  note.appendLabel({
    text: '', markup, height, left: 10, top: null, width: width - 10,
    size: 16, color: colors.text, align: 'left', lineHeight: 30
  });
  return note;
}
function appendNote(parent: HTMLElement, key: string, top: number, width = 760, height = 30, left?: number): void {
  const note = createNoteText(state.translations.getReferenceText(key), height, width);
  if (left !== undefined) note.domElement.style.left = `${left}px`;
  note.domElement.style.top = `${top}px`;
  parent.append(note.domElement);
}
function itemCell(parent: HTMLElement, item: ItemDefinition, left: number, top: number, onHover: () => void): void {
  const image = createItemArtwork(item);
  image.domElement.style.left = `${left}px`;
  image.domElement.style.top = `${top}px`;
  parent.append(image.domElement);
  const hitbox = createAnimatedContainer(referenceLayout.cellSize, null, null, referenceLayout.cellSize);
  hitbox.domElement.style.left = `${left}px`;
  hitbox.domElement.style.top = `${top}px`;
  hitbox.setMouseOverHandler(onHover);
  parent.append(hitbox.domElement);
}
function itemBreak(category: Category, item: ItemDefinition): [boolean, number] {
  let wrap = false,
    gap = 0;
  switch (category.index) {
    case 0:
      wrap = item.ability === 'sacrifice';
      if (wrap) gap = 10;
      break;
    case 1:
      wrap = item.ability === 'atkBy2xMP' || item.ability === 'danger';
      if (wrap) gap = 10;
      break;
    case 2:
      wrap = item.defense === 30 || item.guardian === GuardianVenus;
      if (wrap) gap = 10;
      break;
    case 3:
      wrap = item.abilityValue === 20 || item.ability === 'removeAllCurses' || item.ability === 'callPhenomenon';
      if (wrap) gap = 10;
      break;
    case 4:
      wrap = item.attack === 25 || item.curse === CurseDarkcloud || item.attack === 30;
      if (wrap) gap = 10;
      break;
    case 5:
      wrap = item.abilityValue === 30;
      if (wrap) gap = 10;
      break;
    case 7:
      wrap = item.element === ItemElementDarkness;
      break;
  }
  return [wrap, gap];
}
export class ItemReference extends ReferenceContent {
  renderItemReference(category: Category): void {
    const grid = createAnimatedContainer(referenceLayout.gridHeight, referenceLayout.gridLeft, referenceLayout.gridTop, referenceLayout.gridWidth);
    if (category === CategoryWeapons || category === CategoryArmor) grid.domElement.style.overflowY = 'scroll';
    this.domElement.append(grid.domElement);
    let row = 0,
      column = 0,
      gap = 0;
    for (const item of state.itemModels.slice().filter(item => item.category === category)) {
      itemCell(grid.domElement, item, column * referenceLayout.cellStep, gap + row * referenceLayout.cellStep, () => this.setReferenceContent(createItemRatesPanel(item)));
      const [wrap, extra] = itemBreak(category, item);
      gap += extra;
      if (wrap || column === 8) {
        row++;
        column = 0;
      } else column++;
    }
    switch (category.index) {
      case 0:
        appendNote(grid.domElement, 'discardNote', 220);
        appendNote(grid.domElement, 'sacrificeNote', 260);
        break;
      case 2:
        appendNote(grid.domElement, 'bounceNote', 890);
        break;
      case 4:
        appendNote(grid.domElement, 'miraclesNote', 400);
        appendNote(grid.domElement, 'usedMiraclesNote', 440);
        break;
      case 5:
        appendNote(grid.domElement, 'devilsNote', 220);
        break;
    }
  }
}
export function createItemReference(category: Category): ItemReference {
  const element = document.createElement('div'),
    page = new ItemReference(element);
  page.applyElementStyles(element, screen.height, referenceLayout.pageLeft, null, referenceLayout.pageWidth);
  page.renderItemReference(category);
  return page;
}
export class GuardianReference extends ReferenceContent {
  private preview: ItemRatesContent | null = null;
  renderGuardianReference(): void {
    const grid = createAnimatedContainer(referenceLayout.gridHeight, referenceLayout.gridLeft, referenceLayout.gridTop, referenceLayout.gridWidth);
    grid.domElement.style.overflowY = 'scroll';
    this.domElement.append(grid.domElement);
    const guardians = [GuardianMars, GuardianMercury, GuardianJupiter, GuardianSaturn, GuardianUranus, GuardianPluto, GuardianNeptune, GuardianVenus, GuardianEarth, GuardianMoon];
    for (const [row, guardian] of guardians.entries()) for (const [column, item] of state.itemModels.slice().filter(item => item.category === CategoryGuardians && item.guardian === guardian).entries()) itemCell(grid.domElement, item, column * referenceLayout.cellStep, row * referenceLayout.cellStep, () => this.showGuardian(item, guardian));
    appendNote(grid.domElement, 'earthNote', 690, 335, 60, 85);
    appendNote(grid.domElement, 'moonNote', 775, 335, 60, 85);
    appendNote(grid.domElement, 'guardianAttackNote', 860);
    appendNote(grid.domElement, 'guardiansNote', 900);
  }
  private showGuardian(item: ItemDefinition, guardian: Guardian): void {
    this.setReferenceContent(createItemRatesPanel(item));
    const element = document.createElement('div'),
      preview = new ItemRatesContent(element);
    preview.applyElementStyles(element, referenceLayout.previewHeight, referenceLayout.previewLeft, referenceLayout.previewTop, referenceLayout.previewWidth);
    element.append(createGuardianArtwork(guardian, 'large').domElement);
    const description = createGuardianMediumIcon(guardian);
    description.domElement.style.top = '310px';
    element.append(description.domElement);
    this.preview?.dispose(0);
    this.preview = preview;
    this.domElement.append(element);
  }
}
export function createGuardianReference(): GuardianReference {
  const element = document.createElement('div'),
    page = new GuardianReference(element);
  page.applyElementStyles(element, screen.height, referenceLayout.pageLeft, null, referenceLayout.pageWidth);
  page.renderGuardianReference();
  return page;
}
export class ItemRatesPanel extends AnimatedElement<HTMLDivElement> {
  renderItemRates(item: ItemDefinition): void {
    this.domElement.append(createCombatCounterDetails(item, 0, false, 0, null, false, 0, 0).domElement);
    const texts = state.translations;
    let text: string | null;
    switch (item.category.index) {
      case 5:
        text = `${texts.getReferenceText('appearanceRate')}: ${replaceFirst(texts.getReferenceText('ratePercent'), '{{rate}}', String(item.appearanceRate))}`;
        break;
      case 6:
        text = item.guardianAttackRate > 0 ? `${texts.getReferenceText('guardianAttackRate')}: ${replaceFirst(texts.getReferenceText('ratePercent'), '{{rate}}', String(100 * item.guardianAttackRate / 20))}` : null;
        break;
      default:
        text = item.giftRate > 0 ? `${texts.getReferenceText('giftRate')}: ${item.giftRate}/${state.totalGiftRate}` : null;
    }
    if (text !== null) {
      const note = createNoteText(text, 30, 380);
      note.setPosition(330, 54);
      this.domElement.append(note.domElement);
    }
  }
}
export function createItemRatesPanel(item: ItemDefinition): ItemRatesPanel {
  const element = document.createElement('div'),
    panel = new ItemRatesPanel(element);
  panel.applyElementStyles(element, referenceLayout.ratesHeight, referenceLayout.gridLeft, referenceLayout.ratesTop, referenceLayout.gridWidth);
  panel.renderItemRates(item);
  return panel;
}
export class ElementReference extends ReferenceContent {
  highlightElementNames(text: string, element: ItemElement): string {
    return replaceFirst(text, `{{${element.key}}}`, `<span style="color: ${elementColor(element)}">${state.translations.getElementNamesText(element.key)}</span>`);
  }
  renderElementReference(): void {
    const texts = state.translations,
      items = [null, ...allItemElements];
    for (const [index, item] of items.entries()) {
      const darkness = item === ItemElementDarkness,
        row = createAnimatedContainer(darkness ? 65 : 36, 10, 115 + index * 35, 750);
      if (index === 0) {
        row.domElement.style.borderTopLeftRadius = '5px';
        row.domElement.style.borderTopRightRadius = '5px';
      } else if (index === items.length - 1) {
        row.domElement.style.borderBottomLeftRadius = '5px';
        row.domElement.style.borderBottomRightRadius = '5px';
      }
      row.setBackgroundColor(colors.noteGreen);
      row.addBorderOverlay(1, colors.brand);
      if (item !== null) {
        const image = createElementArtwork(item);
        image.setPosition(8, 8);
        row.domElement.append(image.domElement);
      }
      const label = createTextElement('', darkness ? 60 : 30, 34, 3, 650);
      label.domElement.style.lineHeight = '30px';
      label.domElement.style.textAlign = 'left';
      label.applyNormalTextStyle(18, colors.text);
      let description = texts.elementDescriptions.get(item?.key ?? '') ?? '';
      const highlights = item === ItemElementFire || item === ItemElementWater ? [ItemElementFire, ItemElementWater] : item === ItemElementWood || item === ItemElementStone ? [ItemElementWood, ItemElementStone] : item === ItemElementLight ? [ItemElementLight] : darkness ? [ItemElementDarkness] : [];
      for (const element of highlights) description = this.highlightElementNames(description, element);
      label.domElement.innerHTML = description;
      if (item === null) label.fitFontSize();
      row.domElement.append(label.domElement);
      this.domElement.append(row.domElement);
    }
    appendNote(this.domElement, 'elementsNote', 440, 750, 30, 10);
    let lightNote = this.highlightElementNames(texts.getReferenceText('lightNote'), ItemElementLight);
    for (const item of [ItemElementFire, ItemElementWater, ItemElementWood, ItemElementStone]) lightNote = this.highlightElementNames(lightNote, item);
    const note = createNoteText(lightNote, 30, 750);
    note.setPosition(10, 480);
    this.domElement.append(note.domElement);
  }
}
export class StatusEffectsReference extends ReferenceContent {
  renderStatusEffectsReference(): void {
    for (const [index, curse] of allCurses.entries()) {
      const icon = createCurseMediumIcon(curse);
      icon.domElement.style.left = `${10 + (index < 4 ? 0 : 350)}px`;
      icon.domElement.style.top = `${115 + index % 4 * 100}px`;
      this.domElement.append(icon.domElement);
    }
    appendNote(this.domElement, 'diseasesNote', 520, 750, 30, 10);
    appendNote(this.domElement, 'diseaseUpgradeNote', 560, 750, 30, 10);
    appendNote(this.domElement, 'fogNote', 600, 750, 30, 10);
  }
}
