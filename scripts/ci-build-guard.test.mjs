import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ciConfigFiles,
  findCiBuildViolations,
  nativeBuildMatches,
  nativeScriptNames,
  stripYamlComments,
} from './ci-build-guard.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const repoScripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
const nativeNames = nativeScriptNames(repoScripts);
const hits = (text) => nativeBuildMatches(text, nativeNames).map(({ match }) => match);

test('native script names come from package.json, directly and through other scripts', () => {
  for (const name of ['bootstrap', 'build', 'package', 'mach', 'mach:build', 'build:full']) {
    assert.ok(nativeNames.has(name), `${name} should be a native script`);
  }
  for (const name of ['build:release', 'build:ui', 'firefox:sync', 'rollback:release-final']) {
    assert.ok(nativeNames.has(name), `${name} should be a native script`);
  }
  for (const name of ['ext:build', 'tools:build', 'shell:build', 'import', 'download', 'lc']) {
    assert.ok(!nativeNames.has(name), `${name} must not be a native script`);
  }
  assert.ok(!nativeNames.has('rollback:check'), 'rollback:check only lints and checks');
});

test('rejects every native build entry point', () => {
  const commands = [
    'pnpm build',
    'pnpm run build',
    'pnpm run bootstrap',
    'pnpm package',
    'pnpm run build:ui',
    'pnpm mach:build',
    'pnpm run mach build',
    'pnpm -r run package',
    'pnpm run build:full',
    'pnpm run build:release',
    'pnpm run firefox:sync',
    'pnpm run rollback:release-final',
    'node scripts/bento-build.mjs build',
    'node scripts/bento-build.mjs bootstrap',
    'node scripts/bento-build.mjs package',
    'bash scripts/bento-env.sh build',
    'bash scripts/bento-env.sh bootstrap',
    'bash scripts/bento-env.sh package',
    'bash "$REPO_ROOT/scripts/bento-env.sh" build --ui',
    './mach build',
    'cd engine && ./mach bootstrap',
    'mach package',
    'bash scripts/build-release.sh',
    'node scripts/build-rollback-variant.mjs rollback-final-r2 release',
    'gh release create v0.0.1',
  ];
  for (const command of commands) {
    assert.ok(hits(`run: ${command}\n`).length > 0, `${command} should be rejected`);
  }
});

test('rejects manual triggers, artifact uploads, and release steps', () => {
  for (const text of [
    'on:\n  workflow_dispatch:\n',
    'on:\n  workflow_run:\n    workflows: [CI]\n',
    'on: pull_request_target\n',
    '- uses: actions/upload-artifact@v7\n',
    '- uses: softprops/action-gh-release@v3\n',
    '- uses: actions/attest@v4\n',
  ]) {
    assert.ok(hits(text).length > 0, `${text.trim()} should be rejected`);
  }
});

test('accepts the extension builds and source commands CI runs', () => {
  const commands = [
    'pnpm run ext:build',
    'pnpm run ext:build && pnpm run import',
    'pnpm --filter @bento/shell build',
    'pnpm --filter @bento/tools build',
    'pnpm --filter=@bento/shell run build',
    'pnpm -F @bento/shell build',
    'pnpm --filter @bento/shell typecheck',
    'pnpm run download',
    'pnpm run import',
    'pnpm run lc',
    'pnpm run rollback:check',
    'pnpm run release:security-check:shell',
    'pnpm install --frozen-lockfile',
    'bash scripts/bento-env.sh download',
    "import { loadConfig } from './scripts/bento-build.mjs';",
    'node scripts/snapshot-import-output.mjs > import-first.sha256',
    'node scripts/check-import-output.mjs',
  ];
  for (const command of commands) {
    assert.deepEqual(hits(`run: ${command}\n`), [], `${command} should be accepted`);
  }
});

test('ignores comments but not quoted text', () => {
  const commented = [
    '# Do not add workflow_dispatch here\n',
    '    # pnpm run build is local only\n',
    'run: pnpm run ext:build # not pnpm build\n',
    "name: 'Build' # ./mach build\n",
  ];
  for (const text of commented) assert.deepEqual(hits(text), [], text);

  assert.equal(stripYamlComments('run: echo "a # b" # c\n'), 'run: echo "a # b" \n');
  assert.equal(stripYamlComments("run: echo 'it''s # x' # y\n"), "run: echo 'it''s # x' \n");
  assert.equal(stripYamlComments('url: https://example.com/#anchor\n'), 'url: https://example.com/#anchor\n');
  assert.ok(hits('run: echo "x" ; pnpm build # local\n').length > 0, 'code before a comment counts');
});

test('scans local composite actions and workflows in a repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-ci-guard-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { build: 'bash scripts/bento-env.sh build', 'ext:build': 'vite build' } }),
    );
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github/actions/safe'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github/actions/native'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github/workflows/ci.yml'), 'jobs:\n  a:\n    steps:\n      - run: pnpm run ext:build\n');
    fs.writeFileSync(path.join(root, '.github/actions/safe/action.yml'), 'runs:\n  steps:\n    - run: pnpm run ext:build # not pnpm build\n');
    assert.deepEqual(findCiBuildViolations(root), []);

    fs.writeFileSync(path.join(root, '.github/actions/native/action.yaml'), 'runs:\n  steps:\n    - run: pnpm build\n');
    const violations = findCiBuildViolations(root);
    assert.deepEqual(
      violations.map(({ file }) => file),
      ['.github/actions/native/action.yaml'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real workflows and local actions are clean', () => {
  const files = ciConfigFiles(repoRoot);
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    '.github/actions/engine-source/action.yml',
  ]) {
    assert.ok(files.includes(file), `${file} should be scanned`);
  }
  assert.deepEqual(findCiBuildViolations(repoRoot), []);
});
