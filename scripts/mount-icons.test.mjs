// The mount script runs in Firefox chrome, which cannot import lucide-react, so it keeps verbatim
// copies of the icon nodes it draws. This fails when a copy differs from the installed package
// (the version @muxui/react depends on), so a lucide-react bump cannot leave the chrome icons behind.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(ROOT, 'src/browser/base/content/bento-shell-mount.js'), 'utf8');

const literal = /^ {2}const ICONS = (\{\n.*?\n {2}\});$/ms.exec(source);
assert.ok(literal, 'const ICONS is missing from the mount script');
// JSON round trip: the literal is evaluated in another realm, so its prototypes differ.
const ICONS = JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal[1]})`)));

/** chevronLeft -> chevron-left, volume2 -> volume-2 (the upstream file name). */
const kebab = (key) => key.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();

for (const [key, shapes] of Object.entries(ICONS)) {
  test(`mount icon ${key} matches lucide-react ${kebab(key)}`, async () => {
    const file = resolve(ROOT, 'node_modules/lucide-react/dist/esm/icons', `${kebab(key)}.mjs`);
    const { __iconNode } = await import(pathToFileURL(file).href);
    // Drop the React key; the mount copies carry the drawn attributes only.
    const expected = __iconNode.map(([tag, attrs]) => [
      tag,
      Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== 'key')),
    ]);
    assert.deepEqual(shapes, expected);
  });
}
