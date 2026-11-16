import { engine } from '../engine.ts';
import { Random } from '../random.ts';
import { requireValue } from '../errors.ts';
import { assistant2010Items, assistantItems, assistantTypes, flash2010Items, flashItems, itemAt, type FlashItem, type FlashVersion } from './catalog.ts';
import { FLASH_ATTACK_MAX, attackOf, canAddAttack, canAddDefense, defenseKind, setCosts, type FlashAttack, type FlashPiece } from './rules.ts';
import { children, element, field, has, tag, type XmlNode } from './xml.ts';
import { concealFogMessage } from './fog.ts';

export interface FlashPlayer {
  name: string;
  team: string;
  bot: boolean;
  ready: boolean;
  waitingAttack: boolean;
  hp: number;
  mp: number;
  yen: number;
  items: FlashPiece[];
  abilities: FlashPiece[];
  harms: string[];
  disease: string;
  assistant?: { type: string; hp: number };
  dead: boolean;
  lost: boolean;
  finished: boolean;
  deals: number;
}

export interface PendingAttack extends FlashAttack {
  commander: string;
  attacker: string;
  defender: string;
  removedAttribute: boolean;
  history: string[];
  mystery?: string;
  assistantType?: string;
  mortar?: FlashPiece;
  missed?: boolean;
  decidedHP?: number;
  decidedAssistant?: string;
  resultPieces?: FlashPiece[];
  powers?: { hp: number; mp: number; yen: number };
  buying?: FlashPiece;
  offeredItemIndex?: number;
  dying?: boolean;
  mysteryItems?: Record<string, FlashPiece[]>;
  mysteryAssistants?: Record<string, string>;
}

export interface FlashMessage {
  xml: string;
  recipient?: string;
  exceptRecipients?: string[];
}

const diseases = ['COLD', 'FEVER', 'HELL', 'HEAVEN'];
const harms = ['COLD', 'FEVER', 'HELL', 'HEAVEN', 'FOG', 'ILLUSION', 'GLORY', 'DARK_CLOUD'];
const lowerHarms = ['FOG', 'GLORY'];
const assistantChance = 25;
const diseaseWorsenChance = 5;
const legacyIllusionActionProbability = 0.2;
const flashItemCapacity = 16;
const legacyOpeningHandSize = 8;
const modernOpeningHandSize = 10;
const battleTurnMilliseconds = 60000;
const maximumSelectedPieces = 22;
const maximumAbilityCount = 6;
const pestleDamageMultiplier = 10;
const battleWorkLimit = 1000;
const assistantHitPoints = 20;
const botPurchaseItemCapacity = 10;
const botCheapItemPriceLimit = 5;

export function newFlashPlayer(name: string, team = 'SINGLE', bot = false): FlashPlayer {
  return {
    name, team, bot, ready: false, waitingAttack: false, hp: engine.STARTING_HP, mp: engine.STARTING_MP,
    yen: engine.STARTING_CP, items: [], abilities: [], harms: [], disease: '', dead: false,
    lost: false, finished: false, deals: 0,
  };
}

export function pieceXml(piece: FlashPiece): string {
  return tag('item', piece.item.id)
    + (piece.item.assistantType ? tag('assistantType', piece.item.assistantType) : '')
    + (piece.illusionItem ? tag('illusionItem', piece.illusionItem.id) : '')
    + (piece.abilityIndex !== undefined ? tag('abilityIndex', piece.abilityIndex) : '')
    + (piece.costMP ? tag('costMP', piece.costMP) : '');
}

export function playerXml(player: FlashPlayer): string {
  return element('player', tag('name', player.name) + tag('team', player.team)
    + (player.ready ? tag('isReady') : '') + (player.dead ? tag('isDead') : '')
    + (player.waitingAttack ? tag('isWaitingAttackTurn') : '')
    + (player.lost ? tag('isLost') : '') + (player.finished ? tag('isFinished') : '')
    + tag('power', player.hp, { key: 'HP' }) + tag('power', player.mp, { key: 'MP' })
    + tag('power', player.yen, { key: 'YEN' })
    + (player.disease ? tag('disease', player.disease) : '')
    + player.harms.map((harm) => tag('harm', harm)).join('')
    + (player.assistant ? element('assistant', tag('type', player.assistant.type) + tag('hp', player.assistant.hp)) : ''));
}

export class FlashBattle {
  players: FlashPlayer[];
  inning = 0;
  turn = 0;
  over = false;
  pending?: PendingAttack;
  queue: PendingAttack[] = [];
  messages: FlashMessage[] = [];
  private ending = false;
  private creatureDone = false;
  private readonly giftPool: readonly FlashItem[];

  constructor(players: FlashPlayer[], readonly random = new Random(), readonly version: FlashVersion = '2013') {
    this.players = players;
    // Zero-weight historical cards remain addressable but are never dealt.
    this.giftPool = (version === '2010' ? flash2010Items : flashItems).filter((item) => item.embeddedWeight > 0 && item.type !== 'FIXED');
  }

  get current(): FlashPlayer {
    return this.players[this.turn]!;
  }

  get expected(): FlashPlayer | undefined {
    if (this.over) {
      return undefined;
    }
    const name = this.pending?.buying ? this.pending.attacker : this.pending?.defender;
    return name ? this.player(name) : this.current;
  }

  player(name: string): FlashPlayer {
    const player = this.players.find((candidate) => candidate.name === name);
    requireValue(player);
    return player;
  }

  enemies(first: FlashPlayer, second: FlashPlayer): boolean {
    return first !== second && (first.team === 'SINGLE' || first.team !== second.team);
  }

  send(name: string, content = '', recipient?: string): void {
    const xml = element(name, content);
    if (recipient) {
      const viewer = this.players.find((player) => player.name === recipient);
      const concealed = viewer?.harms.includes('FOG') && ['COMMAND', 'START_INNING'].includes(name);
      this.messages.push({ xml: concealed ? concealFogMessage(xml, recipient) : xml, recipient });
      return;
    }
    const foggedPlayers = this.players.filter((player) => !player.dead && player.harms.includes('FOG'));
    this.messages.push({ xml, exceptRecipients: foggedPlayers.map((player) => player.name) });
    for (const player of foggedPlayers) {
      this.messages.push({ xml: concealFogMessage(xml, player.name), recipient: player.name });
    }
  }

