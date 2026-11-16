import { opacity, layer } from './theme';
import { colors } from './palette';
import { Easing, EasingLinear, TextAlignment } from '../domain/enums';
import { parseInteger, parseDouble } from '../shared/values';
import { getMeasuringElement } from './measurement';

export type Dimension = number | null;
export type Frames = readonly (Keyframe | ReadonlyMap<string, string | number>)[];
export interface ElementBounds {
  height?: Dimension;
  left?: Dimension;
  top?: Dimension;
  width?: Dimension;
}
export interface ElementPosition {
  left?: Dimension;
  top?: Dimension;
}
const pixels = (value: string): number => value.length ? parseInteger(value.replaceAll('px', '')) : 0;

export class GameElement<T extends HTMLElement = HTMLElement> {
  domElement!: T;
  constructor(element?: T) {
    if (element) {
      this.domElement = element;
    }
  }
  get element(): unknown { return this.domElement; }
  set element(value: unknown) { this.domElement = value as T; }
  get container(): T { return this.domElement; }
  set container(value: T) { this.domElement = value; }
  applyElementStyles(_element: HTMLElement, height: Dimension, left: Dimension, top: Dimension, width: Dimension): void {
    const style = this.domElement.style;
    style.margin = '0px';
    style.padding = '0px';
    style.outline = '0px';
    style.boxSizing = 'border-box';
    style.overflow = 'hidden';
    style.userSelect = 'none';
    style.position = 'absolute';
    this.setBounds(height, left, top, width);
    style.zIndex = layer.base;
  }
  getLeft(): number { return pixels(this.domElement.style.left); }
  getTop(): number { return pixels(this.domElement.style.top); }
  getWidth(): number { return pixels(this.domElement.style.width); }
  getHeight(): number { return pixels(this.domElement.style.height); }
  setTop(top: number): void { this.domElement.style.top = `${top}px`; }
  setHeight(height: number): void { this.domElement.style.height = `${height}px`; }
  setElementBounds(bounds: ElementBounds): void {
    const style = this.domElement.style;
    if (bounds.left != null) {
      style.left = `${bounds.left}px`;
    }
    if (bounds.top != null) {
      style.top = `${bounds.top}px`;
    }
    if (bounds.width != null) {
      style.width = `${bounds.width}px`;
    }
    if (bounds.height != null) {
      this.setHeight(bounds.height);
    }
  }

  setBounds(height: Dimension, left: Dimension, top: Dimension, width: Dimension): void {
    this.setElementBounds({ height, left, top, width });
  }

  setHeightLeftWidth(height: Dimension, left: Dimension, width: Dimension): void {
    this.setElementBounds({ height, left, width });
  }

  setSize(height: Dimension, width: Dimension): void {
    this.setElementBounds({ height, width });
  }

  setPosition(left: Dimension, top: Dimension): void {
    this.setElementBounds({ left, top });
  }
  getOpacity(): number {
    const value = this.domElement.style.opacity;
    return value.length ? parseDouble(value) : 1;
  }
  setOpacity(opacity: number): void {
    this.domElement.style.opacity = opacity === 1 ? '' : String(opacity);
  }
  rotateElement(degrees: number): void {
    this.domElement.style.transform = `rotate(${degrees}deg)`;
  }
  setBorderRadius(radius: number): void {
    const style = this.domElement.style;
    const value = `${radius}px`;
    style.borderTopLeftRadius = value;
    style.borderTopRightRadius = value;
    style.borderBottomLeftRadius = value;
    style.borderBottomRightRadius = value;
  }
  setBorder(width: number, color: string): void {
    const style = this.domElement.style;
    const value = `${width}px solid ${color}`;
    style.borderTop = value;
    style.borderBottom = value;
    this.setBorderLeft(width, color);
    this.setBorderRight(width, color);
  }
  setBorderLeft(width: number, color: string): void {
    this.domElement.style.borderLeft = `${width}px solid ${color}`;
  }
  setBorderRight(width: number, color: string): void {
    this.domElement.style.borderRight = `${width}px solid ${color}`;
  }
  setBackgroundColor(color: string | null): void {
    this.domElement.style.backgroundColor = color ?? 'transparent';
  }
  append(child: GameElement): void {
    this.domElement.append(child.domElement);
  }
  disposeElement(_ignored?: unknown): void {
    const element = this.domElement;
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.cancel();
    }
    element.remove();
  }
  setContentHeight(height: number): void {
    this.setHeight(height);
  }
  dispose(_ignored?: unknown): void {
    this.disposeElement();
  }
}

