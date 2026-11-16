/**
 * Exploration policy built on the real engine rules.
 *
 * It never invents item behavior: every candidate is checked with
 * engine.canApplyCommand/validateItemAction, MP cost and damage come from
 * engine.calculations, and stat transfers use engine.stats. The policy only
 * chooses among commands the real client would allow, while biasing toward item
 * models, command types, curses, and guardians that earlier games have not seen.
 */
import {toPlain} from './transport.mjs';

// IDs are 1-based positions in public/i18n/en.json's official item catalog.
// Keep the labels aligned with that catalog; tests pin these mappings.
export const MODEL_IDS = {
  dangerousPestle: 94,
  rainbowCurtain: 189,
  guardianPot: 201,
  nocturnalBroom: 205,
  goddessSoap: 206,
  stringOfFate: 207,
  dangerousMortar: 209,
  release: 239,
};

const REMOVAL_COMMANDS = new Set(['discard', 'sacrifice', 'sell']);
const NO_TARGET_COMMANDS = new Set(['discard', 'sacrifice', 'exchange']);
const HARMFUL_TO_EARTH_DEFENSES = new Set([
  'counterAtk',
  'counter2xAtk',
  'counterBoost2xMP',
  'counterCurse',
  'counterTakeCP',
  'reflectAnything',
  'reflectMiracle',
  'reflectWeapon',
  'bounceWeapon',
  'bounceMiracle',
]);

function modelLabel(model) {
  return model.ability || model.category?.key || 'weapon';
}

/** The wire attack keeps the String of Fate caller; defense uses the phenomenon. */
function resolvedAttackModels(attack, catalog) {
  const models = attack.itemModelIds
    .map(id => catalog.findByIndex(id - 1))
    .filter(Boolean);
  return models.length > 1 && models[0].ability === 'callPhenomenon'
    ? models.slice(1)
    : models;
}

function usableSlots(player, catalog) {
  const infos = [];
  for (const slot of player.items) {
    if (!slot.modelId || slot.used) continue;
    let model;
    try {
      model = slot.getItemModel(catalog);
    } catch {
      continue;
    }
    if (!model) continue;
    infos.push({slot, model, slotIndex: slot.id, fakeModelId: slot.fakeModelId});
  }
  return infos;
}

function allItemInfos(player, catalog) {
  const infos = [];
  for (const slot of player.items) {
    if (!slot.modelId) continue;
    let model;
    try {
      model = slot.getItemModel(catalog);
    } catch {
      continue;
    }
    if (!model) continue;
    infos.push({slot, model, slotIndex: slot.id, fakeModelId: slot.fakeModelId});
  }
  return infos;
}

function serializeSelection(infos) {
  return infos.map(info => ({
    slotIndex: info.slotIndex,
    modelId: info.model.id,
    name: info.model.name,
    category: info.model.category?.key ?? null,
    commandType: info.model.ability,
    fakeModelId: info.fakeModelId,
  }));
}

function selectionModels(infos) {
  return infos.map(info => info.model);
}

function isEnemyPlayer(self, other) {
  if (other.id === self.id) return false;
  const selfTeam = self.team?.key ?? 0;
  const otherTeam = other.team?.key ?? 0;
  if (selfTeam === 0 || otherTeam === 0) return true;
  return selfTeam !== otherTeam;
}

export class ExplorationPolicy {
  constructor({engine, catalog, rng, coverage = {}, options = {}}) {
    this.engine = engine;
    this.CategoryWeapons = engine.CategoryWeapons;
    this.CategoryMiracles = engine.CategoryMiracles;
    this.CurseFlash = engine.CurseFlash;
    this.catalog = catalog;
    this.rng = rng;
    this.coverage = coverage;
    this.options = options;
    this.focus = new Set((options.focus ?? []).map(Number).filter(Number.isInteger));
    this.defenseFocus = new Set((options.defenseFocus ?? []).map(Number).filter(Number.isInteger));
    this.preferCommands = new Set(options.preferCommands ?? []);
    this.selfTargetChance = options.selfTargetChance ?? 0;
    this.declineBuyChance = options.declineBuyChance ?? 0;
    this.targetMode = options.targetMode ?? 'auto';
    this.targetPlayerId = options.targetPlayerId ?? null;
    this.teamAware = options.teamAware !== false;
    this.passive = options.passive === true;
    this.aoeFocus = options.aoeFocus === true;
    this.fogFocus = options.fogFocus === true;
    this.dangerFocus = options.dangerFocus === true;
    this.prayerMode = options.prayerMode === true;
    this.guardianFocus = options.guardianFocus === true;
    this.earthTradeFocus = options.earthTradeFocus === true;
    this.discardAllMode = options.discardAllMode === true;
    this.earthSeen = false;
    this.dreamFocus = options.dreamFocus === true;
    this.miracleAttack = options.miracleAttack === true;
    this.plainWeaponAttack = options.plainWeaponAttack === true;
    this.sameElementPlus = options.sameElementPlus === true;
    this.rainbowTransfer = options.rainbowTransfer === true;
    this.rainbowResponseKind = options.rainbowResponseKind ?? null;
    this.targetRainbowHolder = options.targetRainbowHolder === true;
    this.rainbowAcquire = options.rainbowAcquire === true;
    this.focusAcquire = options.focusAcquire === true;
    this.dreamDeficits = new Map((options.dreamDeficits ?? []).map(entry => [Number(entry[0]), Number(entry[1])]));
    this.CurseDream = engine.CurseDream;
    this.guardianTargets = new Set();
    this.removalMode = options.removalMode ?? null;
    this.removalAfterFog = options.removalAfterFog === true;
    this.respondToIncomingBuy = options.respondToIncomingBuy === true;
    this.incomingBuyMode = options.incomingBuyMode ?? 'forgive';
    this.buyChoice = true;
    this.pendingBuyChoice = null;
    this.seenThisGame = new Set();
    this.blockedModels = new Set();
    this.forceForgive = false;
    this.commandCount = 0;
    this.aimForPrayer = options.aimForPrayer === true;
    this.broomExperiment = options.broomExperiment === true;
    this.broomEdge = options.broomEdge === true;
    this.soapExperiment = options.soapExperiment === true;
    this.reuseMiracles = options.reuseMiracles === true;
  }

  block(modelId) {
    if (Number.isInteger(modelId)) this.blockedModels.add(modelId);
  }

  blockDefense() {
    this.forceForgive = true;
  }

  modelWeight(model) {
    const globalUses = this.coverage.itemModels?.[String(model.id)]?.uses ?? 0;
    const typeSeen = this.coverage.commandTypes?.[modelLabel(model)] ?? 0;
    let weight = 1;
    if (globalUses === 0) weight += 18;
    if (this.focus.has(model.id)) weight += 400;
    if (!this.seenThisGame.has(model.id)) weight += 6;
    if (typeSeen === 0) weight += 10;
    if (this.aimForPrayer && (model.ability === 'discard' || model.ability === 'sacrifice')) weight += 30;
    if (this.preferCommands.has(model.ability)) weight += 120;
    if (this.aoeFocus && model.category === this.CategoryWeapons) {
      weight += 25;
      if (model.hitRate > 0) weight += 35;
    }
    if (this.fogFocus && model.curse?.key === 'fog') weight += 200;
    if (this.guardianFocus && (model.id === MODEL_IDS.guardianPot || model.id === MODEL_IDS.release)) weight += 250;
    if (this.dangerFocus && model.id === MODEL_IDS.dangerousPestle) weight += 300;
    if (this.dangerFocus && model.id === MODEL_IDS.dangerousMortar) weight += 80;
    if (this.passive) {
      if (model.ability === 'discard' || model.ability === 'sacrifice') weight += 60;
      if (model.ability === 'sell' || model.ability === 'buy' || model.ability === 'exchange') weight += 25;
      if (model.ability === 'boostHP') weight += 45;
      if (model.ability === 'boostMP') weight += 20;
      if (model.ability === 'removeAllCurses' || model.ability === 'removeMildCurses') weight += 40;
    }
    return weight;
  }

  isDreamCursed(player) {
    return player.curses.has(this.CurseDream);
  }

  trueModelFor(info) {
    return this.catalog.findByIndex(info.slot.modelId - 1) ?? info.model;
  }

  isDreamSource(model) {
    return model.curse === this.CurseDream;
  }

  /** Items that move the dream experiment forward should survive the passive filter. */
  dreamPriority(info, self) {
    if (!this.dreamFocus) return false;
    if (!this.isDreamCursed(self)) return this.isDreamSource(this.trueModelFor(info));
    return info.slot.fakeModelId > 0;
  }

  /** Defense ordering: catch Dream first, then reveal disguised slots. */
  defenseDreamRank(info, self) {
    const trueModel = this.trueModelFor(info);
    if (!this.isDreamCursed(self)) {
      return this.isDreamSource(trueModel) && trueModel.ability === 'selfCurseAndRedraw' ? 100 : 0;
    }
    return info.slot.fakeModelId > 0 ? 50 : 0;
  }

  /** True when this item would wipe the dream curse the experiment depends on. */
  suppressedByDream(info, self) {
    if (!this.dreamFocus || self === null || !this.isDreamCursed(self)) return false;
    const trueModel = this.trueModelFor(info);
    if (trueModel.id === MODEL_IDS.dangerousPestle || trueModel.id === MODEL_IDS.dangerousMortar) return true;
    return trueModel.ability === 'removeAllCurses' || trueModel.ability === 'removeMildCurses';
  }

