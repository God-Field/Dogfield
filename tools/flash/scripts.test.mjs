import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyScriptPatches, normalizeScript, scriptPatches } from './scripts.mjs';

const original = 'package fixture\n{\n   public const endpoint:String = "remote";\n}\n';
const patch = `--- a/Example.as
+++ b/Example.as
@@ -1,4 +1,4 @@
 package fixture
 {
-   public const endpoint:String = "remote";
+   public const endpoint:String = "local";
 }
`;

async function fixture(context) {
  const temporary = await mkdtemp(join(tmpdir(), 'dogfield-script-patches-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const scripts = join(temporary, 'scripts');
  const patches = join(temporary, 'patches');
  await mkdir(scripts);
  await mkdir(patches);
  await writeFile(join(scripts, 'Example.as'), normalizeScript(original.replaceAll('\n', '  \r\n')));
  await writeFile(join(patches, 'Example.as.patch'), patch);
  return { scripts, patches };
}

test('unified script patches apply to normalized exports and cannot be applied twice', async (context) => {
  const { scripts, patches } = await fixture(context);
  assert.deepEqual(await scriptPatches(patches), ['Example.as.patch']);
  await applyScriptPatches(scripts, patches);
  assert.equal(await readFile(join(scripts, 'Example.as'), 'utf8'), original.replace('remote', 'local'));
  await assert.rejects(applyScriptPatches(scripts, patches), /ActionScript patch failed/);
});

test('script patches reject changed context instead of silently using fuzzy hunks', async (context) => {
  const { scripts, patches } = await fixture(context);
  const changed = original.replace('package fixture', 'package incompatible');
  await writeFile(join(scripts, 'Example.as'), changed);
  await assert.rejects(applyScriptPatches(scripts, patches), /ActionScript patch failed/);
  assert.equal(await readFile(join(scripts, 'Example.as'), 'utf8'), changed);
});

test('script patch headers must match their file path', async (context) => {
  const { scripts, patches } = await fixture(context);
  await writeFile(join(patches, 'Example.as.patch'), patch.replaceAll('a/Example.as', 'a/Other.as'));
  await assert.rejects(applyScriptPatches(scripts, patches), /Unexpected script patch headers/);
  assert.equal(await readFile(join(scripts, 'Example.as'), 'utf8'), original);
});
