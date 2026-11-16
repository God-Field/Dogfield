export const emptyWireValues = (value: unknown) =>
  value === null ||
  value === false ||
  value === '' ||
  (typeof value === 'number' && value === 0) ||
  (Array.isArray(value) && value.length === 0);

export function pruneWireFields(
  record: Record<string, unknown>,
  keptFields: ReadonlySet<string>,
): void {
  for (const [fieldName, fieldValue] of Object.entries(record)) {
    if (keptFields.has(fieldName)) {
      continue;
    }
    if (emptyWireValues(fieldValue)) {
      delete record[fieldName];
    }
  }
}