  /** Boosts the items that keep the dream experiment going without wasting it. */
  dreamWeight(info, self) {
    const slot = info.slot;
    const trueModel = this.trueModelFor(info);
    const cursed = self !== null && this.isDreamCursed(self);
    const disguised = slot.fakeModelId > 0 && slot.fakeModelId !== slot.modelId;
    let weight = 0;
    if (cursed) {
      if (slot.fakeModelId > 0) {
        weight += 600;
        if (disguised) weight += 400;
        weight += (this.dreamDeficits.get(slot.modelId) ?? 0) * 20;
      }
      if (trueModel.ability === 'boostHP' && self.hp <= 30) weight += 800;
      if (trueModel.ability === 'boostMP' && self.mp <= 6) weight += 300;
      if (this.isDreamSource(trueModel)) weight -= 100;
    } else if (this.isDreamSource(trueModel)) {
      weight += 2000;
    }
    return weight;
  }

  weightedPick(infos, self = null) {
    const allowed = this.dreamFocus
      ? infos.filter(info => !this.suppressedByDream(info, self))
      : infos;
    const pool = allowed.length === 0 ? infos : allowed;
    const weights = pool.map(info => this.dreamFocus
      ? this.dreamWeight(info, self) + this.modelWeight(info.model)
      : this.modelWeight(info.model));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return pool[this.rng.int(pool.length)];
    let target = this.rng.next() * total;
    for (const [index, info] of pool.entries()) {
      target -= weights[index];
      if (target <= 0) return info;
    }
    return pool[pool.length - 1];
  }

  normalContext(self) {
    return {mode: 'normal', hasFlashCurse: [...self.curses].some(curse => curse === this.CurseFlash)};
  }

  canUseItem(info, self) {
    return this.engine.validateItemAction({
      models: [info.model],
      availableMp: self.mp,
      mode: 'normal',
      hasSpecialItemCommand: this.hasWeapon(self),
    }) === null;
  }

  /** Builds a real, client-valid attack/action selection for one seed item. */
  buildAttack(seed, usable, self, game) {
    const context = this.normalContext(self);
    const selected = [seed];
    const selectedModels = () => selectionModels(selected);
    const action = seed.model.ability;
    const isRemoval = REMOVAL_COMMANDS.has(action);
    const candidates = usable.filter(info => info !== seed);
    const compatible = candidates.filter(info => this.engine.canApplyCommand(selectedModels(), info.model, context));

    if (action === 'discard' || action === 'sacrifice') {
      const filtered = this.dangerFocus ? compatible.filter(info => info.model.id !== MODEL_IDS.dangerousMortar && info.model.id !== MODEL_IDS.dangerousPestle) : compatible;
      if (filtered.length === 0) return null;
      // Prefer discarding a weapon when the game wants to reach the prayer path.
      const ranked = this.rng.shuffle(filtered).sort((left, right) => {
        if (!this.aimForPrayer && !this.passive) return 0;
        const leftWeapon = left.model.category === this.CategoryWeapons ? 1 : 0;
        const rightWeapon = right.model.category === this.CategoryWeapons ? 1 : 0;
        return rightWeapon - leftWeapon;
      });
      const count = 1 + (this.rng.chance(0.35) ? 1 : 0);
      for (const info of ranked) {
        if (selected.length > count) break;
        if (this.engine.canApplyCommand(selectedModels(), info.model, context)) selected.push(info);
      }
      if (selected.length < 2) return null;
    } else if (action === 'sell') {
      const sellable = this.dangerFocus
        ? compatible.filter(info => info.model.id !== MODEL_IDS.dangerousMortar && info.model.id !== MODEL_IDS.dangerousPestle)
        : compatible.filter(info => !this.rainbowTransfer || !this.isRainbowResponseModel(info.model));
      if (sellable.length === 0) return null;
      const pool = this.passive
        ? sellable.slice().sort((left, right) => (right.model.category === this.CategoryWeapons ? 1 : 0) - (left.model.category === this.CategoryWeapons ? 1 : 0))
        : sellable;
      selected.push(this.weightedPick(pool, self));
    } else {
      // Optional add-ons: extra plus-attack weapons, MP cutters, elements.
      // Passive/apocalypse games avoid damage add-ons; preferred command types
      // (for example attackEveryEnemy) are added much more aggressively.
      let allowed = this.passive
        ? compatible.filter(info => !this.isDamaging(info.model)
          || (this.aoeFocus && info.model.ability === 'attackEveryEnemy'))
        : compatible;
      if (this.plainWeaponAttack) {
        allowed = allowed.filter(info => info.model.element === null);
      }
      const preferred = allowed.filter(info => this.preferCommands.has(info.model.ability));
      const focused = allowed.filter(info => this.focus.has(info.model.id)
        && !this.defenseFocus.has(info.model.id)
        && !preferred.includes(info));
      const sameElementPlus = this.sameElementPlus
        ? allowed.filter(info => info.model.isPlusAtk
          && info.model.element !== null
          && info.model.element === seed.model.element)
        : [];
      const others = this.rng.shuffle(allowed.filter(info => !preferred.includes(info)
        && !focused.includes(info)
        && !sameElementPlus.includes(info)
        && !this.defenseFocus.has(info.model.id)));
      const extras = [...sameElementPlus, ...preferred, ...focused, ...others].slice(0, 4);
      for (const info of extras) {
        if (selected.length >= 4) break;
        const chance = this.preferCommands.has(info.model.ability) || this.focus.has(info.model.id) ? 0.95 : 0.45;
        if (this.rng.chance(chance) && this.engine.canApplyCommand(selectedModels(), info.model, context)) {
          selected.push(info);
        }
      }
    }

    let alert = this.engine.validateItemAction({
      models: selectedModels(),
      availableMp: self.mp,
      mode: 'normal',
      hasSpecialItemCommand: this.hasWeapon(self),
    });
    while (alert !== null && selected.length > 1) {
      selected.pop();
      alert = this.engine.validateItemAction({
        models: selectedModels(),
        availableMp: self.mp,
        mode: 'normal',
        hasSpecialItemCommand: this.hasWeapon(self),
      });
    }
    if (alert !== null) return null;

    const target = this.chooseTarget(seed.model, self, game);
    return {selected, target, context, alert};
  }

  isDamaging(model) {
    return model.attack > 0
      || model.category === this.CategoryWeapons
      || ['attackEveryEnemy', 'attackSomebody', 'danger', 'dealDamage', 'dealDarkDamage', 'attackDyingly', 'attackTwice'].includes(model.ability);
  }

  chooseTarget(model, self, game) {
    if (NO_TARGET_COMMANDS.has(model.ability)) return undefined;
    if (this.dreamFocus && this.isDreamSource(model) && !this.isDreamCursed(self)) return self.id;
    if (!model.isDirectTargetCommand()) return undefined;
    const living = game.players.filter(player => !player.dead);
    const enemies = living.filter(player => player.id !== self.id && (!this.teamAware || isEnemyPlayer(self, player)));
    const teammates = living.filter(player => player.id !== self.id && this.teamAware && !isEnemyPlayer(self, player));
    if (this.focusAcquire && model.ability === 'buy') {
      const missingFocus = [...this.focus].some(modelId =>
        !self.items.some(slot => slot.modelId === modelId));
      if (missingFocus) {
        const focusHolder = living.find(player =>
          player.id !== self.id
          && player.items.some(slot => this.focus.has(slot.modelId)));
        if (focusHolder !== undefined) return focusHolder.id;
      }
    }
    if (this.rainbowAcquire
      && model.ability === 'buy'
      && self.items.some(slot => slot.modelId === MODEL_IDS.rainbowCurtain)
      && !this.holderHasRainbowResponse(self)) {
      const responseHolder = this.findRainbowResponseHolder(game, self);
      if (responseHolder !== null) return responseHolder.id;
    }
    if (this.targetRainbowHolder) {
      const holder = this.findRainbowHolder(game, self);
      if (holder !== null
        && holder.id !== self.id
        && this.holderHasRainbowResponse(holder)) {
        return holder.id;
      }
    }
    const mode = this.targetMode;
    if (mode === 'self') return self.id;
    if (mode === 'teammate') return teammates.length === 0 ? undefined : this.rng.pick(teammates).id;
    if (mode === 'specific') {
      const target = living.find(player => player.id === Number(this.targetPlayerId));
      if (target) return target.id;
    }
    if (mode === 'random') {
      if (living.length === 0) return undefined;
      return this.rng.pick(living).id;
    }
    if (mode === 'weakest' || mode === 'strongest') {
      const pool = enemies.length !== 0 ? enemies : living.filter(player => player.id !== self.id);
      if (pool.length === 0) return undefined;
      const sorted = pool.slice().sort((left, right) => mode === 'weakest' ? left.hp - right.hp : right.hp - left.hp);
      return sorted[0].id;
    }
    // auto: passive games keep economic cards on themselves to avoid damage.
    if (this.passive) return self.id;
    const selfAlive = living.some(player => player.id === self.id);
    if (selfAlive && this.selfTargetChance > 0 && this.rng.chance(this.selfTargetChance)) return self.id;
    if (enemies.length === 0) return undefined;
    return this.rng.pick(enemies).id;
  }

