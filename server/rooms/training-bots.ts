import type { StartUser } from '../types.ts';
import { Random } from '../random.ts';
import { generateAiNames } from './bot-names.ts';

/**
 * Create the server-controlled players for a training battle.
 *
 * Every existing player name is reserved so a generated name can never
 * collide with someone already in the room.
 */
export function createTrainingBots(
  botCount: number,
  reservedNames: readonly string[],
  random: Random,
  language: string,
): StartUser[] {
  return generateAiNames(botCount, reservedNames, language, random).map(
    (name) => ({
      name,
      isBot: true,
    }),
  );
}
