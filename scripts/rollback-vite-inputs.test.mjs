import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = path.join(repo, 'extensions/bento-shell');
const archived = path.join(repo, 'rollback/legacy-source/extensions/bento-shell');
const archivedConfig = readFileSync(path.join(archived, 'vite.config.ts'), 'utf8');

// Rollback staging overlays the archived shell onto the live one and swaps in the
// archived Vite config, so each HTML entry that config requires must exist in one
// of the two roots or the rollback build cannot resolve it.
test('every HTML entry in the archived Vite config exists in the staged shell', () => {
  const entries = [...archivedConfig.matchAll(/resolve\(__dirname, '([^']+\.html)'\)/g)].map(
    (match) => match[1],
  );
  assert.ok(entries.length >= 13, `expected the shell entry list, found ${entries.length}`);
  const missing = entries.filter(
    (file) => !existsSync(path.join(live, file)) && !existsSync(path.join(archived, file)),
  );
  assert.deepEqual(missing, []);
});

// public/panel-newtab.html is copied as-is, so the archived config must emit the
// stylesheet it links instead of building the page as an entry.
test('the archived Vite config emits the plain panel-newtab stylesheet', () => {
  assert.ok(existsSync(path.join(live, 'public/panel-newtab.html')));
  assert.match(archivedConfig, /panelNewtabCss\(/);
});
