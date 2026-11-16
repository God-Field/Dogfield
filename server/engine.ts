// The server imports the same TypeScript engine as the browser, without UI code.
import * as engine from './engine-entry.ts';
import { readFile } from 'node:fs/promises';
export { engine };
export const translations = JSON.parse(
  await readFile(new URL('../public/i18n/en.json', import.meta.url), 'utf8'),
);
export const itemCatalog = new engine.ItemCatalog();
const items = engine.decodeJson(translations.items);
if (!Array.isArray(items)) {
  throw new Error('Invalid item translations');
}
engine.decodeItemModel(items, itemCatalog);
export const getItemDefinition = (modelId: number) => {
  const definition = itemCatalog.findById(modelId);
  if (!definition) {
    throw new Error(`Unknown item model: ${modelId}`);
  }
  return definition;
};
