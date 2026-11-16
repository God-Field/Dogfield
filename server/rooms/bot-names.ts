import { Random } from '../random.ts';

/**
 * Official training-mode AI name generator.
 *
 * This is based on the last known-good generator that shipped in the client
 * (`20201016.js`, function `E.tt`, deobfuscated as `aiNames.dart.js`). That
 * version already had the two core branches: alphabetic names with distinct
 * initials for Latin-like locales, and character-run names for Japanese and
 * Simplified Chinese.
 *
 * The client-era version has been updated to match the newer official server
 * behavior observed in live training games:
 *
 * - Alphabetic initials are shuffled and sampled without replacement instead
 *   of being consumed alphabetically.
 * - Russian was added with all 33 Cyrillic initials and Russian vowels.
 * - Korean and Traditional Chinese were added to the character-run branch.
 * - The character pools were recovered from live samples: 166 Japanese kana,
 *   140 Korean Hangul syllables, 251 Simplified Chinese characters, and 278
 *   Traditional Chinese characters.
 * - Spanish, French, and Portuguese use the English alphabetic rules and
 *   Latin pool; other unsupported language codes do the same.
 * - Existing player names are reserved, preventing a generated bot name from
 *   matching any player already in the room.
 *
 * Character-run locales may repeat initials inside one lobby. Alphabetic
 * locales keep initials distinct within a lobby.
 */

interface CharacterRunRules {
  readonly branch: 'character-run';
  readonly characters: string;
  readonly nameLengths: readonly number[];
}

interface AlphabeticRules {
  readonly branch: 'alphabetic';
  readonly characters: string;
  readonly initialExcludedCharacters: ReadonlySet<string>;
  readonly nameLengths: readonly number[];
  readonly vowels: readonly string[];
  readonly excludedAfterVowel: ReadonlySet<string>;
  readonly excludedAfterConsonantVowel: ReadonlySet<string>;
  readonly specialFinalCharacter: string | null;
}

type LanguageRules = CharacterRunRules | AlphabeticRules;

const ENGLISH_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz';
const RUSSIAN_CHARACTERS = 'абвгдежзийклмнопрстуфхцчшщъыьэюяё';
const JAPANESE_CHARACTERS = 'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわをんァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヲンヴヵヶー';
const KOREAN_CHARACTERS = '가갸거겨고교구규그기나냐너녀노뇨누뉴느니다댜더뎌도됴두듀드디라랴러려로료루류르리마먀머며모묘무뮤므미바뱌버벼보뵤부뷰브비사샤서셔소쇼수슈스시아야어여오요우유으이자쟈저져조죠주쥬즈지차챠처쳐초쵸추츄츠치카캬커켜코쿄쿠큐크키타탸터텨토툐투튜트티파퍄퍼펴포표푸퓨프피하햐허혀호효후휴흐히';
const SIMPLIFIED_CHINESE_CHARACTERS = '一三上不丝中丽乃之乌乐乡了二五亚伊余你佬信像克兔八兰关兵具冬冲击刀创前剑剪劫勇化北十南卟原双只可司名后吹咩唯嘎因土块坡坦大太奈奔女好如娅子孩宇宗宙定对寺封小尼山岩巧巴布师希带帽幡庄庆强思性恋恒惠慕我打把拉敌教斯新方无日旧是曜最月有木杨极果枪标校根桃森椒橙比水永没治泰津浆浦润火熊爱牙牛特犬狐狗狸狼猪猫猴玉王玩球璃生田男画登白百的皮真眼石碎神程穗空窝粽紫红纳组绪绿羊美羽翻老者肉舔芽苔英苹草药莓莫蓝虚蛛蜘蝶血西记译谷豆财越跳轴辈辑辛辣达进追邪郎部酱里野金钻长阪限隆隈雏雪露青面鞍骏骑魅鱼鲁鸡鸭麦麻黄黑鼻龙';
const TRADITIONAL_CHINESE_CHARACTERS = '一丁七三上下丙中之乙九乾二五亨亮人仁任伍你信兔八公六兼冬刀刃分前剪劉力動包匕北十南原參口台右同呆和嚴四園圓團土地域堂堡壇士壬壹夏大天女奶奸妳姜子孝宇宙宮富實寶小尖山岸峰左巧己干平庚彼後忍志忠怕恁憐戊我手拾捌攪支方日明星春時月木李東林果柒根梁梅森楓槍樹橘橙檯欲氛水沉油沼洋流海淼渺滷漿澤濕灘火炎煎爺牙牛物狗猴獄玉王玖瓶甲男病痘痰癌癲癸眼矛石研神祢禮秋秒筆籠米精糬紅紫終絞綠維羊羌義耳聰肆肉肩腔腳膽臺與良芬花苔茶草莓菜蓮蔡蔥藍蘋虎蛇蜂蝕蟲西角觸言諒變豆豬貓財貪責貳辛辰退進遇醫金銀銅錨鍋鐘間闇陳陸陽雞零雷電霸靈靛頭顏颱食飯餃餅馬骨鬥鬼魂魚鯉鯨鹽麵麻黃黯鼠鼻齒龍';

