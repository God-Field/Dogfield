import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { FlashBattle, newFlashPlayer } from '../flash/battle.ts';
import { flash2010Items, flashItems, itemAt } from '../flash/catalog.ts';
import { FLASH_ATTACK_MAX, attackOf, canAddAttack, canAddDefense, canDefend, setCosts } from '../flash/rules.ts';
import { FlashService } from '../flash/service.ts';
import { FlashAccounts, account2013, duelStraightBonus } from '../flash/accounts.ts';
import { FlashConnection, listenFlashTcp } from '../flash/transport.ts';
import { parseXml, escapeXml, field, children } from '../flash/xml.ts';
import { Random } from '../random.ts';
import { engine } from '../engine.ts';
import { Store } from '../store.ts';
import { flashLotteryInterval } from '../flash/lottery.ts';
import { flashBookCount, flashBookCost, flashBookEntries } from '../flash/book.ts';
import { createServer } from '../http/server.ts';

const piece = (id) => ({ item: itemAt(id), costMP: 0 });
const find = (predicate) => {
  const item = flashItems.find(predicate);
  assert.ok(item);
  return item.id;
};
const command = (ids, target) => parseXml(`<COMMAND${target ? ` target="${escapeXml(target)}"` : ''}>${ids.map((id) => `<piece><item>${id}</item></piece>`).join('')}</COMMAND>`);
const battleFixture = (firstIds = [], secondIds = [], seed = 1) => {
  const first = newFlashPlayer('Alice');
  const second = newFlashPlayer('Bob');
  first.items = firstIds.map(piece);
  second.items = secondIds.map(piece);
  const battle = new FlashBattle([first, second], new Random(seed));
  return { battle, first, second };
};
const login = (name, mode = 'FREE_FIGHT') => `<LOGIN><name>${escapeXml(name)}</name><language>ENGLISH</language><mode>${mode}</mode></LOGIN>`;

// Expected rules below are from the decompiled SWF.
test('Flash XML preserves entities and rejects ambiguous or unsafe documents', () => {
  assert.equal(field(parseXml('<CHAT><comment>&lt;hello &amp; &#x1f43e;&gt;</comment></CHAT>'), 'comment'), '<hello & 🐾>');
  for (const source of ['<!DOCTYPE a><a/>', '<a/><b/>', '<a></b>', '<a foo="1" foo="2"/>', '<a>', '<a><']) {
    assert.throws(() => parseXml(source));
  }
  assert.throws(() => field(parseXml('<a><b>1</b><b>2</b></a>'), 'b'));
});

test('Flash catalog retains zero-based IDs and old defense relationships', () => {
  assert.equal(flashItems.length, 364);
  assert.equal(itemAt(0).attackKind, 'DO_NOTHING');
  assert.equal(itemAt(1).attackKind, 'DISCARD');
  assert.equal(itemAt(5).value, 1);
  assert.equal(canDefend('LIGHT', 'DARK'), true);
  assert.equal(canDefend('DARK', ''), true);
  assert.equal(canDefend('FIRE', 'FIRE'), false);
  assert.equal(canDefend('FIRE', 'WATER'), true);
  assert.throws(() => itemAt(-1));
  assert.throws(() => itemAt(1.1));
});

test('Flash Mirage clears an existing element unless a later attribute card sets it again', () => {
  const elementalWeapon = flashItems.find((item) => item.type === 'WEAPON' && item.attribute && item.hitRate === 0);
  const plainWeapon = flashItems.find((item) => item.type === 'WEAPON' && !item.attribute && item.hitRate === 0);
  const mirage = flashItems.find((item) => item.attackExtra === 'WIDE_ATK');
  const attributeCard = flashItems.find((item) => item.attackExtra === 'ADD_ATTRIBUTE');

  assert.ok(elementalWeapon);
  assert.ok(plainWeapon);
  assert.ok(mirage);
  assert.ok(attributeCard);

  assert.equal(attackOf([piece(elementalWeapon.id), piece(mirage.id)]).attribute, '');
  assert.equal(attackOf([piece(plainWeapon.id), piece(attributeCard.id), piece(mirage.id)]).attribute, '');
  assert.equal(attackOf([piece(plainWeapon.id), piece(mirage.id), piece(attributeCard.id)]).attribute, attributeCard.attribute);
});

test('Flash attack doubling Miracles stack on melee weapons', () => {
  const meleeWeapon = flashItems.find((item) => item.type === 'WEAPON' && item.attackKind === 'ATK' && item.hitRate === 0 && item.value > 0);
  const miracle = flashItems.find((item) => item.attackExtra === 'DOUBLE_ATK');

  assert.ok(meleeWeapon);
  assert.ok(miracle);

  const weaponPiece = piece(meleeWeapon.id);
  const firstMiracle = piece(miracle.id);
  const secondMiracle = piece(miracle.id);
  assert.equal(canAddAttack([weaponPiece], firstMiracle), true);
  assert.equal(canAddAttack([weaponPiece, firstMiracle], secondMiracle), true);
  assert.equal(attackOf([weaponPiece, firstMiracle, secondMiracle]).value, Math.min(FLASH_ATTACK_MAX, meleeWeapon.value * 4));
});

test('Flash discarding allows weapons, prohibits fixed items, and requires a second card', () => {
  assert.equal(canAddAttack([piece(1)], piece(5), '2010'), true);
  assert.equal(canAddAttack([piece(1)], piece(0), '2010'), false);
  const oldBattle = new FlashBattle([newFlashPlayer('Alice'), newFlashPlayer('Bob')], new Random(1), '2010');
  oldBattle.player('Alice').items = [piece(5)];
  oldBattle.startInning = () => {};
  assert.throws(() => oldBattle.submit('Alice', command([1], 'Alice')));
  oldBattle.submit('Alice', command([1, 5], 'Alice'));
  assert.equal(oldBattle.player('Alice').items.length, 0);
});

test('Flash owns cards and rejects duplicate selections, forged abilities, and wrong turns', () => {
  const { battle, first } = battleFixture([5]);
  assert.throws(() => battle.submit('Bob', command([5], 'Alice')));
  assert.throws(() => battle.submit('Alice', command([6], 'Bob')));
  assert.throws(() => battle.submit('Alice', command([1, 5, 5], 'Alice')));
  assert.throws(() => battle.submit('Alice', parseXml('<COMMAND target="Bob"><piece><item>5</item><isAbility/></piece></COMMAND>')));
  assert.equal(first.items.length, 1);
});

test('Flash prayer requires no weapons and a free inventory slot', () => {
  assert.throws(() => battleFixture([5]).battle.submit('Alice', command([0], 'Alice')));
  const armor = find((item) => item.type === 'PROTECTOR');
  assert.throws(() => battleFixture(Array(16).fill(armor)).battle.submit('Alice', command([0], 'Alice')));
  const { battle, first } = battleFixture([armor]);
  battle.submit('Alice', command([0], 'Alice'));
  assert.equal(first.items.length, 2);
});

test('Flash magic-free removes the previous magic cost and magical attack scales with paid MP', () => {
  const magical = find((item) => item.attackExtra === 'MAGICAL');
  const free = find((item) => item.attackExtra === 'MAGIC_FREE');
  const selected = [piece(magical), piece(free)];
  setCosts(selected);
  assert.equal(selected[0].costMP, 0);
  assert.equal(attackOf(selected).value, 0);
});

test('Flash miracles enter the reusable ability row and are reusable without consuming it', () => {
  const miracle = find((item) => item.type === 'MAGIC' && item.attackKind === 'INCREASE_HP');
  const { battle, first } = battleFixture([miracle]);
  first.mp = engine.MAX_STAT;
  battle.submit('Alice', command([miracle], 'Alice'));
  assert.equal(first.abilities.length, 1);
  assert.equal(first.abilities[0].item.id, miracle);
  battle.submit('Bob', command([0], 'Bob'));
  battle.submit('Alice', parseXml(`<COMMAND target="Alice"><piece><item>${miracle}</item><isAbility/></piece></COMMAND>`));
  assert.equal(first.abilities.length, 1);
});

test('Flash assistants shield HP and excess damage spills to their owner', () => {
  const weapon = find((item) => item.type === 'WEAPON' && item.value === 5 && !item.hitRate && !item.attackExtra);
  const { battle, second } = battleFixture([weapon]);
  second.assistant = { type: 'MARS', hp: 3 };
  battle.submit('Alice', command([weapon], 'Bob'));
  battle.submit('Bob', command([]));
  assert.equal(second.hp, 38);
  assert.equal(second.assistant, undefined);
});

for (const version of ['2010', '2013']) {
  const catalog = version === '2010' ? flash2010Items : flashItems;
  const versionPiece = (item) => ({ item, costMP: 0 });
  const fixture = () => {
    const first = newFlashPlayer('Alice');
    const second = newFlashPlayer('Bob');
    const battle = new FlashBattle([first, second], new Random(1), version);
    // Keep these rule checks independent of new deals and guardian actions.
    battle.startInning = () => {};
    battle.random.chance = () => false;
    return { battle, first, second };
  };

  test(`${version} miracles survive more than six reuses and a seventh learned miracle evicts the oldest`, () => {
    const miracle = catalog.find((item) => item.type === 'MAGIC' && item.attackKind === 'INCREASE_HP');
    assert.ok(miracle);
    const { battle, first } = fixture();
    first.items = [versionPiece(miracle)];
    first.mp = engine.MAX_STAT;
    battle.submit('Alice', command([miracle.id], 'Alice'));
    const learned = first.abilities[0];
    assert.equal(learned.item.id, miracle.id);

    for (let reuseIndex = 0; reuseIndex < 7; reuseIndex++) {
      battle.turn = battle.players.indexOf(first);
      first.items = [];
      first.mp = engine.MAX_STAT;
      battle.submit('Alice', parseXml(`<COMMAND target="Alice"><piece><item>${miracle.id}</item><isAbility/></piece></COMMAND>`));
      assert.deepEqual(first.abilities, [learned]);
      assert.equal(first.mp, engine.MAX_STAT - miracle.subValue);
    }

    const olderMiracles = catalog.filter((item) => item.type === 'MAGIC' && item.id !== miracle.id).slice(0, 6);
    assert.equal(olderMiracles.length, 6);
    first.abilities = olderMiracles.map(versionPiece);
    first.items = [versionPiece(miracle)];
    first.mp = engine.MAX_STAT;
    battle.turn = battle.players.indexOf(first);
    battle.submit('Alice', command([miracle.id], 'Alice'));
    assert.deepEqual(first.abilities.map((entry) => entry.item.id), [...olderMiracles.slice(1), miracle].map((item) => item.id));
  });

  test(`${version} guardians retain partial HP, disappear at zero, and pass excess damage to their owner`, () => {
    const weapon = catalog.find((item) => item.type === 'WEAPON' && item.attackKind === 'ATK'
      && item.value === 5 && !item.attribute && !item.hitRate && !item.attackExtra);
    assert.ok(weapon);
    for (const guardianHp of [20, 5, 3]) {
      const { battle, first, second } = fixture();
      first.items = [versionPiece(weapon)];
      second.assistant = { type: 'MARS', hp: guardianHp };
      const ownerHp = second.hp;
      battle.submit('Alice', command([weapon.id], 'Bob'));
      battle.submit('Bob', command([]));
      assert.equal(second.hp, ownerHp - Math.max(0, weapon.value - guardianHp));
      assert.deepEqual(second.assistant, guardianHp > weapon.value ? { type: 'MARS', hp: guardianHp - weapon.value } : undefined);
    }
  });

  test(`${version} damaging dark attacks kill through guardian HP`, () => {
    const weapon = catalog.find((item) => item.type === 'WEAPON' && item.attackKind === 'ATK'
      && item.attribute === 'DARK' && !item.hitRate && !item.attackExtra);
    assert.ok(weapon);
    const { battle, first, second } = fixture();
    first.items = [versionPiece(weapon)];
    second.assistant = { type: 'MARS', hp: 20 };
    battle.submit('Alice', command([weapon.id], 'Bob'));
    battle.submit('Bob', command([]));
    assert.equal(second.hp, 0);
    assert.equal(second.assistant, undefined);
    assert.equal(second.dead, true);
  });

  test(`${version} dark armor can respond to light with its counter effect`, () => {
    const weapon = catalog.find((item) => item.type === 'WEAPON' && item.attackKind === 'ATK'
      && item.attribute === 'LIGHT' && !item.hitRate && !item.attackExtra);
    const armor = catalog.find((item) => item.type === 'PROTECTOR' && item.attribute === 'DARK' && item.defenseKind);
    assert.ok(weapon);
    assert.ok(armor);
    assert.equal(armor.defenseKind, 'COUNTER');
    const { battle, first, second } = fixture();
    first.items = [versionPiece(weapon)];
    second.items = [versionPiece(armor)];
    const ownerHp = second.hp;
    battle.submit('Alice', command([weapon.id], 'Bob'));
    battle.submit('Bob', command([armor.id]));
    assert.equal(second.hp, ownerHp - weapon.value);
    assert.equal(battle.pending.kind, 'ADD_HARM');
    battle.submit('Alice', command([]));
    assert.ok(first.harms.includes('DARK_CLOUD'));
  });
}

test('Flash glory limits defense to one card, including magic-free', () => {
  const armor = find((item) => item.type === 'PROTECTOR' && item.defenseKind === 'DFS' && !item.attribute);
  const attack = attackOf([piece(5)]);
  assert.equal(canAddDefense([piece(armor)], piece(armor), attack, true), false);
  assert.equal(canAddDefense([piece(armor)], piece(armor), attack, false), true);
});

test('Flash Curtain of Rainbow permits mismatched elemental armor in either selection order', () => {
  const fireAttack = attackOf([piece(find((item) => item.type === 'WEAPON' && item.attribute === 'FIRE' && item.attackKind === 'ATK'))]);
  const fireArmor = piece(find((item) => item.type === 'PROTECTOR' && item.defenseKind === 'DFS' && item.attribute === 'FIRE'));
  const curtain = piece(find((item) => item.defenseExtra === 'REMOVE_ATTRIBUTE'));

  assert.equal(canAddDefense([], fireArmor, fireAttack, false), false);
  assert.equal(canAddDefense([fireArmor], curtain, fireAttack, false), true);
  assert.equal(canAddDefense([], curtain, fireAttack, false), true);
  assert.equal(canAddDefense([curtain], fireArmor, fireAttack, false), true);
});

test('Flash exchange conserves HP/MP/yen and validates every power', () => {
  const { battle, first } = battleFixture([2]);
  const before = structuredClone(first);
  assert.throws(() => battle.submit('Alice', parseXml('<COMMAND target="Alice"><piece><item>2</item></piece><power key="HP">999</power><power key="MP">0</power><power key="YEN">0</power></COMMAND>')));
  assert.deepEqual(first, before);
  battle.submit('Alice', parseXml('<COMMAND target="Alice"><piece><item>2</item></piece><power key="HP">30</power><power key="MP">10</power><power key="YEN">30</power></COMMAND>'));
  assert.equal(battle.player('Alice').hp, 30);
  assert.equal(battle.player('Alice').mp, 10);
});

test('Flash socket framing handles split UTF-8, multiple frames and heartbeat frames', () => {
  const service = new FlashService();
  const output = [];
  const connection = new FlashConnection(service, (data) => output.push(data), () => assert.fail('unexpected close'));
  const input = Buffer.from(`${login('Éva')}\0\0`);
  const split = input.indexOf(Buffer.from('É')) + 1;
  connection.receive(input.subarray(0, split));
  assert.equal(output.length, 0);
  connection.receive(input.subarray(split));
  assert.ok(output[0].includes('<name>Éva</name>'));
  connection.disconnect();
  assert.equal(service.sessions.size, 0);
});

test('Flash duplicate Free Fight login initializes the client before rejecting it without replacing the owner', () => {
  for (const version of ['2013', '2010']) {
    const service = new FlashService();
    const ownerMessages = [];
    const owner = service.connect((message) => ownerMessages.push(message));
    const request = login('Alice').replace('</LOGIN>', `<version>${version}</version></LOGIN>`);
    service.receive(owner, request);
    const originalMessages = [...ownerMessages];
    const rejectedMessages = [];
    const rejected = service.connect((message) => rejectedMessages.push(message));
    service.receive(rejected, request);

    assert.deepEqual(rejectedMessages, [
      '<ENTER><lobby/></ENTER>',
      '<ERROR><message>userExists</message></ERROR>',
    ]);
    assert.deepEqual([...service.sessions], [owner]);
    assert.deepEqual(ownerMessages, originalMessages);
    assert.throws(() => service.receive(rejected, '<ENTER><name>Unauthorized room</name></ENTER>'));
    assert.equal(service.rooms.size, 0);

    service.disconnect(rejected);
    assert.deepEqual([...service.sessions], [owner]);
    assert.deepEqual(ownerMessages, originalMessages);
    service.disconnect(owner);
    const retry = service.connect(() => {});
    service.receive(retry, request);
    assert.deepEqual([...service.sessions], [retry]);
  }
});

