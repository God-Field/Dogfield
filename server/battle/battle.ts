import type {
  Stat,
  Player,
  Slot,
  Game,
  Command,
  Attack,
  GameEvent,
  StartUser,
  DyingAttack,
} from '../types.ts';
import type { ItemDefinition } from '../../src/domain/models.ts';
import { engine, itemCatalog } from '../engine.ts';
import { Random } from '../random.ts';
import { requireValue } from '../errors.ts';
import * as botAI from './bots.ts';
import * as itemEffects from './item-effects.ts';
import * as inventory from './inventory.ts';
import * as trade from './trade.ts';
import * as guardians from './guardians.ts';
import * as defenseEffects from './defense.ts';
import {
  areEnemies,
  createAttackQueue,
  selectDirectAttackTarget,
} from './targets.ts';
import {
  clearItemDisguise,
  getOccupiedItemSlots,
  getSortedOccupiedItemSlots,
  isPlaceholderSlot,
  renumberOccupiedItemSlots,
} from './inventory.ts';
import { pruneWireFields } from './wire.ts';

const cloneState = structuredClone;
const diseaseCurses = ['cold', 'fever', 'hell', 'heaven'];

const GUARDIAN_LEAVE_PERCENT = 10;
const GUARDIAN_ACTION_PERCENT = 25;
const DISEASE_WORSEN_PERCENT = 5;
const DOUBLE_ATTACK_FACTOR = 2;
const HEAVEN_HEAL_AMOUNT = 5;
const DISEASE_DAMAGE: Record<string, number> = {
  cold: 1,
  fever: 2,
  hell: 5,
};

export class Battle {

  private playedThisSubmit = new Set<number>();

  constructor(
    readonly game: Game,
    readonly random = new Random(),
  ) {
    for (const player of game.players) {
      player.items ??= [];
    }
    const hasOfficialScheduler = game.guardianPlayerIds !== undefined ||
      this.attack !== undefined;
    const hasCompletedOfficialDiseaseTick = !game.serverTurn &&
      game.diseasePlayerId === undefined && hasOfficialScheduler;
    if (hasCompletedOfficialDiseaseTick) {
      game.serverTurn = { diseaseDone: true };
      if (game.guardianPlayerIds === undefined) {
        game.serverTurn.guardians = game.players.map((player) => player.id);
      }
    }
  }

  get alive() {
    return this.game.players.filter((player) => !player.dead);
  }

  get catalog() {
    return itemCatalog;
  }

  getItemDefinition(modelId: number): ItemDefinition {
    const definition = this.catalog.findById(modelId);
    if (!definition) {
      throw new Error(`Unknown item model: ${modelId}`);
    }
    return definition;
  }

  getSlotDefinition(itemSlot: Slot): ItemDefinition {
    return this.getItemDefinition(itemSlot.fakeModelId || itemSlot.modelId);
  }

  private getCatalogItem(
    description: string,
    predicate: (definition: ItemDefinition) => boolean,
  ): ItemDefinition {
    const definition = this.catalog.find(predicate);
    if (!definition) {
      throw new Error(`Missing catalog item: ${description}`);
    }
    return definition;
  }

  commandSelectionContext(
    player: Player,
    mode: 'normal' | 'defense',
    incomingDefinitions: readonly ItemDefinition[],
  ): engine.CommandSelectionContext {
    return {
      mode,
      hasFlashCurse: player.curses?.includes('flash') ?? false,
      incomingAttack: {
        items: incomingDefinitions,
        hasAttackValue: engine.hasAttackValue(
          incomingDefinitions,
          this.attack?.atk ?? 0,
        ),
      },
    };
  }

  findPlayer(playerId: number | undefined): Player | undefined {
    return this.game.players.find((player) => player.id === playerId);
  }

  requirePlayer(playerId: number | undefined): Player {
    const player = this.findPlayer(playerId);
    requireValue(player);
    return player;
  }

  pruneEmptyWireFields(
    emptyItemPlayerIds: ReadonlySet<number> = new Set(),
  ): void {
    for (const event of this.game.events) {
      pruneWireFields(event, new Set(['action']));
    }
    for (const attack of this.game.attacks ?? []) {
      delete (attack as { serverTurn?: unknown }).serverTurn;
      pruneWireFields(
        attack as unknown as Record<string, unknown>,
        new Set(),
      );
    }
    for (const player of this.game.players) {
      if (!player.isBot) {
        delete player.isBot;
      }
      pruneWireFields(
        player as unknown as Record<string, unknown>,
        new Set(['id', 'hp', 'mp', 'cp', 'items']),
      );
      if (
        emptyItemPlayerIds.has(player.id)
        && Array.isArray(player.items)
        && player.items.length === 0
      ) {
        (player as unknown as { items: Slot[] | null }).items = null;
      }
    }
  }

  emit(action: string, fields: Omit<GameEvent, 'action'> = {}) {
    const event: GameEvent = {
      action,
      ...cloneState(fields),
    };
    pruneWireFields(event, new Set(['action']));
    this.game.events.push(event);
  }

  pickFromPool<Value>(
    label: string,
    values: readonly Value[],
    weight: (value: Value) => number = () => 1,
  ): Value | null {
    return values.length === 0
      ? null
      : this.random.pick(label, values, weight);
  }

  get attack() {
    return this.game.attacks?.[0];
  }

  get currentAttack(): Attack {
    const attack = this.attack;
    requireValue(attack);
    return attack;
  }

  get apocalypse() {
    return this.game.tiebreakGF != null && this.game.gf >= this.game.tiebreakGF;
  }

  get battleEngine() {
    const decodedGame = engine.decodeJson(this.game);
    const gameFields = engine.asMap(decodedGame);
    const gameState = engine.decodeGameState(gameFields);
    return engine.BattleEngine.fromGameState(gameState, this.catalog);
  }

