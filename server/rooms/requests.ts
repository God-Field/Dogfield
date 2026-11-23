import type { RoomPayload } from '../types.ts';
import { engine } from '../engine.ts';
import { requireValue } from '../errors.ts';

const supportedModes = new Set(['training', 'private', 'duel']);
export const ownerOnlyActions = new Set([
  'reset-game',
  'start-game',
  'shuffle-teams',
  'set-tiebreak',
  'set-room-locked',
]);
const knownActions = new Set<string>([
  ...Object.values(engine.cloudFunction),
  ...Object.values(engine.roomAction),
]);
const wireStringFields = [
  'mode',
  'roomId',
  'userName',
  'password',
  'userId',
  'text',
];
const wireIntegerFields = ['team', 'gf', 'playerCount'];
const wireBooleanFields = ['isLocked'];

function requireFieldType(
  payload: Record<string, unknown>,
  fieldName: string,
  isExpectedValue: (value: unknown) => boolean,
): void {
  const value = payload[fieldName];
  if (value === null || value === undefined) {
    return;
  }
  requireValue(isExpectedValue(value));
}

function requireFieldTypes(payload: Record<string, unknown>): void {
  for (const fieldName of wireStringFields) {
    requireFieldType(
      payload,
      fieldName,
      (value) => typeof value === 'string',
    );
  }
  for (const fieldName of wireIntegerFields) {
    requireFieldType(
      payload,
      fieldName,
      (value) => typeof value === 'number' && Number.isInteger(value),
    );
  }
  for (const fieldName of wireBooleanFields) {
    requireFieldType(
      payload,
      fieldName,
      (value) => typeof value === 'boolean',
    );
  }
  requireFieldType(
    payload,
    'command',
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
  );
}

export function parseRoomPayload(action: string, input: unknown): RoomPayload {
  requireValue(knownActions.has(action), 404);
  // Account updates accept an empty or legacy payload and perform no room action.
  if (action === 'update-account') {
    return {};
  }
  requireValue(input && typeof input === 'object' && !Array.isArray(input));
  requireFieldTypes(input as Record<string, unknown>);
  const payload = input as RoomPayload;
  requireValue(
    typeof payload.mode === 'string' && supportedModes.has(payload.mode),
  );
  if (action === 'get-record') {
    requireValue(payload.mode === 'duel');
    return payload;
  }
  return payload;
}

export function requireModeAction(mode: string, action: string): void {
  if (mode === 'training') {
    requireValue(
      ['start-game', 'submit-command', 'reset-game'].includes(action),
    );
  }
  if (mode === 'duel') {
    requireValue(
      [
        'join-room',
        'submit-command',
        'leave-room',
        'reset-game',
        'kick-user',
      ].includes(action),
    );
  }
}