  /** When our own Buy is pending, the server offers an item and waits for our confirmation. */
  decideBuyConfirmation(game, self, attackOverride = null) {
    const attack = attackOverride ?? game.attack;
    if (attack === null || attack === undefined || attack.playerId !== self.id) return null;
    const models = resolvedAttackModels(attack, this.catalog);
    if (models.length === 0 || models[0].ability !== 'buy') return null;
    const events = game.events;
    let offerIndex = -1;
    for (let index = 0; index < events.length; index++) if (events[index].action === 'buy') offerIndex = index;
    if (offerIndex < 0) {
      this.pendingBuyChoice = null;
      return null;
    }
    if (events.slice(offerIndex + 1).some(event => event.action === 'setBought')) {
      this.pendingBuyChoice = null;
      return null;
    }
    const offer = events[offerIndex];
    let offeredResponse = false;
    if (this.rainbowAcquire && offer.item !== null && offer.item !== undefined) {
      try {
        const offeredModel = offer.item.getItemModel(this.catalog);
        offeredResponse = offeredModel !== null && this.isRainbowResponseModel(offeredModel);
      } catch {
        offeredResponse = false;
      }
    }
    if (this.pendingBuyChoice === null) {
      this.pendingBuyChoice = this.rainbowAcquire
        ? offeredResponse
        : !this.rng.chance(this.declineBuyChance);
      this.buyChoice = this.pendingBuyChoice;
    }
    let offered = null;
    try {
      offered = offer.item === null ? null : offer.item.getItemModel(this.catalog);
    } catch {
      offered = null;
    }
    return {
      phase: 'buy',
      kind: 'confirmBuy',
      command: this.engine.createCommandPayload({bought: this.buyChoice}),
      summary: {
        offeredItem: offered?.name ?? null,
        offeredModelId: offered?.id ?? null,
        price: offered?.price ?? null,
        targetPlayerId: attack.targetPlayerId,
        buyerHp: self.hp,
        buyerCp: self.cp,
      },
      reason: 'the server offered an item for our Buy and waits for the buyer confirmation',
    };
  }

  alternateBuyChoice() {
    this.buyChoice = !this.buyChoice;
  }

  exchangePayload(slot, self) {
    const directions = [
      {kind: 'hpToMp', amount: this.rng.pick([1, 5, 10])},
      {kind: 'hpToCp', amount: this.rng.pick([1, 5, 10])},
      {kind: 'mpToHp', amount: -this.rng.pick([1, 5, 10])},
    ];
    const direction = this.passive
      ? (self.mp > 0
        ? {kind: 'mpToHp', amount: -Math.min(self.mp, this.rng.pick([1, 5, 10]))}
        : {kind: 'hpToCp', amount: 1})
      : this.rng.pick(directions);
    let hp = self.hp;
    let mp = self.mp;
    let cp = self.cp;
    if (direction.kind === 'hpToMp') {
      const result = this.engine.transferStat(hp, mp, direction.amount);
      hp = result.hp;
      mp = result.target;
    } else if (direction.kind === 'hpToCp') {
      const result = this.engine.transferStat(hp, cp, direction.amount);
      hp = result.hp;
      cp = result.target;
    } else {
      const result = this.engine.transferStat(hp, mp, direction.amount);
      hp = result.hp;
      mp = result.target;
    }
    return {
      command: this.engine.createCommandPayload({itemIds: [slot], mp, cp}),
      summary: {direction: direction.kind, amount: direction.amount, predicted: {hp, mp, cp}},
    };
  }

  hasWeapon(player) {
    for (const slot of player.items) {
      if (!slot.modelId) continue;
      let model;
      try {
        model = slot.getItemModel(this.catalog);
      } catch {
        continue;
      }
      if (model?.category === this.CategoryWeapons) return true;
    }
    return false;
  }

  /**
   * Slot 0 is the always-available Discard/Sacrifice command card. It is not
   * in the player's item list, but the client submits itemIds [0, partner].
   */
  buildRemoval(game, self, usable, mode) {
    const modelId = mode === 'sacrifice' ? 2 : 1;
    const special = this.catalog.findByIndex(modelId - 1);
    if (!special) return null;
    const context = this.normalContext(self);
    const partners = usable.filter(info => info.model.category !== this.CategoryWeapons
      && info.model.ability !== 'revive'
      && info.model.ability !== 'attractDanger'
      && !(this.dangerFocus && (info.model.id === MODEL_IDS.dangerousMortar || info.model.id === MODEL_IDS.dangerousPestle))
      && !(this.rainbowTransfer && this.isRainbowResponseModel(info.model))
      && this.engine.canApplyCommand([special], info.model, context));
    if (partners.length === 0) return null;
    const partner = this.weightedPick(partners, self);
    const virtual = {slot: null, model: special, slotIndex: 0, fakeModelId: 0};
    return {
      phase: 'attack',
      kind: mode,
      command: this.engine.createCommandPayload({itemIds: [0, partner.slotIndex]}),
      selected: serializeSelection([virtual, partner]),
      summary: {
        removal: mode,
        specialModelId: modelId,
        partner: partner.model.name,
        partnerModelId: partner.model.id,
      },
      seedModelId: partner.model.id,
      reason: 'slot 0 is the always-available Discard/Sacrifice command card used with a discardable partner item',
    };
  }

  /** Sells one disguised weapon to ourselves so it turns into its true form without damage. */
  buildDreamSell(game, self, usable) {
    const sell = usable.find(info => info.model.ability === 'sell');
    if (sell === undefined) return null;
    const context = this.normalContext(self);
    const weapons = usable.filter(info =>
      info.slot.fakeModelId > 0
      && info.slot.fakeModelId !== info.slot.modelId
      && info.model.category === this.CategoryWeapons
      && !this.suppressedByDream(info, self)
      && this.engine.canApplyCommand([sell.model], info.model, context));
    if (weapons.length === 0) return null;
    const weapon = this.weightedPick(weapons, self);
    return {
      phase: 'attack',
      kind: 'dreamSell',
      command: this.engine.createCommandPayload({itemIds: [sell.slotIndex, weapon.slotIndex], targetPlayerId: self.id}),
      selected: serializeSelection([sell, weapon]),
      summary: {
        dreamSell: true,
        weapon: weapon.model.name,
        weaponModelId: weapon.model.id,
        fakeModelId: weapon.slot.fakeModelId,
        trueModelId: weapon.slot.modelId,
      },
      seedModelId: weapon.model.id,
      reason: 'dream sell removes and reveals a disguised weapon through the self-sale path',
    };
  }

  /**
   * Reveals one disguised non-weapon per turn through Discard/Sacrifice.
   *
   * Discard is self-contained: it consumes the partner and still advances the
   * exchange, so the experiment can keep drawing one dreamed gift per turn
   * without damaging the bots and ending the game early.
   */
  buildDreamFlush(game, self, usable) {
    const apocalypseComplete = game.tiebreakGF !== null && game.tiebreakGF !== undefined && game.gf >= game.tiebreakGF;
    const mode = apocalypseComplete ? 'sacrifice' : 'discard';
    const specialModelId = mode === 'sacrifice' ? 2 : 1;
    const special = this.catalog.findByIndex(specialModelId - 1);
    if (!special) return null;
    const context = this.normalContext(self);
    const partners = usable.filter(info =>
      info.slot.fakeModelId > 0
      && info.slot.fakeModelId !== info.slot.modelId
      && info.model.category !== this.CategoryWeapons
      && info.model.ability !== 'revive'
      && info.model.ability !== 'attractDanger'
      && !this.suppressedByDream(info, self)
      && this.engine.canApplyCommand([special], info.model, context));
    if (partners.length === 0) return null;
    const partner = this.weightedPick(partners, self);
    return {
      phase: 'attack',
      kind: mode,
      command: this.engine.createCommandPayload({itemIds: [0, partner.slotIndex]}),
      selected: serializeSelection([
        {slot: null, model: special, slotIndex: 0, fakeModelId: 0},
        partner,
      ]),
      summary: {
        dreamFlush: true,
        removal: mode,
        partner: partner.model.name,
        partnerModelId: partner.model.id,
        partnerFakeModelId: partner.fakeModelId,
        trueModelId: partner.slot.modelId,
      },
      seedModelId: partner.model.id,
      reason: 'dream flush discards one disguised item per turn, revealing it without damaging the bots',
    };
  }

