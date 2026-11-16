import { cp, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = resolve(argument('source') ?? resolve(repository, '../godfield-flash/client-files'));
const assetDirectory = resolve(repository, 'public/flash/assets');
await access(resolve(source, 'static.godfield.net/images'));
await mkdir(assetDirectory, { recursive: true });
await cp(resolve(source, 'static.godfield.net'), assetDirectory, { recursive: true });
await cp(resolve(source, 'www.godfield.net/game/ipamp.swf'), resolve(repository, 'public/flash/ipamp.swf'));
console.log(`Imported historical assets into ${assetDirectory}`);
const ruffle = argument('ruffle');
if (ruffle) {
  const ruffleSource = resolve(ruffle);
  await access(resolve(ruffleSource, 'ruffle.js'));
  await cp(ruffleSource, resolve(repository, 'public/flash/ruffle'), { recursive: true });
  console.log('Imported Ruffle; set FLASH_RUFFLE_DIR=public/flash/ruffle to use it instead of the npm runtime.');
}
for (const script of ['recover-images.py', 'recover-sounds.py', 'create-mode-images.py']) {
  execFileSync('python3', [resolve(repository, 'tools/flash', script), `--output=${assetDirectory}`], { stdio: 'inherit' });
}
console.log('Run npm run server, then open /flash/. No network access is needed at runtime.');
