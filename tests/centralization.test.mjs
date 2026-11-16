import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = 'src';

function sourceFiles(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return file.endsWith('.ts') ? [file] : [];
  });
}

const files = sourceFiles(sourceRoot).map(file => ({file, text: fs.readFileSync(file, 'utf8')}));

function expectCentralized(testName, allowedFile, pattern) {
  test(testName, () => {
    const violations = files
      .filter(({file}) => file !== allowedFile)
      .flatMap(({file, text}) => {
        const match = text.match(pattern);
        return match === null ? [] : [`${file}: ${match[0]}`];
      });
    assert.deepEqual(violations, []);
  });
}

expectCentralized('colors live only in the shared palette', path.join('src', 'ui', 'palette.ts'), /#[0-9a-fA-F]{6}\b/);
expectCentralized('inline SVG icons live only in the shared icon module', path.join('src', 'ui', 'icons.ts'), /<svg\b/);
expectCentralized('icon constants live only in the shared icon module', path.join('src', 'ui', 'icons.ts'), /^\s*(?:export\s+)?const\s+[A-Z0-9_]*_ICON\s*=/m);
expectCentralized('sound names are referenced through the shared catalog', path.join('src', 'services', 'audio.ts'), /\b(?:play|preload)Sound\(\s*['"]/);
expectCentralized('room and cloud actions are referenced through the protocol module', path.join('src', 'services', 'protocol.ts'), /\b(?:callCloudFunction|sendRoomAction\w*|updateRoomState)\(\s*['"]/);