  /** Non-damaging fallback actions used by stall mode when no sacrificeable partner exists. */
  buildStallAction(game, self, usable) {
    const sell = usable.find(info => info.model.ability === 'sell');
    const weapon = usable.find(info => info.model.category === this.CategoryWeapons && info.model.id !== MODEL_IDS.dangerousPestle);
    if (sell !== undefined && weapon !== undefined) {
      return {
        phase: 'attack',
        kind: 'sellSelf',
        command: this.engine.createCommandPayload({itemIds: [sell.slotIndex, weapon.slotIndex], targetPlayerId: self.id}),
        selected: serializeSelection([sell, weapon]),
        summary: {stall: 'sell weapon to self', weapon: weapon.model.name},
        seedModelId: weapon.model.id,
        reason: 'stall mode removes an accumulated weapon by selling it to self',
      };
    }
    const buy = usable.find(info => info.model.ability === 'buy');
    if (buy !== undefined) {
      return {
        phase: 'attack',
        kind: 'buySelf',
        command: this.engine.createCommandPayload({itemIds: [buy.slotIndex], targetPlayerId: self.id}),
        selected: serializeSelection([buy]),
        summary: {stall: 'buy self (canNotBuy consumes the card without damage)'},
        seedModelId: buy.model.id,
        reason: 'stall mode consumes a Buy card on self for a no-damage turn',
      };
    }
    const exchange = usable.find(info => info.model.ability === 'exchange');
    if (exchange !== undefined) {
      const payload = this.exchangePayload(exchange.slotIndex, self);
      return {
        phase: 'attack',
        kind: 'exchange',
        command: payload.command,
        summary: {...payload.summary, stall: 'exchange self'},
        selected: serializeSelection([exchange]),
        seedModelId: exchange.model.id,
        reason: 'stall mode converts MP to HP or HP to CP through the real exchange rule',
      };
    }
    return null;
  }

  performedMiracleInfos(player) {
    return allItemInfos(player, this.catalog).filter(info => {
      const trueModel = this.trueModelFor(info);
      return info.slot.used === true && trueModel.category === this.CategoryMiracles;
    });
  }

  experimentBroomInfo(usable) {
    return usable.find(info =>
      info.slot.modelId === MODEL_IDS.nocturnalBroom
      && (info.slot.fakeModelId === 0 || info.slot.fakeModelId === MODEL_IDS.nocturnalBroom)) ?? null;
  }

  experimentMiracleRank(info) {
    const trueModel = this.trueModelFor(info);
    if (trueModel.ability === 'boostHP') return 0;
    if (trueModel.ability === 'removeAllCurses' || trueModel.ability === 'removeMildCurses') return 1;
    if (trueModel.attack === 0 && trueModel.ability !== 'addCurse') return 2;
    if (trueModel.ability === 'addCurse') return 4;
    return 3;
  }

  buildExperimentItemDecision(seed, self, targetPlayerId, kind, reason, summary = {}) {
    const alert = this.engine.validateItemAction({
      models: [seed.model],
      availableMp: self.mp,
      mode: 'normal',
      hasSpecialItemCommand: this.hasWeapon(self),
    });
    if (alert !== null) return null;
    const commandInput = {itemIds: [seed.slotIndex]};
    if (targetPlayerId !== undefined && targetPlayerId !== null) {
      commandInput.targetPlayerId = targetPlayerId;
    }
    return {
      phase: 'attack',
      kind,
      command: this.engine.createCommandPayload(commandInput),
      selected: serializeSelection([seed]),
      summary: {
        ...summary,
        seedName: seed.model.name,
        seedModelId: seed.model.id,
        selfHp: self.hp,
        selfMp: self.mp,
      },
      seedModelId: seed.model.id,
      reason,
    };
  }

  buildExperimentHeal(self, usable) {
    if (self.hp > 45) return null;
    const healInfos = usable.filter(info => {
      const trueModel = this.trueModelFor(info);
      return trueModel.ability === 'boostHP' && trueModel.id !== MODEL_IDS.goddessSoap;
    });
    if (healInfos.length === 0) return null;
    const healInfo = this.weightedPick(healInfos, self);
    return this.buildExperimentItemDecision(
      healInfo,
      self,
      undefined,
      'experimentHeal',
      'broom experiment: heal before continuing the stall',
      {experimentHeal: true},
    );
  }

  buildExperimentMiracle(self, game, usable) {
    const miracleInfos = usable.filter(info => {
      const trueModel = this.trueModelFor(info);
      return trueModel.category === this.CategoryMiracles
        && info.model.isItemTargetingCommand()
        && trueModel.id !== MODEL_IDS.goddessSoap
        && trueModel.ability !== 'removeUsedMiracles'
        && trueModel.ability !== 'removeItems';
    });
    if (miracleInfos.length === 0) return null;
    const ranked = miracleInfos
      .slice()
      .sort((left, right) => this.experimentMiracleRank(left) - this.experimentMiracleRank(right));
    const livingEnemies = game.players
      .filter(player => !player.dead && player.id !== self.id)
      .sort((left, right) => right.hp - left.hp);
    for (const info of ranked) {
      const trueModel = this.trueModelFor(info);
      const targetPlayerId = trueModel.isDirectTargetCommand()
        ? livingEnemies[0]?.id ?? self.id
        : undefined;
      const decision = this.buildExperimentItemDecision(
        info,
        self,
        targetPlayerId,
        'miracleSetup',
        'broom experiment: perform at least one miracle before stalling',
        {
          experimentMiracle: true,
          miracleName: trueModel.name,
          performedBefore: this.performedMiracleInfos(self).length,
        },
      );
      if (decision !== null) return decision;
    }
    return null;
  }

  buildExperimentBroomSweep(self, game, broomInfo) {
    const performedTargets = game.players
      .filter(player => !player.dead && player.id !== self.id)
      .map(player => {
        const itemInfos = allItemInfos(player, this.catalog);
        const miracles = itemInfos.filter(info =>
          info.slot.used === true
          && this.trueModelFor(info).category === this.CategoryMiracles);
        const removableCount = itemInfos.filter(info => !info.slot.used).length;
        return {player, miracles, removableCount, occupiedCount: itemInfos.length};
      })
      .filter(entry => entry.miracles.length > 0);
    const candidates = this.broomEdge
      ? performedTargets
          .filter(entry => entry.removableCount < 3 || entry.occupiedCount >= 18)
          .sort((left, right) =>
            (left.removableCount - right.removableCount)
            || (right.occupiedCount - left.occupiedCount)
            || (right.miracles.length - left.miracles.length))
      : performedTargets.sort((left, right) =>
          (right.miracles.length - left.miracles.length) || (right.player.hp - left.player.hp));
    if (candidates.length === 0) return null;
    const target = candidates[0];
    return this.buildExperimentItemDecision(
      broomInfo,
      self,
      target.player.id,
      'broomSweep',
      this.broomEdge
        ? 'broom experiment: target a low-item or full-hand performed-miracle holder'
        : 'broom experiment: sweep a player who has performed miracles',
      {
        broomSweep: true,
        broomEdge: this.broomEdge,
        targetName: target.player.name,
        targetPlayerId: target.player.id,
        targetPerformedCount: target.miracles.length,
        targetRemovableCount: target.removableCount,
        targetOccupiedCount: target.occupiedCount,
        targetPerformedMiracles: target.miracles.map(info => ({
          slotIndex: info.slotIndex,
          modelId: this.trueModelFor(info).id,
          name: this.trueModelFor(info).name,
        })),
      },
    );
  }

  buildExperimentStall(self, game, usable) {
    const stall = this.buildStallAction(game, self, usable);
    if (stall !== null) return stall;
    const safeAbilities = new Set([
      'boostHP',
      'boostMP',
      'boostCP',
      'removeAllCurses',
      'removeMildCurses',
    ]);
    const safeInfos = usable.filter(info => {
      const trueModel = this.trueModelFor(info);
      if (trueModel.id === MODEL_IDS.nocturnalBroom || trueModel.id === MODEL_IDS.goddessSoap) return false;
      if (!info.model.isItemTargetingCommand()) return false;
      return safeAbilities.has(trueModel.ability);
    });
    if (safeInfos.length !== 0) {
      const safeInfo = this.weightedPick(safeInfos, self);
      const trueModel = this.trueModelFor(safeInfo);
      const targetPlayerId = trueModel.isDirectTargetCommand() ? self.id : undefined;
      return this.buildExperimentItemDecision(
        safeInfo,
        self,
        targetPlayerId,
        'experimentStall',
        'broom experiment: use a non-damaging item while waiting for a broom',
        {experimentStall: true, stallAbility: trueModel.ability},
      );
    }
    const weapons = usable
      .filter(info => info.model.category === this.CategoryWeapons && info.model.id !== MODEL_IDS.dangerousPestle)
      .sort((left, right) => left.model.attack - right.model.attack);
    if (weapons.length !== 0) {
      const weapon = weapons[0];
      const livingEnemies = game.players
        .filter(player => !player.dead && player.id !== self.id)
        .sort((left, right) => right.hp - left.hp);
      const targetPlayerId = livingEnemies[0]?.id ?? self.id;
      return this.buildExperimentItemDecision(
        weapon,
        self,
        targetPlayerId,
        'experimentWeaponStall',
        'broom experiment: use the weakest weapon when no non-damaging action exists',
        {experimentWeaponStall: true, damaging: true},
      );
    }
    return {
      phase: 'attack',
      kind: 'pray',
      command: this.engine.createCommandPayload({}),
      summary: {experimentStall: true, prayer: true},
      reason: 'broom experiment: no weapon and no item action, so pray to draw a gift',
    };
  }