  drain(): FlashMessage[] {
    return this.messages.splice(0);
  }

  gift(): FlashPiece {
    const item = this.random.pick('flashGift', this.giftPool, (candidate) => candidate.embeddedWeight);
    return { item, costMP: 0 };
  }

  deal(player: FlashPlayer): void {
    if (player.dead || player.items.length >= flashItemCapacity) {
      return;
    }
    const piece = this.gift();
    if (this.version !== '2010' && player.harms.includes('ILLUSION') && this.canIllude(piece.item)) {
      piece.illusionItem = this.illusionFor(piece.item);
    }
    player.items.push(piece);
    this.send('DEAL', tag('item', (piece.illusionItem ?? piece.item).id), player.name);
  }

  start(): void {
    this.players = this.random.shuffle('flashPlayerOrder', this.players);
    this.send('START_GAME');
    const openingHandSize = this.version === '2010' ? legacyOpeningHandSize : modernOpeningHandSize;
    for (const player of this.players) {
      player.waitingAttack = true;
      for (let dealIndex = 0; dealIndex < openingHandSize; dealIndex++) {
        this.deal(player);
      }
    }
    // Close the opening deal before Turn 1 so the original clients sort their
    // hands. Only START_INNING advances the displayed turn counter.
    this.send('END_INNING');
    this.send('RESET_ATTACK_ORDER');
    this.startInning();
  }

  startInning(): void {
    this.inning++;
    this.ending = false;
    this.creatureDone = false;
    this.current.waitingAttack = false;
    const randomAction = this.version === '2010' && this.current.harms.includes('ILLUSION')
      && this.random.value('flash2010Illusion') < legacyIllusionActionProbability;
    // The SWF skips startTurn for <illusion/> and waits for a forced command.
    // Only 2010 uses that effect; 2013 Illusion disguises dealt cards instead.
    if (randomAction) {
      this.send('START_INNING', element('attacker', tag('name', this.current.name)) + tag('illusion'));
      this.stepBot(true);
    } else {
      this.send('START_INNING', element('attacker', tag('name', this.current.name)));
    }
  }

  snapshot(viewer?: FlashPlayer): string {
    const fogged = viewer?.harms.includes('FOG') ?? false;
    let content = element('players', this.players.map((player) => {
      if (fogged && viewer !== player && !player.dead) {
        return element('player', tag('name', player.name) + tag('team', player.team));
      }
      return playerXml(player);
    }).join(''));
    if (this.inning) {
      content += tag('inningCount', this.inning);
      if (this.over) {
        content += tag('isEnded');
      }
      if (viewer) {
        const items = viewer.items.map((piece) => element('item',
          tag('item', (piece.illusionItem ?? piece.item).id) + (piece.illusionItem ? tag('isIllusion') : ''))).join('');
        const abilities = viewer.abilities.map((piece, index) => element('ability', tag('item', piece.item.id) + tag('abilityIndex', index))).join('');
        content += tag('dealCount', 0) + element('privatePlayer', tag('time', battleTurnMilliseconds) + items + abilities);
      }
      if (!fogged || viewer === this.current) {
        content += element('attacker', tag('name', this.current.name));
      }
      if (this.pending) {
        content += this.pending.history.map((xml) => fogged ? concealFogMessage(xml, viewer!.name) : xml).join('');
      }
    }
    return element('game', content);
  }

  private canIllude(item: FlashItem): boolean {
    // Usage groups are constrained by the same properties as Item.usage.
    return this.illusionGroup(item) !== '';
  }

  private illusionGroup(item: FlashItem): string {
    if (item.type === 'WEAPON') {
      if (item.hitRate && !item.defenseKind) {
        return 'WEAPON_WIDE';
      }
      if (item.defenseKind === 'DFS' && !item.attribute) {
        return 'WEAPON_DFS';
      }
      if (['BLOCK_WEAPON', 'FLICK_WEAPON', 'REFLECT_WEAPON'].includes(item.defenseExtra)) {
        return item.attackExtra === 'INCREASE_ATK' ? 'WEAPON_BLOCK_INCREASE' : 'WEAPON_BLOCK';
      }
      if (['BLOCK_MAGIC', 'FLICK_MAGIC', 'REFLECT_MAGIC'].includes(item.defenseExtra)) {
        return 'WEAPON_MAGIC';
      }
      if (!item.defenseExtra) {
        if (['INCREASE_ATK', 'ADD_ATTRIBUTE'].includes(item.attackExtra)) {
          return 'WEAPON_INCREASE';
        }
        return item.attackExtra === 'MAGIC_FREE' ? '' : 'WEAPON';
      }
    }
    if (item.type === 'PROTECTOR') {
      if (!item.defenseKind) {
        return '';
      }
      if (item.attribute) {
        return item.attribute === 'DARK' ? '' : `PROTECTOR_${item.attribute}`;
      }
      if (['BLOCK_MAGIC', 'FLICK_MAGIC', 'REFLECT_MAGIC'].includes(item.defenseExtra)) {
        return 'PROTECTOR_MAGIC';
      }
      return `PROTECTOR_${['INCREASE_ATK', 'MAGIC_FREE'].includes(item.attackExtra) ? item.attackExtra : ''}`;
    }
    if (item.type === 'SUNDRY') {
      if (item.attackKind) {
        return 'SUNDRY';
      }
      return ['REVIVE', 'MORTAR'].includes(item.attackExtra) ? 'SUNDRY_PASSIVE' : '';
    }
    return '';
  }

  private illusionFor(item: FlashItem): FlashItem {
    const group = this.illusionGroup(item);
    return this.random.pick('flashIllusion', this.giftPool.filter((candidate) => this.illusionGroup(candidate) === group));
  }