  get expectedCommandPlayerId(): number | undefined {
    const pendingAttack = this.attack;
    if (!pendingAttack) {
      return this.game.attackTurnPlayerId;
    }
    if (pendingAttack.buyingItemModelId) {
      return pendingAttack.playerId;
    }
    return pendingAttack.targetPlayerId;
  }

  applyStatChange(player: Player, field: Stat, amount: number) {
    if (field === 'hp') {
      Object.assign(player, engine.changeHp(player.hp, amount));
    }
    if (field === 'mp') {
      Object.assign(player, engine.changeMp(player.hp, player.mp, amount));
    }
    if (field === 'cp') {
      Object.assign(
        player,
        engine.changeCp(player.hp, player.mp, player.cp, amount),
      );
    }
  }

  applyStatBoost(
    player: Player,
    field: Stat,
    amount: number,
    includePlayerId = false,
  ): void {
    this.emit(
      {
        hp: 'boostHP',
        mp: 'boostMP',
        cp: 'boostCP',
      }[field],
      {
        [field]: amount,
        ...(includePlayerId
          ? {
              playerId: player.id,
            }
          : {}),
      },
    );
    this.applyStatChange(player, field, amount);
  }

  takeSlots(player: Player, selectedSlots: Slot[], removePermanently = false): void {
    inventory.takeSlots(this, player, selectedSlots, removePermanently);
  }

  addSlot(
    player: Player,
    modelId: number,
    fillPlaceholder = true,
  ): inventory.ItemAcquisition {
    return inventory.addSlot(
      this,
      player,
      modelId,
      fillPlaceholder,
    );
  }

  applyDreamDisguise(player: Player, item: Slot): void {
    inventory.applyDreamDisguise(this, player, item);
  }

  addPlaceholderSlot(player: Player): boolean {
    return inventory.addPlaceholderSlot(player);
  }

  drawGift(player: Player, allowDevil = true): inventory.GiftDraw | null {
    return inventory.drawGift(this, player, allowDevil);
  }

  deliverGift(player: Player, gift: inventory.GiftDraw): void {
    inventory.deliverGift(this, player, gift);
  }

  resolveGift(player: Player, allowDevil = true): void {
    inventory.resolveGift(this, player, allowDevil);
  }

  applyDamage(
    player: Player,
    amount: number,
    includePlayerId = false,
    deferGuardianLeave = false,
  ) {
    this.emit('dealDamage', {
      damage: amount,
      ...(includePlayerId
        ? {
            playerId: player.id,
          }
        : {}),
    });
    this.applyStatChange(player, 'hp', -amount);
    if (!deferGuardianLeave) {
      this.checkGuardianLeave(player);
    }
  }

  checkGuardianLeave(player: Player) {
    if (
      player.guardian &&
      this.random.chance('guardianLeave', GUARDIAN_LEAVE_PERCENT)
    ) {
      this.emit('removeGuardian', {
        playerId: player.id,
      });
      delete player.guardian;
    }
  }

  applyCurse(player: Player, curse: string | undefined) {
    if (!curse) {
      return;
    }
    player.curses ??= [];
    if (diseaseCurses.includes(curse)) {
      player.curses = player.curses.filter(
        (curseName) => !diseaseCurses.includes(curseName),
      );
    }
    if (!player.curses.includes(curse)) {
      player.curses.push(curse);
    }
  }

  applyDisease(player: Player, incomingCurse: string | null, natural = false) {
    const existingDisease = player.curses?.find((curseName) =>
      diseaseCurses.includes(curseName),
    );
    if (!existingDisease) {
      if (incomingCurse === null) {
        return null;
      }
      this.emit('addCurse', {
        curse: incomingCurse,
      });
      player.curses ??= [];
      player.curses.push(incomingCurse);
      return incomingCurse;
    }
    const existingLevel = diseaseCurses.indexOf(existingDisease);
    const incomingLevel =
      incomingCurse === null
        ? existingLevel
        : diseaseCurses.indexOf(incomingCurse);
    const nextLevel =
      incomingLevel > existingLevel ? incomingLevel : existingLevel + 1;
    if (nextLevel >= diseaseCurses.length) {
      this.emit('upgradeHeaven', {
        playerId: player.id,
        ...(natural
          ? {
              natural: true,
            }
          : {}),
      });
      this.applyDamage(player, player.hp, true);
      return null;
    }
    const nextCurse = diseaseCurses[nextLevel];
    if (incomingLevel > existingLevel) {
      this.emit('addCurse', {
        curse: nextCurse,
      });
    } else {
      this.emit('upgradeDisease', {
        playerId: player.id,
        curse: nextCurse,
        ...(natural
          ? {
              natural: true,
            }
          : {}),
      });
    }
    player.curses = player.curses!.filter(
      (curseName) => !diseaseCurses.includes(curseName),
    );
    player.curses.push(nextCurse);
    return nextCurse;
  }

  addCurse(player: Player, curse: string | undefined, reportDuplicate = false) {
    if (!curse) {
      return;
    }
    if (diseaseCurses.includes(curse)) {
      this.applyDisease(player, curse, false);
      return;
    }
    if (!player.curses?.includes(curse)) {
      this.emit('addCurse', {
        curse,
      });
      player.curses ??= [];
      player.curses.push(curse);
    } else if (reportDuplicate) {
      this.emit('safe');
    }
  }

  applySelfCurse(player: Player, curse: string | undefined) {
    this.addCurse(player, curse);
  }

  removeCurses(player: Player, removeAll: boolean) {
    const removedCurses = (player.curses ?? [])
      .filter(
        (curseName) =>
          removeAll || engine.isMildCurse(curseName),
      )
      .sort(
        (firstCurse, secondCurse) =>
          engine.allCurses.findIndex(
            (curse) => curse.key === firstCurse,
          ) -
          engine.allCurses.findIndex(
            (curse) => curse.key === secondCurse,
          ),
      );
    this.emit(
      removedCurses.length ? 'removeCurses' : 'safe',
      removedCurses.length
        ? {
            curses: removedCurses,
          }
        : {},
    );
    player.curses = (player.curses ?? []).filter(
      (curseName) => !removedCurses.includes(curseName),
    );
    if (removedCurses.includes('dream')) {
      for (const itemSlot of player.items) {
        clearItemDisguise(itemSlot);
      }
    }
  }