  decideBroomExperiment(game, self, usable) {
    const heal = this.buildExperimentHeal(self, usable);
    if (heal !== null) return heal;
    if (this.performedMiracleInfos(self).length === 0) {
      const miracle = this.buildExperimentMiracle(self, game, usable);
      if (miracle !== null) return miracle;
    }
    const broomInfo = this.experimentBroomInfo(usable);
    const actorHasFog = [...self.curses].some(curse => curse.key === 'fog');
    if (broomInfo !== null && !actorHasFog) {
      const sweep = this.buildExperimentBroomSweep(self, game, broomInfo);
      if (sweep !== null) return sweep;
    }
    return this.buildExperimentStall(self, game, usable);
  }

  decideSoapExperiment(game, self, usable) {
    const heal = this.buildExperimentHeal(self, usable);
    if (heal !== null) return heal;
    if (this.performedMiracleInfos(self).length < 3) {
      const miracle = this.buildExperimentMiracle(self, game, usable);
      if (miracle !== null) return miracle;
    }
    const soapInfo = usable.find(info =>
      info.slot.modelId === MODEL_IDS.goddessSoap
      && (info.slot.fakeModelId === 0 || info.slot.fakeModelId === MODEL_IDS.goddessSoap)) ?? null;
    const actorHasFog = [...self.curses].some(curse => curse.key === 'fog');
    if (soapInfo !== null && !actorHasFog) {
      const performedTargets = game.players
        .filter(player => !player.dead && player.id !== self.id)
        .map(player => ({player, miracles: this.performedMiracleInfos(player)}))
        .filter(entry => entry.miracles.length >= 3)
        .sort((left, right) =>
          (right.miracles.length - left.miracles.length) || (right.player.hp - left.player.hp));
      if (performedTargets.length !== 0) {
        const target = performedTargets[0];
        return this.buildExperimentItemDecision(
          soapInfo,
          self,
          target.player.id,
          'soapWash',
          'soap experiment: wash a player holding at least three performed miracles',
          {
            soapWash: true,
            targetName: target.player.name,
            targetPlayerId: target.player.id,
            targetPerformedCount: target.miracles.length,
            targetPerformedMiracles: target.miracles.map(info => ({
              slotIndex: info.slotIndex,
              modelId: this.trueModelFor(info).id,
              name: this.trueModelFor(info).name,
            })),
          },
        );
      }
    }
    return this.buildExperimentStall(self, game, usable);
  }

  guardianRoster(game) {
    const guardianOwners = new Set();
    const earthOwners = new Set();
    for (const player of game.players) {
      if (player.dead) continue;
      if (player.guardian) guardianOwners.add(player.id);
      if (player.guardian?.key === 'earth') earthOwners.add(player.id);
    }
    return {guardianOwners, earthOwners};
  }

  buildGuardianSummon(summon, self) {
    const alert = this.engine.validateItemAction({
      models: [summon.model],
      availableMp: self.mp,
      mode: 'normal',
      hasSpecialItemCommand: this.hasWeapon(self),
    });
    if (alert !== null) return null;
    return {
      phase: 'attack',
      kind: 'summonGuardian',
      command: this.engine.createCommandPayload({itemIds: [summon.slotIndex]}),
      selected: serializeSelection([summon]),
      summary: {guardianSpawn: summon.model.name, earthTrade: true},
      seedModelId: summon.model.id,
      reason: 'earth experiment: spawn another guardian and reroll for Earth',
    };
  }

  buildEarthTradeHeal(self, usable) {
    if (self.hp > 60) return null;
    const healInfos = usable.filter(info => info.model.ability === 'boostHP');
    if (healInfos.length === 0) return null;
    const healInfo = this.weightedPick(healInfos, self);
    return this.buildExperimentItemDecision(
      healInfo,
      self,
      undefined,
      'earthTradeHeal',
      'earth experiment: heal so the game keeps cycling turns',
      {earthTradeHeal: true},
    );
  }

  buildEarthTradePhenomenon(self, usable) {
    const phenomenon = usable.find(info =>
      info.model.ability === 'callPhenomenon' && this.canUseItem(info, self));
    if (phenomenon === undefined) return null;
    return this.buildExperimentItemDecision(
      phenomenon,
      self,
      undefined,
      'earthTradePhenomenon',
      'earth experiment: fish for Solar Eclipse so every player gains a guardian',
      {earthTradePhenomenon: true},
    );
  }

  buildEarthTradeBuy(game, self, usable) {
    const buy = usable.find(info =>
      info.model.ability === 'buy' && this.canUseItem(info, self));
    if (buy === undefined) return null;
    const desiredModelIds = new Set([MODEL_IDS.guardianPot, MODEL_IDS.stringOfFate]);
    const candidates = game.players
      .filter(player => !player.dead && player.id !== self.id)
      .map(player => ({player, items: allItemInfos(player, this.catalog)}))
      .filter(entry => entry.items.some(info => desiredModelIds.has(info.model.id)))
      .filter(entry => entry.items.some(info =>
        info.model.id === MODEL_IDS.guardianPot ? self.cp >= 10 : self.cp >= 3))
      .sort((left, right) => left.items.length - right.items.length);
    if (candidates.length === 0) return null;
    const target = candidates[0];
    return {
      phase: 'attack',
      kind: 'earthTradeBuy',
      command: this.engine.createCommandPayload({
        itemIds: [buy.slotIndex],
        targetPlayerId: target.player.id,
      }),
      selected: serializeSelection([buy]),
      summary: {
        earthTradeBuy: true,
        targetPlayerId: target.player.id,
        targetName: target.player.name,
        targetItemCount: target.items.length,
        desiredItems: target.items
          .filter(info => desiredModelIds.has(info.model.id))
          .map(info => ({modelId: info.model.id, name: info.model.name})),
      },
      seedModelId: buy.model.id,
      reason: 'earth experiment: buy a Guardian Pot or String of Fate from another player',
    };
  }

  buildEarthTradeStall(game, self, usable, earthOwners) {
    const urgentHeal = self.hp <= 25
      ? this.buildEarthTradeHeal(self, usable)
      : null;
    if (urgentHeal !== null) return urgentHeal;

    const summon = usable.find(info =>
      info.model.ability === 'setGuardian' && this.canUseItem(info, self));
    if (summon !== undefined && !earthOwners.has(self.id)) {
      const summonDecision = this.buildGuardianSummon(summon, self);
      if (summonDecision !== null) return summonDecision;
    }

    if (!this.earthSeen) {
      const phenomenon = this.buildEarthTradePhenomenon(self, usable);
      if (phenomenon !== null) return phenomenon;
    }

    const buy = this.buildEarthTradeBuy(game, self, usable);
    if (buy !== null) return buy;

    const heal = this.buildEarthTradeHeal(self, usable);
    if (heal !== null) return heal;

    const stall = this.buildStallAction(game, self, usable);
    if (stall !== null) return stall;

    const safeAbilities = new Set([
      'boostHP',
      'boostMP',
      'boostCP',
      'removeAllCurses',
      'removeMildCurses',
    ]);
    const safeInfo = usable.find(info =>
      safeAbilities.has(info.model.ability) && info.model.isItemTargetingCommand());
    if (safeInfo !== undefined) {
      const safeDecision = this.buildExperimentItemDecision(
        safeInfo,
        self,
        undefined,
        'earthTradeStall',
        'earth experiment: use a non-damaging item while waiting for Earth',
        {earthTradeStall: true, stallAbility: safeInfo.model.ability},
      );
      if (safeDecision !== null) return safeDecision;
    }

    const hasSummon = usable.some(info => info.model.ability === 'setGuardian');
    if (!this.hasWeapon(self)) {
      return {
        phase: 'attack',
        kind: 'pray',
        command: this.engine.createCommandPayload({}),
        summary: {earthTrade: true, prayer: true},
        reason: 'earth experiment: unarmed prayer is non-damaging and draws a gift',
      };
    }

    if (!hasSummon) {
      const apocalypseComplete = game.tiebreakGF !== null
        && game.tiebreakGF !== undefined
        && game.gf >= game.tiebreakGF;
      const removal = this.buildRemoval(
        game,
        self,
        usable,
        apocalypseComplete ? 'sacrifice' : 'discard',
      );
      if (removal !== null) return removal;
    }

    const allWeapons = usable
      .filter(info => info.model.category === this.CategoryWeapons)
      .sort((left, right) => left.model.attack - right.model.attack);
    const preferredWeapons = allWeapons.filter(info => info.model.id !== MODEL_IDS.dangerousPestle);
    const weapons = preferredWeapons.length !== 0 ? preferredWeapons : allWeapons;
    if (weapons.length !== 0) {
      const weapon = weapons[0];
      const livingEnemies = game.players
        .filter(player =>
          !player.dead
          && player.id !== self.id
          && !earthOwners.has(player.id))
        .sort((left, right) => right.hp - left.hp);
      const targetPlayerId = livingEnemies[0]?.id ?? self.id;
      const weaponDecision = this.buildExperimentItemDecision(
        weapon,
        self,
        targetPlayerId,
        'earthTradeWeaponStall',
        'earth experiment: weakest weapon against the healthiest non-Earth enemy',
        {
          earthTradeWeaponStall: true,
          damaging: weapon.model.attack > 0,
          targetPlayerId,
        },
      );
      if (weaponDecision !== null) return weaponDecision;
    }

    if (this.hasWeapon(self)) {
      const weapon = allWeapons[0];
      if (weapon !== undefined) {
        const livingEnemies = game.players
          .filter(player =>
            !player.dead
            && player.id !== self.id
            && !earthOwners.has(player.id))
          .sort((left, right) => right.hp - left.hp);
        const targetPlayerId = livingEnemies[0]?.id ?? self.id;
        return {
          phase: 'attack',
          kind: 'earthTradeWeaponStall',
          command: this.engine.createCommandPayload({
            itemIds: [weapon.slotIndex],
            targetPlayerId,
          }),
          selected: serializeSelection([weapon]),
          summary: {
            earthTradeWeaponStall: true,
            fallback: true,
            damaging: weapon.model.attack > 0,
            targetPlayerId,
          },
          seedModelId: weapon.model.id,
          reason: 'earth experiment: a weapon is still in hand, so prayer is not legal',
        };
      }
    }

    return {
      phase: 'attack',
      kind: 'pray',
      command: this.engine.createCommandPayload({}),
      summary: {earthTrade: true, prayer: true},
      reason: 'earth experiment: no non-damaging action, so pray to keep the turn cycling',
    };
  }

