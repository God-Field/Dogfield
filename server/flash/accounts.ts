import { createHash, randomInt } from 'node:crypto';
import { Store } from '../store.ts';
import { requireValue } from '../errors.ts';
import { tag } from './xml.ts';
import { bookElementXml, book2010ElementXml, flashBookCost, flashBookEntries, flash2010BookCost, flash2010BookEntries, type FlashBook } from './book.ts';
import { flashLotteryInterval, pickFlashLotteryPrize, type FlashLotteryClaim, type FlashLotteryOptions } from './lottery.ts';

export const flashLoginBonus = 50;
const duelEntryCost = 50;
const percentageScale = 10000;
const recentDuelRoundLimit = 20;
export const flashLoginBonusInterval = 20 * 60 * 60 * 1000;

export const spiritModes = [2, 3, 5, 7, 9] as const;
export const spiritCharges = [50, 50, 50, 75, 125] as const;
export const spiritBonuses = [60, 75, 90, 160, 300] as const;

export interface SpiritRecord {
  game: number;
  score: number;
  best: number;
  completed?: boolean;
}

export interface DuelResult {
  game: number;
  win: number;
  draw: number;
}

export interface DuelRound extends DuelResult {
  date: string;
}

export interface Flash2013Account {
  lottery?: FlashLotteryClaim;
  book?: FlashBook;
  coin: number;
  ticket?: string;
  // Previous 15-game round: 2 per win, 1 per draw, plus 10 at 16 points.
  scoreBonus: number;
  duelOpponents?: string[];
  duel: DuelResult;
  years: Record<string, { result: DuelResult; rounds: DuelRound[] }>;
  spirit: Record<string, SpiritRecord>;
}

export function account2013(account: FlashAccount): Flash2013Account {
  account.flash2013 ??= {
    coin: 0, scoreBonus: 0, duel: { game: 0, win: 0, draw: 0 }, years: {}, spirit: {},
  };
  return account.flash2013;
}

export function canEnterDuel2013(account: FlashAccount): boolean {
  const modern = account2013(account);
  return modern.ticket === 'DUEL' || modern.coin >= duelEntryCost || account.credits >= duelEntryCost;
}

/** Local payment preference: consume a matching ticket, then coins, then Charin. */
export function chargeDuel2013(account: FlashAccount): void {
  requireValue(canEnterDuel2013(account));
  const modern = account2013(account);
  if (modern.ticket === 'DUEL') {
    delete modern.ticket;
  } else if (modern.coin >= duelEntryCost) {
    modern.coin -= duelEntryCost;
  } else {
    account.credits -= duelEntryCost;
  }
}

export interface FlashAccount {
  [field: string]: unknown;
  credits: number;
  hasPaid: boolean;
  straight: number;
  spirit: Record<string, SpiritRecord>;
  flash2013?: Flash2013Account;
  book2010?: FlashBook;
  lastLoginBonusAt?: number;
}

export function duelStraightBonus(straight: number): number {
  if (straight === 0) {
    return 0;
  }

  if (straight < 4) {
    return (straight + 1) * 10;
  }

  return 50;
}

export class FlashAccounts {
  private readonly lotteryNow: () => number;
  private readonly lotteryRandomInt: (maximum: number) => number;

  constructor(readonly store = new Store(), readonly startingCredits = 1000, lottery: FlashLotteryOptions = {}) {
    requireValue(Number.isSafeInteger(startingCredits) && startingCredits >= 0);
    this.lotteryNow = lottery.now ?? Date.now;
    this.lotteryRandomInt = lottery.randomInt ?? randomInt;
  }

  drawLot(token: string): FlashLotteryClaim {
    const currentTime = this.lotteryNow();
    requireValue(Number.isSafeInteger(currentTime) && currentTime >= 0);
    // Entrance stores UTC date strings at whole-second precision. Match that
    // boundary so its button cannot reappear a fraction of a second too early.
    const now = Math.floor(currentTime / 1000) * 1000;
    const account = this.get(token);
    const modern = account2013(account);
    if (modern.lottery && now - modern.lottery.claimedAt < flashLotteryInterval) {
      // Replay the granted result on retries without adding currency or tickets again.
      return modern.lottery;
    }
    const prize = pickFlashLotteryPrize(this.lotteryRandomInt);
    const claim: FlashLotteryClaim = { claimedAt: now, coin: prize.coin ?? 0 };
    if (prize.ticket) {
      modern.ticket = prize.ticket;
      claim.ticket = prize.ticket;
    }
    modern.coin += claim.coin;
    modern.lottery = claim;
    this.set(token, account);
    return claim;
  }

  claimLoginBonus(token: string): number {
    const account = this.get(token);
    const now = Math.floor(this.lotteryNow() / 1000) * 1000;
    requireValue(Number.isSafeInteger(now) && now >= 0);
    if (account.lastLoginBonusAt !== undefined && now - account.lastLoginBonusAt < flashLoginBonusInterval) {
      return 0;
    }
    account.credits += flashLoginBonus;
    account.lastLoginBonusAt = now;
    this.set(token, account);
    return flashLoginBonus;
  }

  book2010Xml(token: string, language: string): string {
    const book = this.get(token).book2010 ?? { score: 0, elements: [] };
    return tag('score', book.score) + book.elements.map((id) => book2010ElementXml(id, language)).join('');
  }

  addBook2010Score(token: string, score: number): void {
    requireValue(Number.isSafeInteger(score) && score > 0);
    const account = this.get(token);
    const book = account.book2010 ??= { score: 0, elements: [] };
    book.score += score;
    this.set(token, account);
  }

