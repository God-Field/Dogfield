/** Small deterministic PRNG so a run can be reproduced from its seed. */
export function createRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  return {
    next,
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive);
    },
    pick(items) {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },
    chance(probability) {
      return next() < probability;
    },
    shuffle(items) {
      const copy = items.slice();
      for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(next() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    },
  };
}

export function parseSeed(text) {
  if (text === undefined || text === null) return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  if (/^\d+$/.test(String(text))) return Number(text) >>> 0;
  let hash = 0x811c9dc5;
  for (const character of String(text)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