  getDyingAttackItems(player: Player): Slot[] {
    return getOccupiedItemSlots(player).filter(
      (itemSlot) =>
        this.getItemDefinition(itemSlot.modelId).ability === 'attackDyingly',
    );
  }

  enqueueDyingAttack(player: Player): void {
    const items = this.getDyingAttackItems(player);
    if (items.length === 0) {
      return;
    }
    const turnProgress = (this.game.serverTurn ??= {});
    turnProgress.dyingAttacks ??= [];
    for (const item of items) {
      const isAlreadyQueued = turnProgress.dyingAttacks.some(
        (dyingAttack: DyingAttack) =>
          dyingAttack.playerId === player.id &&
          dyingAttack.itemId === item.id,
      );
      if (isAlreadyQueued) {
        continue;
      }
      turnProgress.dyingAttacks.push({
        playerId: player.id,
        itemId: item.id,
        modelId: item.modelId,
      });
    }
  }

  resolveDeaths(allowGameEnd = true) {
    const target = this.findPlayer(this.attack?.targetPlayerId);
    const deathOrder = target && !target.dead
      ? [target, ...this.alive.filter((player) => player !== target)]
      : this.alive;
    for (const player of deathOrder) {
      if (player.hp <= 0) {
        const amulets = getOccupiedItemSlots(player).filter(
          (itemSlot) =>
            this.getItemDefinition(itemSlot.modelId).ability === 'revive',
        );
        if (amulets.length > 0) {
          const amulet = amulets.length === 1
            ? amulets[0]
            : this.random.pick('reviveItem', amulets);
          this.emit('revive', {
            playerId: player.id,
            item: amulet,
          });
          this.takeSlots(player, [amulet]);
          this.applyStatBoost(player, 'hp', this.getItemDefinition(amulet.modelId).abilityValue, true);
        } else {
          player.dead = true;
          if ((player.confusionCount ?? 0) > 0) {
            const pendingAttack = this.game.attacks?.[0];
            const diedOutsideAttack = pendingAttack === undefined
              || pendingAttack.targetPlayerId === undefined;
            player.confusionCount = this.playedThisSubmit.has(player.id)
              && diedOutsideAttack
              ? -1
              : 0;
          }
          this.emit('die', {
            playerId: player.id,
          });
          this.enqueueDyingAttack(player);
          const turnProgress = (this.game.serverTurn ??= {});
          turnProgress.turnDeaths ??= [];
          turnProgress.turnDeaths.push(player.id);
          if ((this.game.attacks?.length ?? 0) >= 1) {
            this.game.dyingPlayerIds ??= [];
            if (!this.game.dyingPlayerIds.includes(player.id)) {
              this.game.dyingPlayerIds.push(player.id);
            }
          }
        }
      }
    }
    if (
      allowGameEnd &&
      !this.game.dyingPlayerIds?.length &&
      !this.game.serverTurn?.dyingAttacks?.length &&
      this.hasWinningSide()
    ) {
      delete this.game.attacks;
      this.game.isOver = true;
      delete this.game.guardianPlayerIds;
      delete this.game.diseasePlayerId;
      delete this.game.dyingPlayerIds;
      for (const player of this.game.players) {

        const diedThisSubmit = this.game.serverTurn?.turnDeaths?.includes(player.id);
        if ((player.confusionCount ?? 0) < 0 && !diedThisSubmit) {
          delete player.confusionCount;
        }
      }
      this.emit('endGame');
      return true;
    }
    return false;
  }

  hasWinningSide(): boolean {
    const survivingPlayers = this.alive;
    const remainingTeam = survivingPlayers[0]?.team;
    const hasOneTeam = Boolean(remainingTeam) && survivingPlayers.every(
      (player) => player.team === remainingTeam,
    );
    return survivingPlayers.length <= 1 || hasOneTeam;
  }

  selectCommandItems(player: Player, command: Command, defense: boolean) {
    const selectedItemIds = command.itemIds ?? [];
    requireValue(
      Array.isArray(selectedItemIds) &&
        selectedItemIds.every(Number.isInteger) &&
        new Set(selectedItemIds).size === selectedItemIds.length,
    );
    let virtualModelId = 0;
    const usesVirtualSlot = selectedItemIds.includes(0) && !defense;
    if (usesVirtualSlot) {
      virtualModelId = this.apocalypse
        ? this.getCatalogItem(
            'sacrifice card',
            (itemDefinition) => itemDefinition.ability === 'sacrifice',
          ).id
        : this.getCatalogItem(
            'discard card',
            (itemDefinition) => itemDefinition.ability === 'discard',
          ).id;
    }
    const selectedSlots = selectedItemIds.map((itemId) =>
      itemId === 0 && !defense
        ? {
            id: 0,
            modelId: virtualModelId,
          }
        : player.items.find(
            (itemSlot) => itemSlot.id === itemId && itemSlot.modelId > 0,
          ),
    );
    requireValue(selectedSlots.every((slot): slot is Slot => !!slot));
    const itemDefinitions = selectedSlots.map((itemSlot) =>
      this.getSlotDefinition(itemSlot),
    );
    if (
      !defense &&
      itemDefinitions[0]?.ability === 'sell' &&
      selectedSlots.length > 1
    ) {
      requireValue(selectedSlots[1]!.used !== true);
    }
    const incomingDefinitions =
      this.attack === undefined
        ? []
        : this.attackDefinitions(this.attack);
    const context = this.commandSelectionContext(
      player,
      defense ? 'defense' : 'normal',
      incomingDefinitions,
    );
    const selectedDefinitions: ItemDefinition[] = [];
    for (const definition of itemDefinitions) {
      requireValue(
        engine.canApplyCommand(selectedDefinitions, definition, context),
      );
      selectedDefinitions.push(definition);
    }
    requireValue(
      engine.validateItemAction({
        models: itemDefinitions,
        availableMp: player.mp,
        mode: context.mode,
        hasSpecialItemCommand:
          !defense &&
          getOccupiedItemSlots(player).some(
            (itemSlot) =>
              this.getSlotDefinition(itemSlot).category ===
              engine.CategoryWeapons,
          ),
      }) === null,
    );
    requireValue(!('bought' in command) || defense);
    return {
      slots: cloneState(selectedSlots),
      definitions: selectedSlots.map((itemSlot) =>
        this.getItemDefinition(itemSlot.modelId),
      ),
      mpCost: engine.calculateMpCost(itemDefinitions),
    };
  }

