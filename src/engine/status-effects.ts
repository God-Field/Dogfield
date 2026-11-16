import {
  Curse,
  CurseCold,
  CurseFever,
  CurseFlash,
  CurseFog,
  CurseHeaven,
  CurseHell,
} from '../domain/enums';

/** Curses removable by mild curse removal effects. */
export const mildCurses: ReadonlySet<Curse> = new Set([
  CurseCold,
  CurseFever,
  CurseFog,
  CurseFlash,
]);

const mildCurseKeys: ReadonlySet<string> = new Set(
  [...mildCurses].map((curse) => curse.key),
);

export function isMildCurse(curseName: string): boolean {
  return mildCurseKeys.has(curseName);
}

/** Curses that share the single visible status slot in the original UI. */
const visibleStatusEffects: ReadonlySet<Curse> = new Set([CurseCold, CurseFever, CurseHell, CurseHeaven]);

export function isVisibleStatusEffect(curse: Curse): boolean {
  return visibleStatusEffects.has(curse);
}

export function findVisibleStatusEffect(curses: Iterable<Curse>): Curse | null {
  for (const curse of curses) if (visibleStatusEffects.has(curse)) return curse;
  return null;
}

export function hasStatusEffect(curses: Iterable<Curse>, curse: Curse): boolean {
  for (const existing of curses) if (existing === curse) return true;
  return false;
}
