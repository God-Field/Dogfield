// Named entropy boundaries let differential checks stop before unknown RNG.
export class Random {
  constructor(public seed = Date.now()) {
    this.seed = seed >>> 0;
  }

  value(label: string) {
    this.seed += 0x6d2b79f5;
    let randomBits = this.seed;
    randomBits = Math.imul(randomBits ^ (randomBits >>> 15), randomBits | 1);
    randomBits ^=
      randomBits + Math.imul(randomBits ^ (randomBits >>> 7), randomBits | 61);
    return ((randomBits ^ (randomBits >>> 14)) >>> 0) / 4294967296;
  }

  chance(label: string, percent: number) {
    return percent >= 100 || (percent > 0 && this.value(label) < percent / 100);
  }

  pick<Value>(
    label: string,
    values: readonly Value[],
    weight: (value: Value) => number = () => 1,
  ): Value {
    if (!values.length) {
      throw new Error(`Empty random pool: ${label}`);
    }
    const randomFraction = this.value(label);
    const totalWeight = values.reduce(
      (accumulatedWeight, value) => accumulatedWeight + weight(value),
      0,
    );
    let weightedPosition = randomFraction * totalWeight;

    for (const value of values) {
      weightedPosition -= weight(value);
      if (weightedPosition < 0) {
        return value;
      }
    }

    return values.at(-1)!;
  }

  shuffle<Value>(label: string, values: readonly Value[]): Value[] {
    const shuffledValues = [...values];
    for (
      let shuffleIndex = shuffledValues.length - 1;
      shuffleIndex > 0;
      shuffleIndex--
    ) {
      const swapIndex = Math.floor(this.value(label) * (shuffleIndex + 1));
      [shuffledValues[shuffleIndex], shuffledValues[swapIndex]] = [
        shuffledValues[swapIndex],
        shuffledValues[shuffleIndex],
      ];
    }
    return shuffledValues;
  }
}