  stepBots(maxSteps = 10_000): void {
    let stepCount = 0;
    while (!this.game.isOver && stepCount < maxSteps) {
      let botChoice;
      try {
        botChoice = this.botCommand();
      } catch {
        break;
      }
      if (!botChoice) {
        break;
      }
      const isConfusedAttackTurn =
        (botChoice.player.confusionCount ?? 0) > 0 && !this.attack;
      const isAutoPlayableSeat = botChoice.player.isBot || isConfusedAttackTurn;
      if (!isAutoPlayableSeat) {
        break;
      }
      for (const dyingPlayerId of this.game.dyingPlayerIds ?? []) {
        const dyingPlayer = this.findPlayer(dyingPlayerId);
        if (dyingPlayer) {
          this.enqueueDyingAttack(dyingPlayer);
        }
      }
      const player = botChoice.player;
      const command = botChoice.command;
      const pendingAttack = this.attack;
      try {
        this.applyCommand(player, command, pendingAttack);
      } catch {
        break;
      }
      stepCount++;
    }
  }

  submit(userId: string, input: unknown, stepBots = false) {
    const player = this.requirePlayer(this.expectedCommandPlayerId);
    requireValue(typeof userId === 'string' && player.userId === userId);
    return this.submitPlayerCommand(player.id, input, stepBots);
  }

  submitPlayerCommand(playerId: number, input: unknown, stepBots = false) {
    const command = input as Command;
    requireValue(
      !this.game.isOver &&
        command &&
        typeof command === 'object' &&
        !Array.isArray(command),
    );
    const pendingAttack = this.attack;
    const player = this.requirePlayer(this.expectedCommandPlayerId);
    requireValue(!player.dead && player.id === playerId);
    this.game.events = [];
    this.playedThisSubmit.clear();
    const emptyHandsAtSubmitStart = new Set<number>();
    for (const gamePlayer of this.game.players) {
      const wireItems = (
        gamePlayer as unknown as { items: Slot[] | null | undefined }
      ).items;
      if (
        wireItems === null
        || wireItems === undefined
        || wireItems.length === 0
      ) {
        emptyHandsAtSubmitStart.add(gamePlayer.id);
      }
      gamePlayer.items ??= [];
    }
    const turnProgress = (this.game.serverTurn ??= {});
    turnProgress.turnDeaths = [];
    for (const dyingPlayerId of this.game.dyingPlayerIds ?? []) {
      const dyingPlayer = this.findPlayer(dyingPlayerId);
      if (dyingPlayer) {
        this.enqueueDyingAttack(dyingPlayer);
      }
    }
    this.applyCommand(player, command, pendingAttack);
    if (stepBots) {
      this.stepBots();
    }
    this.game.updateCount++;
    this.game.updatedAt = new Date().toISOString();
    for (const player of this.game.players) {
      if (!player.dead && (player.confusionCount ?? 0) < 0) {
        player.confusionCount = 0;
      }
    }
    this.pruneEmptyWireFields(emptyHandsAtSubmitStart);
    return this.game;
  }

  private applyCommand(
    player: Player,
    command: Command,
    pendingAttack: Attack | undefined,
  ): void {
    if (pendingAttack?.buyingItemModelId) {
      this.confirmPurchase(player, command);
    } else if (pendingAttack) {
      this.resolveDefenseCommand(player, command);
    } else {
      this.resolvePlayCommand(player, command);
    }
  }

  private validatePlayCommand(
    player: Player,
    command: Command,
    itemDefinitions: readonly ItemDefinition[],
  ): void {
    const firstDefinition = itemDefinitions[0];
    const ability = firstDefinition?.ability;
    if (
      firstDefinition?.isDirectTargetCommand() &&
      !itemDefinitions.some(
        (itemDefinition) => itemDefinition.ability === 'attackEveryEnemy',
      )
    ) {
      requireValue(
        command.targetPlayerId === undefined ||
          (Number.isInteger(command.targetPlayerId) &&
            this.findPlayer(command.targetPlayerId) &&
            !this.requirePlayer(command.targetPlayerId).dead),
      );
    }
    if (ability === 'exchange') {
      requireValue(
        typeof command.mp === 'number' &&
          typeof command.cp === 'number' &&
          Number.isInteger(command.mp) &&
          Number.isInteger(command.cp) &&
          command.mp >= 0 &&
          command.mp <= engine.MAX_STAT &&
          command.cp >= 0 &&
          command.cp <= engine.MAX_STAT,
      );
      const remainingHealth =
        player.hp + player.mp + player.cp - command.mp - command.cp;
      requireValue(
        remainingHealth >= 0 && remainingHealth <= engine.MAX_STAT,
      );
    }
  }