export class AnimationCancelledError extends Error {
  constructor(message: string) {
    super(message);
  }
  toString(): string { return `AnimationException: ${this.message}`; }
}
export class AnimatedElement<T extends HTMLElement = HTMLElement> extends GameElement<T> {
  setMouseOverHandler(callback: () => unknown): void {
    this.domElement.addEventListener('mouseover', () => callback(), false);
  }
  createRoundedClone(): AnimatedElement {
    const clone = createAnimatedContainer(this.getHeight(), null, null, this.getWidth());
    const original = this.domElement.style;
    const style = clone.domElement.style;
    style.borderTopLeftRadius = `${pixels(original.borderTopLeftRadius)}px`;
    style.borderTopRightRadius = `${pixels(original.borderTopRightRadius)}px`;
    style.borderBottomLeftRadius = `${pixels(original.borderBottomLeftRadius)}px`;
    style.borderBottomRightRadius = `${pixels(original.borderBottomRightRadius)}px`;
    return clone;
  }
  addInsetBorderOverlay(width: number, color: string, inset: number): void {
    let clone: AnimatedElement;
    if (inset === 0) {
      clone = this.createRoundedClone();
    } else {
      clone = createAnimatedContainer(this.getHeight() - inset * 2, inset, inset, this.getWidth() - inset * 2);
      const original = this.domElement.style;
      const style = clone.domElement.style;
      style.borderTopLeftRadius = `${pixels(original.borderTopLeftRadius) - inset}px`;
      style.borderTopRightRadius = `${pixels(original.borderTopRightRadius) - inset}px`;
      style.borderBottomLeftRadius = `${pixels(original.borderBottomLeftRadius) - inset}px`;
      style.borderBottomRightRadius = `${pixels(original.borderBottomRightRadius) - inset}px`;
    }
    clone.setBorder(width, color);
    this.domElement.append(clone.domElement);
  }
  addBorderOverlay(width: number, color: string): void {
    this.addInsetBorderOverlay(width, color, 0);
  }
  animate(frames: Frames, duration: number, easing: Easing | null): Promise<null> {
    return this.animateElement(frames, duration, easing);
  }
  animateWithDefaults(frames: Frames, duration: number): Promise<null> {
    return this.animate(frames, duration, null);
  }
  async animateElement(frames: Frames, duration: number, easing: Easing | null): Promise<null> {
    const keyframes = frames.map(frame => frame instanceof Map ? Object.fromEntries(frame) : frame);
    const animation = this.domElement.animate(keyframes, { duration, easing: (easing ?? EasingLinear).key, fill: 'forwards' });
    try {
      await animation.finished;
    } catch (error) {

      if (isAbortError(error)) throw new AnimationCancelledError(String(error));
      throw error;
    }
    return null;
  }
  async animateAsync(duration: number): Promise<null> {
    await this.animateWithDefaults([], duration);
    return null;
  }
  async translateElement(duration: number, easing: Easing | null, left: Dimension, top: Dimension): Promise<null> {
    left ??= this.getLeft();
    top ??= this.getTop();
    const frames = [{ transform: `translate(${this.getLeft() - left}px, ${this.getTop() - top}px)` }, { transform: 'translate(0px, 0px)' }];
    const element = this.domElement;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    await this.animate(frames, duration, easing);
    element.style.transform = 'none';
    return null;
  }

  animateToPosition(position: ElementPosition, duration: number, easing: Easing | null): Promise<null> {
    return this.translateElement(duration, easing, position.left ?? null, position.top ?? null);
  }

