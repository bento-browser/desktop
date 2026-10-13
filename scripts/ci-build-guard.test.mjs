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
const repoPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const nativeNames = nativeScriptNames(repoPackage.scripts);
const hits = (text) =>
  nativeBuildMatches(text, nativeNames, repoPackage.name).map(({ match }) => match);

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

  // The rollback driver defaults to `build`, so an alias without an action is native.
  const aliases = nativeScriptNames({
    bare: 'node scripts/build-rollback-variant.mjs rollback-final-r2',
    checked: 'node scripts/build-rollback-variant.mjs rollback-final-r2 check',
  });
  assert.deepEqual([...aliases], ['bare']);
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
    'node scripts/build-rollback-variant.mjs rollback-final-r2',
    'node scripts/build-rollback-variant.mjs rollback-final-r2 check && node scripts/build-rollback-variant.mjs rollback-final-r2',
    'gh release create v0.0.1',
  ];
  for (const command of commands) {
    assert.ok(hits(`run: ${command}\n`).length > 0, `${command} should be rejected`);
  }
});

test('treats a filter that selects the root package as an unfiltered run', () => {
  assert.equal(repoPackage.name, 'bento-browser');
  for (const command of [
    'pnpm --filter bento-browser build',
    'pnpm --filter=bento-browser run build',
    'pnpm -F bento-browser run package',
    'pnpm --filter . build',
    'pnpm --filter ./ build',
    'pnpm --filter {.} build',
    'pnpm --filter {./} build',
    'pnpm --filter=. run bootstrap',
    'pnpm --filter "bento-browser" build',
  ]) {
    assert.ok(hits(`run: ${command}\n`).length > 0, `${command} should be rejected`);
  }
  for (const command of [
    'pnpm --filter @bento/shell build',
    'pnpm --filter=@bento/tools run build',
    'pnpm -F @bento/shell build',
    'pnpm --filter bento-browser-other build',
    'pnpm --filter ./extensions/bento-shell build',
    'pnpm --filter bento-browser run ext:build',
  ]) {
    assert.deepEqual(hits(`run: ${command}\n`), [], `${command} should be accepted`);
  }
});

test('sees through quoted script names and backslash continuations', () => {
  for (const text of [
    'run: pnpm run "build"\n',
    "run: pnpm run 'build'\n",
    'run: pnpm "package"\n',
    'run: |\n  pnpm run \\\n    build\n',
    'run: |\n  pnpm \\\n    --silent \\\n    run build\n',
    'run: |\r\n  pnpm run \\\r\n    bootstrap\r\n',
    'run: |\n  bash scripts/bento-env.sh \\\n    build\n',
  ]) {
    assert.ok(hits(text).length > 0, `${JSON.stringify(text)} should be rejected`);
  }
  for (const text of [
    'run: pnpm run "ext:build"\n',
    "run: pnpm run 'build:ext'\n",
    'run: |\n  pnpm run \\\n    ext:build\n',
    'run: |\n  pnpm \\\n    --filter @bento/shell \\\n    build\n',
  ]) {
    assert.deepEqual(hits(text), [], `${JSON.stringify(text)} should be accepted`);
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
    'node scripts/build-rollback-variant.mjs rollback-transition-r1 check',
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
