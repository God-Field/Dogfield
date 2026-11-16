import {
  Category, ItemElement, Curse, Guardian, Team, GameMode,
  allCategories as allCategories, allItemElements as allItemElements, allCurses as allCurses,
  allGuardians as allGuardians, allTeams as allTeams, allGameModes as allGameModes,
  CategoryMiracles, ItemElementDarkness, ItemElementLight
} from './enums';
import { BattleEvent, AttackCommand, GameState, ItemSlot, ItemDefinition, PlayerStatus, RoomState, RoomUser, RoomPlayer } from './models';
import { asMap } from '../shared/collections';
import { isInteger } from '../shared/values';
import { defaultItemCatalog, type ItemCatalog } from './item-catalog';

type Data = Map<string, unknown>;
const integer = (value: unknown, fallback = 0): number => isInteger(value) ? value : fallback;
const nullableInteger = (value: unknown): number | null => isInteger(value) ? value : null;
const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const nullableText = (value: unknown): string | null => typeof value === 'string' ? value : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const present = <T>(value: T | null): value is T => value !== null;
export function parseCategory(value: unknown): Category {
  const category = allCategories.find(category => category.key === text(value));
  if (!category) throw new TypeError('Invalid category');
  return category;
}
export const parseItemElement = (value: unknown): ItemElement | null => allItemElements.find(element => element.key === text(value)) ?? null;
export const parseCurse = (value: unknown): Curse | null => allCurses.find(curse => curse.key === text(value)) ?? null;
export const parseGuardian = (value: unknown): Guardian | null => allGuardians.find(guardian => guardian.key === text(value)) ?? null;
export function parseTeam(value: unknown): Team {
  const team = allTeams.find(team => team.key === integer(value));
  if (!team) throw new TypeError('Invalid team');
  return team;
}
export const parseMode = (value: unknown): GameMode | null => allGameModes.find(mode => mode.key === text(value)) ?? null;