  async animateRectClip(easing: Easing | null, duration: number): Promise<null> {
    const width = this.getWidth();
    const height = this.getHeight();
    const middle = Math.trunc(height / 2);
    await this.animate([{ clipPath: `rect(${middle}px ${width}px ${middle}px 0px)` }, { clipPath: `rect(0px ${width}px ${height}px 0px)` }], duration, easing);
    this.domElement.style.clipPath = 'none';
    return null;
  }
  async animateCircleClip(easing: Easing | null, duration: number, radius: number): Promise<null> {
    await this.animate([{ clipPath: 'circle(0px)' }, { clipPath: `circle(${radius}px)` }], duration, easing);
    this.domElement.style.clipPath = 'none';
    return null;
  }
  async fadeElement(duration: number, easing: Easing | null, opacity: number): Promise<null> {
    await this.animate([{ opacity: this.getOpacity() }, { opacity }], duration, easing);
    return null;
  }
  async fadeIn(duration: number, easing: Easing | null): Promise<null> {
    await this.fadeElement(duration, easing, 1);
    this.setOpacity(opacity.visible);
    return null;
  }
  fadeInWithDefaults(duration: number): Promise<null> {
    return this.fadeIn(duration, null);
  }
  async fadeOut(duration: number, easing: Easing | null): Promise<null> {
    await this.fadeElement(duration, easing, 0);
    this.setOpacity(opacity.hidden);
    return null;
  }
  fadeOutWithDefaults(duration: number): Promise<null> {
    return this.fadeOut(duration, null);
  }
}
export class InteractiveElement extends AnimatedElement {
  interactionOverlay: AnimatedElement | null = null;
  disabledOverlay: AnimatedElement | null = null;
  setActionHandler(callback: () => unknown): void {
    this.domElement.addEventListener('click', () => callback(), false);
  }
  initializeClickable(): void {
    if (this.interactionOverlay !== null) {
      return;
    }
    this.resetClickable();
    const element = this.domElement;
    element.style.cursor = 'pointer';
    const overlay = this.createRoundedClone();
    overlay.setOpacity(opacity.hidden);
    overlay.setMouseOverHandler(() => {
      overlay.setBackgroundColor(colors.white);
      overlay.setOpacity(opacity.faint);
    });
    overlay.domElement.addEventListener('mouseout', () => overlay.setOpacity(opacity.hidden), false);
    overlay.domElement.addEventListener('mousedown', () => {
      overlay.setBackgroundColor(colors.black);
      overlay.setOpacity(opacity.faint);
    }, false);
    overlay.domElement.addEventListener('mouseup', () => {
      overlay.setBackgroundColor(colors.white);
      overlay.setOpacity(opacity.faint);
    }, false);
    this.interactionOverlay = overlay;
    element.append(overlay.domElement);
  }
  resetClickable(): void {
    this.domElement.style.cursor = '';
    this.interactionOverlay?.dispose();
    this.interactionOverlay = null;
  }
  setDisabled(disabled: boolean): void {
    if (disabled) {
      if (this.disabledOverlay !== null) {
        return;
      }
      const overlay = this.createRoundedClone();
      overlay.setBackgroundColor(colors.black);
      overlay.setOpacity(opacity.disabledOverlay);
      this.disabledOverlay = overlay;
      this.domElement.append(overlay.domElement);
    } else {
      this.disabledOverlay?.dispose();
      this.disabledOverlay = null;
    }
    this.domElement.style.pointerEvents = disabled ? 'none' : '';
  }
}
export class TextStyler<T extends HTMLElement = HTMLElement> extends GameElement<T> {
  applyTextStyle(size: number, color: string, bold: boolean): void {
    const style = this.domElement.style;
    style.fontSize = `${size}px`;
    style.color = color;
    style.fontWeight = bold ? 'bold' : '';
  }
  applyNormalTextStyle(size: number, color: string): void {
    this.applyTextStyle(size, color, false);
  }
}
export class TextElement extends TextStyler {
  constructor(element?: HTMLElement) {
    super(element);
    if (element && !element.style.textAlign) {
      element.style.textAlign = 'center';
    }
  }

  get element(): HTMLElement { return this.domElement; }
  set element(value: HTMLElement) { this.domElement = value; }
  override setHeight(height: number): void {
    super.setHeight(height);
    this.domElement.style.lineHeight = `${height}px`;
  }
  setText(text: string, _height?: Dimension, _left?: Dimension, _top?: Dimension, _width?: Dimension): void {
    const element = this.domElement;
    element.style.overflow = 'visible';
    element.textContent = text;
    element.style.pointerEvents = 'none';
  }
  setContentHeight(height: number): void {
    this.setHeight(height);
  }
  getText(): string {
    return this.domElement.textContent ?? '';
  }
  setTextAlignment(alignment: TextAlignment): void {
    this.domElement.style.textAlign = alignment.key;
  }
  setTextDecoration(color: string | null): void {
    this.domElement.style.textDecoration = color === null ? '' : `underline ${color}`;
  }
  setTextShadow(color: string): void {
    const shadows: string[] = [];
    for (const horizontalOffset of [-1, 0, 1]) {
      for (const verticalOffset of [-1, 0, 1]) {
        if (horizontalOffset !== 0 || verticalOffset !== 0) {
          shadows.push(`${horizontalOffset}px ${verticalOffset}px ${color}`);
        }
      }
    }
    this.domElement.style.textShadow = shadows.join(',');
  }
  fitFontSize(): void {
    const measure = getMeasuringElement().domElement;
    const element = this.domElement;
    measure.textContent = this.getText();
    measure.style.fontWeight = element.style.fontWeight === 'bold' ? 'bold' : '';
    let size = pixels(element.style.fontSize);
    for (; size >= 12; size--) {
      measure.style.fontSize = `${size}px`;
      if (measure.offsetWidth < pixels(element.style.width)) {
        break;
      }
    }
    measure.textContent = '';
    element.style.fontSize = `${size}px`;
  }
}
export class KeydownHandler extends TextStyler<HTMLInputElement> {
  get element(): HTMLInputElement { return this.domElement; }
  set element(value: HTMLInputElement) { this.domElement = value; }
  setKeydownHandler(callback: (key: string) => unknown): void {
    this.domElement.addEventListener('keydown', event => callback(event.key), false);
  }
}
export class ChangeHandler extends TextStyler<HTMLSelectElement> {
  get element(): HTMLSelectElement { return this.domElement; }
  set element(value: HTMLSelectElement) { this.domElement = value; }
  setChangeHandler(callback: () => unknown): void {
    this.domElement.addEventListener('change', () => callback(), false);
  }
}
export class LinkElement extends GameElement<HTMLAnchorElement> { }
export class ImageElement extends GameElement<HTMLImageElement> { }
export class ImageContainer extends GameElement { }

