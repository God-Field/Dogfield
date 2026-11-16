import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../../server/http/server.ts';
import { extractScripts } from './scripts.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const jar = process.env.FFDEC_JAR;
assert.ok(jar, 'Set FFDEC_JAR to the local JPEXS jar');
const temporary = await mkdtemp(join(tmpdir(), 'dogfield-flash-audio-'));
let browser;
let server;
try {
  const fixture = await createServer({ botInterval: 0 });
  server = fixture.server;
  server.get('/audio-probe/', async (_request, reply) => reply.type('text/html').send(`<!doctype html><body>
    <script src="/flash/ruffle/ruffle.js"></script><script>
    window.RufflePlayer.config = { autoplay: 'on', unmuteOverlay: 'hidden' };
    const player = window.RufflePlayer.newest().createPlayer();
    document.body.append(player);
    player.ruffle().load({url: '/audio-probe.swf', allowScriptAccess: true,
      parameters: {serverURL: location.origin, language: 'en'}});
    </script>`));
  let movieBytes;
  server.get('/audio-probe.swf', async (_request, reply) => reply.type('application/x-shockwave-flash').send(movieBytes));
  await server.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  for (const version of ['2013', '201005', '201008']) {
    const mainPath = 'net/godfield/client/main/Main.as';
    const baseMovie = resolve(process.env.FLASH_MOVIE_DIR ?? resolve(repository, 'public/flash'), version === '2013' ? 'godfield.swf' : `godfield-${version}.swf`);
    const scripts = await extractScripts({ jar, movie: baseMovie, directory: join(temporary, version),
      filenames: [mainPath] });
    await mkdir(join(scripts, 'cc/charin/api'), { recursive: true });
    // JPEXS replaces existing classes. Reuse the API class as a recording
    // Sound subclass only in this temporary probe movie.
    const probe = await readFile(resolve(repository, 'tools/flash/audio/ProbeSound.as'), 'utf8');
    await writeFile(join(scripts, 'cc/charin/api/CharinAPI.as'), probe);
    let main = await readFile(join(scripts, mainPath), 'utf8');
    main = main.replace('   public class Main', '   import flash.external.ExternalInterface;\n   import cc.charin.api.CharinAPI;\n   import cc.charin.sound.SoundPlayer;\n   public class Main');
    main = main.replace('         _instance = this;', '         _instance = this;\n         ExternalInterface.addCallback("dogfieldAudioProbe",this.audioProbe);');
    main = main.replace('      public static function get instance()', `      public function audioProbe(muted:Boolean, volume:Number) : String
      {
         var sound:CharinAPI = new CharinAPI();
         SoundPlayer.mute = muted;
         SoundPlayer.volume = volume;
         SoundPlayer.play(sound);
         return sound.starts + "|" + sound.initialVolume;
      }

      public static function get instance()`);
    await mkdir(join(scripts, 'net/godfield/client/main'), { recursive: true });
    await writeFile(join(scripts, mainPath), main);
    const movie = join(temporary, `${version}.swf`);
    const compilation = spawnSync('java', ['-jar', resolve(jar), '-importScript', baseMovie, movie, scripts], { encoding: 'utf8' });
    assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
    movieBytes = await readFile(movie);
    const page = await browser.newPage();
    await page.route('**/*', (route) => {
      assert.equal(new URL(route.request().url()).origin, origin, 'Audio checks must stay offline');
      return route.continue();
    });
    await page.goto(`${origin}/audio-probe/`);
    await page.waitForFunction(() => {
      try {
        return document.querySelector('ruffle-player')?.ruffle().callExternalInterface('dogfieldAudioProbe', false, 0.5)?.includes('|');
      } catch {
        return false;
      }
    });
    for (const [muted, volume, expected] of [[true, 1, '0|-1'], [false, 0, '0|-1'],
      [true, 0.5, '0|-1'], [false, 0.25, '1|0.25'], [false, 1, '1|1']]) {
      const result = await page.evaluate(({ muted, volume }) => document.querySelector('ruffle-player')
        .ruffle().callExternalInterface('dogfieldAudioProbe', muted, volume), { muted, volume });
      assert.equal(result, expected, `${version}: mute=${muted}, volume=${volume}`);
    }
    await page.close();
    console.log(`SWF ${version}: mute, zero volume, initial playback volume and unmute passed.`);
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
