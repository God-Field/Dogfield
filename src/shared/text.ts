/** The original width limit counts UTF-16 units: ASCII is one column, others two. */
export function getUserNameWidth(text: string): number {
  let width = 0;
  for (let index = 0; index < text.length; index++) {
    width += text.charCodeAt(index) <= 127 ? 1 : 2;
  }
  return width;
}
