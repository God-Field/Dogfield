import {allLanguages as allLanguages} from '../domain/enums';
import {decodeItemModel} from '../domain/decode';
import {asMap, decodeJson} from '../shared/collections';
import {state} from '../app/state';
import {Translations} from './translations';

export async function loadTranslations(): Promise<null> {
  const requestedCode = new URLSearchParams(window.location.search).get('lang');
  let requested = allLanguages.find(language=>language.key===requestedCode) ?? null;
  let preferred = null;
  for (const code of window.navigator.languages) {
    preferred = allLanguages.find(language=>language.key===code)
      ?? allLanguages.find(language=>code.startsWith(language.key.substring(0,2))) ?? null;
    if (!preferred) continue;
    if (code === requested?.key) {
      window.history.replaceState({}, '', window.location.pathname);
      requested = null;
    }
    break;
  }
  state.language = requested ?? preferred ?? allLanguages[0];
  const response = await window.fetch(`/i18n/${state.language.key}.json`);
  const data = asMap(decodeJson(await response.json()));
  state.translations = Translations.fromData(asMap(data.get('texts')));
  const items = data.get('items');
  decodeItemModel(Array.isArray(items) ? items : []);
  return null;
}
