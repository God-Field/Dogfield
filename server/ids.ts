import { randomBytes } from 'node:crypto';

const randomIdAlphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function createRandomId(length: number): string {
  const characters: string[] = [];
  const acceptanceLimit =
    Math.floor(256 / randomIdAlphabet.length) * randomIdAlphabet.length;

  while (characters.length < length) {
    const remainingCharacters = length - characters.length;
    const randomValues = randomBytes(Math.max(16, remainingCharacters * 2));

    for (const randomValue of randomValues) {
      if (randomValue >= acceptanceLimit) {
        continue;
      }

      characters.push(
        randomIdAlphabet[randomValue % randomIdAlphabet.length],
      );

      if (characters.length === length) {
        break;
      }
    }
  }

  return characters.join('');
}