export function createElement(element: HTMLElement, height: Dimension, left: Dimension, top: Dimension, width: Dimension): GameElement {
  const widget = new GameElement(element);
  widget.applyElementStyles(element, height, left, top, width);
  return widget;
}
export function createAnimatedContainer(height: Dimension, left: Dimension, top: Dimension, width: Dimension): AnimatedElement {
  const element = document.createElement('div'), widget = new AnimatedElement(element);
  widget.applyElementStyles(element, height, left, top, width);
  return widget;
}
export function createInteractiveElement(height: Dimension, left: Dimension, top: Dimension, width: Dimension): InteractiveElement {
  const element = document.createElement('div'), widget = new InteractiveElement(element);
  widget.applyElementStyles(element, height, left, top, width);
  return widget;
}
export function createLinkElement(url: string, height: Dimension, left: Dimension, top: Dimension, width: Dimension): LinkElement {
  const element = document.createElement('a');
  element.href = url;
  const widget = new LinkElement(element);
  widget.applyElementStyles(element, height, left, top, width);
  return widget;
}
export function createImageElement(name: string, height: Dimension, width: Dimension): ImageElement {
  const element = document.createElement('img');
  element.src = name.startsWith('/') || name.startsWith('http://') || name.startsWith('https://') ? name : `/images/${name}.webp`;
  const widget = new ImageElement(element);
  widget.applyElementStyles(element, height, null, null, width);
  element.style.pointerEvents = 'none';
  return widget;
}
export function createSvgImageElement(name: string, width: Dimension): ImageElement {
  const element = document.createElement('img');
  element.src = `/images/${name}.svg`;
  const widget = new ImageElement(element);
  widget.applyElementStyles(element, null, null, null, width);
  element.style.pointerEvents = 'none';
  return widget;
}
export function createTextInput(height: Dimension, left: Dimension, top: Dimension, width: Dimension): KeydownHandler {
  const element = document.createElement('input');
  element.type = 'text';
  const widget = new KeydownHandler(element);
  widget.applyElementStyles(element, height, left, top, width);
  widget.setBackgroundColor(colors.inputYellow);
  element.style.border = 'none';
  element.style.padding = '2px 5px';
  element.style.userSelect = 'auto';
  return widget;
}
export function createTextElement(text: string, height: Dimension, left: Dimension, top: Dimension, width: Dimension): TextElement {
  const element = document.createElement('span'), widget = new TextElement(element);
  widget.applyElementStyles(element, height, left, top, width);
  widget.setText(text, height, left, top, width);
  return widget;
}
export function createImageContainer(markup: string | null, height: Dimension, left: Dimension, top: Dimension, width: Dimension): ImageContainer {
  const element = document.createElement('div'), widget = new ImageContainer(element);
  widget.applyElementStyles(element, height, left, top, width);
  element.style.overflow = 'visible';
  if (markup != null) element.innerHTML = markup;
  element.style.pointerEvents = 'none';
  return widget;
}
function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}
export async function ignoreCancelledAnimation(operation: PromiseLike<unknown>): Promise<null> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof AnimationCancelledError) && !isAbortError(error)) {
      throw error;
    }
  }
  return null;
}
export function runScheduledCallback(operation: PromiseLike<unknown>): void { void ignoreCancelledAnimation(operation); }