const ENGLISH_VOWELS = Object.freeze(['a', 'e', 'i', 'o', 'u']);
const RUSSIAN_VOWELS = Object.freeze(['а', 'е', 'ё', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я']);
const LATIN_NAME_LENGTHS = Object.freeze([3, 4, 5, 6]);
const JAPANESE_NAME_LENGTHS = Object.freeze([2, 2, 3, 3, 4, 4, 5]);
const KOREAN_NAME_LENGTHS = Object.freeze([1, 2, 2, 3, 3, 4]);
const CHINESE_NAME_LENGTHS = Object.freeze([1, 1, 2, 2, 3, 3, 4]);

const ENGLISH_RULES: AlphabeticRules = Object.freeze({
  branch: 'alphabetic',
  characters: ENGLISH_CHARACTERS,
  initialExcludedCharacters: new Set(['x']),
  nameLengths: LATIN_NAME_LENGTHS,
  vowels: ENGLISH_VOWELS,
  excludedAfterVowel: new Set(['q']),
  excludedAfterConsonantVowel: new Set(['q', 'x']),
  specialFinalCharacter: 'x',
});

const RUSSIAN_RULES: AlphabeticRules = Object.freeze({
  branch: 'alphabetic',
  characters: RUSSIAN_CHARACTERS,
  initialExcludedCharacters: new Set<string>(),
  nameLengths: LATIN_NAME_LENGTHS,
  vowels: RUSSIAN_VOWELS,
  excludedAfterVowel: new Set<string>(),
  excludedAfterConsonantVowel: new Set<string>(),
  specialFinalCharacter: null,
});

const JAPANESE_RULES: CharacterRunRules = Object.freeze({
  branch: 'character-run',
  characters: JAPANESE_CHARACTERS,
  nameLengths: JAPANESE_NAME_LENGTHS,
});

const KOREAN_RULES: CharacterRunRules = Object.freeze({
  branch: 'character-run',
  characters: KOREAN_CHARACTERS,
  nameLengths: KOREAN_NAME_LENGTHS,
});

const SIMPLIFIED_CHINESE_RULES: CharacterRunRules = Object.freeze({
  branch: 'character-run',
  characters: SIMPLIFIED_CHINESE_CHARACTERS,
  nameLengths: CHINESE_NAME_LENGTHS,
});

const TRADITIONAL_CHINESE_RULES: CharacterRunRules = Object.freeze({
  branch: 'character-run',
  characters: TRADITIONAL_CHINESE_CHARACTERS,
  nameLengths: CHINESE_NAME_LENGTHS,
});

const LANGUAGE_RULES: Readonly<Record<string, LanguageRules | undefined>> =
  Object.freeze({
    en: ENGLISH_RULES,
    ru: RUSSIAN_RULES,
    ja: JAPANESE_RULES,
    ko: KOREAN_RULES,
    'zh-hans': SIMPLIFIED_CHINESE_RULES,
    'zh-hant': TRADITIONAL_CHINESE_RULES,
  });

interface AlphabeticStateCounts {
  readonly vowel: number;
  readonly special: number;
  readonly consonantAfterVowel: number;
  readonly consonantAfterConsonant: number;
}

function getLanguageRules(language: string): LanguageRules {
  return LANGUAGE_RULES[language] ?? ENGLISH_RULES;
}

function countCharacterRunPossibleNames(
  characters: readonly string[],
  nameLengths: readonly number[],
): number {
  const poolSize = new Set(characters).size;
  let total = 0;

  for (const nameLength of new Set(nameLengths)) {
    total += poolSize ** nameLength;
  }

  return total;
}

function countAlphabeticPossibleNames(
  rules: AlphabeticRules,
  characters: readonly string[],
): number {
  const uniqueCharacters = [...new Set(characters)];
  const uniqueVowels = [...new Set(rules.vowels)];
  const vowelSet = new Set(uniqueVowels);
  const specialFinalCharacter = rules.specialFinalCharacter;
  const eligibleInitials = uniqueCharacters.filter(
    (character) => !rules.initialExcludedCharacters.has(character),
  );
  const afterVowelCharacters = uniqueCharacters.filter(
    (character) => !rules.excludedAfterVowel.has(character),
  );
  const afterConsonantVowelCharacters = uniqueCharacters.filter(
    (character) => !rules.excludedAfterConsonantVowel.has(character),
  );
  const initialVowels = eligibleInitials.filter((character) =>
    vowelSet.has(character),
  );
  const initialSpecialCharacters = eligibleInitials.filter(
    (character) =>
      specialFinalCharacter !== null && character === specialFinalCharacter,
  );
  const initialConsonants = eligibleInitials.filter(
    (character) =>
      !vowelSet.has(character) && character !== specialFinalCharacter,
  );
  const afterVowelVowels = afterVowelCharacters.filter((character) =>
    vowelSet.has(character),
  );
  const afterVowelSpecialCharacters = afterVowelCharacters.filter(
    (character) =>
      specialFinalCharacter !== null && character === specialFinalCharacter,
  );
  const afterVowelConsonants = afterVowelCharacters.filter(
    (character) =>
      !vowelSet.has(character) && character !== specialFinalCharacter,
  );
  const afterConsonantVowelVowels = afterConsonantVowelCharacters.filter(
    (character) => vowelSet.has(character),
  );
  const afterConsonantVowelSpecialCharacters =
    afterConsonantVowelCharacters.filter(
      (character) =>
        specialFinalCharacter !== null &&
        character === specialFinalCharacter,
    );
  const afterConsonantVowelConsonants =
    afterConsonantVowelCharacters.filter(
      (character) =>
        !vowelSet.has(character) && character !== specialFinalCharacter,
    );
  const allowedLengths = new Set(rules.nameLengths);
  const maximumLength = Math.max(...allowedLengths);
  let state: AlphabeticStateCounts = {
    vowel: initialVowels.length,
    special: initialSpecialCharacters.length,
    consonantAfterVowel: 0,
    consonantAfterConsonant: initialConsonants.length,
  };
  let total = 0;

  for (let nameLength = 1; nameLength <= maximumLength; nameLength += 1) {
    if (allowedLengths.has(nameLength)) {
      total +=
        state.vowel +
        state.special +
        state.consonantAfterVowel +
        state.consonantAfterConsonant;
    }

    state = {
      vowel:
        state.vowel * afterVowelVowels.length +
        state.special * uniqueVowels.length +
        state.consonantAfterVowel * afterConsonantVowelVowels.length +
        state.consonantAfterConsonant * uniqueVowels.length,
      special:
        state.vowel * afterVowelSpecialCharacters.length +
        state.consonantAfterVowel *
          afterConsonantVowelSpecialCharacters.length,
      consonantAfterVowel:
        state.vowel * afterVowelConsonants.length,
      consonantAfterConsonant:
        state.consonantAfterVowel *
        afterConsonantVowelConsonants.length,
    };
  }

  return total;
}

function countPossibleNames(
  rules: LanguageRules,
  characters: readonly string[],
): number {
  if (rules.branch === 'character-run') {
    return countCharacterRunPossibleNames(characters, rules.nameLengths);
  }

  return countAlphabeticPossibleNames(rules, characters);
}

/**
 * Count the distinct names a language can generate.
 *
 * This is used by the feasibility precheck before random generation.
 */
export function countPossibleAiNames(language: string): number {
  const rules = getLanguageRules(language);
  return countPossibleNames(rules, Array.from(rules.characters));
}

function generateCharacterRunAiNames(
  nameCount: number,
  reservedNames: readonly string[],
  characters: readonly string[],
  nameLengths: readonly number[],
  random: Random,
): string[] {
  const names: string[] = [];

  while (names.length < nameCount) {
    const nameLength = random.pick('trainingBotNameLength', nameLengths);
    const nameCharacters: string[] = [];

    for (
      let characterIndex = 0;
      characterIndex < nameLength;
      characterIndex += 1
    ) {
      nameCharacters.push(
        random.pick('trainingBotCharacter', characters),
      );
    }

    const name = nameCharacters.join('');

    if (names.includes(name) || reservedNames.includes(name)) {
      continue;
    }

    names.push(name);
  }

  return names;
}

function generateAlphabeticAiNames(
  nameCount: number,
  reservedNames: readonly string[],
  characters: readonly string[],
  rules: AlphabeticRules,
  random: Random,
): string[] {
  const vowelSet = new Set(rules.vowels);
  const eligibleInitials = characters.filter(
    (character) => !rules.initialExcludedCharacters.has(character),
  );
  if (eligibleInitials.length === 0) {
    throw new Error(
      'No eligible initials are available for alphabetic AI names.',
    );
  }

  let availableInitials = random.shuffle(
    'trainingBotInitial',
    eligibleInitials,
  );
  const names: string[] = [];

  while (names.length < nameCount) {
    if (availableInitials.length === 0) {
      // Reuse initials only after every eligible initial has been consumed.
      availableInitials = random.shuffle(
        'trainingBotInitial',
        eligibleInitials,
      );
    }

    const initial = availableInitials.shift()!;
    const nameLength = random.pick('trainingBotNameLength', rules.nameLengths);
    const nameCharacters: string[] = [initial];

    while (nameCharacters.length < nameLength) {
      const finalCharacter = nameCharacters[nameCharacters.length - 1];

      if (vowelSet.has(finalCharacter)) {
        const candidates = characters.filter(
          (character) => !rules.excludedAfterVowel.has(character),
        );
        nameCharacters.push(
          random.pick('trainingBotCharacter', candidates),
        );
        continue;
      }

      const previousCharacter =
        nameCharacters.length <= 1
          ? null
          : nameCharacters[nameCharacters.length - 2];
      const previousIsVowel =
        previousCharacter !== null && vowelSet.has(previousCharacter);

      if (!previousIsVowel) {
        nameCharacters.push(
          random.pick('trainingBotVowel', rules.vowels),
        );
        continue;
      }

      if (
        rules.specialFinalCharacter !== null &&
        finalCharacter === rules.specialFinalCharacter
      ) {
        nameCharacters.push(
          random.pick('trainingBotVowel', rules.vowels),
        );
        continue;
      }

      const candidates = characters.filter(
        (character) => !rules.excludedAfterConsonantVowel.has(character),
      );
      nameCharacters.push(
        random.pick('trainingBotCharacter', candidates),
      );
    }

    nameCharacters[0] = nameCharacters[0].toUpperCase();
    const name = nameCharacters.join('');

    if (names.includes(name) || reservedNames.includes(name)) {
      // Put the initial back and try a different letter next time.
      availableInitials.push(initial);
      continue;
    }

    names.push(name);
  }

  return names;
}

/**
 * Generate AI opponent names for the requested language.
 *
 * The caller supplies every existing player name so generated names cannot
 * collide with players who are already in the room.
 */
export function generateAiNames(
  nameCount: number,
  reservedNames: readonly string[],
  language: string,
  random: Random,
): string[] {
  const rules = getLanguageRules(language);
  const characters = Array.from(rules.characters);
  const possibleNameCount = countPossibleNames(rules, characters);
  const uniqueReservedNames = new Set(reservedNames);

  if (
    nameCount > 0 &&
    nameCount + uniqueReservedNames.size > possibleNameCount
  ) {
    throw new Error(
      `Cannot generate ${nameCount} unique AI names for ${language}: ` +
        `${possibleNameCount} possible names with ` +
        `${uniqueReservedNames.size} reserved.`,
    );
  }

  if (rules.branch === 'character-run') {
    return generateCharacterRunAiNames(
      nameCount,
      reservedNames,
      characters,
      rules.nameLengths,
      random,
    );
  }

  return generateAlphabeticAiNames(
    nameCount,
    reservedNames,
    characters,
    rules,
    random,
  );
}