  private select(player: FlashPlayer, request: XmlNode): FlashPiece[] {
    const selected: FlashPiece[] = [];
    const claimedItems = new Set<FlashPiece>();
    const claimedAbilities = new Set<FlashPiece>();
    for (const pieceNode of children(request, 'piece')) {
      const itemText = field(pieceNode, 'item');
      requireValue(/^\d+$/.test(itemText));
      const item = itemAt(Number(itemText), this.version);
      const isAbility = has(pieceNode, 'isAbility');
      let available: FlashPiece | undefined;
      if (isAbility) {
        available = player.abilities.find((piece) => piece.item.id === item.id && !claimedAbilities.has(piece));
        requireValue(available);
        claimedAbilities.add(available);
        selected.push({ item: available.item, costMP: 0, abilityIndex: player.abilities.indexOf(available) });
      } else if (item.type === 'FIXED') {
        requireValue(selected.length === 0 && !this.pending);
        selected.push({ item, costMP: 0 });
      } else {
        const illusionIndex = field(pieceNode, 'illusionItemIndex');
        const matches = player.items.filter((piece) => (piece.illusionItem ?? piece.item).id === item.id && !claimedItems.has(piece));
        if (illusionIndex) {
          requireValue(/^\d+$/.test(illusionIndex));
          const illusions = player.items.filter((piece) => piece.illusionItem?.id === item.id);
          available = illusions[Number(illusionIndex)];
          requireValue(available && !claimedItems.has(available));
        } else {
          // The client always sends an index for a disguised card.
          available = matches.find((piece) => !piece.illusionItem);
        }
        requireValue(available);
        claimedItems.add(available);
        selected.push({ ...available });
      }
    }
    requireValue(selected.length <= maximumSelectedPieces);
    const trial: FlashPiece[] = [];
    for (const piece of selected) {
      const valid = this.pending
        ? canAddDefense(trial, piece, this.pending, player.harms.includes('GLORY'), this.pending.removedAttribute)
        : canAddAttack(trial, piece, this.version);
      requireValue(valid);
      trial.push(piece);
    }
    if (!this.pending) {
      requireValue(selected.length > 0);
      const first = selected[0]!.illusionItem ?? selected[0]!.item;
      if (['DISCARD', 'SELL', 'ADD_ITEM'].includes(first.attackKind)) {
        requireValue(selected.length >= 2);
        if (this.version === '2010') {
          requireValue(selected.length === 2);
        }
      }
      if (first.attackKind === 'DO_NOTHING') {
        requireValue(!player.items.some((piece) => (piece.illusionItem ?? piece.item).type === 'WEAPON') && player.items.length < flashItemCapacity);
      }
    }
    const removal = !this.pending && ['DISCARD', 'SELL', 'ADD_ITEM'].includes(selected[0]!.item.attackKind);
    requireValue(setCosts(selected, removal, this.pending ? undefined : player.mp) <= player.mp);
    return selected;
  }

  private consume(player: FlashPlayer, pieces: FlashPiece[], attack: boolean): void {
    // AttackCommand.kind changes SELL into the sold creature's effect.
    const kind = attack ? attackOf(pieces).kind : '';
    const keepMagic = !['DISCARD', 'SELL'].includes(kind);
    const newAbilities: FlashPiece[] = [];
    let replacementCount = 0;
    for (const piece of pieces) {
      if (piece.abilityIndex !== undefined) {
        replacementCount++;
        continue;
      }
      if (piece.item.type === 'FIXED') {
        continue;
      }
      const index = player.items.findIndex((candidate) => candidate.item.id === piece.item.id
        && candidate.illusionItem?.id === piece.illusionItem?.id);
      requireValue(index >= 0);
      player.items.splice(index, 1);
      replacementCount++;
      if (piece.item.type === 'MAGIC' && keepMagic) {
        newAbilities.push({ item: piece.item, costMP: 0 });
      }
      if (kind === 'DISCARD' && piece.item.attackExtra === 'MORTAR') {
        player.items.push({ item: piece.item, costMP: 0 });
      }
    }
    player.abilities.push(...newAbilities);
    player.abilities = player.abilities.slice(-maximumAbilityCount);
    if (kind === 'DO_NOTHING' || kind === 'SELL') {
      replacementCount = 1;
    } else if (kind === 'DISCARD') {
      replacementCount = 0;
    }
    player.deals += replacementCount;
    this.change(player, 'mp', -pieces.reduce((total, piece) => total + piece.costMP, 0));
  }

  private guardianCard(type: string, attackKind: string): FlashItem {
    const catalog = this.version === '2010' ? assistant2010Items : assistantItems;
    const cards = catalog.get(type)!.filter((item) => item.attackKind === attackKind);
    return this.random.pick(`flashMystery${type}Card`, cards, (item) => item.embeddedWeight);
  }

  private useGuardianCard(attack: PendingAttack, type: string, attackKind: string): void {
    const guardianAttack = attackOf([{ item: this.guardianCard(type, attackKind), costMP: 0 }]);
    attack.pieces = guardianAttack.pieces;
    attack.kind = guardianAttack.kind;
    attack.extra = guardianAttack.extra;
    attack.attribute = guardianAttack.attribute;
    attack.value = guardianAttack.value;
    attack.hitRate = guardianAttack.hitRate;
    attack.type = guardianAttack.type;
    attack.assistantType = type;
  }

  submit(name: string, request: XmlNode): void {
    const checkpoint = structuredClone({
      players: this.players, pending: this.pending, queue: this.queue,
      inning: this.inning, turn: this.turn, over: this.over,
      ending: this.ending, creatureDone: this.creatureDone, messages: this.messages,
      seed: this.random.seed,
    });
    try {
      this.execute(name, request);
    } catch (error) {
      this.players = checkpoint.players;
      this.pending = checkpoint.pending;
      this.queue = checkpoint.queue;
      this.inning = checkpoint.inning;
      this.turn = checkpoint.turn;
      this.over = checkpoint.over;
      this.ending = checkpoint.ending;
      this.creatureDone = checkpoint.creatureDone;
      this.messages = checkpoint.messages;
      this.random.seed = checkpoint.seed;
      throw error;
    }
  }

