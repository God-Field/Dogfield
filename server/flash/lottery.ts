export const flashLotteryInterval = 20 * 60 * 60 * 1000;

export interface FlashLotteryPrize {
  coin?: number;
  ticket?: 'DUEL';
}

export interface FlashLotteryClaim {
  claimedAt: number;
  coin: number;
  ticket?: 'DUEL';
}

export interface FlashLotteryOptions {
  now?: () => number;
  randomInt?: (maximum: number) => number;
}

// Official January 2013 mode guide: equal odds of 25 coins or one Duel ticket.
export function pickFlashLotteryPrize(randomInt: (maximum: number) => number): FlashLotteryPrize {
  return randomInt(2) === 0 ? { coin: 25 } : { ticket: 'DUEL' };
}
