import { readFile } from 'node:fs/promises';

export interface FlashItem {
  id: number;
  name: string;
  image: string;
  type: string;
  attackKind: string;
  attackExtra: string;
  defenseKind: string;
  defenseExtra: string;
  attribute: string;
  value: number;
  subValue: number;
  hitRate: number;
  price: number;
  /** Eleventh column in the original SWF, unused by its rendering code. */
  embeddedWeight: number;
  assistantType?: string;
}

const itemColumns = {
  type: 0,
  attackKind: 1,
  attackExtra: 2,
  defenseKind: 3,
  defenseExtra: 4,
  attribute: 5,
  value: 6,
  subValue: 7,
  hitRate: 8,
  price: 9,
  embeddedWeight: 10,
} as const;
const assistantColumns = {
  type: 0,
  attackKind: 1,
  attackExtra: 2,
  attribute: 3,
  value: 4,
  hitRate: 5,
  embeddedWeight: 6,
} as const;
const imageNameColumn = 0;
const displayNameColumn = 1;

const readCsv = async (name: string) => (await readFile(new URL(`data/${name}.csv`, import.meta.url), 'utf8'))
  .trimEnd().split(/\r?\n/).map((line) => line.split(','));
export type FlashVersion = '2010' | '2013';

async function readItems(suffix: string): Promise<readonly FlashItem[]> {
  const names = await readCsv(`names${suffix}`);
  const rows = await readCsv(`items${suffix}`);

  return rows.map((row, index) => ({
    id: index,
    image: names[index]?.[imageNameColumn] ?? '',
    name: names[index]?.[displayNameColumn] ?? String(index),
    type: row[itemColumns.type]!,
    attackKind: row[itemColumns.attackKind]!,
    attackExtra: row[itemColumns.attackExtra]!,
    defenseKind: row[itemColumns.defenseKind]!,
    defenseExtra: row[itemColumns.defenseExtra]!,
    attribute: row[itemColumns.attribute]!,
    value: Number(row[itemColumns.value]),
    subValue: Number(row[itemColumns.subValue]),
    hitRate: Number(row[itemColumns.hitRate]),
    price: Number(row[itemColumns.price]),
    embeddedWeight: Number(row[itemColumns.embeddedWeight]),
  }));
}

export const flashItems = await readItems('');
export const flash2010Items = await readItems('-2010');

export const assistantTypes = ['MARS', 'MERCURY', 'JUPITER', 'SATURN', 'URANUS', 'PLUTO', 'NEPTUNE', 'VENUS', 'EARTH', 'MOON'];
async function readAssistants(suffix: string): Promise<Map<string, FlashItem[]>> {
  const assistantItems = new Map<string, FlashItem[]>();
  for (const row of await readCsv(`assistants${suffix}`)) {
    const assistantType = row[assistantColumns.type]!;
    const items = assistantItems.get(assistantType) ?? [];
    items.push({
      id: items.length, name: assistantType, image: '', type: 'WEAPON',
      attackKind: row[assistantColumns.attackKind]!, attackExtra: row[assistantColumns.attackExtra]!,
      attribute: row[assistantColumns.attribute]!,
      defenseKind: '', defenseExtra: '', value: Number(row[assistantColumns.value]),
      subValue: 0, hitRate: Number(row[assistantColumns.hitRate]), price: 0,
      embeddedWeight: Number(row[assistantColumns.embeddedWeight]), assistantType,
    });
    assistantItems.set(assistantType, items);
  }
  return assistantItems;
}

export const assistantItems = await readAssistants('');
export const assistant2010Items = await readAssistants('-2010');

export function itemAt(id: number, version: FlashVersion = '2013'): FlashItem {
  const item = (version === '2010' ? flash2010Items : flashItems)[id];
  if (!Number.isInteger(id) || !item) {
    throw new Error(`Unknown Flash item ${id}`);
  }
  return item;
}
