import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from '../../server/http/server.ts';
import { FlashBattle, newFlashPlayer, playerXml } from '../../server/flash/battle.ts';
import { element, tag, parseXml } from '../../server/flash/xml.ts';
import { Random } from '../../server/random.ts';
import { applyScriptPatches, extractScripts, scriptPatches } from './scripts.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const count = Number(argument('matches') ?? 1000);
const firstSeed = Number(argument('seed') ?? 1);
const playerCount = Number(argument('players') ?? 4);
const teamCount = Number(argument('teams') ?? 0);
assert.ok(Number.isInteger(playerCount) && playerCount >= 2 && playerCount <= 9);
assert.ok(Number.isInteger(teamCount) && teamCount >= 0 && teamCount <= Math.min(4, playerCount));
assert.ok(Number.isSafeInteger(count) && count > 0);
assert.ok(Number.isSafeInteger(firstSeed));
const stateFields = ['name', 'hp', 'mp', 'yen', 'disease', 'dead', 'lost', 'assistant', 'assistantHP', 'harms'];
const jar = argument('ffdec') ?? process.env.FFDEC_JAR;
assert.ok(jar, 'Set FFDEC_JAR to the local JPEXS jar');
const temporary = await mkdtemp(join(tmpdir(), 'dogfield-flash-parity-'));
const artifactDirectory = resolve(repository, `artifacts/flash/parity/${firstSeed}-${count}-${playerCount}-${teamCount}`);
await mkdir(artifactDirectory, { recursive: true });
let browser;
let server;
try {
  const clientPath = 'net/godfield/client/main/Client.as';
  const baseMovie = resolve(repository, 'public/flash/godfield.swf');
  const patchDirectory = resolve(repository, 'tools/flash/parity');
  const filenames = (await scriptPatches(patchDirectory)).map((filename) => filename.slice(0, -6));
  const scripts = await extractScripts({ jar, movie: baseMovie, directory: temporary,
    filenames: [...filenames, clientPath] });
  await applyScriptPatches(scripts, patchDirectory);
  let client = await readFile(join(scripts, clientPath), 'utf8');
  client = client.replace('   public class Client', '   import flash.external.ExternalInterface;\n   public class Client');
  client = client.replace('         ErrorCatcher.onCatch = this.onCatchError;', '         ErrorCatcher.onCatch = this.onCatchError;\n         ExternalInterface.addCallback("dogfieldReplay", new Statistics().replay);');
  await mkdir(join(scripts, 'net/godfield/client/main'), { recursive: true });
  await writeFile(join(scripts, clientPath), client);
  const movieSHA256 = createHash('sha256').update(await readFile(baseMovie)).digest('hex');
  const movie = join(temporary, 'probe.swf');
  const compilation = spawnSync('java', ['-jar', resolve(jar), '-importScript', baseMovie, movie, scripts], { encoding: 'utf8' });
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
  const movieBytes = await readFile(movie);
  const fixture = await createServer({ botInterval: 0 });
  server = fixture.server;
  server.get('/probe.swf', async (_request, reply) => reply.type('application/x-shockwave-flash').send(movieBytes));
  server.get('/probe/', async (_request, reply) => reply.type('text/html').send(`<!doctype html><div id="player"></div><script src="/flash/ruffle/ruffle.js"></script><script>
  window.RufflePlayer.config = { autoplay: 'on', unmuteOverlay: 'hidden' };
  const player = window.RufflePlayer.newest().createPlayer();
  document.getElementById('player').append(player);
  player.ruffle().load({url:'/probe.swf',allowScriptAccess:true,parameters:{serverURL:location.origin,language:'en'}});
  </script>`));
  await server.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const externalRequests = [];
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on('console', (message) => {
    if (/Error|error|DOGFIELD/.test(message.text())) {
      console.log(message.text());
    }
  });
  page.on('pageerror', (error) => console.error(error.message));
  await page.goto(`${origin}/probe/`);
  await page.waitForFunction(() => {
    try {
      return document.querySelector('ruffle-player')?.ruffle().callExternalInterface('dogfieldReplay', '<replay/>')?.includes('<result');
    } catch {
      return false;
    }
  }, null, { timeout: 30000 });

  const controlPlayer = newFlashPlayer('Control');
  function expectedPlayer(player) {
    const state = [player.name, player.hp, player.mp, player.yen, player.disease, player.dead, player.lost,
      player.assistant?.type ?? '', player.assistant?.hp ?? 0, [...player.harms].sort().join(',')].join('|');
    return tag('player', undefined, { name: player.name, state });
  }
  const controlInitial = element('players', playerXml(controlPlayer));
  controlPlayer.hp = 39;
  const controlMessages = '<START_INNING><attacker><name>Control</name></attacker></START_INNING>'
    + '<COMMAND><piece><item>5</item></piece><commander><name>Control</name></commander><target><name>Control</name></target></COMMAND>';
  const control = element('replay', controlInitial + element('step', element('messages', controlMessages) + element('expected', expectedPlayer(controlPlayer))));
  const runClient = (source) => page.evaluate((input) => document.querySelector('ruffle-player').ruffle().callExternalInterface('dogfieldReplay', input), source);
  assert.equal(parseXml(await runClient(control)).attributes.steps, '1', 'The original client must apply the known one-HP attack');
  const corrupted = control.replace('Control|39|10|20|', 'Control|38|10|20|');
  assert.equal(parseXml(await runClient(corrupted)).attributes.step, '0', 'The probe must reject an intentionally incorrect server HP');

  let totalSteps = 0;
  let failedMatches = 0;
  const failures = [];
  for (let seed = firstSeed; seed < firstSeed + count; seed++) {
    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan'];
    const players = names.slice(0, playerCount).map((name, playerIndex) => newFlashPlayer(name, teamCount ? `TEAM${playerIndex % teamCount + 1}` : 'SINGLE', true));
    const steps = [];
    const messages = [];
    class RecordedBattle extends FlashBattle {
      send(name, content = '', recipient) {
        const relevant = ['START_INNING', 'COMMAND', 'BUY', 'DISEASE', 'DIE', 'END_INNING', 'UNFOG', 'DYING'].includes(name);
        if (relevant) {
          const source = element(name, content + (name === 'UNFOG' ? tag('probeRecipient', recipient) : ''));
          // Earth outcomes carry different private inventories, with identical
          // stat changes. Replay one original, unconcealed command per event.
          const previous = messages.at(-1);
          const signature = source.replace(/<mysteryResult>[\s\S]*?<\/mysteryResult>/g, '');
          const duplicatePrivate = recipient && name === 'COMMAND' && previous?.signature === signature;
          if (!duplicatePrivate) {
            messages.push({ source, signature });
          }
        }
        return super.send(name, content, recipient);
      }
    }
    const battle = new RecordedBattle(players, new Random(seed));
    const initial = element('players', players.map(playerXml).join(''));
    battle.start();
    function recordStep() {
      const expected = battle.players.map(expectedPlayer).join('');
      steps.push(element('step', element('messages', messages.splice(0).map((message) => message.source).join('')) + element('expected', expected)));
      battle.drain();
    }
    recordStep();
    let commands = 0;
    let serverFailed = false;
    while (!battle.over && commands < 2000) {
      try {
        assert.ok(battle.stepBot(), `Seed ${seed} must progress`);
      } catch (error) {
        const failure = { seed, commands, error: String(error), expected: battle.expected?.name, current: battle.current?.name, players: battle.players, pending: battle.pending };
        failures.push(failure);
        failedMatches++;
        serverFailed = true;
        await writeFile(join(artifactDirectory, `seed-${seed}-server-failure.json`), JSON.stringify(failure, null, 2));
        console.log(`Server failure seed ${seed}, action ${commands}: ${error}`);
        break;
      }
      recordStep();
      commands++;
    }
    if (!battle.over) {
      if (!serverFailed) {
        failedMatches++;
        failures.push({ seed, error: 'Battle did not finish within 2000 actions' });
      }
      await writeFile(join(artifactDirectory, `seed-${seed}.xml`), element('replay', initial + steps.join('')));
      continue;
    }
    const source = element('replay', initial + steps.join(''));
    const result = await runClient(source);
    const report = parseXml(result);
    if (report.attributes.step !== undefined) {
      failedMatches++;
      const failure = { seed, result };
      failures.push(failure);
      await writeFile(join(artifactDirectory, `seed-${seed}.xml`), source);
      await writeFile(join(artifactDirectory, `seed-${seed}-failure.xml`), result);
      if (failedMatches <= 5) {
        console.log(`Divergence seed ${seed}: ${result}`);
      }
    }
    totalSteps += steps.length;
    if ((seed - firstSeed + 1) % 100 === 0) {
      console.log(`${seed - firstSeed + 1} matches, ${totalSteps} action boundaries, ${failedMatches} divergences`);
    }
  }
  await writeFile(join(artifactDirectory, 'report.json'), JSON.stringify({ firstSeed, matches: count, playerCount, teamCount, totalSteps, failedMatches, stateFields, movieSHA256, failures }, null, 2));
  console.log(`${count} matches, ${totalSteps} action boundaries, ${failedMatches} divergences`);
  assert.deepEqual(externalRequests, [], 'The parity campaign must stay local');
  assert.equal(failedMatches, 0, `See ${artifactDirectory}`);
} finally {
  await browser?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
