import { screen } from '../ui/theme';
import { loadTranslations } from '../i18n/load';
import { state } from './state';
import { getRootElement } from './runtime';
import { getMeasuringElement } from '../ui/measurement';
import { createHomePage } from './home-shell';
import { MobileAppPrompt } from '../ui/decorative';
import { createLinkElement } from '../ui/elements';
import { createStoreBadge, preloadScreenBackgrounds } from '../ui/assets';
import { closeNetworkRequests, initializeFirebase } from '../services/firebase';

export async function initializeGodfield(): Promise<null> {
  await loadTranslations();
  document.title = state.translations.getAppText('title');
  const userAgent = navigator.userAgent.toLowerCase();
  if (['android', 'iphone', 'ipad'].some(device => userAgent.includes(device))) {
    const root = getRootElement(), element = document.createElement('div');
    new MobileAppPrompt(element).applyElementStyles(element, screen.homeHeight, null, null, screen.width);
    const apple = createLinkElement(`https://apps.apple.com/${state.language.getLanguageCode()}/app/id1536427424?l=${state.language.key}`, 230, 220, 60, 640);
    apple.domElement.append(createStoreBadge('app-store', state.language.key, 640).domElement);
    element.append(apple.domElement);
    const google = createLinkElement(`https://play.google.com/store/apps/details?id=net.godfield&hl=${state.language.key}`, 200, 220, 380, 640);
    google.domElement.append(createStoreBadge('google-play', state.language.key, 640).domElement);
    element.append(google.domElement);
    root.domElement.append(element);
    return null;
}
  document.documentElement?.addEventListener('contextmenu', event => event.preventDefault(), false);
  window.addEventListener('unload', closeNetworkRequests, false);
  preloadScreenBackgrounds();
  await initializeFirebase();
  const root = getRootElement(), measure = getMeasuringElement().domElement;
  measure.style.whiteSpace = 'nowrap';
  measure.style.visibility = 'hidden';
  root.domElement.append(measure);
  const application = createHomePage();
  root.domElement.append(application.domElement);
  application.openHomePage(null);
  return null;
}
export function ensureCanonicalHost(): void {
  if (window.location.hostname.includes('app') || window.location.pathname !== '/') {
    window.location.href = 'https://godfield.net';
    return;
  }
  void initializeGodfield();
}
export function startGodfield(): void { ensureCanonicalHost(); }
