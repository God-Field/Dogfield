import {state, getSettings} from '../app/runtime';

export const sounds = {
  addCurse: 'add-curse',
  addItem: 'add-item',
  alert: 'alert',
  atkBy2xMp: 'atk-by-2x-mp',
  attackByGuardian: 'attack-by-guardian',
  attackDyingly: 'attack-dyingly',
  attractDanger: 'attract-danger',
  block: 'block',
  boostCp: 'boost-cp',
  boostHp: 'boost-hp',
  boostMp: 'boost-mp',
  bounce: 'bounce',
  buy: 'buy',
  cancelEntry: 'cancel-entry',
  cancelItem: 'cancel-item',
  click: 'click',
  command: 'command',
  confusion: 'confusion',
  counterAttack: 'counter-attack',
  darkcloud: 'darkcloud',
  dealDamage: 'deal-damage',
  dealDarkDamage: 'deal-dark-damage',
  devilToBoostSomething: 'devil-to-boost-something',
  devilToDealDamage1: 'devil-to-deal-damage-1',
  devilToDealDamage2: 'devil-to-deal-damage-2',
  devilToDealDamage3: 'devil-to-deal-damage-3',
  devilToRemoveSomething: 'devil-to-remove-something',
  die: 'die',
  disease: 'disease',
  drawGame: 'draw-game',
  dream: 'dream',
  exchange: 'exchange',
  fog: 'fog',
  gift: 'gift',
  hit: 'hit',
  increase: 'increase',
  makeEntry: 'make-entry',
  miss: 'miss',
  moveCp: 'move-cp',
  phenomenon: 'phenomenon',
  poor: 'poor',
  pray: 'pray',
  redraw: 'redraw',
  reference: 'reference',
  reflect: 'reflect',
  removeCurses: 'remove-curses',
  removeGuardian: 'remove-guardian',
  removeItems: 'remove-items',
  revive: 'revive',
  sacrifice: 'sacrifice',
  safe: 'safe',
  selectItem: 'select-item',
  selfCurse: 'self-curse',
  setGuardian: 'set-guardian',
  showRemovedItem: 'show-removed-item',
  shuffleTeams: 'shuffle-teams',
  startGame: 'start-game',
  startTurn: 'start-turn',
  targetPlayer: 'target-player',
  tiebreak: 'tiebreak',
  timeGaugeAlarm: 'time-gauge-alarm',
  turnPlayer: 'turn-player',
  upgradeDisease: 'upgrade-disease',
  upgradeHeaven: 'upgrade-heaven',
  useNoItems: 'use-no-items',
  winGame: 'win-game',
} as const;
export type SoundName = typeof sounds[keyof typeof sounds];

const soundNames: SoundName[] = Object.values(sounds);
const soundSources = new Map<string, string>();
export function registerSound(name: string, source: string): void {
  soundSources.set(name, source);
  if (typeof document !== 'undefined') {
    preloadSound(name);
  }
}
export function unregisterSound(name: string): void {
  soundSources.delete(name);
  state.audioElements.delete(name);
}
export function initializeVolumeControls(): void {
  if (state.audioElements.size !== 0) return;
  const settings = getSettings();
  state.isMuted = settings.isMuted;
  state.volume = settings.volume ?? 50;
  preloadSound(sounds.click);
}
export function applyMuteSetting(): void {
  const settings = getSettings();
  settings.isMuted = state.isMuted;
  settings.volume = state.volume === 50 ? null : state.volume;
  settings.saveSettings();
}
export function createAudioElement(name: string): HTMLAudioElement {
  const audio = document.createElement('audio');
  audio.src = soundSources.get(name) ?? '/audio/' + name + '.mp3';
  return audio;
}
export function playSound(name: string): void {
  if (typeof document === 'undefined' || state.isMuted) return;
  const isRegistered = soundSources.has(name) || state.audioElements.has(name);
  if (!isRegistered) return;
  const audio = createAudioElement(name);
  audio.volume = state.volume / 100;
  void audio.play();
}
export function preloadSound(name: string): void {
  if (typeof document === 'undefined' || state.audioElements.has(name)) return;
  state.audioElements.add(name);
  const audio = createAudioElement(name);
  audio.preload = 'auto';
  audio.load();
}
export function preloadAllSounds(): void { for (const name of soundNames) preloadSound(name); }