  resolvePlayCommand(player: Player, command: Command): void {
    this.playedThisSubmit.add(player.id);
    const {
      slots: selectedSlots,
      definitions: itemDefinitions,
      mpCost: magicPointCost,
    } = this.selectCommandItems(player, command, false);
    const firstDefinition = itemDefinitions[0];
    const ability = firstDefinition?.ability;

    this.validatePlayCommand(player, command, itemDefinitions);
    this.emit(
      'useAttackItems',
      selectedSlots.length
        ? {
            items: selectedSlots,
          }
        : {},
    );
    this.applyStatChange(player, 'mp', -magicPointCost);
    if ((player.confusionCount ?? 0) > 0) {
      player.confusionCount!--;
    }
    if (!firstDefinition) {
      this.resolvePrayer(player);
      return;
    }
    this.takeSlots(
      player,
      selectedSlots,
      ['discard', 'sacrifice', 'sell'].includes(ability),
    );
    if (ability === 'discard' || ability === 'sacrifice') {
      this.emit(ability);
      if (ability === 'sacrifice') {
        for (let index = 1; index < selectedSlots.length; index++) {
          this.addPlaceholderSlot(player);
        }
      }
      this.finishTurn({
        gift: ability === 'sacrifice',
      });
      return;
    }
    if (ability === 'sell') {
      const turnProgress = (this.game.serverTurn ??= {});
      turnProgress.sellingItemId = selectedSlots[1]?.id;
      this.addPlaceholderSlot(player);
    }
    const attack: Attack = {
      playerId: player.id,
      itemModelIds: itemDefinitions.map((itemDefinition) => itemDefinition.id),
    };
    if (ability === 'exchange') {
      attack.mp = command.mp;
      attack.cp = command.cp;
    }
    if (this.resolveItemAttack(player, attack, itemDefinitions, command)) {
      return;
    }
    if (this.applyItemEffect(player, player, firstDefinition, attack)) {
      return;
    }
    delete this.game.attacks;
    this.finishTurn();
  }

  private convertMPToAttack(
    player: Player,
    attack: Attack,
    definition: ItemDefinition,
  ): boolean {
    if (definition.ability !== 'atkBy2xMP') {
      return false;
    }
    const attackValue = DOUBLE_ATTACK_FACTOR * player.mp;
    if (attackValue !== 0) {
      attack.atk = attackValue;
    }
    player.mp = 0;

    return true;
  }

  private resolvePrayer(player: Player): void {
    const hasPlaceholder = player.items.some(isPlaceholderSlot);
    const hasRoom = player.items.length < engine.MAX_ITEM_SLOTS;
    let overflowItem: Slot | undefined;
    if (!hasPlaceholder && !hasRoom) {
      overflowItem = this.random.pick('overflowItem', getOccupiedItemSlots(player));
      this.takeSlots(player, [overflowItem], true);
    }
    this.addPlaceholderSlot(player);
    this.emit('pray', overflowItem ? { overflowItem } : {});
    this.finishTurn();
  }

  private resolveItemAttack(
    player: Player,
    attack: Attack,
    itemDefinitions: readonly ItemDefinition[],
    command: Command = {},
  ): boolean {
    const firstDefinition = itemDefinitions[0];
    if (!firstDefinition) {
      return false;
    }
    const convertsMPToAttack = this.convertMPToAttack(
      player,
      attack,
      firstDefinition,
    );
    const ability = firstDefinition.ability;
    const guardian = attack.guardian !== undefined;
    if (ability === 'callPhenomenon') {
      return false;
    }
    const everyEnemyCount = itemDefinitions.filter(
      (itemDefinition) => itemDefinition.ability === 'attackEveryEnemy',
    ).length;
    const targetsEveryEnemy = everyEnemyCount > 0 || firstDefinition.hitRate > 0;
    const isDanger = ability === 'danger';
    const hasRedundantCurseRemovalTarget =
      command.targetPlayerId === player.id &&
      (ability === 'removeMildCurses' || ability === 'removeAllCurses');
    const hasExplicitTarget = command.targetPlayerId !== undefined &&
      !hasRedundantCurseRemovalTarget;
    const needsDirectTarget = firstDefinition.isDirectTargetCommand(guardian)
      || convertsMPToAttack
      || (!guardian && (ability === 'boostMPAndAddCurse' || hasExplicitTarget));
    const needsSingleTarget = ability !== 'exchange' && (isDanger || needsDirectTarget);
    if (!targetsEveryEnemy && !needsSingleTarget) {
      return false;
    }
    let targets: Player[];
    if (isDanger && !targetsEveryEnemy) {
      // Danger chooses its recipient when each strike resolves.
      targets = [player];
    } else if (targetsEveryEnemy || guardian) {
      targets = this.alive.filter((candidatePlayer) =>
        areEnemies(player, candidatePlayer),
      );
      if (targets.length === 0) {
        delete this.game.attacks;
        return false;
      }
      if (!targetsEveryEnemy) {
        targets = [this.random.pick('guardianTarget', targets)];
      }
    } else {
      targets = [selectDirectAttackTarget(
        this,
        player,
        firstDefinition,
        command.targetPlayerId,
      )];
    }
    this.game.attacks = createAttackQueue(attack, targets, this.random, {
      cycleCount: Math.max(everyEnemyCount, 1),
      strikesPerTarget: ability === 'attackTwice' ? DOUBLE_ATTACK_FACTOR : 1,
    });
    this.resolveAttackTarget();
    return true;
  }

  attackDefinitions(attack: Attack) {
    const itemDefinitions = attack.itemModelIds.map((modelId) =>
      this.getItemDefinition(modelId));
    const isPhenomenon = itemDefinitions[0]?.ability === 'callPhenomenon';
    return isPhenomenon && itemDefinitions.length > 1
      ? itemDefinitions.slice(1)
      : itemDefinitions;
  }

  turnOrderAfter(previousPlayerId: number) {
    return [
      ...this.alive.filter((player) => player.id > previousPlayerId),
      ...this.alive.filter((player) => player.id <= previousPlayerId),
    ];
  }