  decideEarthTrade(game, self, usable) {
    const {guardianOwners, earthOwners} = this.guardianRoster(game);
    this.guardianTargets = guardianOwners;
    if (earthOwners.size > 0) this.earthSeen = true;
    return this.buildEarthTradeStall(game, self, usable, earthOwners);
  }

  buildDiscardAll(self, usable) {
    const special = this.catalog.findByIndex(0);
    if (!special) return null;
    const context = this.normalContext(self);
    const selectedModels = [special];
    const selectedInfos = [{slot: null, model: special, slotIndex: 0, fakeModelId: 0}];
    for (const info of usable) {
      if (!this.engine.canApplyCommand(selectedModels, info.model, context)) {
        return null;
      }
      selectedModels.push(info.model);
      selectedInfos.push(info);
    }
    const alert = this.engine.validateItemAction({
      models: selectedModels,
      availableMp: self.mp,
      mode: 'normal',
      hasSpecialItemCommand: this.hasWeapon(self),
    });
    if (alert !== null) return null;
    return {
      phase: 'attack',
      kind: 'discardAll',
      command: this.engine.createCommandPayload({
        itemIds: [0, ...usable.map((info) => info.slotIndex)],
      }),
      selected: serializeSelection(selectedInfos),
      summary: {
        discardAll: true,
        handSize: usable.length,
        items: usable.map((info) => info.model.name),
      },
      seedModelId: special.id,
      reason: 'discard every remaining card while the hand has no blockers',
    };
  }

  buildSingleDiscard(partner) {
    const special = this.catalog.findByIndex(0);
    if (!special) return null;
    const virtual = {slot: null, model: special, slotIndex: 0, fakeModelId: 0};
    return {
      phase: 'attack',
      kind: 'discardOne',
      command: this.engine.createCommandPayload({
        itemIds: [0, partner.slotIndex],
      }),
      selected: serializeSelection([virtual, partner]),
      summary: {
        discardOne: true,
        partner: partner.model.name,
        partnerModelId: partner.model.id,
      },
      seedModelId: special.id,
      reason: 'discard one card to fill a placeholder without creating another',
    };
  }

  decideDiscardAll(game, self, usable) {
    const allItems = allItemInfos(self, this.catalog);
    if (allItems.length === 0) return null;
    const hasPlaceholder = self.items.some((itemSlot) => !itemSlot.modelId);
    const allDiscardable = allItems.every((info) =>
      info.slot.used !== true
        && info.model.category !== this.CategoryWeapons
        && info.model.ability !== 'revive'
        && info.model.ability !== 'attractDanger');
    if (allDiscardable && !hasPlaceholder) {
      const discardAll = this.buildDiscardAll(self, usable);
      if (discardAll !== null) return discardAll;
    }

    if (hasPlaceholder) {
      const partner = usable.find((info) =>
        info.model.category !== this.CategoryWeapons
          && info.model.ability !== 'revive'
          && info.model.ability !== 'attractDanger'
          && this.canUseItem(info, self));
      if (partner !== undefined) return this.buildSingleDiscard(partner);
    }

    const weapons = usable
      .filter((info) => info.model.category === this.CategoryWeapons)
      .sort((left, right) => left.model.attack - right.model.attack);
    if (weapons.length !== 0) {
      const weapon = weapons[0];
      const target = game.players
        .filter((player) => !player.dead && player.id !== self.id)
        .sort((left, right) => right.hp - left.hp)[0];
      return this.buildExperimentItemDecision(
        weapon,
        self,
        target?.id ?? self.id,
        'discardAllWeaponClear',
        'discard-all: consume a weapon so the hand can become fully discardable',
        {discardAllWeaponClear: true, damaging: weapon.model.attack > 0},
      );
    }

    const special = usable.find((info) =>
      (info.model.ability === 'attractDanger'
        || (info.model.ability === 'revive' && self.dead === true))
      && this.canUseItem(info, self));
    if (special !== undefined) {
      return this.buildExperimentItemDecision(
        special,
        self,
        self.id,
        'discardAllSpecialClear',
        'discard-all: consume an undiscardable special card',
        {discardAllSpecialClear: true},
      );
    }

    return null;
  }

  reusableMiracleInfos(player) {
    return allItemInfos(player, this.catalog).filter(info => {
      const trueModel = this.trueModelFor(info);
      return info.slot.used === true
        && trueModel.category === this.CategoryMiracles
        && (info.slot.fakeModelId === 0 || info.slot.fakeModelId === info.slot.modelId);
    });
  }

  buildReuseMiracle(self, game) {
    const reusable = this.reusableMiracleInfos(self);
    if (reusable.length === 0) return null;
    const safeAbilities = new Set([
      'boostHP',
      'boostMP',
      'boostCP',
      'removeAllCurses',
      'removeMildCurses',
      'setGuardian',
    ]);
    const ranked = reusable.slice().sort((left, right) => {
      const leftTrue = this.trueModelFor(left);
      const rightTrue = this.trueModelFor(right);
      const leftRank = safeAbilities.has(leftTrue.ability) ? 0 : leftTrue.attack;
      const rightRank = safeAbilities.has(rightTrue.ability) ? 0 : rightTrue.attack;
      return leftRank - rightRank;
    });
    const livingEnemies = game.players
      .filter(player => !player.dead && player.id !== self.id)
      .sort((left, right) => right.hp - left.hp);
    for (const info of ranked) {
      const trueModel = this.trueModelFor(info);
      const targetPlayerId = trueModel.isDirectTargetCommand()
        ? livingEnemies[0]?.id ?? self.id
        : undefined;
      const decision = this.buildExperimentItemDecision(
        info,
        self,
        targetPlayerId,
        'reuseMiracle',
        'reuse experiment: use a performed miracle again',
        {
          reuseMiracle: true,
          miracleName: trueModel.name,
          performedCount: reusable.length,
        },
      );
      if (decision !== null) return decision;
    }
    return null;
  }

  isRainbowResponseModel(model) {
    if (this.rainbowResponseKind === 'weapon') {
      return model.ability === 'blockWeapon';
    }
    if (this.rainbowResponseKind === 'miracle') {
      return ['bounceMiracle', 'reflectMiracle', 'blockMiracle', 'reflectAnything'].includes(model.ability);
    }
    if (this.rainbowResponseKind === 'blockMiracle') {
      return model.ability === 'blockMiracle';
    }
    if (this.rainbowResponseKind === 'bounceMiracle') {
      return model.ability === 'bounceMiracle';
    }
    if (this.rainbowResponseKind === 'reflectMiracle') {
      return model.ability === 'reflectMiracle';
    }
    return false;
  }

  findRainbowHolder(game, self) {
    return game.players.find(player => !player.dead
      && player.items.some(slot => slot.modelId === MODEL_IDS.rainbowCurtain)) ?? null;
  }

  holderHasRainbowResponse(holder) {
    return holder.items.some(slot => {
      if (!slot.modelId) return false;
      const model = this.catalog.findByIndex(slot.modelId - 1);
      return model !== null && this.isRainbowResponseModel(model);
    });
  }

  findRainbowResponseHolder(game, self) {
    return game.players.find(player => !player.dead
      && player.id !== self.id
      && player.items.some(slot => {
        if (!slot.modelId) return false;
        const model = this.catalog.findByIndex(slot.modelId - 1);
        return model !== null && this.isRainbowResponseModel(model);
      })) ?? null;
  }

  buildRainbowTransfer(game, self, usable) {
    const holder = this.findRainbowHolder(game, self);
    if (holder === null || holder.id === self.id) return null;
    if (this.holderHasRainbowResponse(holder)) return null;
    const sell = usable.find(info => info.model.ability === 'sell');
    if (sell === undefined) return null;
    const response = usable.find(info => this.isRainbowResponseModel(info.model));
    if (response === undefined) return null;
    return {
      phase: 'attack',
      kind: 'rainbowTransfer',
      command: this.engine.createCommandPayload({
        itemIds: [sell.slotIndex, response.slotIndex],
        targetPlayerId: holder.id,
      }),
      selected: serializeSelection([sell, response]),
      summary: {
        rainbowTransfer: true,
        response: response.model.name,
        responseModelId: response.model.id,
        holderName: holder.name,
      },
      seedModelId: response.model.id,
      reason: 'sell the needed response card to the Rainbow Curtain holder',
    };
  }

