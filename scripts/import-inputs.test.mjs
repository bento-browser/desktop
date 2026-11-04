import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const SCRIPT = new URL('./import-inputs.mjs', import.meta.url).pathname;

/** Runs the script as CI does: raw bytes on stdin, answer on stdout. */
function runRaw(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const run = (paths) => runRaw(paths.map((path) => `${path}\0`).join(''));

const safePaths = [
  'docs/core-functionality.md',
  'docs/technical/panel-state.md',
  'docs/img/screenshot.png',
  'README.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.agents/skills/bento-upgrade-firefox/SKILL.md',
  '.agents/skills/example/run.mjs',
  'scripts/check-doc-links.test.mjs',
  'extensions/bento-shell/src/components/Tab/Tab.tsx',
  'extensions/bento-shell/src/theme/bento-tokens.css',
  'extensions/bento-shell/src/lib/experiments.ts',
  'extensions/bento-tools/src/background.ts',
  '.size-baseline.json',
  '.size-limit.json',
  '.legacy-alias-cap.json',
  '.github/workflows/codeql.yml',
];

const unsafePaths = [
  // Markdown outside docs/ and the repo root.
  'branding/bento/README.md',
  'extensions/ublock-origin/README.md',
  'plans/notes.md',
  '.md',
  // Tests and scripts outside scripts/*.test.mjs.
  'src/browser/foo.test.js',
  'scripts/bento-build.mjs',
  'scripts/import.sh',
  'scripts/lib/helper.test.mjs',
  'scripts/helper.test.mjs.bak',
  'scripts/.test.mjs',
  // Firefox-facing inputs.
  'src/browser/base/content/bento-shell-mount.js',
  'patches/series.json',
  'patches/core-ui/01-example.patch',
  'prefs/bento.js',
  'branding/bento/logo.svg',
  'config/firefox-versions.json',
  'bento.json',
  'package.json',
  'pnpm-lock.yaml',
  // Extension build inputs and Firefox experiments.
  'extensions/bento-shell/vite.config.ts',
  'extensions/bento-shell/package.json',
  'extensions/bento-shell/manifest.json',
  'extensions/bento-tools/manifest.json',
  'extensions/bento-shell/public/boot.js',
  'extensions/bento-shell/experiments/chrome-bridge/api.js',
  'extensions/bento-tools/experiments/bento-privacy/api.js',
  'extensions/bento-shell/src/experiments/example.js',
  'extensions/bento-tools/src/lib/experiments/deep/example.ts',
  'extensions/bento-shell/src/experiments',
  'extensions/bento-shell/src',
  'extensions/bento-shell/src-extra/a.ts',
  'extensions/ublock-origin/uBlock0@raymondhill.net.xpi',
  // Workflows and actions.
  '.github/workflows/ci.yml',
  '.github/workflows/codeql.yml.bak',
  '.github/actions/setup/action.yml',
  // Near misses of the root files and directories.
  '.size-baseline.json.bak',
  'docs',
  'docsx/a.md',
  '.agentsx/a.mjs',
  'README.MD',
  'README.md.bak',
  // Malformed paths git never prints.
  './README.md',
  '/docs/a.md',
  'docs/../patches/x.patch',
  'docs//a.md',
  'docs/',
  '',
];

test('every skippable path alone gives false and no stderr', async () => {
  const results = await Promise.all(safePaths.map((path) => run([path])));
  results.forEach((result, index) => {
    assert.deepEqual(result, { code: 0, stdout: 'false\n', stderr: '' }, safePaths[index]);
  });
});

test('all skippable paths together give false', async () => {
  assert.deepEqual(await run(safePaths), { code: 0, stdout: 'false\n', stderr: '' });
});

test('every other path alone gives true and names itself on stderr', async () => {
  const results = await Promise.all(unsafePaths.map((path) => run([path])));
  results.forEach((result, index) => {
    const path = unsafePaths[index];
    assert.equal(result.code, 0, path);
    assert.equal(result.stdout, 'true\n', path);
    assert.equal(
      result.stderr,
      `source-import required: ${JSON.stringify(path)} is not on the skip allowlist\n`,
      path,
    );
  });
});

test('one unsafe path among skippable paths gives true and names the first one', async () => {
  const { code, stdout, stderr } = await run([
    'docs/a.md',
    'patches/x.patch',
    'README.md',
    'bento.json',
  ]);
  assert.equal(code, 0);
  assert.equal(stdout, 'true\n');
  assert.equal(stderr, 'source-import required: "patches/x.patch" is not on the skip allowlist\n');
});

test('empty input gives true', async () => {
  for (const input of ['', '\0']) {
    const { code, stdout, stderr } = await runRaw(input);
    assert.equal(code, 0);
    assert.equal(stdout, 'true\n');
    assert.match(stderr, /^source-import required: .+\n$/);
  }
});

test('paths with spaces are matched whole, with or without a trailing NUL', async () => {
  const space = 'docs/with space/notes file.md';
  assert.deepEqual(await runRaw(`${space}\0README.md\0`), {
    code: 0,
    stdout: 'false\n',
    stderr: '',
  });
  assert.deepEqual(await runRaw(`README.md\0${space}`), { code: 0, stdout: 'false\n', stderr: '' });
  const unsafe = await runRaw('patches/with space.patch\0');
  assert.equal(unsafe.stdout, 'true\n');
  assert.match(unsafe.stderr, /"patches\/with space\.patch"/);
});

test('a path cannot forge a workflow command in the log', async () => {
  const { stdout, stderr } = await runRaw('::error::forged\0');
  assert.equal(stdout, 'true\n');
  assert.ok(stderr.startsWith('source-import required: '), stderr);
});