  resolveAttackTarget(): void {
    const attack = this.currentAttack;
    const definition = this.attackDefinitions(attack)[0];
    if (definition.ability === 'danger') {
      this.emit('danger');
      if (this.resolveDangerHolder()) {
        return;
      }
      attack.targetPlayerId = this.random.pick('dangerTarget', this.alive).id;
    }
    const player = this.requirePlayer(attack.targetPlayerId);
    const resolvesWithoutDefense =
      attack.targetPlayerId === attack.playerId || player.dead;
    if (resolvesWithoutDefense && definition.hitRate === 0) {
      this.emit('setTargetPlayer', {
        playerId: player.id,
      });
      this.resolveDefenseCommand(player, {}, false);
      return;
    }
    if ((attack.hitRate || definition.hitRate) > 0 && !attack.reversed) {
      const hit =
        player.curses?.includes('darkcloud') ||
        this.random.chance('hit', attack.hitRate || definition.hitRate);
      this.emit(hit ? 'hit' : 'miss', {
        playerId: player.id,
      });
      if (!hit) {
        this.completeAttack();
        return;
      }
    } else {
      this.emit('setTargetPlayer', {
        playerId: player.id,
      });
    }
    if (player.dead) {
      this.resolveDefenseCommand(player, {}, false);
    }
  }

  resolveDefenseCommand(player: Player, command: Command, announce = true): void {
    defenseEffects.resolveDefenseCommand(this, player, command, announce);
  }

  completeAttack(): void {
    this.resolveDeaths(false);
    this.game.attacks!.shift();
    if (this.attack) {
      const { targetPlayerId, ...nextAttack } = this.attack;
      this.emit('nextAttack', {
        attack: nextAttack,
      });
      this.resolveAttackTarget();
      return;
    }
    delete this.game.attacks;
    this.finishTurn();
  }

  offerPurchase(buyer: Player, seller: Player): void {
    trade.offerPurchase(this, buyer, seller);
  }

  confirmPurchase(buyer: Player, command: Command): void {
    trade.confirmPurchase(this, buyer, command);
  }

  resolveSale(
    seller: Player,
    buyer: Player,
    definition: ItemDefinition,
    restoredItemId?: number,
  ): void {
    trade.resolveSale(this, seller, buyer, definition, restoredItemId);
  }

  spreadStatTotal(totalStats: number) {
    requireValue(
      Number.isInteger(totalStats) &&
        totalStats >= 0 &&
        totalStats <= engine.MAX_STAT * 3,
    );

    const maximumStat = engine.MAX_STAT;
    const minimumHp = Math.max(0, totalStats - maximumStat * 2);
    const maximumHp = Math.min(maximumStat, totalStats);
    const hp =
      minimumHp +
      Math.floor(
        this.random.value('guardianExchangeHp') *
          (maximumHp - minimumHp + 1),
      );
    const minimumMp = Math.max(0, totalStats - hp - maximumStat);
    const maximumMp = Math.min(maximumStat, totalStats - hp);
    const mp =
      minimumMp +
      Math.floor(
        this.random.value('guardianExchangeMp') *
          (maximumMp - minimumMp + 1),
      );
    return {
      hp,
      mp,
      cp: totalStats - hp - mp,
    };
  }

  applyItemEffect(
    attacker: Player,
    target: Player,
    definition: ItemDefinition,
    attack: Partial<Attack> = {},
  ): boolean | void {
    return itemEffects.applyItemEffect(
      this,
      attacker,
      target,
      definition,
      attack,
    );
  }

  resolveRedraw(player: Player) {
    this.emit('redraw');
    const redrawPool = this.catalog.filter(
      (itemDefinition) => itemDefinition.giftRate > 0,
    );
    if (redrawPool.length === 0) {
      return;
    }
    const redrawnItems: Slot[] = [];
    for (const itemSlot of player.items) {
      if (isPlaceholderSlot(itemSlot)) {
        redrawnItems.push(itemSlot);
        continue;
      }
      const modelId = this.random.pick(
        'redrawItem',
        redrawPool,
        (itemDefinition) => itemDefinition.giftRate,
      ).id;
      const item: Slot = {
        id: itemSlot.id,
        modelId,
      };
      this.applyDreamDisguise(player, item);
      redrawnItems.push(item);
    }
    player.items = redrawnItems;
    renumberOccupiedItemSlots(player);
    this.emit('replaceItems', {
      playerId: player.id,
      items: getSortedOccupiedItemSlots(player),
    });
  }

  resolveCounterAttack(
    player: Player,
    attacker: Player,
    definition: ItemDefinition,
    index: number,
    damage: number,
  ) {
    this.emit('counterAttack', {
      index,
    });
    const attack: Attack = {
      playerId: player.id,
      itemModelIds: [definition.id],
      targetPlayerId: attacker.id,
    };
    if (definition.ability === 'counterAtk') {
      attack.atk = Math.max(0, damage);
    }
    if (definition.ability === 'counter2xAtk') {
      attack.atk = damage * DOUBLE_ATTACK_FACTOR;
    }
    if (definition.ability === 'counterBoost2xMP') {
      attack.mp = damage * DOUBLE_ATTACK_FACTOR;
      attack.targetPlayerId = player.id;
    }
    if (definition.ability === 'counterTakeCP') {
      attack.cp = damage;
    }
    const counterAttacks =
      definition.hitRate > 0
        ? this.random
            .shuffle(
              'targetOrder',
              this.alive.filter((candidatePlayer) =>
                areEnemies(player, candidatePlayer),
              ),
            )
            .map((candidatePlayer) => ({
              ...attack,
              targetPlayerId: candidatePlayer.id,
            }))
        : [attack];
    this.game.attacks!.push(...counterAttacks);
  }