test('Flash multiplayer lobby enforces passwords and starts when all opponents are ready', () => {
  const service = new FlashService(new Random(1));
  const output = new Map();
  const enter = (name) => {
    const messages = [];
    output.set(name, messages);
    const session = service.connect((xml) => messages.push(xml));
    service.receive(session, login(name));
    return session;
  };
  const alice = enter('Alice');
  const bob = enter('Bob');
  service.receive(alice, '<ENTER><name>Room</name><password>secret</password><playersLimit>2</playersLimit></ENTER>');
  const roomId = alice.room.id;
  service.receive(bob, `<ENTER><id>${roomId}</id></ENTER>`);
  assert.equal(bob.room, undefined);
  assert.ok(output.get('Bob').at(-1).includes('passwordIncorrect'));
  service.receive(bob, `<ENTER><id>${roomId}</id><password>secret</password></ENTER>`);
  for (const session of [alice, bob]) {
    service.receive(session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
    service.receive(session, '<READY><isReady/></READY>');
  }
  assert.ok(alice.room.battle);
  assert.equal(alice.room.battle.players.length, 2);
  assert.equal(output.get('Alice').filter((xml) => xml.startsWith('<DEAL>')).length, 10);
  assert.equal(output.get('Bob').filter((xml) => xml.startsWith('<DEAL>')).length, 10);
  assert.throws(() => service.receive(alice, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>'));
});

test('Flash TCP serves socket policy and login on an ephemeral port', async () => {
  const service = new FlashService();
  const server = await listenFlashTcp(service, 0, '127.0.0.1');
  const socket = connect(server.address().port, '127.0.0.1');
  try {
    await once(socket, 'connect');
    socket.write('<policy-file-request/>\0');
    const [policy] = await once(socket, 'data');
    assert.match(policy.toString(), /cross-domain-policy/);
    socket.write(`${login('Alice')}\0`);
    const [response] = await once(socket, 'data');
    assert.match(response.toString(), /<ENTER><lobby\/>/);
  } finally {
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Flash HTTP and binary WebSocket share the authoritative service', async () => {
  const { server, flash } = await createServer({ botInterval: 0 });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${server.server.address().port}/flash/socket`);
  try {
    await once(socket, 'open');
    const message = once(socket, 'message');
    socket.send(Buffer.from(`${login('Alice')}\0`));
    const [data, binary] = await message;
    assert.equal(binary, true);
    assert.match(data.toString(), /<name>Alice<\/name>/);
    assert.equal(flash.sessions.size, 1);
    const count = await server.inject('/flash/api/getUserCount');
    assert.match(count.body, /<userCount>1<\/userCount>/);
    assert.equal((await server.inject('/flash/')).statusCode, 200);
    assert.equal((await server.inject('/crossdomain.xml')).statusCode, 200);
    assert.match((await server.inject('/flash/api/getData')).body, /<charin>0<\/charin>/);
  } finally {
    socket.terminate();
    await server.close();
  }
});

test('Flash seeded bot battles make progress and keep resources bounded', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const players = ['Alice', 'Bob', 'Carol', 'Dave'].map((name) => newFlashPlayer(name, 'SINGLE', true));
    const battle = new FlashBattle(players, new Random(seed));
    battle.start();
    for (let step = 0; step < 500 && !battle.over; step++) {
      assert.equal(battle.stepBot(), true, `seed ${seed}, step ${step}`);
      battle.drain();
      for (const player of battle.players) {
        assert.ok(player.items.length <= 16);
        assert.ok(player.abilities.length <= 6);
        for (const stat of ['hp', 'mp', 'yen']) {
          assert.ok(Number.isInteger(player[stat]) && player[stat] >= 0 && player[stat] <= engine.MAX_STAT);
        }
      }
    }
    assert.ok(battle.inning > 5 || battle.over, `seed ${seed} stalled`);
  }
});

test('Flash uses the official embedded pool and never deals archived zero-weight cards', () => {
  const { battle } = battleFixture();
  for (let draw = 0; draw < 2000; draw++) {
    assert.ok(battle.gift().item.embeddedWeight > 0);
    assert.ok(battle.gift().item.id < 246);
  }
});

test('Flash buying waits for the buyer and transfers exactly one owned card and its price', () => {
  const { battle } = battleFixture([4], [5]);
  battle.submit('Alice', command([4], 'Bob'));
  battle.submit('Bob', command([]));
  assert.equal(battle.expected.name, 'Alice');
  assert.equal(battle.pending.buying.item.id, 5);
  assert.throws(() => battle.submit('Bob', parseXml('<BUY><doBuy/></BUY>')));
  assert.equal(battle.expected.name, 'Alice');
  battle.submit('Alice', parseXml('<BUY><doBuy/></BUY>'));
  assert.equal(battle.player('Alice').yen, 19);
  assert.equal(battle.player('Bob').yen, 21);
  assert.ok(battle.player('Alice').items.some((entry) => entry.item.id === 5));
  assert.equal(battle.player('Bob').items.some((entry) => entry.item.id === 5), false);
});

test('Flash declining a Buy offer advances to the next player who can act', () => {
  const { battle } = battleFixture([4], [5]);
  battle.startInning();
  battle.drain();

  battle.submit('Alice', command([4], 'Bob'));
  battle.submit('Bob', command([]));
  assert.equal(battle.expected.name, 'Alice');
  battle.submit('Alice', parseXml('<BUY/>'));

  assert.equal(battle.pending, undefined);
  assert.equal(battle.expected.name, 'Bob');
  battle.submit('Bob', command([5], 'Alice'));
  assert.equal(battle.expected.name, 'Alice');
});

test('Flash bot evaluates and accepts buy offers when affordable or declines when full', () => {
  // Case 1: Bot accepts affordable offer
  const first = newFlashPlayer('Alice');
  const second = newFlashPlayer('Bob');
  first.items = [piece(5)]; // price 1
  second.items = [piece(4)]; // Buy card
  second.bot = true;
  second.yen = 20;

  const battle = new FlashBattle([first, second], new Random(1));
  battle.turn = 1;
  battle.startInning();
  battle.drain();

  battle.submit('Bob', command([4], 'Alice'));
  battle.drain();
  battle.submit('Alice', command([]));
  battle.drain();

  assert.equal(battle.expected.name, 'Bob');
  assert.equal(battle.pending.buying.item.id, 5);
  assert.equal(battle.stepBot(), true);

  assert.ok(second.items.some((p) => p.item.id === 5));
  assert.equal(second.yen, 19);
  assert.equal(first.yen, 21);

  // Case 2: Bot with full inventory declines expensive card (Gold Club, price 15)
  const p1 = newFlashPlayer('Alice');
  const p2 = newFlashPlayer('Bob');
  p1.items = [piece(8)]; // Gold Club, price 15
  p2.items = [piece(4), piece(5), piece(5), piece(5), piece(5), piece(5), piece(5), piece(5), piece(5), piece(5), piece(5)];
  p2.bot = true;
  p2.yen = 20;

  const b2 = new FlashBattle([p1, p2], new Random(1));
  b2.turn = 1;
  b2.startInning();
  b2.drain();

  b2.submit('Bob', command([4], 'Alice'));
  b2.drain();
  b2.submit('Alice', command([]));
  b2.drain();

  assert.equal(b2.expected.name, 'Bob');
  assert.equal(b2.pending.buying.item.id, 8);
  assert.equal(b2.stepBot(), true);

  assert.equal(p2.items.some((p) => p.item.id === 8), false);
  assert.equal(p2.yen, 20);
  assert.equal(p1.yen, 20);
});

test('Flash reflection returns a targeted attack to its previous attacker', () => {
  const reflect = find((item) => item.defenseExtra === 'REFLECT_WEAPON');
  const { battle } = battleFixture([5], [reflect]);
  battle.submit('Alice', command([5], 'Bob'));
  battle.submit('Bob', command([reflect]));
  assert.equal(battle.expected.name, 'Alice');
  battle.submit('Alice', command([]));
  assert.equal(battle.player('Alice').hp, 39);
  assert.equal(battle.player('Bob').hp, 40);
});

test('Flash dark cloud forces random attacks to hit without changing their listed hit rate', () => {
  const weapon = find((item) => item.type === 'WEAPON' && item.hitRate === 25);
  const { battle, second } = battleFixture([weapon]);
  second.harms.push('DARK_CLOUD');
  battle.submit('Alice', command([weapon], 'Bob'));
  assert.equal(battle.pending.hitRate, 25);
  assert.equal(battle.pending.missed, false);
});

test('Flash lower-harm cleansing removes glory but retains illusion and dark cloud', () => {
  const cleanse = find((item) => item.attackKind === 'REMOVE_LOWER_HARMS');
  const { battle, first } = battleFixture([cleanse]);
  first.harms = ['GLORY', 'ILLUSION', 'DARK_CLOUD'];
  battle.submit('Alice', command([cleanse], 'Alice'));
  assert.deepEqual(first.harms, ['ILLUSION', 'DARK_CLOUD']);
});

test('Flash magical weapons spend remaining MP after the attached miracle costs', () => {
  const magical = find((item) => item.attackExtra === 'MAGICAL');
  const { battle } = battleFixture([magical]);
  battle.submit('Alice', command([magical], 'Bob'));
  assert.equal(battle.pending.value, 20);
  assert.equal(battle.pending.pieces[0].costMP, 10);
  assert.equal(battle.player('Alice').mp, 0);
});

test('Flash forgetting removes the card-defined number of abilities and retains the others', () => {
  const forget = find((item) => item.attackKind === 'REMOVE_ABILITIES' && item.type !== 'CREATURE');
  const miracle = find((item) => item.type === 'MAGIC');
  const { battle, second } = battleFixture([forget]);
  second.abilities = [piece(miracle), piece(miracle), piece(miracle)];
  battle.submit('Alice', command([forget], 'Bob'));
  battle.submit('Bob', command([]));
  assert.equal(battle.player('Bob').abilities.length, 2);
});

test('Flash counter rings use the damage and effect documented in the original card text', () => {
  const weapon = find((item) => item.type === 'WEAPON' && item.value === 5 && !item.hitRate && !item.attackExtra);
  const { battle } = battleFixture([weapon], [193]);
  battle.submit('Alice', command([weapon], 'Bob'));
  battle.submit('Bob', command([193]));
  assert.equal(battle.player('Bob').mp, 20);
  assert.equal(battle.player('Bob').hp, 35);
  assert.equal(battle.player('Alice').hp, 40);
});

test('Flash illegal commands leave authoritative state, RNG and outgoing messages unchanged', () => {
  const { battle } = battleFixture([5]);
  const before = JSON.stringify(battle);
  assert.throws(() => battle.submit('Alice', command([5], 'Unknown')));
  assert.equal(JSON.stringify(battle), before);
});

test('Flash fog conceals other commanders and targets while preserving self-action completion', async () => {
  const { concealFogMessage } = await import('../flash/fog.ts');
  const selfAction = concealFogMessage('<COMMAND><commander><name>Bob</name></commander><target><name>Bob</name></target><piece><item>0</item></piece></COMMAND>', 'Alice');
  assert.ok(!selfAction.includes('Bob'));
  assert.ok(selfAction.includes('<isSelf>'));
  const incoming = concealFogMessage('<COMMAND><commander><name>Bob</name></commander><target><name>Alice</name></target><piece><item>5</item></piece></COMMAND>', 'Alice');
  assert.ok(!incoming.includes('Bob'));
  assert.ok(incoming.includes('<name>Alice</name>'));
  assert.ok(!concealFogMessage('<START_INNING><attacker><name>Bob</name></attacker></START_INNING>', 'Alice').includes('Bob'));
});

test('Flash fog snapshots conceal other live stats and messages have mutually exclusive audiences', () => {
  const { battle, first } = battleFixture([5]);
  first.harms.push('FOG');
  battle.inning = 1;
  const snapshot = parseXml(battle.snapshot(first));
  const players = snapshot.children.find((node) => node.name === 'players').children;
  assert.equal(players[1].children.some((node) => node.name === 'power'), false);
  battle.send('START_INNING', '<attacker><name>Bob</name></attacker>');
  const messages = battle.drain();
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].exceptRecipients, ['Alice']);
  assert.equal(messages[1].recipient, 'Alice');
  assert.ok(!messages[1].xml.includes('Bob'));
});

test('Flash full cleansing reveals only illusion cards with their original shown identities', () => {
  const cleanse = find((item) => item.attackKind === 'REMOVE_ALL_HARMS');
  const { battle, first } = battleFixture([cleanse, 5, 6]);
  first.harms.push('ILLUSION');
  first.items[1].illusionItem = itemAt(6);
  battle.submit('Alice', command([cleanse], 'Alice'));
  const reveal = battle.drain().find((message) => message.xml.startsWith('<UNILLUSION>'));
  assert.ok(reveal);
  assert.equal(parseXml(reveal.xml).children.length, 1);
  assert.ok(reveal.xml.includes('<item>5</item><illusionItem>6</illusionItem>'));
  assert.equal(battle.player('Alice').items.some((entry) => entry.illusionItem), false);
});

test('Flash mystery outcomes serialize private inventories and shared assistants before applying them', () => {
  for (const outcome of ['EARTH', 'MOON']) {
    class MysteryRandom extends Random {
      pick(label, values, weight) {
        return label === 'flashMystery' ? outcome : super.pick(label, values, weight);
      }
    }
    const { first, second } = battleFixture([243, 5], [6, 7]);
    const battle = new FlashBattle([first, second], new MysteryRandom(2));
    battle.submit('Alice', command([243], 'Alice'));
    const messages = battle.drain().filter((message) => message.xml.startsWith('<COMMAND>'));
    assert.ok(messages.some((message) => message.xml.includes('<mysteryResult>')));
    if (outcome === 'EARTH') {
      const privateMessage = messages.find((message) => message.recipient === 'Alice');
      const commandNode = parseXml(privateMessage.xml);
      const result = commandNode.children.find((node) => node.name === 'mysteryResult');
      assert.deepEqual(result.children.map((node) => Number(node.text)), first.items.slice(0, result.children.length).map((entry) => entry.item.id));
    } else {
      assert.ok(first.assistant);
      assert.ok(second.assistant);
      assert.ok(messages[0].xml.includes(`<assistantType>${first.assistant.type}</assistantType>`));
    }
  }
});

test('Flash Mystery Uranus (Huge Tub) selects a random living target instead of the caster', () => {
  class UranusRandom extends Random {
    pick(label, values, weight) {
      if (label === 'flashMystery') {
        return 'URANUS';
      }
      if (label === 'flashMysteryUranus') {
        return values.find((p) => p.name === 'Bob');
      }
      if (label === 'flashMysteryURANUSCard') {
        return values.find((item) => item.value === 2);
      }
      return super.pick(label, values, weight);
    }
  }
  const { battle, first, second } = battleFixture([243], [4]);
  battle.random = new UranusRandom(42);
  battle.submit('Alice', command([243], 'Alice'));
  assert.equal(battle.pending.kind, 'ATK');
  assert.equal(battle.pending.type, 'WEAPON');
  assert.equal(battle.pending.attribute, 'LIGHT');
  assert.equal(battle.pending.value, 2);
  assert.equal(battle.pending.hitRate, 0);
  assert.equal(battle.pending.pieces[0].item.assistantType, 'URANUS');
  assert.equal(battle.pending.defender, 'Bob');
  assert.equal(battle.pending.commander, 'Alice');
});

test('Flash Mystery Earth (Magnetic Storm) shuffles existing cards among living players without dealing gifts', () => {
  class EarthRandom extends Random {
    pick(label, values, weight) {
      if (label === 'flashMystery') {
        return 'EARTH';
      }
      return super.pick(label, values, weight);
    }
  }
  const { battle, first, second } = battleFixture([243, 10, 20], [30, 40]);
  battle.random = new EarthRandom(42);
  battle.submit('Alice', command([243], 'Alice'));
  assert.equal(second.items.length, 2);
  assert.ok(second.items.every((p) => [10, 20, 30, 40].includes(p.item.id)));
  assert.equal(first.items.length, 3);
  const alicePreserved = first.items.filter((p) => [10, 20, 30, 40].includes(p.item.id));
  assert.equal(alicePreserved.length, 2);
});

test('Flash Dangerous Pestle deals tenfold damage and randomly targets any Mortar holder', () => {
  const pestle = flashItems.find((item) => item.attackExtra === 'PESTLE');
  const mortar = flashItems.find((item) => item.attackExtra === 'MORTAR');

  class PestleRandom extends Random {
    pick(label, values, weight) {
      if (label === 'flashPestleMortarTarget') {
        assert.equal(values.length, 2, 'Choose randomly among every Mortar in play');
        return values.find((target) => target.player.name === 'Carol');
      }
      if (label === 'flashPestleTarget') {
        return values.find((player) => player.name === 'Carol');
      }
      return super.pick(label, values, weight);
    }
  }

  const alice = newFlashPlayer('Alice');
  const bob = newFlashPlayer('Bob');
  const carol = newFlashPlayer('Carol');
  const dave = newFlashPlayer('Dave');
  alice.items = [{ item: pestle, costMP: 0 }];
  bob.items = [{ item: itemAt(10), costMP: 0 }];
  carol.hp = 400;
  carol.items = [{ item: mortar, costMP: 0 }];
  dave.items = [{ item: mortar, costMP: 0 }];

  const battle = new FlashBattle([alice, bob, carol, dave], new PestleRandom(1));
  let pestleDamage;
  const originalResolve = battle.resolve.bind(battle);
  battle.resolve = (attack, defense) => {
    if (attack.extra === 'PESTLE' && attack.mortar) {
      pestleDamage = attack.value;
    }
    originalResolve(attack, defense);
  };
  battle.startInning();
  battle.drain();
  battle.submit('Alice', parseXml(`<COMMAND target="Bob"><piece><item>${pestle.id}</item></piece></COMMAND>`));

  const messages = battle.drain();
  const cmd = messages.find((message) => message.xml.startsWith('<COMMAND'));
  assert.ok(cmd, 'COMMAND emitted');
  assert.ok(cmd.xml.includes('<target><name>Carol</name></target>'), 'Randomly targets Carol, who holds a Mortar');
  assert.ok(cmd.xml.includes(`<mortar><item>${mortar.id}</item></mortar>`), 'Mortar tag attached');
  assert.equal(pestleDamage, 300, 'The 30 damage Pestle deals ten times its base damage');
  assert.ok(!carol.items.some((piece) => piece.item.attackExtra === 'MORTAR'), 'The selected Mortar is consumed');
  assert.equal(dave.items.length, 1, 'Other Mortars remain in play');

  const p1 = newFlashPlayer('Alice');
  const p2 = newFlashPlayer('Bob');
  const p3 = newFlashPlayer('Carol');
  p1.items = [{ item: pestle, costMP: 0 }];
  p2.items = [{ item: itemAt(10), costMP: 0 }];
  p3.items = [{ item: itemAt(11), costMP: 0 }];

  const noMortarBattle = new FlashBattle([p1, p2, p3], new PestleRandom(1));
  noMortarBattle.startInning();
  noMortarBattle.drain();
  noMortarBattle.submit('Alice', parseXml(`<COMMAND target="Bob"><piece><item>${pestle.id}</item></piece></COMMAND>`));
  assert.equal(noMortarBattle.pending.defender, 'Carol', 'Without a Mortar, redirect to a random living target');
  assert.equal(noMortarBattle.pending.value, 30, 'Without a Mortar, Pestle retains its base damage');
  assert.equal(noMortarBattle.pending.attribute, 'LIGHT', 'Light attribute');
  assert.equal(noMortarBattle.pending.mortar, undefined, 'No Mortar is consumed');
});

test('Flash flick defense can deflect attack back onto defender and resolve immediately', () => {
  class SelfFlickRandom extends Random {
    pick(label, values, weight) {
      if (label === 'flashFlick') {
        return values.find((p) => p.name === 'Bob');
      }
      return super.pick(label, values, weight);
    }
  }

  const sword = flashItems.find((i) => i.id === 36); // Wonder Sword, 10 dmg
  const flickSword = flashItems.find((i) => i.id === 20); // Random Sword, FLICK_WEAPON

  const alice = newFlashPlayer('Alice');
  const bob = newFlashPlayer('Bob');
  alice.items = [{ item: sword, costMP: 0 }];
  bob.items = [{ item: flickSword, costMP: 0 }];

  const battle = new FlashBattle([alice, bob], new SelfFlickRandom(1));
  battle.startInning();
  battle.drain();

  battle.submit('Alice', parseXml(`<COMMAND target="Bob"><piece><item>${sword.id}</item></piece></COMMAND>`));
  battle.drain();

  battle.submit('Bob', parseXml(`<COMMAND><piece><item>${flickSword.id}</item></piece></COMMAND>`));
  assert.equal(bob.hp, 30, 'Bob takes 10 damage from self-bounced attack');
  assert.equal(battle.pending, undefined, 'Attack resolved without second defense');
  const messages = battle.drain();
  const cmd = messages.find((m) => m.xml.startsWith('<COMMAND'));
  assert.ok(cmd.xml.includes('<target><name>Bob</name></target>'));
});

test('Flash percentage counter rings (Ring of Mars) counter-attack all living opponents', () => {
  class AlwaysHitRandom extends Random {
    chance(label, percent) {
      if (label === 'flashHit') return true;
      return super.chance(label, percent);
    }
  }

  const marsRing = flashItems.find((i) => i.id === 187); // Ring of Mars
  const sword = flashItems.find((i) => i.id === 36); // Wonder Sword (10 dmg)

  const alice = newFlashPlayer('Alice');
  const bob = newFlashPlayer('Bob');
  const carol = newFlashPlayer('Carol');

  alice.items = [{ item: sword, costMP: 0 }];
  bob.items = [{ item: marsRing, costMP: 0 }];
  carol.items = [];

  const battle = new FlashBattle([alice, bob, carol], new AlwaysHitRandom(1));
  battle.startInning();
  battle.drain();

  battle.submit('Alice', parseXml(`<COMMAND target="Bob"><piece><item>${sword.id}</item></piece></COMMAND>`));
  battle.drain();

  battle.submit('Bob', parseXml(`<COMMAND><piece><item>${marsRing.id}</item></piece></COMMAND>`));
  assert.equal(battle.pending.commander, 'Bob');
  const targets = [battle.pending.defender, ...battle.queue.map((a) => a.defender)].sort();
  assert.deepEqual(targets, ['Alice', 'Carol'], 'Ring of Mars counter-attacks strike all living opponents');
});

test('Flash declined and accepted Buy offers reveal illusion cards consistently', () => {
  for (const accepted of [false, true]) {
    const { battle, second } = battleFixture([4], [5]);
    second.items[0].illusionItem = itemAt(6);
    battle.submit('Alice', command([4], 'Bob'));
    battle.submit('Bob', command([]));
    const offer = battle.drain().find((message) => message.xml.includes('<commandChain>'));
    assert.ok(offer.xml.includes('<item>5</item><illusionItem>6</illusionItem>'));
    assert.equal(battle.player('Bob').items[0].illusionItem, undefined);
    battle.submit('Alice', parseXml(accepted ? '<BUY><doBuy/></BUY>' : '<BUY/>'));
    const owner = battle.player(accepted ? 'Alice' : 'Bob');
    assert.ok(owner.items.some((entry) => entry.item.id === 5 && !entry.illusionItem));
  }
});

test('Flash login uses the client’s exact width-based name limit and character rules', () => {
  const service = new FlashService();
  for (const name of [' Alice', 'Alice ', 'A&B', '九'.repeat(9), '🐾'.repeat(5)]) {
    assert.throws(() => service.receive(service.connect(() => {}), login(name)));
  }
  for (const name of ['九'.repeat(8), 'É'.repeat(16), '🐾'.repeat(4)]) {
    const session = service.connect(() => {});
    service.receive(session, login(name));
    assert.equal(session.name, name);
  }
});

test('Flash team shuffle enforces the original public/private eligibility rules', () => {
  const service = new FlashService(new Random(7));
  const sessions = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'].map((name) => {
    const session = service.connect(() => {});
    service.receive(session, login(name));
    return session;
  });
  service.receive(sessions[0], '<ENTER><name>Teams</name><playersLimit>9</playersLimit></ENTER>');
  const room = sessions[0].room;
  for (const session of sessions) {
    if (!session.room) {
      service.receive(session, `<ENTER><id>${room.id}</id></ENTER>`);
    }
    service.receive(session, '<ENTER_GAME><team>TEAM1</team></ENTER_GAME>');
  }
  assert.throws(() => service.receive(sessions[0], '<SHUFFLE_TEAM/>'));
  service.receive(sessions[4], '<EXIT_GAME/>');
  service.receive(sessions[0], '<READY><isReady/></READY>');
  assert.throws(() => service.receive(sessions[1], '<SHUFFLE_TEAM/>'));
  service.receive(sessions[0], '<READY/>');
  service.receive(sessions[0], '<SHUFFLE_TEAM/>');
  const shuffledSizes = [...new Set(room.players.map((player) => player.team))]
    .map((team) => room.players.filter((player) => player.team === team).length);
  assert.ok([2, 4].includes(shuffledSizes.length));
  assert.equal(new Set(shuffledSizes).size, 1);
});

test('Flash rejected socket commands return a clean authoritative recovery snapshot', () => {
  const service = new FlashService(new Random(1));
  const output = [];
  const connection = new FlashConnection(service, (data) => output.push(data), () => {});
  connection.receive(Buffer.from(`${login('Alice', 'TRAINING')}\0`));
  const session = [...service.sessions][0];
  const battle = session.room.battle;
  battle.turn = battle.players.findIndex((player) => player.name === 'Alice');
  battle.player('Alice').items = [piece(5)];
  output.length = 0;
  connection.receive(Buffer.from('<COMMAND target="Alice"><piece><item>6</item></piece></COMMAND>\0'));
  assert.ok(output[0].includes('invalidRequest'));
  assert.ok(output[1].startsWith('<ENTER><room>'));
  assert.deepEqual(battle.player('Alice').items.map((entry) => entry.item.id), [5]);
  assert.equal(session.room.players, battle.players);
  connection.disconnect();
});

test('Flash ascension bows resolve their card-defined dying attack before ending the battle', () => {
  class HitRandom extends Random {
    chance(label, percent) {
      return label === 'flashHit' || super.chance(label, percent);
    }
  }
  const { first, second } = battleFixture([6], [117]);
  second.hp = 1;
  const battle = new FlashBattle([first, second], new HitRandom(1));
  battle.submit('Alice', command([6], 'Bob'));
  battle.submit('Bob', command([]));
  assert.equal(battle.player('Bob').dead, true);
  assert.equal(battle.expected.name, 'Alice');
  assert.equal(battle.pending.value, 30);
  assert.ok(battle.drain().some((message) => message.xml.startsWith('<DYING>')));
  battle.submit('Alice', command([]));
  assert.equal(battle.player('Alice').hp, 10);
  assert.equal(battle.over, true);
});

test('Flash completed snapshots preserve losers and reveal fog for the winner', () => {
  const { battle, first, second } = battleFixture([5]);
  first.harms.push('FOG');
  second.hp = 1;
  battle.submit('Alice', command([5], 'Bob'));
  battle.submit('Bob', command([]));
  assert.equal(battle.over, true);
  assert.equal(battle.player('Bob').lost, true);
  assert.equal(battle.player('Alice').lost, false);
  assert.equal(battle.player('Alice').harms.includes('FOG'), false);
  assert.ok(battle.snapshot(first).includes('<isLost/>'));
  assert.ok(battle.drain().some((message) => message.recipient === 'Alice' && message.xml.startsWith('<UNFOG>')));
});

test('2010 catalogs preserve their own IDs, card values and assistant attacks', async () => {
  const { flash2010Items, assistant2010Items } = await import('../flash/catalog.ts');
  assert.equal(flash2010Items.length, 364);
  assert.equal(flash2010Items.reduce((total, item) => total + item.embeddedWeight, 0), 500);
  assert.deepEqual(Object.fromEntries(['TRADE', 'WEAPON', 'PROTECTOR', 'MAGIC', 'SUNDRY', 'CREATURE'].map((type) => [
    type,
    flash2010Items.filter((item) => item.type === type).reduce((total, item) => total + item.embeddedWeight, 0),
  ])), { TRADE: 60, WEAPON: 181, PROTECTOR: 130, MAGIC: 30, SUNDRY: 90, CREATURE: 9 });
  assert.deepEqual(Object.fromEntries([...assistant2010Items].map(([type, items]) => [
    type,
    items.reduce((total, item) => total + item.embeddedWeight, 0),
  ])), { MARS: 20, MERCURY: 20, JUPITER: 20, SATURN: 20, URANUS: 20, PLUTO: 20, NEPTUNE: 20, VENUS: 20, EARTH: 1, MOON: 1 });
  assert.equal(itemAt(5, '2010').name, 'Gold Club');
  assert.equal(itemAt(5, '2010').price, 30);
  assert.equal(itemAt(8, '2010').name, 'Paper Knife');
  assert.equal(itemAt(350, '2010').value, 3);
  assert.equal(itemAt(351, '2010').value, 2);
  assert.equal(assistant2010Items.get('PLUTO')[0].attackKind, 'ADD_HARM');
  assert.equal(assistant2010Items.get('JUPITER')[2].attackKind, 'ADD_HARM');
  assert.equal(itemAt(5).name, 'Paper Knife');
});

test('2010 special attack commands require exactly two selected cards', () => {
  const discard = piece(1, '2010');
  const weapon = piece(8, '2010');
  assert.equal(canAddAttack([discard, weapon], piece(8, '2010'), '2010'), false);

  for (const attackKind of ['SELL', 'ADD_ITEM']) {
    const first = { ...weapon, item: { ...weapon.item, attackKind } };
    assert.equal(canAddAttack([first, weapon], piece(8, '2010'), '2010'), false);
  }
});

test('2010 starts with eight cards and rejects discarding multiple cards atomically', () => {
  const first = newFlashPlayer('Alice');
  const second = newFlashPlayer('Bob');
  const battle = new FlashBattle([first, second], new Random(7), '2010');
  battle.start();
  assert.equal(first.items.length, 8);
  assert.equal(second.items.length, 8);
  battle.turn = battle.players.indexOf(first);
  first.items = [8, 8].map((id) => ({ item: itemAt(id, '2010'), costMP: 0 }));
  assert.throws(() => battle.submit('Alice', command([1, 8, 8], 'Alice')));
  assert.equal(battle.player('Alice').items.length, 2);
  battle.submit('Alice', command([1, 8], 'Alice'));
  assert.equal(battle.player('Alice').items.length, 1);
  first.items = [8, 8, 8].map((id) => ({ item: itemAt(id, '2010'), costMP: 0 }));
  battle.turn = battle.players.indexOf(first);
  battle.pending = undefined;
  assert.throws(() => battle.submit('Alice', command([1, 8, 8, 8], 'Alice')));
  assert.equal(battle.player('Alice').items.length, 1);
});

test('2010 XML uses bare item results, assistant item attributes and ability flags', async () => {
  const { encode2010Message } = await import('../flash/wire-2010.ts');
  const converted = parseXml(encode2010Message('<COMMAND><piece><item>2</item><assistantType>PLUTO</assistantType><abilityIndex>0</abilityIndex></piece><mortar><item>355</item></mortar><commandChain><piece><item>8</item></piece></commandChain></COMMAND>'));
  assert.equal(converted.children[0].children[0].attributes.assistantType, 'PLUTO');
  assert.ok(converted.children[0].children.some((node) => node.name === 'isAbility'));
  assert.equal(field(converted, 'mortar'), '355');
  assert.equal(field(converted.children[2], 'item'), '8');
  assert.equal(encode2010Message('<DYING><piece><item>354</item></piece></DYING>'), '<DYING><item>354</item></DYING>');
  assert.equal(encode2010Message('<privatePlayer><item><item>8</item></item><ability><item>307</item><abilityIndex>0</abilityIndex></ability></privatePlayer>'), '<privatePlayer><item>8</item><ability>307</ability></privatePlayer>');
});

test('2010 and 2013 lobbies are isolated and reject unknown versions', () => {
  const service = new FlashService(new Random(1));
  const oldSession = service.connect(() => {});
  const modernSession = service.connect(() => {});
  service.receive(oldSession, login('Alice').replace('</LOGIN>', '<version>2010</version></LOGIN>'));
  service.receive(modernSession, login('Alice'));
  assert.notEqual(oldSession.scope, modernSession.scope);
  assert.equal(oldSession.version, '2010');
  assert.equal(modernSession.version, '2013');
  assert.throws(() => service.receive(service.connect(() => {}), login('Bob').replace('</LOGIN>', '<version>2009</version></LOGIN>')));
});

test('2010 Illusion follows the official 20% random-action description, without disguising cards', () => {
  const first = newFlashPlayer('Alice');
  const second = newFlashPlayer('Bob');
  first.harms = ['ILLUSION'];
  first.items = [{ item: itemAt(8, '2010'), costMP: 0 }];
  const battle = new FlashBattle([first, second], new Random(1), '2010');
  const originalValue = battle.random.value.bind(battle.random);
  battle.random.value = (label) => label === 'flash2010Illusion' ? 0.19 : originalValue(label);
  battle.startInning();
  const messages = battle.drain();
  assert.ok(messages.some((message) => message.xml.includes('<illusion/>')));
  assert.ok(messages.some((message) => message.xml.startsWith('<COMMAND>')));
  const quiet = new FlashBattle([newFlashPlayer('Carol'), newFlashPlayer('Dave')], new Random(1), '2010');
  quiet.current.harms = ['ILLUSION'];
  quiet.random.value = () => 0.2;
  quiet.startInning();
  assert.equal(quiet.drain().some((message) => message.xml.includes('<illusion/>')), false);
  quiet.deal(quiet.current);
  assert.equal(quiet.current.items[0].illusionItem, undefined);
});

test('2013 Illusion starts a playable turn without the legacy forced-action signal', () => {
  for (const illusion of [false, true]) {
    const { battle, first } = battleFixture([5]);
    first.harms = illusion ? ['ILLUSION'] : [];
    battle.random.value = () => { throw new Error('2013 must not roll for the 2010 Illusion effect'); };
    battle.stepBot = () => { throw new Error('2013 must not execute the 2010 automatic action'); };
    battle.startInning();
    assert.deepEqual(battle.drain(), [{
      xml: '<START_INNING><attacker><name>Alice</name></attacker></START_INNING>',
      exceptRecipients: [],
    }]);
    assert.equal(first.items.length, 1);
    assert.equal(battle.expected.name, 'Alice');
  }
});

test('2013 Spirit bot Illusion leaves the next human attack usable and still disguises dealt cards', () => {
  const bot = newFlashPlayer('Spirit', 'SINGLE', true);
  const human = newFlashPlayer('Alice');
  bot.items = [piece(213)];
  human.items = [piece(5)];
  const battle = new FlashBattle([bot, human], new Random(7));
  battle.gift = () => piece(5);
  battle.startInning();
  battle.drain();
  assert.equal(battle.stepBot(), true);
  assert.equal(battle.pending.defender, human.name);
  battle.submit(human.name, command([]));
  assert.ok(human.harms.includes('ILLUSION'));
  assert.equal(battle.expected, human);
  const messages = battle.drain();
  assert.ok(messages.some((message) => message.xml === '<START_INNING><attacker><name>Alice</name></attacker></START_INNING>'));
  assert.ok(messages.every((message) => !message.xml.includes('<illusion/>')));
  battle.submit(human.name, command([5], bot.name));
  assert.equal(battle.pending.commander, human.name);
  assert.equal(battle.stepBot(), true);
  const replacement = human.items[0];
  assert.ok(replacement.illusionItem, '2013 must continue disguising eligible replacement cards');
  assert.ok(human.harms.includes('ILLUSION'));
});

test('2010 forget effects remove leading miracle slots and counter rings use 2010 IDs', () => {
  const oldPiece = (id) => ({ item: itemAt(id, '2010'), costMP: 0 });
  const first = newFlashPlayer('Alice');
  const second = newFlashPlayer('Bob');
  first.items = [oldPiece(351)];
  second.abilities = [307, 308, 309].map(oldPiece);
  const battle = new FlashBattle([first, second], new Random(1), '2010');
  battle.submit('Alice', command([351], 'Bob'));
  if (battle.pending) {
    battle.submit('Bob', command([]));
  }
  assert.deepEqual(second.abilities.map((entry) => entry.item.id), [309]);
  const attacker = newFlashPlayer('Carol');
  const defender = newFlashPlayer('Dave');
  attacker.items = [oldPiece(8)];
  defender.items = [oldPiece(303)];
  const counterBattle = new FlashBattle([attacker, defender], new Random(1), '2010');
  counterBattle.submit('Carol', command([8], 'Dave'));
  counterBattle.submit('Dave', command([303]));
  assert.equal(defender.hp, 39);
  assert.equal(defender.mp, 12);
});

test('2013 full replays preserve audited client-compatible behavior', async () => {
  const baselines = JSON.parse(await readFile(new URL('./fixtures/flash-2013-replays.json', import.meta.url), 'utf8'));
  for (let seed = 1; seed <= 200; seed++) {
    const players = ['Alice', 'Bob', 'Carol', 'Dave'].map((name) => newFlashPlayer(name, 'SINGLE', true));
    const battle = new FlashBattle(players, new Random(seed));
    const matchDigest = createHash('sha256');
    const captureMessages = () => {
      const messages = battle.drain();
      for (const message of messages) {
        if (message.xml.startsWith('<START_INNING')) {
          assert.ok(!message.xml.includes('<illusion'), `Seed ${seed} must enable the 2013 turn`);
        }
      }
      matchDigest.update(JSON.stringify(messages));
    };
    battle.start();
    captureMessages();
    let commands = 0;
    while (!battle.over && commands < 2000) {
      assert.equal(battle.stepBot(), true, `Seed ${seed} must not stall`);
      captureMessages();
      matchDigest.update(JSON.stringify(battle.players));
      commands++;
    }
    assert.equal(battle.over, true, `Seed ${seed} must finish`);
    assert.equal(matchDigest.digest('hex'), baselines[seed], `Replay seed ${seed}`);
  }
});

test('Flash resets and reshuffles attack order when a round completes', () => {
  const players = ['Alice', 'Bob', 'Carol'].map((name) => newFlashPlayer(name, 'SINGLE', true));
  const battle = new FlashBattle(players, new Random(10));
  const resets = [];
  const captureResets = () => {
    for (const msg of battle.drain()) {
      if (msg.xml.includes('RESET_ATTACK_ORDER')) {
        resets.push(msg);
      }
    }
  };
  battle.start();
  captureResets();
  assert.equal(resets.length, 1);
  // Advance through round 1 until round 2 starts (inning 4)
  while (battle.inning <= 3 && !battle.over) {
    battle.stepBot();
    captureResets();
  }
  // The round wrap should have broadcast a second RESET_ATTACK_ORDER
  assert.equal(resets.length, 2);
  assert.ok(battle.inning >= 4);
});

test('Flash removes a user after a strict majority filters them', () => {
  const service = new FlashService(new Random(7));
  const outputs = new Map();
  const sessions = new Map();
  for (const name of ['Alice', 'Bob', 'Carol', 'David']) {
    outputs.set(name, []);
    const session = service.connect((xml) => outputs.get(name).push(xml));
    sessions.set(name, session);
    service.receive(session, login(name));
  }

  service.receive(sessions.get('Alice'), '<ENTER><name>Vote room</name><playersLimit>4</playersLimit></ENTER>');
  for (const name of ['Bob', 'Carol', 'David']) {
    service.receive(sessions.get(name), '<ENTER><id>1</id></ENTER>');
  }
  const room = sessions.get('Alice').room;
  for (const session of sessions.values()) {
    service.receive(session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  }

  service.receive(sessions.get('Bob'), '<FILTER><user>Alice</user><isFiltered/></FILTER>');
  service.receive(sessions.get('Carol'), '<FILTER><user>Alice</user><isFiltered/></FILTER>');
  assert.equal(sessions.get('Alice').room, room);
  assert.equal(room.users.size, 4);

  service.receive(sessions.get('Bob'), '<FILTER><user>Alice</user></FILTER>');
  service.receive(sessions.get('David'), '<FILTER><user>Alice</user><isFiltered/></FILTER>');
  assert.equal(sessions.get('Alice').room, room);
  assert.equal(room.users.size, 4);

  service.receive(sessions.get('Bob'), '<FILTER><user>Alice</user><isFiltered/></FILTER>');
  assert.equal(sessions.get('Alice').room, undefined);
  assert.equal(room.users.size, 3);
  assert.ok(outputs.get('Alice').some((message) => message.startsWith('<ENTER><lobby')));
  assert.ok(outputs.get('Bob').some((message) => message === '<REMOVE_USER><name>Alice</name></REMOVE_USER>'));
});

test('2013 lobby, room, training and recovery XML preserve the room user initialization sequence', (context) => {
  context.mock.method(Date, 'now', () => 1700000000000);
  const service = new FlashService(new Random(7));
  const output = [];
  const alice = service.connect((xml) => output.push(['Alice', xml]));
  const bob = service.connect((xml) => output.push(['Bob', xml]));
  const viewer = service.connect((xml) => output.push(['Viewer', xml]));
  for (const [session, name] of [[alice, 'Alice'], [bob, 'Bob'], [viewer, 'Viewer']]) {
    service.receive(session, `<LOGIN><name>${name}</name><language>ENGLISH</language><mode>FREE_FIGHT</mode></LOGIN>`);
  }
  service.receive(alice, '<ENTER><name>Fixture</name><playersLimit>2</playersLimit><password>secret</password></ENTER>');
  service.receive(bob, '<ENTER><id>1</id><password>secret</password></ENTER>');
  const bobRoomMessages = output.filter(([name]) => name === 'Bob').map(([, xml]) => xml).slice(-2);
  const bobRoom = children(parseXml(bobRoomMessages[0]), 'room')[0];
  assert.deepEqual(children(bobRoom, 'user').map((user) => field(user, 'name')), ['Alice']);
  assert.equal(bobRoomMessages[1], '<ADD_USER><user><name>Bob</name></user></ADD_USER>');
  service.receive(alice, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  service.receive(bob, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  service.receive(alice, '<CHAT><comment>Hello &amp; welcome</comment></CHAT>');
  service.receive(bob, '<FILTER><user>Alice</user><isFiltered/></FILTER>');
  service.receive(alice, '<READY><isReady/></READY>');
  service.receive(bob, '<READY><isReady/></READY>');
  service.resync(alice);
  service.disconnect(alice);
  service.disconnect(bob);
  service.disconnect(viewer);
  const training = service.connect((xml) => output.push(['Training', xml]));
  service.receive(training, '<LOGIN><name>Training</name><language>ENGLISH</language><mode>TRAINING</mode></LOGIN>');
  for (let tick = 0; tick < 20; tick++) {
    service.tick();
  }
  service.resync(training);
  service.disconnect(training);
  assert.equal(createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    '4745378d38bd3ce3cfabc847d34f9be8f1b9b2c4788f21c1f807fa4e90ecef79');
});

const localToken = (name) => `dogfield-local-${name.toLowerCase().padEnd(32, 'a')}`;
const paidLogin = (name, mode) => `<LOGIN><name>${name}</name><language>ENGLISH</language><mode>${mode}</mode><version>2010</version><fcauth>${localToken(name)}</fcauth></LOGIN>`;
const enterPaid = (service, name, mode) => {
  const messages = [];
  const session = service.connect((xml) => messages.push(xml));
  service.receive(session, paidLogin(name, mode));
  return { session, messages };
};

test('Flash duplicate Training logins play in independent rooms without changing the first game', () => {
  for (const version of ['2013', '2010']) {
    const service = new FlashService(new Random(1));
    const owner = service.connect(() => {});
    const request = login('Alice', 'TRAINING').replace('</LOGIN>', `<version>${version}</version></LOGIN>`);
    service.receive(owner, request);
    const originalRoom = owner.room;
    const originalSnapshot = originalRoom.battle.snapshot(originalRoom.battle.player('Alice'));
    const messages = [];
    const duplicate = service.connect((message) => messages.push(message));
    service.receive(duplicate, request);

    assert.equal(service.sessions.size, 2);
    assert.equal(service.rooms.size, 2);
    assert.notEqual(duplicate.room, originalRoom);
    assert.ok(duplicate.room.battle);
    assert.ok(messages[0].startsWith('<ENTER>'));
    assert.ok(!messages.some((message) => message.startsWith('<ERROR>')));
    service.disconnect(duplicate);
    assert.deepEqual([...service.sessions], [owner]);
    assert.equal(owner.room, originalRoom);
    assert.equal(originalRoom.battle.snapshot(originalRoom.battle.player('Alice')), originalSnapshot);
  }
});

test('Flash duplicate paid logins open lobbies but cannot enter a second game or affect the owner', () => {
  for (const version of ['2013', '2010']) {
    for (const mode of ['DUEL', 'SPIRIT']) {
      const service = new FlashService(new Random(1));
      const token = localToken('Alice');
      const request = login('Alice', mode).replace('</LOGIN>',
        `<version>${version}</version><${version === '2010' ? 'fcauth' : 'userID'}>${token}</${version === '2010' ? 'fcauth' : 'userID'}></LOGIN>`);
      const owner = service.connect(() => {});
      service.receive(owner, request);
      const entry = mode === 'DUEL' ? '<ENTER/>' : '<ENTER><playerCount>2</playerCount></ENTER>';
      service.receive(owner, entry);
      const originalRoom = owner.room;
      const originalCredits = service.accounts.get(token).credits;
      const messages = [];
      const duplicate = service.connect((message) => messages.push(message));
      service.receive(duplicate, request);

      assert.equal(service.sessions.size, 2);
      assert.ok(messages[0].startsWith('<ENTER>'));
      assert.ok(!messages.some((message) => message.startsWith('<ERROR>')));
      messages.length = 0;
      service.receive(duplicate, entry);
      assert.ok(messages[0].startsWith('<ENTER>'));
      assert.ok(messages[1].includes('<message>userExists</message>'));
      assert.equal(duplicate.room, undefined);
      assert.ok(!service.duelQueue.has(duplicate));
      assert.equal(service.accounts.get(token).credits, originalCredits);
      service.disconnect(duplicate);
      assert.deepEqual([...service.sessions], [owner]);
      assert.equal(owner.room, originalRoom);
      if (mode === 'DUEL') {
        assert.ok(service.duelQueue.has(owner));
      } else {
        assert.ok(!originalRoom.battle.over);
      }
    }
  }
});

test('Flash Duel never pairs two active players with the same name across different accounts', () => {
  const service = new FlashService(new Random(1));
  const owner = service.connect(() => {});
  service.receive(owner, paidLogin('Alice', 'DUEL'));
  service.receive(owner, '<ENTER/>');
  const messages = [];
  const duplicate = service.connect((message) => messages.push(message));
  service.receive(duplicate, paidLogin('Alice', 'DUEL').replace(localToken('Alice'), localToken('DifferentAccount')));
  service.receive(duplicate, '<ENTER/>');
  assert.ok(messages.some((message) => message.includes('<message>userExists</message>')));
  assert.deepEqual([...service.duelQueue], [owner]);
  assert.equal(service.rooms.size, 0);
});

test('2010 Duel queues, cancels, pairs humans and charges only at pairing', () => {
  const service = new FlashService(new Random(1));
  const alice = enterPaid(service, 'Alice', 'DUEL');
  const bob = enterPaid(service, 'Bob', 'DUEL');
  assert.ok(alice.messages[0].includes('<straight>0</straight>'));
  service.receive(alice.session, '<ENTER/>');
  service.receive(alice.session, '<ENTER/>');
  assert.equal(service.duelQueue.size, 1);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1000);
  service.receive(alice.session, '<EXIT/>');
  assert.equal(service.duelQueue.size, 0);
  assert.ok(alice.messages.at(-1).includes('<waiting>0</waiting>'));
  service.receive(alice.session, '<ENTER/>');
  service.receive(bob.session, '<ENTER/>');
  assert.equal(alice.session.room, bob.session.room);
  assert.equal(alice.session.room.players.length, 2);
  assert.ok(alice.session.room.players.every((player) => !player.bot));
  assert.equal(service.duelQueue.size, 0);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 950);
  assert.equal(service.accounts.get(localToken('Bob')).credits, 950);
  for (const entrant of [alice, bob]) {
    const entered = parseXml(entrant.messages.find((xml) => xml.startsWith('<ENTER><room>')));
    const enteredRoom = children(entered, 'room')[0];
    assert.equal(children(enteredRoom, 'user').length, 2);
    assert.ok(!entrant.messages.some((xml) => xml.startsWith('<ADD_USER>')));
  }
  assert.ok(alice.messages.some((xml) => xml.startsWith('<STRAIGHT>')));
  assert.ok(alice.messages.some((xml) => xml.startsWith('<START_GAME>')));
  service.receive(alice.session, '<ENTER/>');
  assert.equal(service.accounts.get(localToken('Alice')).credits, 950);
  assert.ok(alice.messages.at(-2).startsWith('<ENTER><room>'));
  assert.ok(alice.messages.at(-1).includes('<message>alreadyInGame</message>'));
});

test('2010 Duel streak bonuses match the original client at every threshold', () => {
  const expectedBonuses = [0, 20, 30, 40, 50, 50];
  for (const [straight, expectedBonus] of expectedBonuses.entries()) {
    assert.equal(duelStraightBonus(straight), expectedBonus);
  }
});

test('2010 Duel disconnects award the client-defined streak payout exactly once', () => {
  const service = new FlashService(new Random(1));
  const alice = enterPaid(service, 'Alice', 'DUEL');
  const bob = enterPaid(service, 'Bob', 'DUEL');
  for (const [name, straight] of [['Alice', 2], ['Bob', 3]]) {
    const account = service.accounts.get(localToken(name));
    account.straight = straight;
    service.accounts.set(localToken(name), account);
  }
  service.receive(alice.session, '<ENTER/>');
  service.receive(bob.session, '<ENTER/>');
  service.disconnect(bob.session);
  const death = alice.messages.findLast((message) => message.startsWith('<DIE>'));
  assert.ok(death.includes('<isLost'));
  assert.ok(!alice.messages.some((message) => message.startsWith('<UNFOG>')));
  const endIndex = alice.messages.findIndex((message) => message.startsWith('<END_GAME'));
  assert.ok(alice.messages[endIndex - 1].startsWith('<END_INNING'));
  assert.ok(!alice.messages.some((message) => message.startsWith('<REMOVE_USER>')));
  assert.equal(alice.session.room.battle.over, true);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1070);
  assert.equal(service.accounts.get(localToken('Alice')).straight, 3);
  assert.equal(service.accounts.get(localToken('Bob')).straight, 0);
  service.disconnect(bob.session);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1070);
  service.receive(alice.session, '<EXIT/>');
  assert.equal(alice.session.room, undefined);
  assert.ok(alice.messages.some((xml) => xml.includes('<straight>3</straight>')));
  assert.equal(service.rooms.size, 0);
});

test('2010 paid modes reject insufficient credits and concurrent use of one account', () => {
  const service = new FlashService(new Random(1));
  const alice = enterPaid(service, 'Alice', 'DUEL');
  const account = service.accounts.get(localToken('Alice'));
  account.credits = 49;
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER/>');
  assert.equal(service.duelQueue.size, 0);
  assert.ok(alice.messages.some((xml) => xml.includes('<message>insufficientFunds</message>')));
  account.credits = 1000;
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER/>');
  const duplicate = service.connect(() => {});
  service.receive(duplicate, paidLogin('Other', 'SPIRIT').replace(localToken('Other'), localToken('Alice')));
  service.receive(duplicate, '<ENTER><playerCount>2</playerCount></ENTER>');
  assert.equal(duplicate.room, undefined);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1000);
  service.disconnect(alice.session);
  assert.equal(service.duelQueue.size, 0);
});

test('Flash paid entry returns the actual rejection reason without reporting server maintenance', () => {
  for (const version of ['2013', '2010']) {
    const fixtures = [
      { mode: 'DUEL', entry: '<ENTER/>', credits: 0, expected: 'insufficientFunds' },
      { mode: 'SPIRIT', entry: '<ENTER><playerCount>2</playerCount></ENTER>', credits: 0, expected: 'insufficientFunds' },
      { mode: 'SPIRIT', entry: '<ENTER><playerCount>3</playerCount></ENTER>', expected: 'caveLocked' },
      { mode: 'SPIRIT', entry: '<ENTER><playerCount>4</playerCount></ENTER>', expected: 'invalidRequest' },
    ];
    if (version === '2010') {
      fixtures.push({ mode: 'SPIRIT', entry: '<ENTER><playerCount>2</playerCount></ENTER>', hasPaid: false, expected: 'paymentRequired' });
    }
    for (const fixture of fixtures) {
      const service = new FlashService(new Random(1));
      const token = localToken('Alice');
      const tokenField = version === '2010' ? 'fcauth' : 'userID';
      const messages = [];
      const session = service.connect((message) => messages.push(message));
      service.receive(session, login('Alice', fixture.mode).replace('</LOGIN>',
        `<version>${version}</version><${tokenField}>${token}</${tokenField}></LOGIN>`));
      const account = service.accounts.get(token);
      account.credits = fixture.credits ?? 1000;
      account.hasPaid = fixture.hasPaid ?? true;
      service.accounts.set(token, account);
      messages.length = 0;
      service.receive(session, fixture.entry);
      assert.ok(messages[0].startsWith('<ENTER>'));
      assert.equal(field(parseXml(messages[1]), 'message'), fixture.expected);
      assert.ok(!messages.some((message) => message.includes('<message>isLocked</message>')));
      assert.equal(service.rooms.size, 0);
      assert.equal(service.duelQueue.size, 0);
      assert.equal(service.accounts.get(token).credits, fixture.credits ?? 1000);
    }
  }
  const service = new FlashService();
  const messages = [];
  const guest = service.connect((message) => messages.push(message));
  service.receive(guest, login('Guest', 'DUEL'));
  service.receive(guest, '<ENTER/>');
  assert.ok(messages.some((message) => message.includes('<message>loginRequired</message>')));
  assert.equal(service.duelQueue.size, 0);
});

test('Flash Duel payment changes report insufficient funds only to the account that cannot pay', () => {
  for (const version of ['2013', '2010']) {
    const service = new FlashService(new Random(1));
    const tokenField = version === '2010' ? 'fcauth' : 'userID';
    const enter = (name) => {
      const token = localToken(name);
      const messages = [];
      const session = service.connect((message) => messages.push(message));
      service.receive(session, login(name, 'DUEL').replace('</LOGIN>',
        `<version>${version}</version><${tokenField}>${token}</${tokenField}></LOGIN>`));
      service.receive(session, '<ENTER/>');
      return { session, messages, token };
    };
    const alice = enter('Alice');
    const account = service.accounts.get(alice.token);
    account.credits = 0;
    service.accounts.set(alice.token, account);
    const bob = enter('Bob');
    assert.ok(alice.messages.some((message) => message.includes('<message>insufficientFunds</message>')));
    assert.ok(bob.messages.some((message) => message.includes('<message>opponentUnavailable</message>')));
    assert.ok(!bob.messages.some((message) => message.includes('<message>insufficientFunds</message>')));
    assert.ok(![...alice.messages, ...bob.messages].some((message) => message.includes('<message>isLocked</message>')));
    assert.equal(service.accounts.get(bob.token).credits, 1000);
    assert.equal(service.rooms.size, 0);
    assert.equal(service.duelQueue.size, 0);
  }
});

test('2010 Spirit enforces cave unlocks, payment and bot-only opponents for every size', () => {
  const service = new FlashService(new Random(1));
  const alice = enterPaid(service, 'Alice', 'SPIRIT');
  service.receive(alice.session, '<ENTER><playerCount>3</playerCount></ENTER>');
  assert.equal(alice.session.room, undefined);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1000);
  for (const count of [0, 1, 4, 10, 2.5]) {
    service.receive(alice.session, `<ENTER><playerCount>${count}</playerCount></ENTER>`);
    assert.equal(alice.session.room, undefined);
  }
  for (const [index, playerCount] of [2, 3, 5, 7, 9].entries()) {
    const name = `Player${playerCount}`;
    const current = enterPaid(service, name, 'SPIRIT');
    const account = service.accounts.get(localToken(name));
    if (index > 0) {
      account.spirit[[2, 3, 5, 7, 9][index - 1]] = { game: 5, score: 10, best: 0 };
      service.accounts.set(localToken(name), account);
    }
    service.receive(current.session, `<ENTER><playerCount>${playerCount}</playerCount></ENTER>`);
    const room = current.session.room;
    assert.equal(room.players.length, playerCount);
    assert.equal(room.players.filter((player) => player.bot).length, playerCount - 1);
    assert.equal(service.accounts.get(localToken(name)).credits, 1000 - [50, 50, 50, 75, 125][index]);
    service.disconnect(current.session);
    assert.deepEqual(service.accounts.get(localToken(name)).spirit[playerCount], { game: 1, score: 0, best: 0 });
  }
});

test('2010 Spirit settles wins, 100-game records and unlocked history once', () => {
  const service = new FlashService(new Random(1));
  const alice = enterPaid(service, 'Alice', 'SPIRIT');
  const account = service.accounts.get(localToken('Alice'));
  account.spirit[2] = { game: 99, score: 40, best: 0 };
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  const room = alice.session.room;
  room.battle.forfeit(room.players.find((player) => player.bot).name);
  service.flush(room);
  assert.deepEqual(service.accounts.get(localToken('Alice')).spirit[2], { game: 100, score: 42, best: 42 });
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1010);
  service.flush(room);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1010);
  service.receive(alice.session, '<EXIT/>');
  service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  service.disconnect(alice.session);
  assert.deepEqual(service.accounts.get(localToken('Alice')).spirit[2], { game: 1, score: 0, best: 42 });
});

test('Flash local credits and Spirit records persist through Store reload and APIs', async () => {
  const { FlashAccounts } = await import('../flash/accounts.ts');
  const { Store } = await import('../store.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'flash-account-'));
  try {
    const filename = join(directory, 'state.json');
    const accounts = new FlashAccounts(new Store(filename), 700);
    const account = accounts.get(localToken('Alice'));
    account.credits = 650;
    account.spirit[2] = { game: 10, score: 12, best: 0 };
    const modern = account2013(account);
    modern.coin = 125;
    modern.ticket = 'DUEL';
    modern.scoreBonus = 30;
    modern.duel = { game: 3, win: 1, draw: 1 };
    modern.spirit[2] = { game: 7, score: 8, best: 15 };
    accounts.set(localToken('Alice'), account);
    const fixture = await createServer({ store: new Store(filename), botInterval: 0 });
    try {
      const data = await fixture.server.inject(`/flash/api/getData?fcauth=${localToken('Alice')}`);
      assert.equal(field(parseXml(data.body), 'charin'), '650');
      assert.ok(data.body.includes('<hasPaid/>'));
      const records = await fixture.server.inject(`/flash/api/getRecord?fcauth=${localToken('Alice')}`);
      assert.ok(records.body.includes('<record mode="2"><game>10</game><score>12</score></record>'));
      const coin = await fixture.server.inject(`/flash/api/getCoin?userID=${localToken('Alice')}`);
      assert.equal(coin.body, '<response><coin>125</coin><ticket>DUEL</ticket></response>');
      const spirit = await fixture.server.inject(`/flash/api/getSpiritResult?userID=${localToken('Alice')}`);
      assert.ok(spirit.body.includes('<result mode="2"><game>7</game><score>8</score></result><bestResult mode="2"><score>15</score></bestResult>'));
      const restored = fixture.flash.accounts.get(localToken('Alice')).flash2013;
      assert.equal(restored.scoreBonus, 30);
      assert.deepEqual(restored.duel, { game: 3, win: 1, draw: 1 });
      const anonymous = await fixture.server.inject('/flash/api/getData');
      assert.equal(field(parseXml(anonymous.body), 'charin'), '0');
    } finally {
      await fixture.server.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('2010 paid matches settle after ordinary authoritative battle completion', () => {
  for (const mode of ['DUEL', 'SPIRIT']) {
    for (const seed of [1, 7, 42]) {
      const service = new FlashService(new Random(seed));
      const alice = enterPaid(service, 'Alice', mode);
      service.receive(alice.session, mode === 'DUEL' ? '<ENTER/>' : '<ENTER><playerCount>2</playerCount></ENTER>');
      if (mode === 'DUEL') {
        const bob = enterPaid(service, 'Bob', mode);
        service.receive(bob.session, '<ENTER/>');
      }
      const room = alice.session.room;
      // Drive every seat through the regular bot command path for this fixture.
      for (const player of room.players) {
        player.bot = true;
      }
      let tickCount = 0;
      while (!room.battle.over && tickCount < 10000) {
        service.tick();
        tickCount++;
      }
      assert.ok(room.battle.over, `${mode} seed ${seed} must finish`);
      assert.equal(room.settled, true);
      const winners = room.players.filter((player) => !player.lost);
      const aliceWon = winners.some((player) => player.name === 'Alice');
      const account = service.accounts.get(localToken('Alice'));
      const bonus = mode === 'DUEL' ? 50 : 60;
      assert.equal(account.credits, 950 + (aliceWon ? Math.floor(bonus / winners.length) : 0));
      if (mode === 'SPIRIT') {
        assert.deepEqual(account.spirit[2], { game: 1, score: aliceWon ? Math.floor(2 / winners.length) : 0, best: 0 });
      }
      const balance = account.credits;
      service.flush(room);
      assert.equal(service.accounts.get(localToken('Alice')).credits, balance);
    }
  }
});

test('Flash Broom removes artifacts without dealing replacements to the victim', () => {
  for (const version of ['2013', '2010']) {
    const broomId = version === '2013' ? 240 : 350;
    const knifeId = version === '2013' ? 5 : 8;
    for (const selfTarget of [false, true]) {
      const attacker = newFlashPlayer('Alice');
      const victim = newFlashPlayer('Bob');
      const localPiece = (itemId) => ({ item: itemAt(itemId, version), costMP: 0 });
      attacker.items = [broomId, knifeId, knifeId, knifeId].map(localPiece);
      victim.items = [knifeId, knifeId, knifeId, knifeId].map(localPiece);
      const battle = new FlashBattle([attacker, victim], new Random(7), version);
      const target = selfTarget ? attacker : victim;
      const removedCount = itemAt(broomId, version).value;
      battle.submit('Alice', command([broomId], target.name));
      if (battle.pending) {
        battle.submit('Bob', command([]));
      }
      assert.equal(target.items.length, 4 - removedCount);
      const deals = battle.drain().filter((message) => message.xml.startsWith('<DEAL>'));
      assert.equal(deals.filter((message) => message.recipient === target.name).length, selfTarget ? 1 : 0);
      assert.equal(attacker.items.length, selfTarget ? 4 - removedCount : 4);
      assert.equal(battle.expected.name, 'Bob');
    }
  }
});

test('Flash reflected dying attacks finish instead of awaiting a dead player', () => {
  for (const version of ['2013', '2010']) {
    const bowId = version === '2013' ? 117 : 178;
    const mirrorId = version === '2013' ? 196 : 306;
    const first = newFlashPlayer('Alice');
    const second = newFlashPlayer('Bob');
    const bow = { item: itemAt(bowId, version), costMP: 0 };
    first.items = [bow];
    second.items = [{ item: itemAt(mirrorId, version), costMP: 0 }];
    const battle = new FlashBattle([first, second], new Random(1), version);
    first.dead = true;
    first.hp = 0;
    battle.pending = {
      ...attackOf([bow]), value: 30, commander: 'Alice', attacker: 'Alice', defender: 'Bob',
      removedAttribute: false, history: [], dying: true,
    };
    battle.submit('Bob', command([mirrorId]));
    assert.equal(battle.pending, undefined);
    assert.equal(battle.over, true);
    assert.equal(first.lost, true);
    assert.equal(second.hp, 40);
    assert.ok(battle.drain().some((message) => message.xml.startsWith('<END_GAME')));
  }

  const players = ['Alice', 'Bob', 'Carol', 'Dave'].map((name) => newFlashPlayer(name, 'SINGLE', true));
  const replay = new FlashBattle(players, new Random(204));
  replay.start();
  let actions = 0;
  while (!replay.over && actions < 2000) {
    assert.equal(replay.stepBot(), true);
    actions++;
  }
  assert.equal(replay.over, true);
});

test('Flash money-stealing counters cannot increase the balance of their dead owner', () => {
  for (const version of ['2013', '2010']) {
    const knifeId = version === '2013' ? 5 : 8;
    const ringId = version === '2013' ? 194 : 304;
    const first = newFlashPlayer('Alice');
    const second = newFlashPlayer('Bob');
    first.items = [{ item: itemAt(knifeId, version), costMP: 0 }];
    second.items = [{ item: itemAt(ringId, version), costMP: 0 }];
    const battle = new FlashBattle([first, second], new Random(1), version);
    second.hp = 1;
    battle.submit('Alice', command([knifeId], 'Bob'));
    battle.submit('Bob', command([ringId]));
    assert.equal(second.dead, true);
    assert.equal(battle.pending.commander, 'Bob');
    battle.submit('Alice', command([]));
    assert.equal(first.yen, 19);
    assert.equal(second.yen, 20);
    assert.equal(second.hp, 0);
  }
});

const enterPaid2013 = (service, name, mode) => {
  const messages = [];
  const session = service.connect((message) => messages.push(message));
  service.receive(session, `<LOGIN><name>${name}</name><language>ENGLISH</language><mode>${mode}</mode><userID>${localToken(name)}</userID></LOGIN>`);
  return { session, messages };
};

test('2013 paid modes use userID identity and the original round and result protocol', () => {
  const service = new FlashService(new Random(9));
  const alice = enterPaid2013(service, 'Alice', 'DUEL');
  assert.equal(alice.messages[0], '<ENTER><win>0</win><draw>0</draw><lose>0</lose><scoreBonus>0</scoreBonus></ENTER>');
  const bob = enterPaid2013(service, 'Bob', 'DUEL');
  const account = service.accounts.get(localToken('Alice'));
  account.flash2013 = { coin: 100, ticket: 'DUEL', scoreBonus: 30,
    duel: { game: 14, win: 8, draw: 2 }, years: {}, spirit: {} };
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER/>');
  assert.equal(service.accounts.get(localToken('Alice')).flash2013.ticket, 'DUEL');
  service.receive(alice.session, '<EXIT/>');
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1000);
  service.receive(alice.session, '<ENTER/>');
  service.receive(bob.session, '<ENTER/>');
  const charged = service.accounts.get(localToken('Alice'));
  assert.equal(charged.flash2013.ticket, undefined);
  assert.equal(charged.flash2013.coin, 100);
  assert.equal(charged.credits, 1000);
  assert.ok(alice.messages.includes('<SCORE_BONUS><scoreBonus>30</scoreBonus><anotherScoreBonus>0</anotherScoreBonus></SCORE_BONUS>'));
  assert.ok(!alice.messages.some((message) => message.startsWith('<STRAIGHT>')));
  const room = alice.session.room;
  service.disconnect(bob.session);
  const settled = service.accounts.get(localToken('Alice'));
  assert.equal(settled.flash2013.coin, 180);
  assert.deepEqual(settled.flash2013.duel, { game: 15, win: 9, draw: 2 });
  assert.equal(settled.straight, 0, '2010 streaks must remain separate');
  const year = new Date().getUTCFullYear();
  assert.ok(service.accounts.duelResultXml(localToken('Alice'), year).includes('<round><win>9</win><draw>2</draw><date>'));
  service.flush(room);
  assert.equal(service.accounts.get(localToken('Alice')).flash2013.coin, 180, 'settlement is idempotent');
  service.receive(alice.session, '<EXIT/>');
  assert.ok(alice.messages.at(-2).includes('<win>9</win><draw>2</draw><lose>4</lose><scoreBonus>30</scoreBonus>'));
});

test('2013 Duel accepts whole fees in coins or Charin, never combined insufficient balances', () => {
  for (const fixture of [
    { coin: 50, credits: 0, allowed: true, remainingCoin: 0, remainingCredits: 0 },
    { coin: 49, credits: 50, allowed: true, remainingCoin: 49, remainingCredits: 0 },
    { coin: 49, credits: 49, allowed: false, remainingCoin: 49, remainingCredits: 49 },
    { coin: 0, credits: 0, ticket: 'SPIRIT', allowed: false, remainingCoin: 0, remainingCredits: 0 },
    { coin: 0, credits: 0, ticket: 'DUEL', allowed: true, remainingCoin: 0, remainingCredits: 0 },
  ]) {
    const service = new FlashService(new Random(11));
    const alice = enterPaid2013(service, 'Alice', 'DUEL');
    const bob = enterPaid2013(service, 'Bob', 'DUEL');
    const account = service.accounts.get(localToken('Alice'));
    account.credits = fixture.credits;
    account.flash2013 = { coin: fixture.coin, ticket: fixture.ticket, scoreBonus: 0,
      duel: { game: 0, win: 0, draw: 0 }, years: {}, spirit: {} };
    service.accounts.set(localToken('Alice'), account);
    service.receive(alice.session, '<ENTER/>');
    assert.equal(service.duelQueue.has(alice.session), fixture.allowed);
    service.receive(bob.session, '<ENTER/>');
    assert.equal(Boolean(alice.session.room), fixture.allowed);
    const charged = service.accounts.get(localToken('Alice'));
    assert.equal(charged.credits, fixture.remainingCredits);
    assert.equal(charged.flash2013.coin, fixture.remainingCoin);
  }
});

test('2013 Spirit uses Charin without the 2010 hasPaid gate and isolates cave records', () => {
  for (const [modeIndex, playerCount] of [2, 3, 5, 7, 9].entries()) {
    const service = new FlashService(new Random(13));
    const alice = enterPaid2013(service, 'Alice', 'SPIRIT');
    const account = service.accounts.get(localToken('Alice'));
    account.hasPaid = false;
    account.spirit[2] = { game: 99, score: 100, best: 200 };
    service.accounts.set(localToken('Alice'), account);
    if (modeIndex > 0) {
      service.receive(alice.session, `<ENTER><playerCount>${playerCount}</playerCount></ENTER>`);
      assert.equal(alice.session.room, undefined, '2010 scores cannot unlock 2013 caves');
      const updated = service.accounts.get(localToken('Alice'));
      account2013(updated).spirit[[2, 3, 5, 7, 9][modeIndex - 1]] = { game: 5, score: 10, best: 0 };
      service.accounts.set(localToken('Alice'), updated);
    }
    service.receive(alice.session, `<ENTER><playerCount>${playerCount}</playerCount></ENTER>`);
    assert.equal(alice.session.room.players.length, playerCount);
    assert.equal(service.accounts.get(localToken('Alice')).credits, 1000 - [50, 50, 50, 75, 125][modeIndex]);
    const room = alice.session.room;
    room.battle.players.forEach((player) => { player.lost = player.name !== 'Alice'; });
    room.battle.over = true;
    service.flush(room);
    const result = service.accounts.get(localToken('Alice'));
    assert.deepEqual(result.flash2013.spirit[playerCount], { game: 1, score: playerCount, best: 0 });
    assert.deepEqual(result.spirit[2], { game: 99, score: 100, best: 200 });
    assert.equal(result.credits, 1000 - [50, 50, 50, 75, 125][modeIndex] + [60, 75, 90, 160, 300][modeIndex]);
    assert.ok(service.accounts.recordsXml(localToken('Alice'), '2013').includes(`<result mode="${playerCount}"><game>1</game><score>${playerCount}</score></result>`));
  }
});

test('2013 paid APIs use the SWF userID, ticket, result and bestResult fields', async () => {
  const fixture = await createServer({ botInterval: 0 });
  try {
    const token = localToken('Alice');
    const account = fixture.flash.accounts.get(token);
    account.flash2013 = { coin: 75, ticket: 'DUEL', scoreBonus: 0,
      duel: { game: 0, win: 0, draw: 0 }, years: {}, spirit: { 2: { game: 100, score: 25, best: 25 } } };
    fixture.flash.accounts.set(token, account);
    const coin = await fixture.server.inject(`/flash/api/getCoin?userID=${token}`);
    assert.equal(coin.body, '<response><coin>75</coin><ticket>DUEL</ticket></response>');
    const charin = await fixture.server.inject(`/flash/api/getData?userID=${token}`);
    assert.equal(field(parseXml(charin.body), 'charin'), '1000');
    const spirit = await fixture.server.inject(`/flash/api/getSpiritResult?userID=${token}`);
    assert.ok(spirit.body.includes('<result mode="2"><game>100</game><score>25</score></result><bestResult mode="2"><score>25</score></bestResult>'));
    const duel = await fixture.server.inject(`/flash/api/getDuelResult?userID=${token}&year=2013`);
    assert.ok(duel.body.includes('<result><game>0</game><win>0</win><draw>0</draw>'));
    assert.equal((await fixture.server.inject(`/flash/api/getDuelResult?userID=${token}&year=bad`)).statusCode, 400);
  } finally {
    await fixture.server.close();
  }
});

test('2013 Duel rechecks both balances before charging and permits unpaid lobby observers', () => {
  const service = new FlashService(new Random(14));
  const guestMessages = [];
  const guest = service.connect((message) => guestMessages.push(message));
  service.receive(guest, '<LOGIN><name>Guest</name><language>JAPANESE</language><mode>DUEL</mode></LOGIN>');
  assert.ok(guestMessages[0].startsWith('<ENTER><win>0</win>'));
  service.receive(guest, '<ENTER/>');
  assert.equal(guest.room, undefined);
  assert.equal(service.duelQueue.has(guest), false);
  const alice = enterPaid2013(service, 'Alice', 'DUEL');
  const bob = enterPaid2013(service, 'Bob', 'DUEL');
  service.receive(alice.session, '<ENTER/>');
  const account = service.accounts.get(localToken('Alice'));
  account.credits = 0;
  service.accounts.set(localToken('Alice'), account);
  service.receive(bob.session, '<ENTER/>');
  assert.equal(service.rooms.size, 0);
  assert.equal(service.accounts.get(localToken('Bob')).credits, 1000);
});

test('2013 Duel draws share the full score bonus pool and restart the 15-game round', () => {
  const service = new FlashService(new Random(15));
  const alice = enterPaid2013(service, 'Alice', 'DUEL');
  const bob = enterPaid2013(service, 'Bob', 'DUEL');
  for (const [name, scoreBonus] of [['Alice', 30], ['Bob', 50]]) {
    const account = service.accounts.get(localToken(name));
    const modern = account2013(account);
    modern.scoreBonus = scoreBonus;
    modern.duel = { game: 15, win: 9, draw: 2 };
    service.accounts.set(localToken(name), account);
  }
  service.receive(alice.session, '<ENTER/>');
  service.receive(bob.session, '<ENTER/>');
  const room = alice.session.room;
  room.battle.players.forEach((player) => { player.lost = false; });
  room.battle.over = true;
  service.flush(room);
  for (const name of ['Alice', 'Bob']) {
    const account = service.accounts.get(localToken(name));
    assert.equal(account.flash2013.coin, 65, '(50 + 30 + 50) / 2, including both bonuses in draws');
    assert.equal(account.credits, 950);
    assert.deepEqual(account.flash2013.duel, { game: 1, win: 0, draw: 1 });
  }
});

test('2013 Spirit cannot spend God Coins or tickets and retains its 100-game best result', () => {
  const service = new FlashService(new Random(16));
  const alice = enterPaid2013(service, 'Alice', 'SPIRIT');
  const account = service.accounts.get(localToken('Alice'));
  account.credits = 49;
  const modern = account2013(account);
  modern.coin = 500;
  modern.ticket = 'SPIRIT';
  modern.spirit[2] = { game: 99, score: 40, best: 10 };
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  assert.equal(alice.session.room, undefined);
  account.credits = 50;
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  const room = alice.session.room;
  room.battle.players.forEach((player) => { player.lost = player.name !== 'Alice'; });
  room.battle.over = true;
  service.flush(room);
  const settled = service.accounts.get(localToken('Alice'));
  assert.deepEqual(settled.flash2013.spirit[2], { game: 100, score: 42, best: 42, completed: true });
  assert.equal(settled.credits, 60);
  assert.equal(settled.flash2013.coin, 500);
  assert.equal(settled.flash2013.ticket, 'SPIRIT');
  service.receive(alice.session, '<EXIT/>');
  service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  service.disconnect(alice.session);
  assert.deepEqual(service.accounts.get(localToken('Alice')).flash2013.spirit[2], { game: 100, score: 42, best: 42, completed: true }, 'A disconnect waits for the recovery deadline before recording a loss');
});

test('automatic Megumi-san removal never deals into a nonexistent client card cover', () => {
  for (const version of ['2010', '2013']) {
    const knifeId = version === '2010' ? 8 : 5;
    const firstMegumiId = version === '2010' ? 361 : 251;
    for (const [variantIndex, stat] of ['hp', 'mp', 'yen'].entries()) {
      const owner = newFlashPlayer('Alice');
      const opponent = newFlashPlayer('Bob');
      const megumiId = firstMegumiId + variantIndex;
      owner.items = [knifeId, megumiId].map((itemId) => ({ item: itemAt(itemId, version), costMP: 0 }));
      const random = new Random(7);
      const originalPick = random.pick.bind(random);
      random.pick = (label, values, weight) => label === 'flashCreatureTarget'
        ? values.find((player) => player.name === owner.name) : originalPick(label, values, weight);
      const battle = new FlashBattle([owner, opponent], random, version);
      const before = owner[stat];
      battle.submit(owner.name, command([knifeId], opponent.name));
      battle.submit(opponent.name, command([]));
      assert.equal(owner[stat], before + 20);
      assert.equal(owner.items.length, 1, 'Only the consumed knife is replaced; automatic creatures create no cover');
      assert.ok(!owner.items.some((piece) => piece.item.id === megumiId));
      const messages = battle.drain();
      const deals = messages.filter((message) => message.recipient === owner.name && message.xml.startsWith('<DEAL>'));
      assert.equal(deals.length, 1, `${version} ${stat} must not send an extra replacement`);
      assert.equal(battle.inning, 1, 'The next inning must start after the creature effect');
      assert.equal(battle.pending, undefined);
    }
  }
});

test('local 2013 lottery outcomes, cooldown and retry results do not double-grant', () => {
  for (const roll of [0, 1]) {
    let now = 100999;
    let selections = 0;
    const accounts = new FlashAccounts(new Store(), 700, {
      now: () => now,
      randomInt: (maximum) => {
        assert.equal(maximum, 2);
        selections++;
        return roll;
      },
    });
    const token = localToken(`Lottery${roll}`);
    const claim = accounts.drawLot(token);
    const claimedAt = 100000;
    assert.deepEqual(claim, roll === 0 ? { claimedAt, coin: 25 } : { claimedAt, coin: 0, ticket: 'DUEL' });
    assert.deepEqual(accounts.drawLot(token), claim);
    now = claimedAt + flashLotteryInterval - 1;
    assert.deepEqual(accounts.drawLot(token), claim);
    assert.equal(selections, 1, 'Cooldown retries must not consume entropy or grant rewards');
    const before = accounts.get(token);
    assert.equal(before.credits, 700, 'Lottery does not spend or award Charin');
    assert.deepEqual(before.spirit, {});
    assert.equal(before.straight, 0);
    assert.equal(before.flash2013.coin, roll === 0 ? 25 : 0);
    now++;
    const next = accounts.drawLot(token);
    assert.equal(selections, 2);
    assert.equal(next.claimedAt, now, 'A new reward becomes claimable exactly at 20 hours');
    assert.equal(next.coin, roll === 0 ? 25 : 0, 'Duplicate tickets overwrite the existing slot without awarding coins');
    assert.equal(accounts.get(token).flash2013.coin, roll === 0 ? 50 : 0);
    if (roll === 1) {
      assert.equal(accounts.get(token).flash2013.ticket, 'DUEL', 'Keep the original unspent ticket');
      assert.equal(next.ticket, 'DUEL');
    }
  }
});

test('2013 lottery API persists rewards before getCoin and concurrent retries grant only once', async () => {
  const fixture = await createServer({ botInterval: 0 });
  try {
    const token = localToken('Lottery');
    const battleSeed = fixture.flash.random.seed;
    const responses = await Promise.all(Array.from({ length: 8 }, () => fixture.server.inject(`/flash/api/drawLot?userID=${token}`)));
    const expected = responses[0].body;
    assert.ok(['<response><coin>25</coin></response>', '<response><coin>0</coin><ticket>DUEL</ticket></response>'].includes(expected));
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, expected);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    const balance = await fixture.server.inject(`/flash/api/getCoin?userID=${token}`);
    assert.equal(balance.body, expected);
    assert.equal(fixture.flash.random.seed, battleSeed, 'Lottery entropy must not change battle RNG');
    assert.equal((await fixture.server.inject('/flash/api/drawLot')).statusCode, 403);
    assert.equal((await fixture.server.inject('/flash/api/drawLot?userID=invalid')).statusCode, 403);
    assert.equal((await fixture.server.inject(`/flash/api/drawLot?fcauth=${token}`)).statusCode, 403, '2010 authentication cannot issue 2013 rewards');
  } finally {
    await fixture.server.close();
  }
});

test('lottery rewards and eligibility survive Store reload and a claimed ticket funds Duel entry', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'flash-lottery-'));
  try {
    const filename = join(directory, 'state.json');
    const token = localToken('Alice');
    const accounts = new FlashAccounts(new Store(filename), 0, { randomInt: () => 1, now: () => 1000 });
    const claim = accounts.drawLot(token);
    let selections = 0;
    const restored = new FlashAccounts(new Store(filename), 0, {
      now: () => 1001,
      randomInt: () => {
        selections++;
        return 1;
      },
    });
    assert.deepEqual(restored.drawLot(token), claim);
    assert.equal(selections, 0, 'Server restart must not reset eligibility');
    const service = new FlashService(new Random(19), restored);
    const alice = enterPaid2013(service, 'Alice', 'DUEL');
    const bob = enterPaid2013(service, 'Bob', 'DUEL');
    restored.drawLot(localToken('Bob'));
    service.receive(alice.session, '<ENTER/>');
    service.receive(bob.session, '<ENTER/>');
    assert.ok(alice.session.room?.battle, 'The original ticket entry alternative works without any currency');
    assert.equal(restored.get(token).flash2013.ticket, undefined);
    assert.equal(restored.get(token).flash2013.coin, 0);
    assert.equal(restored.get(token).credits, 0);
    assert.deepEqual(restored.drawLot(token), claim);
    assert.equal(restored.get(token).flash2013.ticket, undefined, 'Replaying a spent prize must not restore its ticket');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('2013 encyclopedia uses the original collection IDs, all 434 entries and localized metadata', () => {
  assert.equal(flashBookCost, 10);
  assert.equal(flashBookEntries.length, flashBookCount);
  assert.deepEqual(flashBookEntries.map((entry) => entry.id), Array.from({ length: 434 }, (_unused, index) => index));
  assert.equal(new Set(flashBookEntries.slice(0, 364).map((entry) => entry.itemId)).size, 364);
  assert.equal(flashBookEntries[5].itemId, 8, 'Book order differs from battle item order');
  assert.equal(flashBookEntries[9].itemId, 254);
  assert.equal(flashBookEntries[364].kind, 'Harm');
  assert.equal(flashBookEntries[372].kind, 'Assistant');
  assert.equal(flashBookEntries[382].kind, 'AssistantItem');
  assert.equal(flashBookEntries[424].kind, 'Mystery');
  assert.ok(flashBookEntries[433].text.ja.startsWith('日食'));
  assert.ok(flashBookEntries.every((entry) => entry.text.en && entry.text.ja));
});

test('local encyclopedia draws spend ten banked Magatama, reveal one new entry and never duplicate', () => {
  const accounts = new FlashAccounts();
  const token = localToken('Book');
  accounts.addBookScore(token, 20);
  const first = parseXml(`<response>${accounts.addBookElement(token, 'JAPANESE', (maximum) => maximum - 1)}</response>`);
  assert.equal(field(first, 'score'), '10');
  assert.equal(children(first, 'element').length, 1);
  assert.equal(children(first, 'element')[0].attributes.id, '433');
  assert.ok(field(children(first, 'element')[0], 'text').startsWith('日食'));
  const second = parseXml(`<response>${accounts.addBookElement(token, 'ENGLISH', () => 0)}</response>`);
  assert.equal(field(second, 'score'), '0');
  assert.equal(children(second, 'element')[0].attributes.id, '0');
  const account = accounts.get(token);
  assert.deepEqual(account.flash2013.book, { score: 0, elements: [433, 0] });
  assert.equal(account.credits, 1000);
  assert.equal(account.flash2013.coin, 0);
  assert.deepEqual(account.spirit, {});
  assert.throws(() => accounts.addBookElement(token, 'JAPANESE'), { status: 409 });
  assert.deepEqual(accounts.get(token), account, 'Insufficient balance cannot mutate the bank or collection');
  account.flash2013.book = { score: 20, elements: flashBookEntries.filter((entry) => entry.id !== 9).map((entry) => entry.id) };
  accounts.set(token, account);
  const last = parseXml(`<response>${accounts.addBookElement(token, 'JAPANESE', () => 0)}</response>`);
  assert.equal(children(last, 'element')[0].attributes.id, '9');
  assert.equal(accounts.get(token).flash2013.book.elements.length, 434);
  assert.throws(() => accounts.addBookElement(token, 'JAPANESE'), { status: 409 });
  assert.equal(accounts.get(token).flash2013.book.score, 10, 'A full encyclopedia cannot charge another draw');
});

test('2013 Magatama are awarded only for Duel and Spirit victories, once per game', () => {
  for (const mode of ['TRAINING', 'FREE_FIGHT', 'DUEL', 'SPIRIT']) {
    const service = new FlashService(new Random(23));
    const alice = enterPaid2013(service, 'Alice', mode);
    if (mode === 'DUEL') {
      const bob = enterPaid2013(service, 'Bob', mode);
      service.receive(alice.session, '<ENTER/>');
      service.receive(bob.session, '<ENTER/>');
    } else if (mode === 'SPIRIT') {
      service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
    } else if (mode === 'FREE_FIGHT') {
      const bob = enterPaid2013(service, 'Bob', mode);
      service.receive(alice.session, '<ENTER><name>Book fixture</name><playersLimit>2</playersLimit></ENTER>');
      service.receive(bob.session, `<ENTER><id>${alice.session.room.id}</id></ENTER>`);
      for (const session of [alice.session, bob.session]) {
        service.receive(session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
        service.receive(session, '<READY><isReady/></READY>');
      }
    }
    const room = alice.session.room;
    room.players.forEach((player) => { player.lost = player.name !== 'Alice'; });
    room.battle.over = true;
    service.flush(room);
    const expectedScore = mode === 'DUEL' || mode === 'SPIRIT' ? room.players.length : undefined;
    assert.equal(service.accounts.get(localToken('Alice')).flash2013?.book?.score, expectedScore);
    service.flush(room);
    assert.equal(service.accounts.get(localToken('Alice')).flash2013?.book?.score, expectedScore, 'Repeated flush cannot double-credit a victory');
    if (mode === 'FREE_FIGHT' || mode === 'DUEL') {
      assert.equal(service.accounts.get(localToken('Bob')).flash2013?.book, undefined, 'Losers receive no book score');
    }
    if (mode === 'FREE_FIGHT') {
      for (const session of room.users) {
        service.receive(session, '<FINISH_GAME/>');
      }
      assert.equal(room.battle, undefined);
      for (const session of room.users) {
        service.receive(session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
        service.receive(session, '<READY><isReady/></READY>');
      }
      room.players.forEach((player) => { player.lost = player.name !== 'Alice'; });
      room.battle.over = true;
      service.flush(room);
      assert.equal(service.accounts.get(localToken('Alice')).flash2013?.book, undefined, 'Free Fight rematches do not award encyclopedia points');
    }
  }
});

test('shared 2013 victories split Magatama and 2010 matches leave the new book bank untouched', () => {
  const service = new FlashService(new Random(24));
  const alice = enterPaid2013(service, 'Alice', 'SPIRIT');
  const account = service.accounts.get(localToken('Alice'));
  account2013(account).spirit[3] = { game: 5, score: 10, best: 0 };
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER><playerCount>5</playerCount></ENTER>');
  const room = alice.session.room;
  room.players.forEach((player, index) => { player.lost = index >= 3; });
  room.battle.over = true;
  service.flush(room);
  assert.equal(service.accounts.get(localToken('Alice')).flash2013.book.score, 1, 'floor(5 players / 3 winners)');
  const legacy = enterPaid(service, 'Legacy', 'SPIRIT');
  service.receive(legacy.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  const legacyRoom = legacy.session.room;
  legacyRoom.players.forEach((player) => { player.lost = player.name !== 'Legacy'; });
  legacyRoom.battle.over = true;
  service.flush(legacyRoom);
  assert.equal(service.accounts.get(localToken('Legacy')).flash2013, undefined);
});

test('encyclopedia APIs persist collections, reject forged draws and serialize concurrent spending', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'flash-book-'));
  const filename = join(directory, 'state.json');
  const token = localToken('Alice');
  try {
    const fixture = await createServer({ store: new Store(filename), botInterval: 0 });
    try {
      fixture.flash.accounts.addBookScore(token, 10);
      const seed = fixture.flash.random.seed;
      const endpoint = `/flash/api/addBookElement?userID=${token}&language=JAPANESE`;
      const attempts = await Promise.all([fixture.server.inject(endpoint), fixture.server.inject(endpoint)]);
      assert.deepEqual(attempts.map((attempt) => attempt.statusCode).sort(), [200, 409]);
      const response = attempts.find((attempt) => attempt.statusCode === 200);
      assert.equal(children(parseXml(response.body), 'element').length, 1);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(fixture.flash.random.seed, seed, 'Book draws do not consume battle entropy');
      assert.equal((await fixture.server.inject('/flash/api/addBookElement')).statusCode, 403);
      assert.equal((await fixture.server.inject(`/flash/api/addBookElement?fcauth=${token}`)).statusCode, 403);
      assert.equal((await fixture.server.inject(`${endpoint}&language=invalid`)).statusCode, 400);
      assert.equal((await fixture.server.inject(`/flash/api/getBook?userID=${token}&language=JAPANESE`)).body, response.body);
    } finally {
      await fixture.server.close();
    }
    const restored = new FlashAccounts(new Store(filename));
    const book = restored.get(token).flash2013.book;
    assert.equal(book.score, 0);
    assert.equal(book.elements.length, 1);
    const xml = parseXml(`<response>${restored.bookXml(token, 'JAPANESE')}</response>`);
    const owned = children(xml, 'element')[0];
    assert.equal(field(owned, 'text'), flashBookEntries[book.elements[0]].text.ja);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('official lottery gives 25 coins and a single ticket with equal probability', () => {
  for (const roll of [0, 1]) {
    const accounts = new FlashAccounts(new Store(), 0, { randomInt: (maximum) => {
      assert.equal(maximum, 2);
      return roll;
    } });
    const claim = accounts.drawLot(localToken('DefaultLottery'));
    assert.equal(claim.coin, roll === 0 ? 25 : 0);
    assert.equal(claim.ticket, roll === 1 ? 'DUEL' : undefined);
  }
});

const historyFreeFightRoom = (count, isPrivate = false, seed = 1) => {
  const service = new FlashService(new Random(seed));
  const sessions = [];
  const outputs = [];
  for (let playerIndex = 0; playerIndex < count; playerIndex += 1) {
    const messages = [];
    const session = service.connect((message) => messages.push(message));
    service.receive(session, `<LOGIN><name>Player${playerIndex}</name><language>ENGLISH</language><mode>FREE_FIGHT</mode>${isPrivate ? '<isPrivate/>' : ''}</LOGIN>`);
    sessions.push(session);
    outputs.push(messages);
  }
  service.receive(sessions[0], '<ENTER><name>Historical rules</name><playersLimit>9</playersLimit></ENTER>');
  const room = sessions[0].room;
  for (const session of sessions.slice(1)) {
    service.receive(session, `<ENTER><id>${room.id}</id></ENTER>`);
  }
  return { service, sessions, outputs, room };
};

test('public rooms reject unequal teams, while private rooms allow them', () => {
  for (const isPrivate of [false, true]) {
    const { service, sessions, room } = historyFreeFightRoom(3, isPrivate);
    for (const [index, session] of sessions.entries()) {
      service.receive(session, `<ENTER_GAME><team>TEAM${index === 0 ? 1 : 2}</team></ENTER_GAME>`);
    }
    for (const session of sessions) {
      service.receive(session, '<READY><isReady/></READY>');
    }
    assert.equal(Boolean(room.battle), isPrivate);
  }
});

test('automatic team assignment randomizes eligible team counts and preserves balance', () => {
  const observedCounts = new Set();
  for (let seed = 1; seed <= 12; seed += 1) {
    for (const count of [4, 5, 6, 7, 8, 9]) {
      const { service, sessions, room } = historyFreeFightRoom(count, true, seed);
      for (const session of sessions) {
        service.receive(session, '<ENTER_GAME><team>TEAM1</team></ENTER_GAME>');
      }
      service.receive(sessions[0], '<SHUFFLE_TEAM/>');
      const sizes = [...new Set(room.players.map((player) => player.team))]
        .map((team) => room.players.filter((player) => player.team === team).length);
      if ([4, 6, 8, 9].includes(count)) {
        assert.equal(new Set(sizes).size, 1);
      } else {
        assert.ok(sizes.length >= 3);
        assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
      }
      if (count === 6) {
        observedCounts.add(sizes.length);
      }
    }
  }
  assert.deepEqual([...observedCounts].sort(), [2, 3]);
});

test('spectator filters mute chat but do not count toward player-majority ejection', () => {
  const { service, sessions, outputs, room } = historyFreeFightRoom(5);
  for (const session of sessions.slice(0, 3)) {
    service.receive(session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  }
  for (const session of sessions.slice(2)) {
    service.receive(session, '<FILTER><user>Player0</user><isFiltered/></FILTER>');
  }
  assert.equal(sessions[0].room, room, 'Two spectators and one player are only one eligible vote');
  const before = outputs.map((messages) => messages.length);
  service.receive(sessions[0], '<CHAT><comment>Muted message</comment></CHAT>');
  assert.equal(outputs[1].length, before[1] + 1);
  for (const index of [2, 3, 4]) {
    assert.equal(outputs[index].length, before[index]);
  }
  service.receive(sessions[1], '<FILTER><user>Player0</user><isFiltered/></FILTER>');
  assert.equal(sessions[0].room, undefined, 'Two of three players form a strict majority');
});

test('nonmember Free Fight players resume their running game by prophet name', () => {
  const { service, sessions, room } = historyFreeFightRoom(2);
  for (const session of sessions) {
    service.receive(session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
    service.receive(session, '<READY><isReady/></READY>');
  }
  const battle = room.battle;
  const originalHand = battle.player('Player0').items;
  service.disconnect(sessions[0]);
  const messages = [];
  const restored = service.connect((message) => messages.push(message));
  service.receive(restored, login('Player0'));
  assert.equal(restored.room, room);
  assert.equal(room.battle, battle);
  assert.equal(battle.player('Player0').items, originalHand);
  assert.equal(battle.player('Player0').bot, false);
  assert.equal(room.finished.has('Player0'), false);
  assert.match(messages[0], /^<ENTER><room>/);
  const stranger = service.connect(() => {});
  service.receive(stranger, login('DifferentName'));
  assert.equal(stranger.room, undefined);
});

test('Duel applies documented next-round bonuses and forbids repeat opponents within a round', () => {
  for (const [wins, draws, expectedBonus] of [[6, 0, 14], [7, 0, 26], [7, 1, 27]]) {
    const service = new FlashService(new Random(20));
    const alice = enterPaid2013(service, 'Alice', 'DUEL');
    const bob = enterPaid2013(service, 'Bob', 'DUEL');
    const account = service.accounts.get(localToken('Alice'));
    account2013(account).duel = { game: 14, win: wins, draw: draws };
    service.accounts.set(localToken('Alice'), account);
    service.receive(alice.session, '<ENTER/>');
    service.receive(bob.session, '<ENTER/>');
    const room = alice.session.room;
    room.battle.forfeit('Bob');
    service.flush(room);
    assert.equal(account2013(service.accounts.get(localToken('Alice'))).scoreBonus, expectedBonus);
    assert.deepEqual(account2013(service.accounts.get(localToken('Alice'))).duelOpponents, []);
    assert.throws(() => service.receive(alice.session, '<CHAT><comment>Not allowed</comment></CHAT>'));
  }
  const service = new FlashService(new Random(20));
  const alice = enterPaid2013(service, 'Alice', 'DUEL');
  const bob = enterPaid2013(service, 'Bob', 'DUEL');
  service.receive(alice.session, '<ENTER/>');
  service.receive(bob.session, '<ENTER/>');
  const firstRoom = alice.session.room;
  firstRoom.battle.forfeit('Bob');
  service.flush(firstRoom);
  service.receive(alice.session, '<EXIT/>');
  service.receive(bob.session, '<EXIT/>');
  service.receive(alice.session, '<ENTER/>');
  service.receive(bob.session, '<ENTER/>');
  assert.equal(alice.session.room, undefined);
  assert.equal(bob.session.room, undefined);
  const carol = enterPaid2013(service, 'Carol', 'DUEL');
  service.receive(carol.session, '<ENTER/>');
  assert.equal(alice.session.room, carol.session.room);
  assert.ok(service.duelQueue.has(bob.session));
});

test('Spirit allows a zero-score 100-game completion to unlock the next cave', () => {
  const service = new FlashService(new Random(20));
  const alice = enterPaid2013(service, 'Alice', 'SPIRIT');
  const account = service.accounts.get(localToken('Alice'));
  account2013(account).spirit[2] = { game: 99, score: 0, best: 0 };
  service.accounts.set(localToken('Alice'), account);
  service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  const room = alice.session.room;
  room.battle.forfeit('Alice');
  service.flush(room);
  assert.equal(account2013(service.accounts.get(localToken('Alice'))).spirit[2].completed, true);
  service.receive(alice.session, '<EXIT/>');
  service.receive(alice.session, '<ENTER><playerCount>3</playerCount></ENTER>');
  assert.equal(alice.session.room.limit, 3);
});

test('Spirit keeps the same paid game for thirty minutes and settles an expired recovery as a loss', (context) => {
  let now = 1700000000000;
  context.mock.method(Date, 'now', () => now);
  const service = new FlashService(new Random(20));
  const alice = enterPaid2013(service, 'Alice', 'SPIRIT');
  service.receive(alice.session, '<ENTER><playerCount>2</playerCount></ENTER>');
  const room = alice.session.room;
  const balance = service.accounts.get(localToken('Alice')).credits;
  service.disconnect(alice.session);
  assert.ok(service.rooms.has(room.id));
  assert.equal(room.settled, undefined);
  now += 30 * 60 * 1000 - 1;
  const restored = enterPaid2013(service, 'Alice', 'SPIRIT');
  assert.equal(restored.session.room, room);
  assert.equal(service.accounts.get(localToken('Alice')).credits, balance, 'Resuming cannot charge another entry fee');
  service.disconnect(restored.session);
  now += 30 * 60 * 1000;
  service.tick();
  assert.equal(service.rooms.has(room.id), false);
  assert.deepEqual(account2013(service.accounts.get(localToken('Alice'))).spirit[2], { game: 1, score: 0, best: 0 });
  const expired = enterPaid2013(service, 'Alice', 'SPIRIT');
  assert.equal(expired.session.room, undefined);
});

test('Flash majority ejection emits the original clients’ transition and alert in order', () => {
  for (const version of ['2010', '2013']) {
    const service = new FlashService(new Random(7));
    const sessions = [];
    const messages = [];
    for (const name of ['Alice', 'Bob', 'Carol', 'David']) {
      const session = service.connect((message) => {
        if (name === 'Alice') {
          messages.push(message);
        }
      });
      service.receive(session, login(name).replace('</LOGIN>', `<version>${version}</version></LOGIN>`));
      sessions.push(session);
    }
    service.receive(sessions[0], '<ENTER><name>Votes</name><playersLimit>4</playersLimit></ENTER>');
    for (const session of sessions.slice(1)) {
      service.receive(session, '<ENTER><id>1</id></ENTER>');
    }
    for (const session of sessions) {
      service.receive(session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
    }
    messages.length = 0;
    for (const session of sessions.slice(1)) {
      service.receive(session, '<FILTER><user>Alice</user><isFiltered/></FILTER>');
    }
    assert.equal(parseXml(messages[0]).name, 'KICKED');
    assert.equal(children(parseXml(messages.at(-2)), 'lobby').length, 1);
    assert.equal(field(parseXml(messages.at(-1)), 'message'), 'kicked');
    assert.equal(sessions[0].room, undefined);
    assert.ok(service.sessions.has(sessions[0]));
  }
});

function legacyFreeFightFixture(charged = true) {
  const service = new FlashService(new Random(7));
  const alice = enterPaid(service, 'Alice', 'FREE_FIGHT');
  const bob = enterPaid(service, 'Bob', 'FREE_FIGHT');
  const observer = enterPaid(service, 'Observer', 'FREE_FIGHT');
  service.receive(alice.session, '<ENTER><name>Legacy</name><playersLimit>2</playersLimit></ENTER>');
  service.receive(bob.session, '<ENTER><id>1</id></ENTER>');
  if (charged) {
    service.receive(alice.session, '<SET_CHARGE><needsCharge/></SET_CHARGE>');
  }
  return { service, alice, bob, observer, room: alice.session.room };
}

test('2010 charge settings are reflected in room snapshots and both room and lobby broadcasts', () => {
  const { service, alice, bob, observer, room } = legacyFreeFightFixture();
  assert.equal(room.needsCharge, true);
  for (const entrant of [alice, bob, observer]) {
    const response = parseXml(entrant.messages.find((message) => message.startsWith('<SET_CHARGE>')));
    assert.equal(children(response, 'needsCharge').length, 1);
    assert.equal(field(response, 'roomID'), entrant === observer ? '1' : '');
  }
  service.resync(alice.session);
  assert.match(alice.messages.at(-2), /<needsCharge(?:\/>|>)/);
  assert.equal(alice.messages.at(-1), '<ADD_USER><user><name>Alice</name></user></ADD_USER>');
  service.receive(alice.session, '<SET_CHARGE/>');
  assert.equal(room.needsCharge, false);
  assert.equal(bob.messages.at(-1), '<SET_CHARGE></SET_CHARGE>');
  service.receive(alice.session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  assert.throws(() => service.receive(bob.session, '<SET_CHARGE><needsCharge/></SET_CHARGE>'));
});

test('2010 charged Free Fight charges once at start, settles winnings and encyclopedia score once', () => {
  const { service, alice, bob, room } = legacyFreeFightFixture();
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  }
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1000);
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<READY><isReady/></READY>');
  }
  assert.ok(room.battle);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 875);
  assert.equal(service.accounts.get(localToken('Bob')).credits, 875);
  room.battle.forfeit('Bob');
  service.flush(room);
  service.flush(room);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1075);
  assert.equal(service.accounts.get(localToken('Bob')).credits, 875);
  assert.equal(service.accounts.get(localToken('Alice')).book2010.score, 2);
  assert.equal(service.accounts.get(localToken('Alice')).flash2013, undefined);
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<FINISH_GAME/>');
  }
  assert.equal(room.battle, undefined);
  assert.equal(room.players.length, 0);
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
    service.receive(entrant.session, '<READY><isReady/></READY>');
  }
  assert.equal(service.accounts.get(localToken('Alice')).credits, 950);
  assert.equal(service.accounts.get(localToken('Bob')).credits, 750);
  room.battle.forfeit('Alice');
  service.flush(room);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 950);
  assert.equal(service.accounts.get(localToken('Bob')).credits, 950);
  assert.equal(service.accounts.get(localToken('Bob')).book2010.score, 2);
});

test('2010 charge failures do not charge other players or leave ready controls stuck', () => {
  const { service, alice, bob, room } = legacyFreeFightFixture();
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  }
  service.receive(alice.session, '<READY><isReady/></READY>');
  const account = service.accounts.get(localToken('Alice'));
  account.credits = 0;
  service.accounts.set(localToken('Alice'), account);
  service.receive(bob.session, '<READY><isReady/></READY>');
  assert.equal(room.battle, undefined);
  assert.ok(room.players.every((player) => !player.ready));
  assert.equal(service.accounts.get(localToken('Bob')).credits, 1000);
  assert.ok(alice.messages.at(-1).includes('<message>insufficientFunds</message>'));
  assert.ok(bob.messages.at(-1).includes('<message>opponentUnavailable</message>'));
  account.credits = 1000;
  service.accounts.set(localToken('Alice'), account);
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<READY><isReady/></READY>');
  }
  assert.ok(room.battle);
});

test('2010 free Free Fight keeps balances and encyclopedia score unchanged', () => {
  const { service, alice, bob, room } = legacyFreeFightFixture(false);
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
    service.receive(entrant.session, '<READY><isReady/></READY>');
  }
  room.battle.forfeit('Bob');
  service.flush(room);
  assert.equal(service.accounts.get(localToken('Alice')).credits, 1000);
  assert.equal(service.accounts.get(localToken('Alice')).book2010, undefined);
});

test('2010 encyclopedia draws use all 434 original indices, charge five points and replay stale requests', async () => {
  const { flash2010BookEntries } = await import('../flash/book.ts');
  assert.equal(flash2010BookEntries.length, 434);
  assert.deepEqual(flash2010BookEntries.map((entry) => entry.id), Array.from({ length: 434 }, (_unused, index) => index));
  const service = new FlashService(new Random(7));
  const alice = enterPaid(service, 'Alice', 'FREE_FIGHT');
  assert.throws(() => service.receive(alice.session, '<DRAW_BOOK/>'));
  service.accounts.addBook2010Score(localToken('Alice'), 5);
  service.receive(alice.session, '<DRAW_BOOK/>');
  const response = parseXml(alice.messages.at(-1));
  assert.equal(response.name, 'DRAW_BOOK');
  const index = Number(field(response, 'index'));
  assert.ok(index >= 0 && index < 434);
  const account = service.accounts.get(localToken('Alice'));
  assert.deepEqual(account.book2010, { score: 0, elements: [index] });
  service.receive(alice.session, '<DRAW_BOOK/>');
  assert.equal(Number(field(parseXml(alice.messages.at(-1)), 'index')), index);
  assert.deepEqual(account.book2010, { score: 0, elements: [index] });
  account.book2010.elements = flash2010BookEntries.map((entry) => entry.id);
  service.accounts.set(localToken('Alice'), account);
  assert.equal(service.accounts.drawBook2010(localToken('Alice'), () => 433), 433);
  assert.equal(account.book2010.score, 0);
  assert.equal(account.book2010.elements.length, 434);
  assert.equal(account.flash2013, undefined);
});

test('legacy book HTTP responses use fcauth, index/count fields and separate collections', async () => {
  const { server, flash } = await createServer({ botInterval: 0 });
  const token = localToken('Book');
  try {
    flash.accounts.addBook2010Score(token, 5);
    flash.accounts.drawBook2010(token, () => 0);
    flash.accounts.addBookScore(token, 10);
    flash.accounts.addBookElement(token, 'ENGLISH', () => 1);
    const legacy = await server.inject(`/flash/api/getBook?fcauth=${token}&language=ENGLISH`);
    assert.equal(legacy.statusCode, 200);
    assert.ok(legacy.body.includes('<element index="0"><count>1</count>'));
    assert.ok(legacy.body.includes('Pray'));
    const modern = await server.inject(`/flash/api/getBook?userID=${token}&language=ENGLISH`);
    assert.ok(modern.body.includes('<element id="1">'));
    assert.ok(!modern.body.includes('<count>'));
    const credits = flash.accounts.get(token).credits;
    assert.equal((await server.inject(`/flash/api/buyCharinByMoritapo?fcauth=${token}`)).statusCode, 501);
    assert.equal(flash.accounts.get(token).credits, credits);
    for (const asset of ['images/component/freefight/book/background.png', 'images/component_ja/freefight/book/element_add_button_up.png', 'images/component/offline/entrance/login_bonus.png']) {
      assert.equal((await server.inject(`/flash/assets/${asset}`)).statusCode, 200);
    }
  } finally {
    await server.close();
  }
});

test('legacy login rewards enforce the 20-hour window across account instances', async () => {
  const { flashLoginBonus, flashLoginBonusInterval } = await import('../flash/accounts.ts');
  let now = 100000000;
  const store = new Store();
  const accounts = new FlashAccounts(store, 1000, { now: () => now });
  const token = localToken('Bonus');
  assert.equal(accounts.claimLoginBonus(token), flashLoginBonus);
  assert.equal(accounts.get(token).credits, 1000 + flashLoginBonus);
  const reloaded = new FlashAccounts(store, 1000, { now: () => now });
  assert.equal(reloaded.claimLoginBonus(token), 0);
  now += flashLoginBonusInterval - 1000;
  assert.equal(reloaded.claimLoginBonus(token), 0);
  now += 1000;
  assert.equal(reloaded.claimLoginBonus(token), flashLoginBonus);
  assert.equal(reloaded.get(token).credits, 1000 + 2 * flashLoginBonus);
  const { server, flash } = await createServer({ botInterval: 0 });
  try {
    const response = await server.inject(`/flash/api/addLoginBonus?fcauth=${token}`);
    assert.equal(field(parseXml(response.body), 'bonus'), String(flashLoginBonus));
    assert.equal(field(parseXml((await server.inject(`/flash/api/addLoginBonus?fcauth=${token}`)).body), 'bonus'), '0');
    assert.equal(flash.accounts.get(token).credits, 1000 + flashLoginBonus);
    assert.equal((await server.inject('/flash/api/addLoginBonus?fcauth=invalid')).statusCode, 403);
  } finally {
    await server.close();
  }
});

test('actual maintenance blocks new games while leaving active games and balances intact', async () => {
  for (const version of ['2010', '2013']) {
    const service = new FlashService(new Random(7));
    service.maintenance = true;
    for (const mode of ['TRAINING', 'DUEL', 'SPIRIT']) {
      const messages = [];
      const session = service.connect((message) => messages.push(message));
      const tokenField = version === '2010' ? 'fcauth' : 'userID';
      service.receive(session, login(mode, mode).replace('</LOGIN>', `<version>${version}</version><${tokenField}>${localToken(mode)}</${tokenField}></LOGIN>`));
      if (mode !== 'TRAINING') {
        service.receive(session, mode === 'DUEL' ? '<ENTER/>' : '<ENTER><playerCount>2</playerCount></ENTER>');
      }
      assert.equal(parseXml(messages[0]).name, 'ENTER');
      assert.ok(messages.some((message) => message.includes('<message>isLocked</message>')));
      assert.ok(!session.room?.battle);
      assert.equal(service.accounts.get(localToken(mode)).credits, 1000);
    }
  }
  const { service, alice, bob, room } = legacyFreeFightFixture(false);
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<ENTER_GAME><team>SINGLE</team></ENTER_GAME>');
  }
  service.maintenance = true;
  service.receive(alice.session, '<READY><isReady/></READY>');
  assert.equal(room.battle, undefined);
  assert.ok(!room.players[0].ready);
  assert.ok(alice.messages.at(-1).includes('<message>isLocked</message>'));
  service.maintenance = false;
  for (const entrant of [alice, bob]) {
    service.receive(entrant.session, '<READY><isReady/></READY>');
  }
  assert.ok(room.battle);
  service.maintenance = true;
  room.battle.forfeit('Bob');
  service.flush(room);
  assert.ok(room.battle.over);
  const fixture = await createServer({ botInterval: 0 });
  fixture.flash.maintenance = true;
  try {
    assert.equal(field(parseXml((await fixture.server.inject('/flash/api/getUserCount')).body), 'userCount'), '-1');
  } finally {
    await fixture.server.close();
  }
});

// Client-source audit: AttackCommand, CommandChain, ItemList, CommandOKButton
// and GameResponseReceiver. Keep these expectations independent of original files.
test('2013 discard accepts multiple artifacts while sale and item-add remain two-card commands', () => {
  assert.equal(canAddAttack([piece(1), piece(5)], piece(6)), true);
  for (const attackKind of ['SELL', 'ADD_ITEM']) {
    const firstPiece = { ...piece(3), item: { ...itemAt(3), attackKind } };
    assert.equal(canAddAttack([firstPiece, piece(5)], piece(6)), false);
  }
  const mortar = find((item) => item.attackExtra === 'MORTAR');
  const { battle, first } = battleFixture([5, 6, mortar]);
  battle.submit('Alice', command([1, 5, 6, mortar], 'Alice'));
  assert.deepEqual(first.items.map((entry) => entry.item.id), [mortar]);
  assert.equal(battle.drain().some((message) => message.xml.startsWith('<DEAL>')), false);
});

test('reflected attacks retain attribute removal for subsequent human and bot defenses', () => {
  for (const bot of [false, true]) {
    const weapon = find((item) => item.type === 'WEAPON' && item.attribute === 'FIRE' && item.attackKind === 'ATK' && !item.hitRate);
    const curtain = find((item) => item.defenseExtra === 'REMOVE_ATTRIBUTE');
    const reflect = find((item) => item.defenseExtra === 'REFLECT_WEAPON');
    const armor = find((item) => item.type === 'PROTECTOR' && item.defenseKind === 'DFS' && item.attribute === 'FIRE');
    const { battle, first } = battleFixture([weapon, armor], [curtain, reflect]);
    battle.submit('Alice', command([weapon], 'Bob'));
    battle.submit('Bob', command([curtain, reflect]));
    assert.equal(battle.pending.removedAttribute, true);
    if (bot) {
      first.bot = true;
      assert.equal(battle.stepBot(), true);
    } else {
      battle.submit('Alice', command([armor]));
    }
    assert.equal(first.hp, 40);
    const responses = battle.drain().filter((message) => message.xml.startsWith('<COMMAND>'));
    assert.ok(responses.at(-1).xml.includes(`<item>${armor}</item>`));
  }
});

test('Earth redistributes revealed artifacts and clears their previous illusion identities', () => {
  class EarthRandom extends Random {
    pick(label, values, weight) {
      return label === 'flashMystery' ? 'EARTH' : super.pick(label, values, weight);
    }

    shuffle(label, values) {
      return label === 'flashMysteryEarth' ? [...values].reverse() : super.shuffle(label, values);
    }
  }
  const mystery = find((item) => item.attackKind === 'MYSTERY');
  const { first, second } = battleFixture([mystery, 5], [6]);
  first.items[1].illusionItem = itemAt(7);
  second.items[0].illusionItem = itemAt(8);
  const battle = new FlashBattle([first, second], new EarthRandom(1));
  battle.deal = () => {};
  battle.submit('Alice', command([mystery], 'Alice'));
  assert.deepEqual(first.items.map((entry) => entry.item.id), [6]);
  assert.deepEqual(second.items.map((entry) => entry.item.id), [5]);
  assert.ok([...first.items, ...second.items].every((entry) => !entry.illusionItem));
  const messages = battle.drain();
  for (const player of [first, second]) {
    const snapshot = battle.snapshot(player);
    assert.ok(!snapshot.includes('<isIllusion>'));
    const message = messages.find((entry) => entry.recipient === player.name && entry.xml.includes('<mysteryResult>'));
    assert.ok(message.xml.includes(`<mysteryResult><item>${player.items[0].item.id}</item></mysteryResult>`));
  }
});

test('selling a creature deals replacements for both consumed cards and applies its effect', () => {
  const sale = find((item) => item.attackKind === 'SELL');
  const creature = find((item) => item.type === 'CREATURE' && item.attackKind === 'INCREASE_HP');
  const { battle, first, second } = battleFixture([sale, creature]);
  battle.submit('Alice', command([sale, creature], 'Bob'));
  battle.submit('Bob', command([]));
  assert.equal(second.hp, 40 + itemAt(creature).value);
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 0);
  assert.equal(battle.drain().filter((message) => message.recipient === 'Alice' && message.xml.startsWith('<DEAL>')).length, 2);
});

test('Pestle mortar multiplication caps damage at the client ATK_MAX', (context) => {
  const pestle = find((item) => item.attackExtra === 'PESTLE');
  const double = find((item) => item.attackExtra === 'DOUBLE_ATK');
  const mortar = find((item) => item.attackExtra === 'MORTAR');
  const cards = [pestle, ...Array(6).fill(double)];
  const { battle, first, second } = battleFixture(cards, [mortar]);
  first.mp = engine.MAX_STAT;
  second.hp = engine.MAX_STAT;
  const prepare = battle.prepare.bind(battle);
  let preparedValue;
  context.mock.method(battle, 'prepare', (attack) => {
    prepare(attack);
    preparedValue = attack.value;
  });
  battle.random.chance = () => false;
  battle.submit('Alice', command(cards, 'Bob'));
  assert.equal(preparedValue, FLASH_ATTACK_MAX);
  assert.equal(second.hp, 0);
  assert.equal(second.dead, true);
});

test('illusion indices distinguish disguised and real artifacts with the same shown ID', () => {
  const { battle, first } = battleFixture([6, 5]);
  first.items[0].illusionItem = itemAt(5);
  battle.submit('Alice', command([5], 'Bob'));
  assert.equal(battle.pending.pieces[0].item.id, 5);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].item.id, 6);
  assert.equal(first.items[0].illusionItem.id, 5);

  const indexed = battleFixture([6]);
  indexed.first.items[0].illusionItem = itemAt(5);
  assert.throws(() => indexed.battle.submit('Alice', command([5], 'Bob')));
  indexed.battle.submit('Alice', parseXml('<COMMAND target="Bob"><piece><item>5</item><illusionItemIndex>0</illusionItemIndex></piece></COMMAND>'));
  assert.equal(indexed.battle.pending.pieces[0].item.id, 6);
});

test('Flash bots submit an illusion index when playing a disguised artifact', () => {
  const { battle, first } = battleFixture([6]);
  first.items[0].illusionItem = itemAt(5);
  first.bot = true;
  assert.equal(battle.stepBot(), true);
  assert.equal(battle.pending.pieces[0].item.id, 6);
  assert.equal(battle.pending.pieces[0].illusionItem.id, 5);
});

test('Flash HP, MP, and money share the client PowerType.MAX limit', () => {
  assert.equal(engine.MAX_STAT, 99);
  for (const [stat, attackKind] of [['hp', 'INCREASE_HP'], ['mp', 'INCREASE_MP'], ['yen', 'INCREASE_YEN']]) {
    const booster = find((item) => item.attackKind === attackKind && item.value > 1 && !item.attackExtra);
    const { battle, first } = battleFixture([booster]);
    first[stat] = engine.MAX_STAT - 1;
    battle.submit('Alice', command([booster], 'Alice'));
    assert.equal(first[stat], engine.MAX_STAT, stat);
  }
});