  drawBook2010(token: string, chooseIndex: (maximum: number) => number = randomInt): number {
    const account = this.get(token);
    const book = account.book2010 ??= { score: 0, elements: [] };
    const available = flash2010BookEntries.filter((entry) => !book.elements.includes(entry.id));
    const complete = available.length === 0;
    if (!complete && book.score < flash2010BookCost) {
      // A draw in another tab can spend the score after this book was rendered.
      // Replay the last owned entry so the original modal finishes its reveal.
      requireValue(book.elements.length > 0, 409);
      return book.elements.at(-1)!;
    }
    const choices = complete ? flash2010BookEntries : available;
    const index = chooseIndex(choices.length);
    requireValue(Number.isInteger(index) && index >= 0 && index < choices.length);
    const entry = choices[index]!;
    if (!complete) {
      book.score -= flash2010BookCost;
      book.elements.push(entry.id);
    }
    this.set(token, account);
    return entry.id;
  }

  bookXml(token: string, language: string): string {
    const modern = account2013(this.get(token));
    const book = modern.book ?? { score: 0, elements: [] };
    return tag('score', book.score) + book.elements.map((id) => bookElementXml(id, language)).join('');
  }

  addBookScore(token: string, score: number): void {
    requireValue(Number.isSafeInteger(score) && score > 0);
    const account = this.get(token);
    const modern = account2013(account);
    const book = modern.book ??= { score: 0, elements: [] };
    book.score += score;
    this.set(token, account);
  }

  addBookElement(token: string, language: string, chooseIndex: (maximum: number) => number = randomInt): string {
    const account = this.get(token);
    const modern = account2013(account);
    const book = modern.book ??= { score: 0, elements: [] };
    const available = flashBookEntries.filter((entry) => !book.elements.includes(entry.id));
    requireValue(book.score >= flashBookCost && available.length > 0, 409);
    const index = chooseIndex(available.length);
    requireValue(Number.isInteger(index) && index >= 0 && index < available.length);
    const entry = available[index]!;
    book.score -= flashBookCost;
    book.elements.push(entry.id);
    this.set(token, account);
    // The client merges entries and uses xml.element.@id to reveal this draw.
    // Returning the entire collection here would break that single-ID reveal.
    return tag('score', book.score) + bookElementXml(entry.id, language);
  }

  validToken(token: string): boolean {
    return /^dogfield-local-[a-z0-9-]{20,100}$/.test(token);
  }

  private path(token: string): string {
    requireValue(this.validToken(token));
    return `flash/accounts/${createHash('sha256').update(token).digest('hex')}`;
  }

  get(token: string): FlashAccount {
    const path = this.path(token);
    const existing = this.store.get<FlashAccount>(path);
    if (existing) {
      return existing;
    }
    const account: FlashAccount = { credits: this.startingCredits, hasPaid: true, straight: 0, spirit: {} };
    this.set(token, account);
    return account;
  }

  set(token: string, account: FlashAccount): void {
    requireValue(Number.isSafeInteger(account.credits) && account.credits >= 0);
    if (account.lastLoginBonusAt !== undefined) {
      requireValue(Number.isSafeInteger(account.lastLoginBonusAt) && account.lastLoginBonusAt >= 0);
    }
    if (account.book2010) {
      const book = account.book2010;
      requireValue(Number.isSafeInteger(book.score) && book.score >= 0);
      requireValue(Array.isArray(book.elements) && new Set(book.elements).size === book.elements.length);
      requireValue(book.elements.every((id) => Number.isInteger(id) && id >= 0 && id < flash2010BookEntries.length));
    }
    if (account.flash2013) {
      const book = account.flash2013.book;
      if (book) {
        requireValue(Number.isSafeInteger(book.score) && book.score >= 0);
        requireValue(Array.isArray(book.elements) && new Set(book.elements).size === book.elements.length);
        requireValue(book.elements.every((id) => Number.isInteger(id) && id >= 0 && id < flashBookEntries.length));
      }
      requireValue(Number.isSafeInteger(account.flash2013.coin) && account.flash2013.coin >= 0);
      requireValue(Number.isSafeInteger(account.flash2013.scoreBonus) && account.flash2013.scoreBonus >= 0);
    }
    this.store.set(this.path(token), account);
    this.store.save();
  }

  duelResultXml(token: string, year: number): string {
    const modern = account2013(this.get(token));
    const records = modern.years[year];
    const result = records?.result ?? { game: 0, win: 0, draw: 0 };
    const resultXml = tag('game', result.game) + tag('win', result.win) + tag('draw', result.draw)
      + tag('win_rate', result.game ? Math.floor(result.win * percentageScale / result.game) : 0)
      + tag('draw_per_game', result.game ? Math.floor(result.draw * percentageScale / result.game) : 0);
    return `<result>${resultXml}</result>` + (records?.rounds ?? []).slice(-recentDuelRoundLimit).reverse().map((round) =>
      `<round>${tag('win', round.win)}${tag('draw', round.draw)}${tag('date', round.date)}</round>`).join('');
  }

  recordsXml(token: string, version: '2010' | '2013' = '2010'): string {
    const account = this.get(token);
    const spirit = version === '2013' ? account2013(account).spirit : account.spirit;
    const recordTag = version === '2013' ? 'result' : 'record';
    const bestTag = version === '2013' ? 'bestResult' : 'bestRecord';
    return spiritModes.map((mode) => {
      const record = spirit[mode] ?? { game: 0, score: 0, best: 0 };
      return `<${recordTag} mode="${mode}">${tag('game', record.game)}${tag('score', record.score)}</${recordTag}>`
        + (record.best ? `<${bestTag} mode="${mode}">${tag('score', record.best)}</${bestTag}>` : '');
    }).join('');
  }
}