  resolveDangerHolder(): boolean {
    const holders = this.alive.filter((candidatePlayer) =>
      getOccupiedItemSlots(candidatePlayer).some(
        (itemSlot) =>
          this.getItemDefinition(itemSlot.modelId).ability === 'attractDanger',
      ),
    );
    if (holders.length === 0) {
      return false;
    }
    const holder = holders.length === 1
      ? holders[0]
      : this.random.pick('dangerHolder', holders);
    const dangerItems = getOccupiedItemSlots(holder).filter(
      (itemSlot) =>
        this.getItemDefinition(itemSlot.modelId).ability === 'attractDanger',
    );
    const item = dangerItems.length === 1
      ? dangerItems[0]
      : this.random.pick('dangerItem', dangerItems);
    this.emit('attractDanger', {
      playerId: holder.id,
      item,
    });
    this.takeSlots(holder, [item], false);
    this.applyDamage(
      holder,
      this.getItemDefinition(item.modelId).abilityValue,
      false,
    );
    this.completeAttack();
    return true;
  }

  resolvePhenomenon(
    player: Player,
    sourceDefinition?: ItemDefinition,
  ): boolean | void {
    const phenomenonPool = this.catalog.filter(
      (itemDefinition) =>
        itemDefinition.category === engine.CategoryPhenomena,
    );
    const definition = this.pickFromPool('phenomenon', phenomenonPool);
    if (definition === null) {
      this.emit('safe');
      return;
    }
    this.emit('phenomenon', {
      itemModelId: definition.id,
    });
    const triggerDefinition = sourceDefinition ?? this.getCatalogItem(
      'phenomenon trigger card',
      (itemDefinition) => itemDefinition.ability === 'callPhenomenon',
    );
    const attack: Attack = {
      playerId: player.id,
      itemModelIds: [triggerDefinition.id, definition.id],
    };
    const queuedAttack = this.resolveItemAttack(
      player,
      attack,
      [definition],
    );
    if (queuedAttack) {
      return true;
    }
    return this.applyItemEffect(player, player, definition, attack);
  }

  resolveDying() {
    const turnProgress = (this.game.serverTurn ??= {});
    while (turnProgress.dyingAttacks?.length) {
      const dyingAttack = turnProgress.dyingAttacks.shift()!;
      const player = this.requirePlayer(dyingAttack.playerId);
      const item = getOccupiedItemSlots(player).find(
        (itemSlot) =>
          itemSlot.id === dyingAttack.itemId &&
          itemSlot.modelId === dyingAttack.modelId,
      );
      if (!item) {
        continue;
      }
      const attack: Attack = {
        playerId: player.id,
        itemModelIds: [item.modelId],
        atk: 30,
        hitRate: 75,
      };

      this.emit('attackDyingly', {
        attack,
        item,
      });
      this.takeSlots(player, [item]);

      const currentDyingPlayerIds = this.game.dyingPlayerIds ?? [];
      this.game.dyingPlayerIds = [
        ...new Set([
          ...currentDyingPlayerIds,
          player.id,
          ...(turnProgress.turnDeaths ?? []),
        ]),
      ];
      let targets = this.alive.filter((candidatePlayer) =>
        areEnemies(player, candidatePlayer),
      );
      if (!targets.length) {
        continue;
      }
      if (targets.length > 1) {
        targets = this.random.shuffle('dyingTargets', targets);
      }
      this.game.attacks = targets.map((candidatePlayer) => ({
        ...attack,
        targetPlayerId: candidatePlayer.id,
      }));
      this.resolveAttackTarget();
      return true;
    }
    delete turnProgress.dyingAttacks;
    delete this.game.dyingPlayerIds;
    return false;
  }

  getEarthDropPool(): ItemDefinition[] {
    return guardians.getEarthDropPool(this);
  }

  pickEarthDropItem(): ItemDefinition | null {
    return guardians.pickEarthDropItem(this);
  }

  selectGuardianAction(player: Player): ItemDefinition[] | null {
    return guardians.selectGuardianAction(this, player);
  }

  private applyTurnDisease(player: Player): void {
    let curse: string | null | undefined = player.curses?.find((curseName) =>
      diseaseCurses.includes(curseName),
    );
    if (!curse) {
      return;
    }
    this.emit('disease', { playerId: player.id });
    if (this.random.chance('upgradeDisease', DISEASE_WORSEN_PERCENT)) {
      curse = this.applyDisease(player, null, true);
    }
    const hasLivingTarget = player.hp > 0;
    if (!curse || !hasLivingTarget) {
      return;
    }
    if (curse === 'heaven') {
      this.applyStatBoost(player, 'hp', HEAVEN_HEAL_AMOUNT, true);
    } else {
      this.applyDamage(player, DISEASE_DAMAGE[curse], true);
    }
  }

  private resolveTurnDisease(
    actingPlayer: Player,
    turnProgress: NonNullable<Game['serverTurn']>,
  ): void {

    const diseasePlayer = this.requirePlayer(
      this.game.diseasePlayerId ?? actingPlayer.id,
    );
    if (!turnProgress.diseaseDone && !diseasePlayer.dead) {
      this.applyTurnDisease(diseasePlayer);
    }
    turnProgress.diseaseDone = true;
    delete this.game.diseasePlayerId;
  }

  /** Returns true when a guardian attack suspends turn completion for a response. */
  private resolveTurnGuardians(
    actingPlayer: Player,
    turnProgress: NonNullable<Game['serverTurn']>,
  ): boolean {
    turnProgress.guardians ??= [];
    const guardianCandidates = this.game.guardianPlayerIds === undefined
      ? this.alive
      : this.game.guardianPlayerIds.map((playerId) => this.requirePlayer(playerId));
    for (const player of guardianCandidates) {
      const canAct = !player.dead && player.guardian
        && areEnemies(player, actingPlayer)
        && !turnProgress.guardians.includes(player.id);
      if (!canAct) {
        continue;
      }
      turnProgress.guardians.push(player.id);
      if (!this.random.chance('guardianAttack', GUARDIAN_ACTION_PERCENT)) {
        continue;
      }
      const definitions = this.selectGuardianAction(player);
      if (definitions === null || definitions.length === 0) {
        continue;
      }
      const definition = definitions[0];
      const attack: Attack = {
        playerId: player.id,
        guardian: player.guardian,
        itemModelIds: definitions.map(
          (guardianDefinition) => guardianDefinition.id,
        ),
      };
      this.emit('attackByGuardian', {
        attack,
      });
      if (this.resolveItemAttack(player, attack, definitions)) {
        return true;
      }
      if (this.applyItemEffect(player, player, definition, attack)) {
        return true;
      }
    }
    return false;
  }