  /** Returns the next command for an attacking turn, or null when none is valid. */
  decideAttack(game, self) {
    const usable = usableSlots(self, this.catalog);
    if (this.rainbowTransfer) {
      const transfer = this.buildRainbowTransfer(game, self, usable);
      if (transfer !== null) return transfer;
    }
    if (this.discardAllMode) {
      const discardDecision = this.decideDiscardAll(game, self, usable);
      if (discardDecision !== null) return discardDecision;
    }
    if (this.earthTradeFocus) {
      const earthTradeDecision = this.decideEarthTrade(game, self, usable);
      if (earthTradeDecision !== null) return earthTradeDecision;
    }
    if (this.broomExperiment) {
      const experimentDecision = this.decideBroomExperiment(game, self, usable);
      if (experimentDecision !== null) return experimentDecision;
    }
    if (this.soapExperiment) {
      const experimentDecision = this.decideSoapExperiment(game, self, usable);
      if (experimentDecision !== null) return experimentDecision;
    }
    if (this.reuseMiracles) {
      const reuseDecision = this.buildReuseMiracle(self, game);
      if (reuseDecision !== null) return reuseDecision;
    }
    if (this.dreamFocus && this.isDreamCursed(self)) {
      const sell = this.buildDreamSell(game, self, usable);
      if (sell !== null && this.rng.chance(0.8)) return sell;
    }
    if (this.dangerFocus) {
      const mortarHolder = game.players.some(player => !player.dead && player.items.some(slot => slot.modelId === MODEL_IDS.dangerousMortar));
      const pestle = usable.find(info => info.model.id === MODEL_IDS.dangerousPestle && !this.blockedModels.has(info.model.id));
      if (pestle && mortarHolder) {
        const target = this.chooseTarget(pestle.model, self, game) ?? game.players.find(player => !player.dead && player.id !== self.id)?.id;
        return {
          phase: 'attack',
          kind: 'danger',
          command: this.engine.createCommandPayload({itemIds: [pestle.slotIndex], targetPlayerId: target}),
          selected: serializeSelection([pestle]),
          summary: {
            danger: true,
            damage: pestle.model.attack,
            targetName: game.players.find(player => player.id === target)?.name ?? null,
          },
          seedModelId: pestle.model.id,
          reason: 'dangerFocus uses Dangerous Pestle immediately; any Dangerous Mortar holder should attract the 99 damage',
        };
      }
    }
    if (this.guardianFocus) {
      const summon = usable.find(info =>
        info.model.ability === 'setGuardian' && this.canUseItem(info, self));
      if (summon !== undefined) {
        return {
          phase: 'attack',
          kind: 'summonGuardian',
          command: this.engine.createCommandPayload({itemIds: [summon.slotIndex]}),
          selected: serializeSelection([summon]),
          summary: {guardianSpawn: summon.model.name},
          seedModelId: summon.model.id,
          reason: 'guardianFocus uses Guardian Pot / summon miracles to spawn a random guardian',
        };
      }
      const enemies = game.players.filter(player => !player.dead && player.id !== self.id && (!this.teamAware || isEnemyPlayer(self, player)));
      const guardianTargets = enemies.filter(player => this.guardianTargets.has(player.id));
      const weapons = usable
        .filter(info => info.model.category === this.CategoryWeapons && info.model.id !== MODEL_IDS.dangerousPestle)
        .sort((left, right) => left.model.attack - right.model.attack);
      if (weapons.length !== 0) {
        const weapon = weapons[0];
        const target = guardianTargets.length !== 0
          ? this.rng.pick(guardianTargets).id
          : enemies.length === 0 ? self.id : this.rng.pick(enemies).id;
        return {
          phase: 'attack',
          kind: 'guardianBait',
          command: this.engine.createCommandPayload({itemIds: [weapon.slotIndex], targetPlayerId: target}),
          selected: serializeSelection([weapon]),
          summary: {
            guardianBait: true,
            damage: weapon.model.attack,
            targetName: game.players.find(player => player.id === target)?.name ?? null,
          },
          seedModelId: weapon.model.id,
          reason: 'guardianFocus makes a weak attack so the target guardian gets a chance to act',
        };
      }
    }
    if (this.prayerMode) {
      const hasWeapon = this.hasWeapon(self);
      const urgentHeal = this.passive && self.hp <= 25 && usable.some(info => info.model.ability === 'boostHP');
      if (!urgentHeal) {
        if (!hasWeapon) {
          return {
            phase: 'attack',
            kind: 'pray',
            command: this.engine.createCommandPayload({}),
            summary: {stall: 'prayer', prayer: true},
            reason: 'prayer stall: no weapons in hand; the empty command ends the turn, draws one gift, and advances GF',
          };
        }
        const stall = this.buildStallAction(game, self, usable);
        if (stall !== null) return stall;
      }
    }
    if (this.removalMode !== null) {
      const apocalypseComplete = game.tiebreakGF !== null && game.tiebreakGF !== undefined && game.gf >= game.tiebreakGF;
      const mode = this.removalMode === 'both'
        ? (apocalypseComplete ? 'sacrifice' : 'discard')
        : this.removalMode;
      const allowed = mode === 'discard' ? !apocalypseComplete || this.removalMode === 'discard'
        : apocalypseComplete || this.removalMode === 'sacrifice';
      const healUrgent = this.passive && self.hp <= 35 && usable.some(info => info.model.ability === 'boostHP');
      const fogged = [...self.curses].some(curse => curse.key === 'fog');
      const waitingForFog = this.removalAfterFog && !fogged;
      if (allowed && !healUrgent && !waitingForFog) {
        const removal = this.buildRemoval(game, self, usable, mode);
        if (removal !== null) return removal;
        const stall = this.buildStallAction(game, self, usable);
        if (stall !== null) return stall;
      }
    }
    let seeds = usable.filter(info => info.model.isItemTargetingCommand()
      && !this.blockedModels.has(info.model.id)
      && !this.suppressedByDream(info, self)
      && !this.defenseFocus.has(info.model.id)
      && !(this.dreamFocus && info.model.ability === 'exchange'));
    if (this.miracleAttack) {
      seeds = seeds.filter(info => info.model.category === this.CategoryMiracles
        && (info.model.attack > 0
          || info.model.ability === 'addCurse'
          || info.model.ability === 'addCurseOnDamage'
          || info.model.ability === 'absorbHP'));
    }
    if (this.plainWeaponAttack) {
      seeds = seeds.filter(info => info.model.category === this.CategoryWeapons
        && info.model.element === null
        && info.model.attack > 0);
    }
    if (this.sameElementPlus) {
      seeds = seeds.filter(info => info.model.category === this.CategoryWeapons
        && info.model.element !== null);
    }
    const hasAoe = this.aoeFocus && usable.some(info => info.model.ability === 'attackEveryEnemy');
    const allSeeds = seeds;
    if (this.passive && !hasAoe) {
      const heals = seeds.filter(info => info.model.ability === 'boostHP');
      const dreamSeeds = seeds.filter(info => this.dreamPriority(info, self));
      if (self.hp <= 35 && heals.length !== 0) seeds = [...heals, ...dreamSeeds];
      else {
        const cleanses = seeds.filter(info => info.model.ability === 'removeAllCurses' || info.model.ability === 'removeMildCurses');
        if (self.curses.size !== 0 && cleanses.length !== 0) seeds = [...cleanses, ...dreamSeeds];
      }
    }
    const buildFrom = seedList => {
      const built = [];
      for (const seed of seedList) {
        if (seed.model.ability === 'exchange') {
          const payload = this.exchangePayload(seed.slotIndex, self);
          built.push({seed, selection: [seed], payload, kind: 'exchange'});
          continue;
        }
        const result = this.buildAttack(seed, usable, self, game);
        if (result !== null) built.push({seed, selection: result.selected, target: result.target, kind: 'normal'});
      }
      return built;
    };
    if (this.passive && !hasAoe) {
      const safe = seeds.filter(info => !this.isDamaging(info.model) || this.dreamPriority(info, self));
      if (safe.length !== 0) seeds = safe;
      else seeds = seeds.slice().sort((left, right) => left.model.attack - right.model.attack);
    }
    let buildable = buildFrom(seeds);
    // A safe seed can still be unbuildable (for example a miracle that costs
    // more MP than we have). Fall back to the damaging seeds before giving up.
    if (buildable.length === 0 && this.passive && seeds !== allSeeds) {
      buildable = buildFrom(allSeeds.slice().sort((left, right) => left.model.attack - right.model.attack));
    }

    if (buildable.length === 0) {
      if (this.miracleAttack) {
        const stall = this.buildStallAction(game, self, usable);
        if (stall !== null) return stall;
        if (!this.hasWeapon(self)) {
          return {
            phase: 'attack',
            kind: 'pray',
            command: this.engine.createCommandPayload({}),
            reason: 'miracle-only mode: no buildable miracle and no weapon, so pray',
            candidates: 0,
          };
        }
      }
      const weapon = usable.find(info => info.model.category === this.CategoryWeapons);
      if (weapon !== undefined) {
        const target = this.passive && !this.dreamFocus ? self.id : this.chooseTarget(weapon.model, self, game);
        const models = [weapon.model];
        return {
          phase: 'attack',
          kind: 'attack',
          command: this.engine.createCommandPayload({itemIds: [weapon.slotIndex], targetPlayerId: target}),
          selected: serializeSelection([weapon]),
          summary: {
            aoe: false,
            passive: this.passive,
            damaging: true,
            damage: this.engine.calculateAttackDamage(models, 0),
            mpCost: 0,
            targetName: game.players.find(player => player.id === target)?.name ?? null,
          },
          seedModelId: weapon.model.id,
          reason: 'forced single-weapon fallback after no richer valid selection was buildable',
        };
      }
      return {
        phase: 'attack',
        kind: 'pray',
        command: this.engine.createCommandPayload({}),
        reason: 'no valid item command and no weapon in hand, matching the client pray rule',
        candidates: 0,
      };
    }

    const chosen = this.weightedPick(buildable.map(item => item.seed), self);
    const choice = buildable.find(item => item.seed === chosen);
    if (choice.kind === 'exchange') {
      return {
        phase: 'attack',
        kind: 'exchange',
        command: choice.payload.command,
        summary: choice.payload.summary,
        selected: serializeSelection(choice.selection),
        seedModelId: choice.seed.model.id,
        reason: 'exchange transfers stats through the real training transfer rule',
      };
    }

    const models = selectionModels(choice.selection);
    const damaging = models.some(model => this.isDamaging(model));
    const isAoe = models.some(model => model.ability === 'attackEveryEnemy');
    const targetId = this.passive && !this.dreamFocus && damaging && !isAoe ? self.id : choice.target;
    const targetPlayer = targetId === undefined ? null : game.players.find(player => player.id === targetId) ?? null;
    const summary = {
      aoe: isAoe,
      passive: this.passive,
      damaging,
      hitRate: models[0]?.hitRate ?? 0,
      damage: this.engine.calculateAttackDamage(models, 0),
      mpCost: this.engine.calculateMpCost(models),
      element: this.engine.getAttackElement(models)?.key ?? null,
      sharedElement: this.engine.getSharedElement(models)?.key ?? null,
      targetName: targetPlayer?.name ?? null,
      targetHp: targetPlayer?.hp ?? null,
      selfHp: self.hp,
      selfMp: self.mp,
    };
    return {
      phase: 'attack',
      kind: 'attack',
      command: this.engine.createCommandPayload({
        itemIds: choice.selection.map(info => info.slotIndex),
        targetPlayerId: targetId,
      }),
      selected: serializeSelection(choice.selection),
      summary,
      seedModelId: choice.seed.model.id,
      reason: 'valid selection produced by engine.canApplyCommand and engine.validateItemAction',
    };
  }