  private execute(name: string, request: XmlNode): void {
    const player = this.player(name);
    requireValue(this.expected === player && !player.dead);
    if (request.name === 'BUY') {
      requireValue(this.pending?.buying);
      const pending = this.pending;
      const item = pending.buying!;
      if (has(request, 'doBuy')) {
        const seller = this.player(pending.defender);
        requireValue(player.yen >= item.item.price);
        const index = pending.offeredItemIndex;
        requireValue(index !== undefined && seller.items[index]?.item.id === item.item.id);
        seller.items.splice(index, 1);
        this.addItem(player, item);
        this.change(player, 'yen', -item.item.price);
        this.change(seller, 'yen', item.item.price);
      }
      this.send('BUY', has(request, 'doBuy') ? tag('doBuy') : '');
      this.pending = undefined;
      this.advance();
      return;
    }
    requireValue(request.name === 'COMMAND' && !this.pending?.buying);
    const pieces = this.select(player, request);
    if (this.pending) {
      requireValue(request.attributes.target === undefined);
      this.consume(player, pieces, false);
      this.defend(player, pieces);
    } else {
      let target = this.player(request.attributes.target ?? player.name);
      requireValue(!target.dead);
      const first = pieces[0]!.item;
      let powers: PendingAttack['powers'];
      if (first.attackKind === 'EXCHANGE') {
        const powerNodes = children(request, 'power');
        requireValue(powerNodes.length === 3);
        const getPower = (key: string) => {
          const matches = powerNodes.filter((node) => node.attributes.key === key);
          requireValue(matches.length === 1 && /^\d+$/.test(matches[0]!.text));
          const value = Number(matches[0]!.text);
          requireValue(Number.isInteger(value) && value >= 0 && value <= engine.MAX_STAT);
          return value;
        };
        powers = { hp: getPower('HP'), mp: getPower('MP'), yen: getPower('YEN') };
        requireValue(powers.hp + powers.mp + powers.yen === player.hp + player.mp + player.yen);
      }
      this.consume(player, pieces, true);
      const attack: PendingAttack = {
        ...attackOf(pieces), commander: player.name, attacker: player.name, defender: target.name,
        removedAttribute: false, history: [], powers,
      };
      if (player.harms.includes('FOG') && this.enemies(player, target)) {
        target = this.random.pick('fogTarget', this.players.filter((candidate) => !candidate.dead && this.enemies(player, candidate)));
        attack.defender = target.name;
      }
      if (['EXCHANGE', 'DO_NOTHING', 'DISCARD', 'MYSTERY'].includes(attack.kind)) {
        attack.defender = player.name;
      }
      this.prepare(attack);
      this.enqueue(...this.attacksForTargets(attack));
      this.advance();
    }
  }

  private prepare(attack: PendingAttack): void {
    const target = this.player(attack.defender);
    if (attack.kind === 'ADD_ITEM' && attack.assistantType && attack.pieces.length === 1) {
      attack.pieces.push(this.gift());
    }
    if (attack.kind === 'SET_ASSISTANT') {
      attack.decidedAssistant = this.random.pick('flashAssistant', assistantTypes);
    }
    if (attack.kind === 'INCREASE_OR_DECREASE_HP') {
      attack.decidedHP = this.random.chance('flashFortune', 50) ? attack.value : -attack.value;
    }
    if (attack.extra === 'PESTLE') {
      const alive = this.players.filter((player) => !player.dead);
      const mortarTargets = alive.flatMap((player) => player.items
        .filter((piece) => piece.item.attackExtra === 'MORTAR')
        .map((piece) => ({ player, piece })));
      if (mortarTargets.length) {
        const target = this.random.pick('flashPestleMortarTarget', mortarTargets);
        attack.defender = target.player.name;
        attack.mortar = { ...target.piece };
        attack.value = Math.min(FLASH_ATTACK_MAX, attack.value * pestleDamageMultiplier);
      } else {
        const pestleTarget = this.random.pick('flashPestleTarget', alive);
        attack.defender = pestleTarget.name;
      }
    }
    if (attack.kind === 'MYSTERY') {
      attack.mystery = this.random.pick('flashMystery', assistantTypes);
      if (attack.mystery === 'EARTH') {
        const alive = this.players.filter((player) => !player.dead);
        const pool = this.random.shuffle('flashMysteryEarth', alive.flatMap((player) => player.items));
        attack.mysteryItems = {};
        let offset = 0;
        for (const player of alive) {
          const count = player.items.length;
          attack.mysteryItems[player.name] = pool.slice(offset, offset + count)
            .map((piece) => ({ item: piece.item, costMP: 0 }));
          offset += count;
        }
      }
      if (attack.mystery === 'MOON') {
        attack.mysteryAssistants = Object.fromEntries(this.players.filter((player) => !player.dead)
          .map((player) => [player.name, this.random.pick('flashMoonAssistant', assistantTypes)]));
      }
      if (attack.mystery === 'URANUS') {
        this.useGuardianCard(attack, 'URANUS', 'ATK');
        const target = this.random.pick('flashMysteryUranus', this.players.filter((player) => !player.dead));
        attack.defender = target.name;
      } else if (attack.mystery === 'PLUTO') {
        this.useGuardianCard(attack, 'PLUTO', 'ATK');
      } else if (attack.mystery === 'NEPTUNE') {
        this.useGuardianCard(attack, 'NEPTUNE', 'INCREASE_HP');
      }
    }
  }

  private attacksForTargets(attack: PendingAttack): PendingAttack[] {
    if (attack.assistantType === 'URANUS') {
      return [attack];
    }
    const attacker = this.player(attack.commander);
    const enemies = this.players.filter((player) => !player.dead && this.enemies(attacker, player));
    if (attack.assistantType === 'PLUTO' || attack.hitRate > 0) {
      return enemies.map((target) => ({
        ...structuredClone(attack),
        defender: target.name,
        missed: attack.hitRate > 0 && !target.harms.includes('DARK_CLOUD')
          && !this.random.chance('flashHit', attack.hitRate),
      }));
    }
    return [attack];
  }

