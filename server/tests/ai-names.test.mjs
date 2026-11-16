import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPossibleAiNames, generateAiNames } from '../rooms/bot-names.ts';
import { Random } from '../random.ts';
import { RoomService } from '../rooms/service.ts';
import { Store } from '../store.ts';

test('AI names follow the language-specific length and character rules', () => {
  const englishNames = generateAiNames(8, [], 'en', new Random(123));
  assert.equal(englishNames.length, 8);
  assert.equal(new Set(englishNames).size, englishNames.length);
  assert.equal(
    new Set(englishNames.map((name) => name[0])).size,
    englishNames.length,
  );
  for (const name of englishNames) {
    assert.match(name, /^[A-Z][a-z]{2,5}$/);
    assert.notEqual(name[0], 'X');
  }

  const russianNames = generateAiNames(8, [], 'ru', new Random(456));
  assert.equal(new Set(russianNames).size, russianNames.length);
  assert.equal(
    new Set(russianNames.map((name) => name[0])).size,
    russianNames.length,
  );
  for (const name of russianNames) {
    assert.match(name, /^[А-ЯЁ][а-яё]{2,5}$/);
  }

  const japaneseNames = generateAiNames(8, [], 'ja', new Random(789));
  for (const name of japaneseNames) {
    assert.match(name, /^[\u3040-\u30ff]{2,5}$/);
  }

  const koreanNames = generateAiNames(8, [], 'ko', new Random(1011));
  for (const name of koreanNames) {
    assert.match(name, /^[\uac00-\ud7af]{1,4}$/);
  }

  const simplifiedChineseNames = generateAiNames(
    8,
    [],
    'zh-hans',
    new Random(1213),
  );
  for (const name of simplifiedChineseNames) {
    assert.match(name, /^[\u4e00-\u9fff]{1,4}$/);
  }

  const traditionalChineseNames = generateAiNames(
    8,
    [],
    'zh-hant',
    new Random(1415),
  );
  for (const name of traditionalChineseNames) {
    assert.match(name, /^[\u4e00-\u9fff]{1,4}$/);
  }
});

test('alphabetic names recycle initials instead of throwing', () => {
  const names = generateAiNames(30, [], 'en', new Random(1819));
  assert.equal(names.length, 30);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^[A-Z][a-z]{2,5}$/);
  }
});

test('feasibility counts match each language name space', () => {
  assert.equal(countPossibleAiNames('en'), 27_916_855);
  assert.equal(countPossibleAiNames('ru'), 343_584_450);
  assert.equal(countPossibleAiNames('ja'), 126_813_235_564);
  assert.equal(countPossibleAiNames('ko'), 386_923_740);
  assert.equal(countPossibleAiNames('zh-hans'), 3_985_002_504);
  assert.equal(countPossibleAiNames('zh-hant'), 5_994_379_170);
  assert.equal(countPossibleAiNames('es'), 27_916_855);
});

test('impossible name counts fail before random generation starts', () => {
  assert.throws(
    () => generateAiNames(30_000_000, [], 'en', new Random(1)),
    /Cannot generate 30000000 unique AI names/,
  );
});

test('unsupported languages fall back to English AI names', () => {
  for (const language of ['es', 'fr', 'pt', 'unknown']) {
    const names = generateAiNames(8, [], language, new Random(1617));
    for (const name of names) {
      assert.match(name, /^[A-Z][a-z]{2,5}$/);
    }
  }
});

test('AI names exclude every reserved player name', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const englishNames = generateAiNames(8, ['Axi'], 'en', new Random(seed));
    assert.equal(englishNames.includes('Axi'), false);

    const koreanNames = generateAiNames(8, ['뮤'], 'ko', new Random(seed));
    assert.equal(koreanNames.includes('뮤'), false);
  }
});

test('training start uses the requested language and reserves players', () => {
  const roomService = new RoomService(new Store(), {
    random: new Random(42),
  });
  const { roomId } = roomService.invoke('create-room', 'u1', {
    mode: 'training',
    userName: 'Axi',
  });
  roomService.invoke('start-game', 'u1', {
    mode: 'training',
    roomId,
    playerCount: 9,
    lang: 'ja',
    gf: null,
  });

  const room = roomService.store.get(
    roomService.path('training', roomId),
  );
  const bots = room.game.players.filter((player) => player.isBot === true);
  const humans = room.game.players.filter(
    (player) => player.isBot !== true,
  );

  assert.equal(bots.length, 8);
  assert.equal(humans.length, 1);
  assert.equal(humans[0].name, 'Axi');

  for (const bot of bots) {
    assert.match(bot.name, /^[\u3040-\u30ff]{2,5}$/);
    assert.notEqual(bot.name, 'Axi');
  }
});