export function decodeItemModel(rows: Iterable<unknown>, catalog: ItemCatalog = defaultItemCatalog): void {
  for (const row of rows) {
    const data = asMap(row);
    const giftRate = integer(data.get('giftRate'));
    const guardianAttackRate =
      integer(data.get('guardianAttackRate'))
      || integer(data.get('guardianActionRate'));
    const definition = new ItemDefinition(
      catalog.length + 1, text(data.get('name')), text(data.get('imageName')),
      parseCategory(data.get('category')), parseItemElement(data.get('element')),
      integer(data.get('atk')), data.get('isPlusAtk') != null, integer(data.get('hitRate')),
      integer(data.get('def')), text(data.get('ability')), integer(data.get('abilityValue')),
      parseCurse(data.get('curse')), parseGuardian(data.get('guardian')),
      integer(data.get('price')), integer(data.get('cost')), giftRate,
      integer(data.get('appearanceRate')), guardianAttackRate
    );
    catalog.add(definition);
  }
}
/** Applies only the fields present in `data`, preserving the current card. */
export function applyItemOverride(definition: ItemDefinition, data: Data): void {
  if (data.has('name')) definition.name = text(data.get('name'));
  if (data.has('imageName')) definition.imageName = text(data.get('imageName'));
  if (data.has('category')) definition.category = parseCategory(data.get('category'));
  if (data.has('element')) definition.element = parseItemElement(data.get('element'));
  if (data.has('atk')) definition.attack = integer(data.get('atk'));
  if (data.has('isPlusAtk')) {
    definition.isPlusAttack =
      data.get('isPlusAtk') != null && data.get('isPlusAtk') !== false;
  }
  if (data.has('hitRate')) definition.hitRate = integer(data.get('hitRate'));
  if (data.has('def')) definition.defense = integer(data.get('def'));
  if (data.has('ability')) definition.ability = text(data.get('ability'));
  if (data.has('abilityValue')) definition.abilityValue = integer(data.get('abilityValue'));
  if (data.has('curse')) definition.curse = parseCurse(data.get('curse'));
  if (data.has('guardian')) definition.guardian = parseGuardian(data.get('guardian'));
  if (data.has('price')) definition.price = integer(data.get('price'));
  if (data.has('cost')) definition.cost = integer(data.get('cost'));
  if (data.has('giftRate')) definition.giftRate = integer(data.get('giftRate'));
  if (data.has('appearanceRate')) {
    definition.appearanceRate = integer(data.get('appearanceRate'));
  }
  if (data.has('guardianAttackRate')) {
    definition.guardianAttackRate = integer(data.get('guardianAttackRate'));
  } else if (data.has('guardianActionRate')) {
    definition.guardianAttackRate = integer(data.get('guardianActionRate'));
  }
}
export function decodeItemSlot(data: Data): ItemSlot {
  return new ItemSlot(integer(data.get('id')), integer(data.get('modelId')), integer(data.get('fakeModelId')), data.get('used') === true);
}
export function decodeCommandPayload(data: Data): AttackCommand {
  const itemIds = list(data.get('itemModelIds'));
  const checkedIds: number[] = [];
  for (const id of itemIds) {
    if (!isInteger(id)) throw new TypeError('Expected integer item model ID');
    checkedIds.push(id);
  }
  return new AttackCommand(
    integer(data.get('playerId')), parseGuardian(data.get('guardian')), checkedIds,
    integer(data.get('atk')), integer(data.get('hitRate')), integer(data.get('mp')),
    integer(data.get('cp')), integer(data.get('targetPlayerId')), data.get('reversed') === true,
    integer(data.get('buyingItemModelId'))
  );
}
export function decodePlayerStatus(data: Data): PlayerStatus {
  return new PlayerStatus(
    integer(data.get('id')), nullableText(data.get('userId')), text(data.get('name')),
    nullableText(data.get('alias')), parseTeam(data.get('team')),
    (data.has('isBot') ? data.get('isBot') : data.get('isAI')) === true,
    integer(data.get('hp')), integer(data.get('mp')), integer(data.get('cp')),
    new Set(list(data.get('curses')).map(parseCurse).filter(present)), parseGuardian(data.get('guardian')),
    integer(data.get('confusionCount')), data.get('dead') === true,
    list(data.get('items')).map(value => decodeItemSlot(asMap(value))), integer(data.get('rating')), integer(data.get('ratingGain'))
  );
}
export function decodeBattleEvent(data: Data): BattleEvent {
  const attack = data.get('attack'), item = data.get('item'), overflow = data.get('overflowItem');
  return new BattleEvent(
    text(data.get('action')), integer(data.get('playerId')),
    attack == null ? null : decodeCommandPayload(asMap(attack)), integer(data.get('damage')),
    integer(data.get('hp')), integer(data.get('mp')), integer(data.get('cp')), parseCurse(data.get('curse')),
    list(data.get('curses')).map(parseCurse).filter(present), parseGuardian(data.get('guardian')),
    list(data.get('guardians')).map(parseGuardian).filter(present), integer(data.get('itemModelId')),
    item == null ? null : decodeItemSlot(asMap(item)), list(data.get('items')).map(value => decodeItemSlot(asMap(value))),
    overflow == null ? null : decodeItemSlot(asMap(overflow)), integer(data.get('index')),
    data.get('bought') === true, data.get('natural') === true
  );
}
export function decodeGameState(data: Data): GameState {
  const attacks = list(data.get('attacks'));
  return new GameState(
    list(data.get('players')).map(value => decodePlayerStatus(asMap(value))), integer(data.get('gf')),
    nullableInteger(data.get('tiebreakGF')), integer(data.get('attackTurnPlayerId')),
    attacks.length ? decodeCommandPayload(asMap(attacks[0])) : null,
    data.get('isOver') === true, list(data.get('events')).map(value => decodeBattleEvent(asMap(value))), integer(data.get('updateCount'))
  );
}
export function decodeRoomPlayer(): (value: unknown) => RoomPlayer {
  return value => {
    const data = asMap(value);
    return new RoomPlayer(text(data.get('userId')), parseTeam(data.get('team')));
  };
}
export function decodeLobbyState(data: Data): RoomState {
  const game = data.get('game');
  return new RoomState(
    list(data.get('users')).map(value => {
      const user = asMap(value);
      return new RoomUser(text(user.get('id')), text(user.get('name')));
    }),
    data.get('isLocked') === true, list(data.get('entries')).map(decodeRoomPlayer()),
    nullableInteger(data.get('tiebreakGF')), game == null ? null : decodeGameState(asMap(game)),
    data.has('teamsShuffled') ? data.get('teamsShuffled') === true : null
  );
}
