import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyScriptPatches, extractScripts, scriptPatches } from './scripts.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = resolve(argument('source') ?? resolve(repository, '../godfield-flash/client-files/www.godfield.net/game/godfield.swf'));
const jar = argument('ffdec') ?? process.env.FFDEC_JAR;
if (!jar) {
  throw new Error('Set FFDEC_JAR or pass --ffdec=/path/to/ffdec.jar. The already patched SWF needs no JPEXS installation.');
}
const digest = createHash('sha256').update(await readFile(source)).digest('hex');
const profiles = {
  d4c86869d68eb95589f05ac747c6ead9cf1ef69b89dfcf478073de81293d3698: { movie: 'godfield.swf', patches: 'patches' },
  c89b94bb095e4d2d4b5d344a3bb8c20b16a7d439174bb7723efa08b7b265606c: { movie: 'godfield-201005.swf', patches: 'patches-2010' },
  '213459bb8bd3092c8ee3fc101560b0864f6c122848dd6a685f8381efaed50712': { movie: 'godfield-201008.swf', patches: 'patches-2010', extraPatches: 'patches-201008' },
};
const profile = profiles[digest];
if (!profile) {
  throw new Error(`Unexpected original SWF SHA-256: ${digest}. No matching ActionScript patch profile.`);
}
const temporary = await mkdtemp(join(repository, 'public/flash/.patch-'));
try {
  const output = join(temporary, 'godfield.swf');
  const patchDirectories = [profile.patches, profile.extraPatches]
    .filter(Boolean).map((directory) => resolve(repository, 'tools/flash', directory));
  const filenames = [];
  for (const directory of patchDirectories) {
    filenames.push(...(await scriptPatches(directory)).map((filename) => filename.slice(0, -6)));
  }
  const scripts = await extractScripts({ jar, movie: source, directory: temporary, filenames });
  for (const directory of patchDirectories) {
    await applyScriptPatches(scripts, directory);
  }
  const result = spawnSync('java', ['-jar', resolve(jar), '-importScript', source, output,
    scripts], { stdio: 'inherit' });
  if (result.status !== 0 || (await stat(output)).size < 100000) {
    throw new Error('JPEXS did not produce a patched SWF.');
  }
  await rename(output, resolve(repository, 'public/flash', profile.movie));
  console.log(`Rebuilt public/flash/${profile.movie} from the original movie and checked-in ActionScript patches.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
