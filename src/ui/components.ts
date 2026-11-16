import {
  AnimatedElement,
  InteractiveElement,
  TextElement,
  createTextElement,
  type Dimension,
} from './elements';

export interface SurfaceOptions {
  height: Dimension;
  left?: Dimension;
  top?: Dimension;
  width: Dimension;
  radius?: number;
  corners?: {topLeft?: number; topRight?: number; bottomLeft?: number; bottomRight?: number};
  background?: string | null;
  border?: {width: number; color: string};
  edgeBorder?: {width: number; color: string};
  insetBorder?: {width: number; color: string; inset: number};
  opacity?: number;
}

export interface LabelOptions {
  text: string;
  height: Dimension;
  left: Dimension;
  top: Dimension;
  width: Dimension;
  size: number;
  color: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  fit?: boolean;
  shadow?: string;
  lineHeight?: number;
  decoration?: string | null;
  nowrap?: boolean;
  markup?: string;
}

export interface CardOptions extends SurfaceOptions {
  label?: LabelOptions;
}

export function applySurface(target: AnimatedElement, options: SurfaceOptions): void {
  target.applyElementStyles(target.domElement, options.height, options.left ?? null, options.top ?? null, options.width);
  if (options.radius !== undefined) target.setBorderRadius(options.radius);
  if (options.corners !== undefined) {
    const style = target.domElement.style;
    if (options.corners.topLeft !== undefined) style.borderTopLeftRadius = `${options.corners.topLeft}px`;
    if (options.corners.topRight !== undefined) style.borderTopRightRadius = `${options.corners.topRight}px`;
    if (options.corners.bottomLeft !== undefined) style.borderBottomLeftRadius = `${options.corners.bottomLeft}px`;
    if (options.corners.bottomRight !== undefined) style.borderBottomRightRadius = `${options.corners.bottomRight}px`;
  }
  if (options.background !== undefined) target.setBackgroundColor(options.background);
  if (options.border !== undefined) target.addBorderOverlay(options.border.width, options.border.color);
  if (options.edgeBorder !== undefined) target.setBorder(options.edgeBorder.width, options.edgeBorder.color);
  if (options.insetBorder !== undefined) target.addInsetBorderOverlay(options.insetBorder.width, options.insetBorder.color, options.insetBorder.inset);
  if (options.opacity !== undefined) target.setOpacity(options.opacity);
}

export function appendLabel(target: AnimatedElement, options: LabelOptions): TextElement {
  const label = createTextElement(options.text, options.height, options.left, options.top, options.width);
  if (options.align !== undefined) label.domElement.style.textAlign = options.align;
  if (options.bold) {
    label.applyTextStyle(options.size, options.color, true);
  } else {
    label.applyNormalTextStyle(options.size, options.color);
  }
  if (options.lineHeight !== undefined) label.domElement.style.lineHeight = `${options.lineHeight}px`;
  if (options.shadow !== undefined) label.setTextShadow(options.shadow);
  if (options.decoration !== undefined) label.setTextDecoration(options.decoration);
  if (options.nowrap) label.domElement.style.whiteSpace = 'nowrap';
  if (options.markup !== undefined) label.domElement.innerHTML = options.markup;
  if (options.fit) label.fitFontSize();
  target.domElement.append(label.domElement);
  return label;
}

export class Surface<T extends HTMLElement = HTMLDivElement> extends AnimatedElement<T> {
  constructor(element: T) {
    super(element);
  }
  applySurface(options: SurfaceOptions): this {
    applySurface(this, options);
    return this;
  }
  appendLabel(options: LabelOptions): TextElement {
    return appendLabel(this, options);
  }
}

export class ActionSurface<T extends HTMLElement = HTMLDivElement> extends InteractiveElement {
  constructor(element: T) {
    super(element);
  }
  applySurface(options: SurfaceOptions): this {
    applySurface(this, options);
    return this;
  }
  appendLabel(options: LabelOptions): TextElement {
    return appendLabel(this, options);
  }
  applyAction(handler: () => unknown): this {
    this.initializeClickable();
    this.setActionHandler(handler);
    return this;
  }
}

export class Card extends Surface<HTMLDivElement> {
  renderCard(options: CardOptions): this {
    this.applySurface(options);
    if (options.label !== undefined) this.appendLabel(options.label);
    return this;
  }
}

export class ActionCard extends ActionSurface<HTMLDivElement> {
  renderCard(options: CardOptions): this {
    this.applySurface(options);
    if (options.label !== undefined) this.appendLabel(options.label);
    return this;
  }
}
