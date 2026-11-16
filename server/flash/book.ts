import { readFile } from 'node:fs/promises';
import { tag } from './xml.ts';

export const flashBookCost = 10;

export interface FlashBookEntry {
  id: number;
  kind: string;
  itemId?: number;
  text: { en: string; ja: string };
}

export interface FlashBook {
  score: number;
  elements: number[];
}

const bookCategories = ['Item', 'Harm', 'Assistant', 'AssistantItem', 'Mystery'] as const;
type BookCategory = typeof bookCategories[number];
type BookTables = Record<BookCategory, string[][]>;

async function readBookCsv(name: string, version = '2013'): Promise<string[][]> {
  const directory = version === '2013' ? 'book' : `book-${version}`;
  const source = await readFile(new URL(`data/${directory}/${name}.csv`, import.meta.url), 'utf8');
  return source.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(','));
}

async function readBookTables(language: string, version = '2013'): Promise<BookTables> {
  const tables = await Promise.all(bookCategories.map((category) => readBookCsv(`${language}Data_${category}`, version)));
  return Object.fromEntries(bookCategories.map((category, index) => [category, tables[index]])) as BookTables;
}

function bookText(row: readonly string[], skipFilename: boolean): string {
  const textColumns = skipFilename ? row.slice(1) : row;
  return textColumns.join('\n').replaceAll('<br />', '\n');
}

async function readBookEntries(): Promise<readonly FlashBookEntry[]> {
  const [order, english, japanese] = await Promise.all([
    readBookCsv('BookItem'), readBookTables('English'), readBookTables('Japanese'),
  ]);
  const entries: FlashBookEntry[] = [];
  const usedItemIds = new Set<number>();
  for (const [filename] of order) {
    const itemId = english.Item.findIndex((row, index) => row[0] === filename && !usedItemIds.has(index));
    if (itemId < 0 || !japanese.Item[itemId]) {
      throw new Error(`Unknown Flash encyclopedia item: ${filename}`);
    }
    usedItemIds.add(itemId);
    entries.push({
      id: entries.length, kind: 'Item', itemId,
      text: { en: bookText(english.Item[itemId]!, true), ja: bookText(japanese.Item[itemId]!, true) },
    });
  }

  const otherCategories = [
    { kind: 'Harm', skipFilename: false },
    { kind: 'Assistant', skipFilename: false },
    { kind: 'AssistantItem', skipFilename: true },
    { kind: 'Mystery', skipFilename: true },
  ] as const;
  for (const { kind, skipFilename } of otherCategories) {
    for (let entryIndex = 0; entryIndex < english[kind].length; entryIndex += 1) {
      entries.push({
        id: entries.length, kind,
        text: { en: bookText(english[kind][entryIndex]!, skipFilename), ja: bookText(japanese[kind][entryIndex]!, skipFilename) },
      });
    }
  }
  return entries;
}

export const flashBookEntries = await readBookEntries();
export const flashBookCount = flashBookEntries.length;

export function bookElementXml(id: number, language: string): string {
  const entry = flashBookEntries[id]!;
  const text = language === 'JAPANESE' ? entry.text.ja : entry.text.en;
  return `<element id="${id}">${tag('text', text)}</element>`;
}

export const flash2010BookCost = 5;

async function read2010BookEntries(): Promise<readonly FlashBookEntry[]> {
  const [english, japanese] = await Promise.all([readBookTables('English', '2010'), readBookTables('Japanese', '2010')]);
  const entries: FlashBookEntry[] = [];
  for (const kind of bookCategories) {
    const skipFilename = ['Item', 'AssistantItem', 'Mystery'].includes(kind);
    for (const [entryIndex, row] of english[kind].entries()) {
      entries.push({
        id: entries.length, kind,
        text: { en: bookText(row, skipFilename), ja: bookText(japanese[kind][entryIndex]!, skipFilename) },
      });
    }
  }
  return entries;
}

export const flash2010BookEntries = await read2010BookEntries();

export function book2010ElementXml(id: number, language: string): string {
  const entry = flash2010BookEntries[id]!;
  const text = language === 'JAPANESE' ? entry.text.ja : entry.text.en;
  return `<element index="${id}">${tag('count', 1)}${tag('text', text)}</element>`;
}
