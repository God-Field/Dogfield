import {MAX_STAT} from '../domain/constants';

export interface StatValues {
  hp: number;
  mp: number;
  cp: number;
}

export function clampStat(value: number): number {
  if (value < 0) return 0;
  if (value > MAX_STAT) return MAX_STAT;
  return value;
}

export function changeHp(hp: number, amount: number): Pick<StatValues, 'hp'> {
  return {hp: clampStat(hp + amount)};
}

/** A negative MP change cascades into HP, matching the original display rules. */
export function changeMp(hp: number, mp: number, amount: number): Pick<StatValues, 'hp' | 'mp'> {
  const next = mp + amount;
  if (next < 0) return {hp: clampStat(hp + next), mp: 0};
  return {hp, mp: clampStat(next)};
}

/** A negative CP change cascades through MP into HP. */
export function changeCp(hp: number, mp: number, cp: number, amount: number): StatValues {
  const next = cp + amount;
  if (next < 0) {
    const afterMp = changeMp(hp, mp, next);
    return {hp: afterMp.hp, mp: afterMp.mp, cp: 0};
  }
  return {hp, mp, cp: clampStat(next)};
}

/** Moves points between HP and another training stat, stopping at bounds. */
export interface StatTransfer {
  hp: number;
  target: number;
}

export function transferStat(hp: number, target: number, amount: number): StatTransfer {
  if (amount > 0) {
    for (let step = amount; step > 0; step--) {
      if (hp <= 0 || target >= MAX_STAT) break;
      hp--;
      target++;
    }
  } else {
    for (let step = amount; step < 0; step++) {
      if (target <= 0 || hp >= MAX_STAT) break;
      target--;
      hp++;
    }
  }
  return {hp, target};
}

export function isStatTransferEnabled(hp: number, target: number, amount: number): boolean {
  return !(amount > 0 && (hp <= 0 || target >= MAX_STAT)
    || amount < 0 && (target <= 0 || hp >= MAX_STAT));
}