  private enqueue(...attacks: PendingAttack[]): void {
    this.queue.push(...attacks);
  }

  private commandXml(attack: PendingAttack, recipient?: string): string {
    let body = attack.pieces.map((piece) => element('piece', pieceXml(piece))).join('')
      + element('commander', tag('name', attack.commander))
      + element('target', tag('name', attack.defender));
    if (attack.powers) {
      body += tag('power', attack.powers.hp, { key: 'HP' }) + tag('power', attack.powers.mp, { key: 'MP' })
        + tag('power', attack.powers.yen, { key: 'YEN' });
    }
    if (attack.missed) {
      body += tag('isMiss');
    }
    if (attack.mystery) {
      body += tag('mystery', attack.mystery);
      if (attack.mysteryItems) {
        const items = recipient ? attack.mysteryItems[recipient] ?? [] : [];
        body += element('mysteryResult', items.map((piece) => tag('item', piece.item.id)).join(''));
      }
      if (attack.mysteryAssistants) {
        body += element('mysteryResult', Object.entries(attack.mysteryAssistants)
          .map(([name, assistant]) => element('player', tag('name', name) + tag('assistantType', assistant))).join(''));
      }
    }
    if (attack.assistantType) {
      body += tag('assistantType', attack.assistantType);
    }
    if (attack.mortar) {
      body += element('mortar', pieceXml(attack.mortar));
    }
    if (attack.dying) {
      body += tag('decidedValue', attack.value);
    }
    return body;
  }

  private chainXml(attack: PendingAttack): string {
    let body = '';
    if (attack.decidedHP !== undefined) {
      body += tag('hp', attack.decidedHP);
    }
    if (attack.decidedAssistant) {
      body += tag('assistantType', attack.decidedAssistant);
    }
    body += (attack.resultPieces ?? []).map((piece) => element('piece', pieceXml(piece))).join('');
    return body ? element('commandChain', body) : '';
  }

  private chooseResultPieces(attack: PendingAttack): void {
    const target = this.player(attack.defender);
    if (attack.kind === 'BUY') {
      const pool = target.items;
      if (pool.length) {
        const offered = this.random.pick('flashBuyItem', pool);
        attack.resultPieces = [{ ...offered }];
        attack.offeredItemIndex = target.items.indexOf(offered);
        offered.illusionItem = undefined;
      }
    } else if (attack.kind === 'REMOVE_ITEMS') {
      const pool = target.items.filter((piece) => piece.item.attackExtra !== 'MORTAR');
      attack.resultPieces = this.random.shuffle('flashRemoveItems', pool).slice(0, attack.value).map((piece) => ({ ...piece }));
    } else if (attack.kind === 'REMOVE_ABILITIES') {
      const abilities = target.abilities.map((piece, index) => ({ ...piece, abilityIndex: index }));
      const removalOrder = this.version === '2010' ? abilities : this.random.shuffle('flashRemoveAbilities', abilities);
      attack.resultPieces = removalOrder
        .slice(0, attack.value).sort((first, second) => second.abilityIndex! - first.abilityIndex!);
    }
  }

  private advance(): void {
    let work = 0;
    while (!this.pending && !this.over) {
      requireValue(work++ < battleWorkLimit);
      this.checkDeaths();
      const attack = this.queue.shift();
      if (attack) {
        const target = this.player(attack.defender);
        if (target.dead) {
          continue;
        }
        this.pending = attack;
        const immediate = attack.attacker === attack.defender || attack.missed || !!attack.mortar;
        if (immediate) {
          this.chooseResultPieces(attack);
        }
        const suffix = immediate ? this.chainXml(attack) : '';
        const body = this.commandXml(attack) + suffix;
        attack.history.push(element('COMMAND', body));
        if (attack.mysteryItems) {
          for (const player of this.players) {
            this.send('COMMAND', this.commandXml(attack, player.name) + suffix, player.name);
          }
        } else {
          this.send('COMMAND', body);
        }
        if (immediate) {
          this.resolve(attack, []);
          this.pending = undefined;
          continue;
        }
        return;
      }
      if (!this.creatureDone) {
        this.creatureDone = true;
        for (const owner of this.players.filter((player) => !player.dead)) {
          for (const piece of owner.items.filter((candidate) => candidate.item.type === 'CREATURE')) {
            const target = this.random.pick('flashCreatureTarget', this.players.filter((player) => !player.dead));
            this.queue.push({ ...attackOf([piece]), commander: owner.name, attacker: owner.name,
              defender: target.name, removedAttribute: false, history: [] });
          }
        }
        if (this.queue.length) {
          continue;
        }
      }
      if (!this.ending) {
        this.ending = true;
        this.tickDisease();
        for (const owner of this.players.filter((player) => !player.dead && player.assistant && this.enemies(player, this.current))) {
          if (this.random.chance('flashAssistantAction', assistantChance)) {
            const piece = { item: this.random.pick('flashAssistantItem', (this.version === '2010' ? assistant2010Items : assistantItems).get(owner.assistant!.type)!, (item) => item.embeddedWeight), costMP: 0 };
            const helpful = ['REMOVE_ALL_HARMS', 'INCREASE_MP', 'INCREASE_HP', 'INCREASE_YEN', 'ADD_ITEM', 'SCATTER_YEN'].includes(piece.item.attackKind)
              && piece.item.attackExtra !== 'TO_ENEMY';
            const targets = helpful ? [owner] : this.players.filter((player) => !player.dead && this.enemies(player, owner));
            if (!targets.length) {
              continue;
            }
            const target = this.random.pick('flashAssistantTarget', targets);
            const attack = { ...attackOf([piece]), commander: owner.name, attacker: owner.name,
              defender: target.name, removedAttribute: false, history: [], assistantType: owner.assistant!.type };
            this.prepare(attack);
            this.enqueue(...this.attacksForTargets(attack));
          }
        }
        continue;
      }
      this.checkDeaths();
      const alive = this.players.filter((player) => !player.dead);
      if (alive.length) {
        for (const player of this.players.filter((candidate) => candidate.dead)) {
          const teamSurvives = player.team !== 'SINGLE' && alive.some((candidate) => candidate.team === player.team);
          player.lost ||= !teamSurvives;
        }
      }
      for (const player of this.players) {
        const count = player.deals;
        player.deals = 0;
        for (let dealIndex = 0; dealIndex < count; dealIndex++) {
          this.deal(player);
        }
      }
      this.send('END_INNING');
      if (this.players.filter((player) => !player.dead).every((player, _index, alive) => !this.enemies(player, alive[0]!))) {
        this.over = true;
        for (const player of this.players.filter((candidate) => candidate.harms.includes('FOG'))) {
          this.revealFog(player);
        }
        this.send('END_GAME');
        return;
      }
      do {
        this.turn = (this.turn + 1) % this.players.length;
        if (this.turn === 0) {
          this.players = this.random.shuffle('flashPlayerOrder', this.players);
          for (const player of this.players) {
            player.waitingAttack = !player.dead;
          }
          this.send('RESET_ATTACK_ORDER');
        }
      } while (this.current.dead);
      this.startInning();
      return;
    }
  }

