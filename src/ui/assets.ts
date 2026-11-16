import { createImageElement, createSvgImageElement, ImageElement } from './elements';
import { screen } from './theme';
import { ItemDefinition } from '../domain/models';
import { Curse, Guardian, ItemElement, allItemElements as allItemElements, allCurses as allCurses, allGuardians as allGuardians } from '../domain/enums';
import { state } from '../app/state';
import { invalidState } from '../shared/values';

export const artworkSize = {
  item: [80, 80],
  element: [20, 20],
  curseSmall: [16, 30],
  curseMedium: [32, 60],
  guardianSmall: [40, 50],
  guardianMedium: [64, 80],
  guardianLarge: [300, 300],
} as const;

export type ArtworkSize = keyof typeof artworkSize;

export function createScreenBackground(name: string): ImageElement {
  if (name === 'home') {
    const image = createImageElement(`screens/${name}`, 746, screen.width);
    image.domElement.style.top = '-43px';
    return image;
  }
  return createImageElement(`screens/${name}`, screen.height, screen.width);
}
export function createItemArtwork(item: ItemDefinition): ImageElement {
  const [height, width] = artworkSize.item;
  const imageName = item.imageName.startsWith('/')
    ? item.imageName
    : `items/${item.category.key}/${item.imageName}`;
  return createImageElement(imageName, height, width);
}
export function createHiddenItemArtwork(): ImageElement {
  const [height, width] = artworkSize.item;
  const image = createImageElement('items/fake', height, width);
  image.setOpacity(0.5);
  return image;
}
export function createElementArtwork(element: ItemElement): ImageElement {
  const [height, width] = artworkSize.element;
  return createImageElement(`elements/${element.key}`, height, width);
}
export function createCurseArtwork(curse: Curse, size: 'small' | 'medium'): ImageElement {
  const [height, width] = size === 'small' ? artworkSize.curseSmall : artworkSize.curseMedium;
  return createImageElement(`curses/${size}/${curse.key}`, height, width);
}
export function createGuardianArtwork(guardian: Guardian, size: 'small' | 'medium' | 'large'): ImageElement {
  const [height, width] = size === 'small' ? artworkSize.guardianSmall : size === 'medium' ? artworkSize.guardianMedium : artworkSize.guardianLarge;
  return createImageElement(`guardians/${size}/${guardian.key}`, height, width);
}
export function createStoreBadge(store: 'app-store' | 'google-play', language: string, width: number): ImageElement {
  return createSvgImageElement(`badges/${store}/${language}`, width);
}
export function preloadScreenBackgrounds(): void {
  for (const name of ['home', 'menu', 'room', 'fog', 'tiebreak']) createScreenBackground(name);
}
export function preloadGameArtwork(): void {
  const items = state.itemModels.slice(), count = items.length;
  for (const item of items) {
    createItemArtwork(item);
    if (items.length !== count) invalidState(items);
  }
  createHiddenItemArtwork();
  for (const element of allItemElements) createElementArtwork(element);
  for (const curse of allCurses) {
    createCurseArtwork(curse, 'small');
    createCurseArtwork(curse, 'medium');
  }
  for (const guardian of allGuardians) {
    createGuardianArtwork(guardian, 'small');
    createGuardianArtwork(guardian, 'medium');
    createGuardianArtwork(guardian, 'large');
  }
}