  finishTurn({ gift = true } = {}): void {
    this.resolveDeaths(false);
    const turnProgress = (this.game.serverTurn ??= {});

    if ((turnProgress.dyingAttacks?.length ?? 0) === 0) {
      delete this.game.dyingPlayerIds;
    }
    const actingPlayer = this.requirePlayer(this.game.attackTurnPlayerId);
    this.resolveTurnDisease(actingPlayer, turnProgress);
    this.resolveDeaths(false);
    if (this.resolveDying()) {
      return;
    }
    if (this.hasWinningSide()) {
      if (gift && this.apocalypse) {
        this.refillConsumedSlots(actingPlayer);
      }
      if (this.resolveDying()) {
        return;
      }
      this.resolveDeaths();
      return;
    }
    if (this.resolveTurnGuardians(actingPlayer, turnProgress)) {
      return;
    }
    // Official logs refill consumed slots only after guardian attacks resolve.
    if (gift) {
      this.refillConsumedSlots(actingPlayer);
    }
    this.resolveDeaths(false);
    if (this.resolveDying()) {
      return;
    }
    if (this.resolveDeaths()) {
      return;
    }
    this.advanceTurn();
  }

  nextTurnPlayer() {
    const survivingPlayers = this.alive;
    return (
      survivingPlayers.find(
        (player) => player.id > this.game.attackTurnPlayerId,
      ) ??
      survivingPlayers[0] ??
      this.game.players.find(
        (player) => player.id === this.game.attackTurnPlayerId,
      )!
    );
  }

  refillConsumedSlots(actingPlayer: Player): void {
    inventory.refillConsumedSlots(this, actingPlayer);
  }

  advanceTurn() {
    delete this.game.attacks;
    delete this.game.serverTurn;
    const nextPlayer = this.nextTurnPlayer();
    this.game.gf++;
    this.game.attackTurnPlayerId = nextPlayer.id;
    this.game.diseasePlayerId = nextPlayer.id;
    this.game.guardianPlayerIds = this.random
      .shuffle(
        'guardianOrder',
        this.turnOrderAfter(nextPlayer.id).filter((player) =>
          areEnemies(player, nextPlayer),
        ),
      )
      .map((player) => player.id);
    this.emit('advanceGF', {
      playerId: nextPlayer.id,
    });
  }

  botDefenseCandidates(player: Player, selectedItemIds: number[] = []) {
    return botAI.botDefenseCandidates(this, player, selectedItemIds);
  }

  chooseBotDefense(player: Player): Command {
    return botAI.chooseBotDefense(this, player);
  }

  chooseBotBuyDecision(offerModelId: number): boolean {
    return botAI.chooseBotBuyDecision(this, offerModelId);
  }

  chooseBotTarget(
    enemies: Player[],
    definition?: ItemDefinition,
  ): number | undefined {
    return botAI.chooseBotTarget(this, enemies, definition);
  }

  addBotAttackFollowUps(
    player: Player,
    command: Command,
    definition: ItemDefinition,
  ): void {
    botAI.addBotAttackFollowUps(this, player, command, definition);
  }

  buildConfusedBotCommand(
    player: Player,
    itemSlot: Slot,
    definition: ItemDefinition,
    occupiedSlots: readonly Slot[],
  ): Command | null {
    return botAI.buildConfusedBotCommand(
      this,
      player,
      itemSlot,
      definition,
      occupiedSlots,
    );
  }

  chooseBotConfusedCommand(
    player: Player,
    pendingAttack: Attack | undefined,
  ) {
    return botAI.chooseBotConfusedCommand(this, player, pendingAttack);
  }

  isValidBotCommand(player: Player, command: Command): boolean {
    return botAI.isValidBotCommand(this, player, command);
  }

  buildBotAttackCommand(
    player: Player,
    itemSlot: Slot,
    definition: ItemDefinition,
    enemies: Player[],
  ): Command | null {
    return botAI.buildBotAttackCommand(
      this,
      player,
      itemSlot,
      definition,
      enemies,
    );
  }

  botCommand() {
    return botAI.botCommand(this);
  }
}
export function openBattle(
  game: Game,
  random: Random = new Random(),
): Battle {
  return new Battle(game, random);
}

export function startBattle(
  users: StartUser[],
  {
    random = new Random(),
    tiebreakGF = null,
    stepBots = false,
  }: {
    random?: Random;
    tiebreakGF?: number | null;
    stepBots?: boolean;
  } = {},
) {
  const players = random.shuffle('playerOrder', users).map((user, index) => ({
    id: index + 1,
    ...user,
    hp: engine.STARTING_HP,
    mp: engine.STARTING_MP,
    cp: engine.STARTING_CP,
    items: [],
  }));
  const game: Game = {
    players,
    gf: 0,
    attackTurnPlayerId: 1,
    updateCount: 1,
    events: [
      {
        action: 'startGame',
      },
    ],
    diseasePlayerId: 1,
    guardianPlayerIds: random
      .shuffle('guardianOrder', players.slice(1))
      .map((player) => player.id),
  };
  if (tiebreakGF != null) {
    game.tiebreakGF = tiebreakGF;
  }

  const battle = openBattle(game, random);
  for (
    let slotIndex = 0;
    slotIndex < engine.INITIAL_ITEM_COUNT;
    slotIndex++
  ) {
    for (const player of players) {
      battle.resolveGift(player, false);
    }
  }
  game.gf = 1;
  battle.emit('advanceGF', {
    playerId: 1,
  });
  if (stepBots) {
    battle.stepBots();
  }
  return game;
}