  private defend(player: FlashPlayer, pieces: FlashPiece[]): void {
    const attack = this.pending!;
    const removed = attack.removedAttribute || pieces.some((piece) => piece.item.defenseExtra === 'REMOVE_ATTRIBUTE');
    const response = pieces.find((piece) => defenseKind(piece.item, attack, removed) === 'SOLO')?.item.defenseExtra;
    attack.removedAttribute = removed;
    let body = pieces.map((piece) => element('piece', pieceXml(piece))).join('');
    if (response?.startsWith('REFLECT') || response?.startsWith('FLICK')) {
      const next = response.startsWith('REFLECT')
        ? this.player(attack.attacker)
        : this.random.pick('flashFlick', this.players.filter((candidate) => !candidate.dead));
      attack.attacker = player.name;
      attack.defender = next.name;
      body += element('target', tag('name', next.name));
      if (next === player) {
        this.chooseResultPieces(attack);
        body += this.chainXml(attack);
        attack.history.push(element('COMMAND', body));
        this.send('COMMAND', body);
        this.resolve(attack, []);
        this.pending = undefined;
        this.advance();
        return;
      }
      attack.history.push(element('COMMAND', body));
      this.send('COMMAND', body);
      if (next.dead) {
        // The client finishes a chain immediately when a reflected dying
        // attack returns to its dead owner; that seat cannot submit a defense.
        this.pending = undefined;
        this.advance();
      }
      return;
    }
    const blocked = response?.startsWith('BLOCK');
    if (!blocked) {
      this.chooseResultPieces(attack);
      body += this.chainXml(attack);
    }
    attack.history.push(element('COMMAND', body));
    this.send('COMMAND', body);
    if (!blocked) {
      if (attack.kind === 'BUY' && attack.resultPieces?.length && attack.attacker !== attack.defender) {
        const buyer = this.player(attack.attacker);
        const offered = attack.resultPieces[0]!;
        if (buyer.yen >= offered.item.price) {
          attack.buying = offered;
          return;
        }
      }
      this.resolve(attack, pieces);
    }
    this.pending = undefined;
    this.advance();
  }

  private addItem(player: FlashPlayer, piece: FlashPiece): void {
    if (player.items.length < flashItemCapacity) {
      player.items.push({ item: piece.item, costMP: 0 });
    }
  }

