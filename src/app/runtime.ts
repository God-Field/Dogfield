import {createElement} from '../ui/elements';
import type {HomePage} from './home-page';
import {UserSettings} from './settings';
export {state} from './state';

let application: HomePage | undefined;
let settings: UserSettings | undefined;
let rootElement: ReturnType<typeof createElement> | undefined;

export function registerApplication(homePage: HomePage): void {
  application = homePage;
}

export function getApplication(): HomePage {
  if (!application) {
    throw new Error('Application has not been created');
  }
  return application;
}

export function getSettings(): UserSettings {
  if (!settings) {
    settings = new UserSettings();
    settings.loadSavedSettings();
  }
  return settings;
}

export function getRootElement(): ReturnType<typeof createElement> {
  if (rootElement) {
    return rootElement;
  }
  const element = document.querySelector<HTMLElement>('#main');
  if (!element) {
    throw new Error('Missing #main container');
  }
  rootElement = createElement(element, null, null, null, null);
  return rootElement;
}
