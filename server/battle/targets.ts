import type { ItemDefinition } from '../../src/domain/models.ts';
import type { Attack, Player } from '../types.ts';
import type { Random } from '../random.ts';
import type { Battle } from './battle.ts';

export function createAttackQueue(
  attack: Attack,
  candidates: readonly Player[],
  random: Random,
  { cycleCount, strikesPerTarget }: {
    cycleCount: number;
    strikesPerTarget: number;
  },
): Attack[] {
  // Each `attackEveryEnemy` card repeats the full AOE pass with an
  // independently shuffled target order. Hit-rate attacks build one pass.
  // `attackTwice` still applies inside each pass: official logs show the
  // same target twice in a row before moving to the next AOE target.
  const attacks: Attack[] = [];
  for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex++) {
    let targets = [...candidates];
    if (targets.length > 1) {
      targets = random.shuffle('targetOrder', targets);
    }
    for (const candidatePlayer of targets) {
      for (
        let strikeIndex = 0;
        strikeIndex < strikesPerTarget;
        strikeIndex++
      ) {
        attacks.push({
          ...attack,
          itemModelIds: [...attack.itemModelIds],
          targetPlayerId: candidatePlayer.id,
        });
      }
    }
  }
  return attacks;
}

export function selectDirectAttackTarget(
  battle: Battle,
  player: Player,
  definition: ItemDefinition,
  requestedPlayerId: number | undefined,
): Player {
  if (definition.ability === 'attackSomebody') {
    return battle.pickFromPool('defaultAttackTarget', battle.alive) ?? player;
  }
  // The native Flutter client omits targetPlayerId when its own player is
  // selected.
  let target = requestedPlayerId === undefined
    ? player
    : battle.requirePlayer(requestedPlayerId);
  if (player.curses?.includes('fog') && areEnemies(player, target)) {
    const fogTargets = battle.alive.filter((candidatePlayer) =>
      areEnemies(player, candidatePlayer),
    );
    if (fogTargets.length > 0) {
      target = battle.random.pick('fogTarget', fogTargets);
    }
  }
  return target;
}

export const areEnemies = (firstPlayer: Player, secondPlayer: Player) =>
  firstPlayer.id !== secondPlayer.id &&
  (!firstPlayer.team || firstPlayer.team !== secondPlayer.team);