  private resolve(attack: PendingAttack, defense: FlashPiece[]): void {
    const attacker = this.player(attack.attacker);
    const target = this.player(attack.defender);
    if (attack.missed) {
      return;
    }
    if (attack.mortar) {
      const index = target.items.findIndex((piece) => piece.item.id === attack.mortar!.item.id);
      if (index >= 0) {
        target.items.splice(index, 1);
        target.deals++;
      }
    }
    switch (attack.kind) {
      case 'DO_NOTHING':
      case 'DISCARD':
      case 'BUY':
        break;
      case 'EXCHANGE':
        if (attack.powers) {
          Object.assign(attacker, attack.powers);
        }
        break;
      case 'SELL':
        this.addItem(target, attack.pieces[1]!);
        this.change(target, 'yen', -attack.value);
        this.change(attacker, 'yen', attack.value);
        break;
      case 'ABSORB_YEN':
        this.change(target, 'yen', -attack.value);
        this.change(attacker, 'yen', attack.value);
        break;
      case 'ATK': {
        const defenseValue = defense.reduce((total, piece) => total + (piece.item.defenseKind === 'DFS'
          ? (piece.item.type === 'WEAPON' ? piece.item.subValue : piece.item.value) : 0), 0);
        const damage = Math.max(0, attack.value - defenseValue);
        this.change(target, 'hp', -damage);
        if (damage > 0) {
          if (harms.includes(attack.extra)) {
            this.addHarm(target, attack.extra);
          }
          if (attack.extra === 'ABSORB_HP') {
            this.change(attacker, 'hp', damage);
          }
          if (attack.extra === 'DAMAGE_TO_SELF') {
            this.change(attacker, 'hp', -damage);
          }
          if (attack.attribute === 'DARK' && !attack.removedAttribute) {
            target.hp = 0;
            target.assistant = undefined;
          }
        }
        for (const piece of defense) {
          if (harms.includes(piece.item.defenseExtra)) {
            this.addHarm(target, piece.item.defenseExtra);
          }
          if (damage > 0 && piece.item.defenseKind === 'COUNTER') {
            const counter = attackOf([piece]);
            const doubled = ['dosei_no_yubiwa', 'kaiou_no_yubiwa'].includes(piece.item.image);
            const scaled = ['ATK', 'ABSORB_YEN', 'INCREASE_MP'].includes(counter.kind);
            counter.value = scaled
              ? Math.min(FLASH_ATTACK_MAX, damage * (doubled ? 2 : 1))
              : counter.value;
            this.enqueue(...this.attacksForTargets({ ...counter,
              commander: target.name, attacker: target.name,
              defender: counter.kind === 'INCREASE_MP' ? target.name : attacker.name,
              removedAttribute: false, history: [], dying: scaled }));
          }
        }
        break;
      }
      case 'INCREASE_HP':
        this.change(target, 'hp', attack.value);
        break;
      case 'INCREASE_MP':
        this.change(target, 'mp', attack.value);
        if (harms.includes(attack.extra)) {
          this.addHarm(target, attack.extra);
        }
        break;
      case 'INCREASE_YEN':
        this.change(target, 'yen', attack.value);
        break;
      case 'SCATTER_YEN':
        for (const player of this.players.filter((candidate) => !candidate.dead)) {
          this.change(player, 'yen', attack.value);
        }
        break;
      case 'INCREASE_OR_DECREASE_HP':
        this.change(target, 'hp', attack.decidedHP ?? 0);
        break;
      case 'ADD_HARM':
        this.addHarm(target, attack.extra);
        break;
      case 'REMOVE_LOWER_HARMS':
      case 'REMOVE_ALL_HARMS': {
        const all = attack.kind === 'REMOVE_ALL_HARMS';
        const unfog = target.harms.includes('FOG');
        const unillusion = this.version !== '2010' && all && target.harms.includes('ILLUSION');
        target.harms = all ? [] : target.harms.filter((harm) => !lowerHarms.includes(harm));
        if (all || ['COLD', 'FEVER'].includes(target.disease)) {
          target.disease = '';
        }
        if (unfog) {
          this.send('UNFOG', this.players.map(playerXml).join('') + tag('inningAttacker', this.current.name), target.name);
        }
        if (unillusion) {
          const reveal = target.items.filter((piece) => piece.illusionItem)
            .map((piece) => element('item', pieceXml(piece))).join('');
          for (const piece of target.items) {
            piece.illusionItem = undefined;
          }
          this.send('UNILLUSION', reveal, target.name);
        }
        break;
      }
      case 'SET_ASSISTANT':
        target.assistant = { type: attack.decidedAssistant!, hp: assistantHitPoints };
        break;
      case 'ADD_ITEM':
        this.addItem(attacker, attack.pieces[1]!);
        break;
      case 'REMOVE_ITEMS':
        for (const piece of attack.resultPieces ?? []) {
          const index = target.items.findIndex((candidate) => candidate.item.id === piece.item.id && candidate.illusionItem?.id === piece.illusionItem?.id);
          if (index >= 0) {
            // Swept artifacts disappear; ItemRemoveShow creates no replacement
            // cover, so a DEAL here would stop the client's response queue.
            target.items.splice(index, 1);
          }
        }
        break;
      case 'REMOVE_ABILITIES':
        for (const piece of attack.resultPieces ?? []) {
          target.abilities.splice(piece.abilityIndex!, 1);
        }
        break;
      case 'MYSTERY':
        this.resolveMystery(attack);
        break;
      default:
        throw new Error(`Unhandled Flash command ${attack.kind}`);
    }
    if (attack.type === 'CREATURE' && !attack.assistantType) {
      const owner = this.player(attack.commander);
      const index = owner.items.findIndex((piece) => piece.item.id === attack.pieces[0]!.item.id);
      if (index >= 0) {
        // Result.end removes an automatic creature without creating a card cover.
        // An extra DEAL would make ItemList.openItem throw and stall the client.
        owner.items.splice(index, 1);
      }
    }
  }

  private resolveMystery(attack: PendingAttack): void {
    for (const player of this.players.filter((candidate) => !candidate.dead)) {
      switch (attack.mystery) {
        case 'MARS':
          player.disease = 'FEVER';
          break;
        case 'MERCURY':
          this.addHarm(player, 'FOG');
          break;
        case 'JUPITER':
          this.addHarm(player, 'ILLUSION');
          break;
        case 'SATURN':
          player.hp = 1;
          player.assistant = undefined;
          break;
        case 'VENUS':
          player.yen = engine.MAX_STAT;
          break;
        case 'EARTH':
          player.items = attack.mysteryItems?.[player.name] ?? player.items;
          break;
        case 'MOON':
          player.assistant = { type: attack.mysteryAssistants![player.name]!, hp: assistantHitPoints };
          break;
      }
    }
  }

  private change(player: FlashPlayer, stat: 'hp' | 'mp' | 'yen', amount: number): void {
    // Both Flash clients' Player.increasePower ignores dead seats, including
    // counter effects that are still resolving after their owner dies.
    if (player.dead) {
      return;
    }
    if (stat === 'hp' && amount < 0 && player.assistant) {
      player.assistant.hp += amount;
      if (player.assistant.hp > 0) {
        return;
      }
      amount = player.assistant.hp;
      player.assistant = undefined;
    }
    const next = player[stat] + amount;
    if (next < 0 && stat !== 'hp') {
      this.change(player, stat === 'yen' ? 'mp' : 'hp', next);
    }
    player[stat] = Math.max(0, Math.min(engine.MAX_STAT, next));
  }

  private addHarm(player: FlashPlayer, harm: string): void {
    if (diseases.includes(harm)) {
      if (!player.disease || diseases.indexOf(player.disease) < diseases.indexOf(harm)) {
        player.disease = harm;
      } else if (player.disease === 'HEAVEN') {
        player.hp = 0;
        player.assistant = undefined;
      } else {
        player.disease = diseases[diseases.indexOf(player.disease) + 1]!;
      }
    } else if (harm && !player.harms.includes(harm)) {
      player.harms.push(harm);
    }
  }

  private tickDisease(): void {
    const player = this.current;
    if (!player.disease || player.dead) {
      return;
    }
    const previousDisease = player.disease;
    const worse = this.random.chance('flashDiseaseWorsen', diseaseWorsenChance);
    if (worse) {
      this.addHarm(player, 'COLD');
    }
    if (player.hp > 0) {
      const changes: Record<string, number> = {
        COLD: -1,
        FEVER: -2,
        HELL: -5,
        HEAVEN: 5,
      };
      this.change(player, 'hp', changes[player.disease]!);
    }
    this.send('DISEASE', tag('disease', previousDisease) + tag('hp', 1) + (worse ? tag('worse') : ''));
  }

