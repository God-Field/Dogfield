import {startGodfield} from './app/bootstrap';

function run(script: HTMLScriptElement | null): void {
  // Retain the host's optional Dart launcher contract without a Dart runtime.
  void script;
  if (typeof dartMainRunner === 'function') dartMainRunner(startGodfield, []);
  else startGodfield();
}
if (typeof document === 'undefined') run(null);
else if (typeof document.currentScript !== 'undefined') run(document.currentScript as HTMLScriptElement | null);
else {
  const scripts = Array.from(document.scripts);
  const onLoad = (event: Event): void => {
    for (const script of scripts) script.removeEventListener('load', onLoad);
    run(event.target as HTMLScriptElement);
  };
  for (const script of scripts) script.addEventListener('load', onLoad);
}
