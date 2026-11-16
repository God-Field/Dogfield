import { createTextElement, TextElement } from './elements';
let measuringElement: TextElement | undefined;
/** Shared hidden text node, attached by bootstrap and reused for font fitting. */
export function getMeasuringElement(): TextElement {
  return measuringElement ??= createTextElement('', null, null, null, null);
}