  private revealFog(player: FlashPlayer): void {
    player.harms = player.harms.filter((harm) => harm !== 'FOG');
    this.send('UNFOG', this.players.map(playerXml).join('') + tag('inningAttacker', this.current.name), player.name);
  }

  private checkDeaths(): void {
    for (const player of this.players.filter((candidate) => !candidate.dead && candidate.hp <= 0)) {
      const reviveIndex = player.items.findIndex((piece) => piece.item.attackExtra === 'REVIVE');
      if (reviveIndex >= 0) {
        const piece = player.items.splice(reviveIndex, 1)[0]!;
        player.hp = piece.item.value;
        player.deals++;
        this.send('DYING', (player === this.current ? tag('isAttacker') : '') + element('piece', pieceXml(piece)));
        continue;
      }
      player.dead = true;
      const dyingPieces = player.items.filter((piece) => piece.item.attackExtra === 'DYING_ATTACK');
      for (const piece of dyingPieces) {
        player.items.splice(player.items.indexOf(piece), 1);
        this.send('DYING', (player === this.current ? tag('isAttacker') : '') + element('piece', pieceXml(piece)));
        const attack: PendingAttack = { ...attackOf([piece]), value: piece.item.subValue,
          commander: player.name, attacker: player.name, defender: player.name,
          removedAttribute: false, history: [], dying: true };
        this.enqueue(...this.attacksForTargets(attack));
      }
      this.send('DIE', playerXml(player));
      if (player.harms.includes('FOG')) {
        this.revealFog(player);
      }
    }
  }

  /** End a two-player match after its human participant disconnects. */
  forfeit(name: string): void {
    if (this.over) {
      return;
    }
    requireValue(this.players.length === 2);
    const player = this.player(name);
    player.dead = true;
    player.lost = true;
    this.pending = undefined;
    this.queue = [];
    // A forfeit marks the seat dead without inventing damage. END_INNING
    // makes the client compute losers before displaying the winner bonus.
    this.send('DIE', playerXml(player));
    this.send('END_INNING');
    this.over = true;
    for (const foggedPlayer of this.players.filter((candidate) => candidate.harms.includes('FOG'))) {
      this.revealFog(foggedPlayer);
    }
    this.send('END_GAME');
  }

  stepBot(randomAction = false): boolean {
    const player = this.expected;
    if (!player || (!player.bot && !randomAction)) {
      return false;
    }
    if (this.pending?.buying) {
      const offered = this.pending.buying;
      const willBuy = player.yen >= offered.item.price
        && (player.items.length < botPurchaseItemCapacity || offered.item.price <= botCheapItemPriceLimit);
      this.submit(player.name, {
        name: 'BUY',
        attributes: {},
        children: willBuy ? [{ name: 'doBuy', attributes: {}, children: [], text: '' }] : [],
        text: '',
      });
      return true;
    }
    const request: XmlNode = { name: 'COMMAND', attributes: {}, children: [], text: '' };
    const candidates = player.items.concat(player.abilities.map((piece, index) => ({ ...piece, abilityIndex: index })));
    if (this.pending) {
      const defense: FlashPiece[] = [];
      for (const piece of candidates) {
        const trial = structuredClone([...defense, piece]);
        if (canAddDefense(defense, piece, this.pending, player.harms.includes('GLORY'), this.pending.removedAttribute) && setCosts(trial) <= player.mp) {
          defense.push(piece);
        }
      }
      request.children = defense.map((piece) => this.pieceRequest(piece, player));
    } else {
      const playable = candidates.filter((piece) => {
        if (!canAddAttack([], piece)) {
          return false;
        }
        const item = piece.illusionItem ?? piece.item;
        return item.attackKind && !['SELL', 'ADD_ITEM', 'EXCHANGE'].includes(item.attackKind)
          && setCosts([{ ...piece }]) <= player.mp;
      });
      const piece = randomAction && playable.length
        ? this.random.pick('flash2010IllusionMove', playable)
        : playable.find((candidate) => candidate.item.attackKind === 'ATK') ?? playable[0];
      if (piece) {
        request.children = [this.pieceRequest(piece, player)];
        const hostile = ['ATK', 'ADD_HARM', 'ABSORB_YEN', 'REMOVE_ITEMS', 'REMOVE_ABILITIES'].includes(piece.item.attackKind);
        const targets = this.players.filter((candidate) => !candidate.dead && (hostile ? this.enemies(player, candidate) : candidate === player));
        request.attributes.target = randomAction
          ? this.random.pick('flash2010IllusionTarget', this.players.filter((candidate) => !candidate.dead)).name
          : (targets[0] ?? player).name;
      } else if (player.items.length >= flashItemCapacity || player.items.some((candidate) => candidate.item.type === 'WEAPON')) {
        const disposable = candidates.find((candidate) => candidate.abilityIndex === undefined && candidate.item.type !== 'FIXED');
        requireValue(disposable);
        request.children = [this.pieceRequest({ item: itemAt(1, this.version), costMP: 0 }, player), this.pieceRequest(disposable, player)];
        request.attributes.target = player.name;
      } else {
        request.children = [this.pieceRequest({ item: itemAt(0, this.version), costMP: 0 }, player)];
        request.attributes.target = player.name;
      }
    }
    this.submit(player.name, request);
    return true;
  }

  private pieceRequest(piece: FlashPiece, player: FlashPlayer): XmlNode {
    const content: XmlNode[] = [{ name: 'item', attributes: {}, children: [], text: String((piece.illusionItem ?? piece.item).id) }];
    if (piece.illusionItem) {
      const illusions = player.items.filter((candidate) => candidate.illusionItem?.id === piece.illusionItem!.id);
      content.push({ name: 'illusionItemIndex', attributes: {}, children: [], text: String(illusions.indexOf(piece)) });
    }
    if (piece.abilityIndex !== undefined) {
      content.push({ name: 'isAbility', attributes: {}, children: [], text: '' });
    }
    return { name: 'piece', attributes: {}, children: content, text: '' };
  }
}