  /** Builds a defense selection against an incoming attack. */
  decideDefense(game, self, attackOverride = null) {
    const attack = attackOverride ?? game.attack;
    if (attack === null || attack === undefined) return null;
    const attackModels = resolvedAttackModels(attack, this.catalog);
    const first = attackModels[0] ?? null;
    if (first !== null && first.ability === 'buy') {
      if (attack.playerId === self.id) return null;

      // The target of Buy gets the ordinary defense prompt. Submitting no items
      // is the client's forgive path; the buyer then confirms the purchase.
      const mode = this.respondToIncomingBuy ? 'bought' : this.incomingBuyMode;
      if (mode === 'bought') {
        return {
          phase: 'defense',
          kind: 'buyResponse',
          command: this.engine.createCommandPayload({bought: this.rng.chance(0.5)}),
          attack: {
            playerId: attack.playerId,
            targetPlayerId: attack.targetPlayerId,
            items: attackModels.map(model => ({modelId: model.id, name: model.name, commandType: model.ability})),
          },
          reason: 'experimental bought field response to an incoming Buy command',
        };
      }
      if (mode === 'item') {
        const slots = usableSlots(self, this.catalog);
        const chosen = this.rng.shuffle(slots).slice(0, 1 + this.rng.int(2));
        return {
          phase: 'defense',
          kind: 'buyOfferItem',
          command: this.engine.createCommandPayload({itemIds: chosen.map(info => info.slotIndex)}),
          selected: serializeSelection(chosen),
          attack: {
            playerId: attack.playerId,
            targetPlayerId: attack.targetPlayerId,
            items: attackModels.map(model => ({modelId: model.id, name: model.name, commandType: model.ability})),
          },
          reason: 'experimental item selection offered to an incoming Buy command',
        };
      }
      return {
        phase: 'defense',
        kind: 'forgive',
        command: this.engine.createCommandPayload({}),
        attack: {
          playerId: attack.playerId,
          targetPlayerId: attack.targetPlayerId,
          items: attackModels.map(model => ({modelId: model.id, name: model.name, commandType: model.ability})),
        },
        reason: 'incoming Buy uses the ordinary empty defense command before the buyer confirms',
      };
    }

    const usable = usableSlots(self, this.catalog);
    const incomingAttack = {
      items: attackModels,
      hasAttackValue: this.engine.hasAttackValue(attackModels, attack.atk ?? 0),
    };
    const context = {
      mode: 'defense',
      hasFlashCurse: [...self.curses].some(curse => curse === this.CurseFlash),
      incomingAttack,
    };
    if (this.forceForgive) {
      this.forceForgive = false;
      return {
        phase: 'defense',
        kind: 'forgive',
        command: this.engine.createCommandPayload({}),
        attack: {
          playerId: attack.playerId,
          targetPlayerId: attack.targetPlayerId,
          items: attackModels.map(model => ({modelId: model.id, name: model.name, commandType: model.ability})),
        },
        reason: 'previous defense command was rejected; the client empty defense is the safe fallback',
      };
    }
    const selected = [];
    const desperate = this.passive || self.hp <= 20;
    let compatible = this.rng.shuffle(usable).filter(info => this.engine.canApplyCommand(selectionModels(selected), info.model, context));
    if (desperate) compatible = compatible.slice().sort((left, right) => right.model.defense - left.model.defense);
    if (this.defenseFocus.size !== 0) {
      const defenseRank = info => {
        if (info.model.id === MODEL_IDS.rainbowCurtain) return 3;
        if (this.defenseFocus.has(info.model.id)) return 2;
        return info.model.defense > 0 ? 1 : 0;
      };
      compatible = compatible.slice().sort((left, right) => defenseRank(right) - defenseRank(left));
    }
    if (this.dreamFocus) {
      compatible = compatible
        .filter(info => !this.suppressedByDream(info, self))
        .sort((left, right) => this.defenseDreamRank(right, self) - this.defenseDreamRank(left, self));
    }
    if (this.earthTradeFocus) {
      const earthOwnerIds = new Set(game.players
        .filter(player => player.guardian?.key === 'earth')
        .map(player => player.id));
      if (earthOwnerIds.has(attack.playerId)) {
        compatible = compatible.filter(info => !HARMFUL_TO_EARTH_DEFENSES.has(info.model.ability));
      }
    }
    const limit = this.dreamFocus || desperate || this.defenseFocus.size !== 0 ? 3 : 1 + this.rng.int(3);
    for (const info of compatible) {
      if (selected.length >= limit) break;
      if (!this.engine.canApplyCommand(selectionModels(selected), info.model, context)) continue;
      const cost = this.engine.calculateMpCost(selectionModels([...selected, info]));
      if (cost > self.mp) continue;
      const dreamy = this.dreamFocus && this.defenseDreamRank(info, self) > 0;
      const focusedDefense = this.defenseFocus.has(info.model.id) || info.model.id === MODEL_IDS.rainbowCurtain;
      if (this.rng.chance(dreamy || focusedDefense ? 0.99 : desperate ? 0.95 : 0.7)) selected.push(info);
    }

    if (selected.length === 0 || (!this.dreamFocus && !this.passive && !desperate && this.rng.chance(0.12))) {
      return {
        phase: 'defense',
        kind: 'forgive',
        command: this.engine.createCommandPayload({}),
        attack: {
          playerId: attack.playerId,
          targetPlayerId: attack.targetPlayerId,
          items: attackModels.map(model => ({modelId: model.id, name: model.name, commandType: model.ability})),
        },
        reason: selected.length === 0
          ? 'no engine-valid defense item; the client sends an empty defense command (forgive)'
          : 'randomly forgiving to observe damage and curse effects',
      };
    }

    const models = selectionModels(selected);
    return {
      phase: 'defense',
      kind: 'defense',
      command: this.engine.createCommandPayload({itemIds: selected.map(info => info.slotIndex)}),
      selected: serializeSelection(selected),
      summary: {
        defense: models.reduce((sum, model) => sum + model.defense, 0),
        mpCost: this.engine.calculateMpCost(models),
        sharedElement: this.engine.getSharedElement(models)?.key ?? null,
        selfHp: self.hp,
        selfMp: self.mp,
      },
      attack: {
        playerId: attack.playerId,
        targetPlayerId: attack.targetPlayerId,
        items: attackModels.map(model => ({modelId: model.id, name: model.name, commandType: model.ability})),
      },
      reason: 'valid defense produced by engine defense-mode canApplyCommand',
    };
  }

  noteDecision(decision) {
    this.commandCount++;
    for (const selected of decision.selected ?? []) this.seenThisGame.add(selected.modelId);
  }
}

export {serializeSelection, usableSlots, modelLabel, toPlain};
