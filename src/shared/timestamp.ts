/** Server timestamps retain sub-millisecond precision and the original string format. */
export class Timestamp {
  constructor(public milliseconds: number, public microsecondRemainder = 0, public isUtc = false) {}
  isBefore(other: Timestamp): boolean { return this.milliseconds < other.milliseconds || this.milliseconds === other.milliseconds && this.microsecondRemainder < other.microsecondRemainder; }
  addMicroseconds(microseconds: number): Timestamp {
    const remainder = this.microsecondRemainder + microseconds;
    const milliseconds = this.milliseconds + Math.floor(remainder / 1000), fraction = (remainder % 1000 + 1000) % 1000;
    if (milliseconds < -8640000000000000 || milliseconds > 8640000000000000 || milliseconds === 8640000000000000 && fraction !== 0) throw new RangeError('Time outside valid range');
    return new Timestamp(milliseconds, fraction, this.isUtc);
  }
  toString(): string {
    const date = new Date(this.milliseconds);
    const parts = this.isUtc
      ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
      : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
    const [year, month, day, hour, minute, second, millisecond] = parts;
    const pad = (value: number, length: number): string => value.toString().padStart(length, '0');
    return `${year < 0 ? '-' : ''}${pad(Math.abs(year), 4)}-${pad(month, 2)}-${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}${this.microsecondRemainder ? pad(this.microsecondRemainder, 3) : ''}${this.isUtc ? 'Z' : ''}`;
  }
}
const timestampPattern = /^([+-]?\d{4,6})-?(\d\d)-?(\d\d)(?:[ T](\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d+))?)?)?( ?[zZ]| ?([-+])(\d\d)(?::?(\d\d))?)?)?$/;
export function parseTimestamp(value: string): Timestamp | null {
  const match = timestampPattern.exec(value);
  if (!match) return null;
  let year = Number(match[1]), month = Number(match[2]) - 1;
  const day = Number(match[3]), hour = Number(match[4] ?? 0), second = Number(match[6] ?? 0);
  let minute = Number(match[5] ?? 0);
  const fraction = Number((match[7] ?? '').padEnd(6, '0').slice(0, 6));
  const isUtc = Boolean(match[8]);
  if (match[9]) minute -= (match[9] === '-' ? -1 : 1) * (Number(match[10]) * 60 + Number(match[11] ?? 0));
  // Date constructors treat years 0–99 specially; use a complete Gregorian cycle.
  if (year >= 0 && year < 100) {
    year += 400;
    month -= 4800;
}
  const millisecond = Math.trunc(fraction / 1000), microsecond = fraction % 1000;
  const timestamp = isUtc ? Date.UTC(year, month, day, hour, minute, second, millisecond) : new Date(year, month, day, hour, minute, second, millisecond).valueOf();
  if (!Number.isFinite(timestamp) || timestamp < -8640000000000000 || timestamp > 8640000000000000 || timestamp === 8640000000000000 && microsecond !== 0) return null;
  return new Timestamp(timestamp, microsecond, isUtc);
}
