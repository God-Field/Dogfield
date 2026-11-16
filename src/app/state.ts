import type {FirebaseAuth} from '../services/firebase';
import type {Language} from '../domain/enums';
import type {ItemDefinition} from '../domain/models';
import type {Translations} from '../i18n/translations';
import {defaultItemCatalog} from '../domain/item-catalog';

class ApplicationState {
  auth!: FirebaseAuth;
  database!: unknown;
  language!: Language;
  translations!: Translations;
  get itemModels(): ItemDefinition[] { return defaultItemCatalog.models; }
  get totalGiftRate(): number { return defaultItemCatalog.totalGiftRate; }
  audioElements = new Set<string>();
  referenceItemsVersion = 0;
  isMuted = false;
  volume = 0;
  lastChatMessage = '';
  lastChatSentAt = null;
  cachedRanking = null;
  cachedRecords = null;
}

export const state = new ApplicationState();
