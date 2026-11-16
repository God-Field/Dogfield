import {Team, Guardian, ItemElement, Curse, CurseHell, CurseHeaven, allItemElements as allItemElements} from '../domain/enums';
import {argumentError} from '../shared/values';
import type {ItemDefinition} from '../domain/models';

export const colors = {
  black: '#000000',
  white: '#ffffff',
  ink: '#111111',
  text: '#4f4f4f',
  neutral: '#eeeeee',
  gray: '#aaaaaa',
  slate: '#668888',
  steel: '#6688aa',
  olive: '#889955',
  leaf: '#77bb33',
  brand: '#008f6f',
  brandBlue: '#006f8f',
  teal: '#008888',
  mint: '#55bb99',
  green: '#00aa00',
  greenBright: '#00cc77',
  greenDark: '#008800',
  cyan: '#00aaee',
  indigo: '#4444dd',
  violet: '#6666ff',
  periwinkle: '#7777ff',
  purple: '#aa55cc',
  purpleBright: '#9966ff',
  blue: '#1177bb',
  blueLight: '#88aaff',
  pink: '#dd6699',
  pinkLight: '#dd7799',
  hotPink: '#ff6699',
  rose: '#ee99bb',
  roseLight: '#ffcccc',
  rosePale: '#eedddd',
  roseWhisper: '#ffeeee',
  red: '#dd4444',
  redDark: '#aa0000',
  redBright: '#ff0000',
  brick: '#aa4444',
  coral: '#ff6666',
  orange: '#ff9900',
  orangeDark: '#cc6644',
  gold: '#eebb00',
  magenta: '#ff3399',
  yellow: '#c5c500',
  khaki: '#dddd88',
  tan: '#ccbb88',
  oliveBright: '#ccbb44',
  amberPale: '#ffeeaa',
  peach: '#ffddaa',
  creamYellow: '#ffeebb',
  lavender: '#eeeeff',
  mintPale: '#ddffcc',
  mintLight: '#eeffee',
  cream: '#ffffee',
  noteGreen: '#f4ffdd',
  chatGreen: '#eeffbf',
  inputYellow: '#eeffaa',
  yellowPale: '#ffffaa',
  yellowWhisper: '#ffffdd',
  magentaPale: '#ffeeff',
  cyanPale: '#ddeeee',
  greenTint: '#ccffcc',
  violetTint: '#ccccff',
  yellowTint: '#ffffcc',
  greenBorder: '#88bb88',
  roseBorder: '#bb8888',
  oliveBorder: '#aaaa88',
  violetBorder: '#8888bb',
  roseTint: '#eeaaaa',
  goldBorder: '#bbbb77',
} as const;

const teamBackgrounds = [
  colors.neutral,
  colors.greenTint,
  colors.roseLight,
  colors.yellowTint,
  colors.violetTint
];
const teamBorders = [
  colors.gray,
  colors.greenBorder,
  colors.roseBorder,
  colors.oliveBorder,
  colors.violetBorder
];
const guardianColors = [
  colors.coral,
  colors.violet,
  colors.orange,
  colors.steel,
  colors.yellow,
  colors.purple,
  colors.cyan,
  colors.greenDark,
  colors.roseTint,
  colors.goldBorder
];
const curseColors = [
  colors.steel,
  colors.coral,
  colors.text,
  colors.text,
  colors.violet,
  colors.yellow,
  colors.orange,
  colors.purple
];

export const teamBackgroundColor = (team: Team): string | null => teamBackgrounds[team.index] ?? null;
export const teamBorderColor = (team: Team): string | null => teamBorders[team.index] ?? null;
export const guardianColor = (guardian: Guardian): string | null => guardianColors[guardian.index] ?? null;
export function elementColor(element: ItemElement | null | undefined): string | null {
  if (element == null) return colors.text;
  const index = allItemElements.indexOf(element);
  return index < 0 ? null : guardianColors[index];
}
export const curseColor = (curse: Curse): string | null => curseColors[curse.index] ?? null;

export const itemCommandElementColor = (item: ItemDefinition): string | null => item.guardian != null ? guardianColor(item.guardian) : elementColor(item.element);
export function curseTextColor(curse: Curse): string | null {
  if (curse === CurseHell) return colors.ink;
  if (curse === CurseHeaven) return colors.neutral;
  return curseColor(curse);
}
interface ResponseStyle {
  text: string;
  background: string;
}

const responseStyles: ReadonlyMap<string, ResponseStyle> = new Map([
  ['bounce', {text: colors.gold, background: colors.cream}],
  ['reflect', {text: colors.magenta, background: colors.magentaPale}],
  ['block', {text: colors.green, background: colors.mintLight}],
]);

function requireResponseStyle(command: string): ResponseStyle {
  const style = responseStyles.get(command);
  if (style === undefined) {
    throw argumentError('null');
  }
  return style;
}

export const responseTextColor = (command: string): string => requireResponseStyle(command).text;
export const responseBackgroundColor = (command: string): string => requireResponseStyle(command).background;
