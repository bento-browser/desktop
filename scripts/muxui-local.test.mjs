import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertMuxSourceStamp,
  muxLocalTsconfig,
  muxLocalViteConfig,
  muxSourcePlugin,
  resolveMuxLocal,
  rollbackMuxStamp,
} from '../extensions/bento-shell/muxui-local.mjs';
import { ROLLBACK_VARIANTS } from './rollback-variants.mjs';

const exportsMap = {
  '.': { types: './generated/index.d.ts', default: './generated/index.mjs' },
  './compatibility': './generated/compatibility.mjs',
  './styles.css': './generated/styles.css',
  './themes': { types: './generated/themes.d.ts', default: './generated/themes.mjs' },
  './themes.css': './generated/themes.css',
  './testing': './generated/testing.mjs',
  './text-editor': {
    types: './generated/text-editor.d.ts',
    default: './generated/text-editor.mjs',
  },
  './markdown': { types: './generated/markdown.d.ts', default: './generated/markdown.mjs' },
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bento-muxui-local-'));
}

/** A minimal Mux packages/react directory whose exports all exist on disk. */
function muxFixture({ name = '@muxui/react', exports = exportsMap, generate = true } = {}) {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, exports }));
  if (generate) {
    fs.mkdirSync(path.join(root, 'generated'));
    const files = Object.values(exports).flatMap((target) =>
      typeof target === 'string' ? [target] : Object.values(target),
    );
    for (const file of files) fs.writeFileSync(path.join(root, file), '');
  }
  return root;
}

test('unset MUXUI_LOCAL leaves npm mode untouched', () => {
  assert.equal(resolveMuxLocal({}), undefined);
  assert.equal(resolveMuxLocal({ MUXUI_LOCAL: '' }), undefined);
  assert.deepEqual(muxLocalViteConfig(undefined, '/workspace'), {});
});

test('MUXUI_LOCAL throws in release mode before touching the path', () => {
  const root = muxFixture();
  for (const release of [{ BENTO_RELEASE: '1' }, { BENTO_BUILD_MODE: 'release' }]) {
    assert.throws(() => resolveMuxLocal({ MUXUI_LOCAL: root, ...release }), /release build/);
    assert.throws(
      () => resolveMuxLocal({ MUXUI_LOCAL: '/does/not/exist', ...release }),
      /release build/,
    );
  }
  assert.ok(resolveMuxLocal({ MUXUI_LOCAL: root, BENTO_RELEASE: '0', BENTO_BUILD_MODE: 'dev' }));
});

test('MUXUI_LOCAL must be an absolute path to generated @muxui/react', () => {
  assert.throws(() => resolveMuxLocal({ MUXUI_LOCAL: 'packages/react' }), /absolute path/);
  assert.throws(
    () => resolveMuxLocal({ MUXUI_LOCAL: path.join(tempDir(), 'missing') }),
    /package\.json/,
  );
  assert.throws(
    () => resolveMuxLocal({ MUXUI_LOCAL: muxFixture({ name: '@muxui/tokens' }) }),
    /expected "@muxui\/react"/,
  );
  assert.throws(
    () => resolveMuxLocal({ MUXUI_LOCAL: muxFixture({ generate: false }) }),
    /generated\/index\.mjs/,
  );

  const partial = muxFixture();
  fs.rmSync(path.join(partial, 'generated', 'themes.css'));
  assert.throws(
    () => resolveMuxLocal({ MUXUI_LOCAL: partial }),
    /export "\.\/themes\.css".*missing/,
  );
});

test('aliases are exact-match regexes, one per public export', () => {
  const root = muxFixture();
  const mux = resolveMuxLocal({ MUXUI_LOCAL: root });
  const resolveAlias = (specifier) => {
    const matches = mux.aliases.filter(({ find }) => find.test(specifier));
    assert.equal(matches.length, 1, `${specifier} must match exactly one alias`);
    return path.relative(root, matches[0].replacement);
  };

  assert.deepEqual(
    Object.fromEntries(
      [
        '@muxui/react',
        '@muxui/react/compatibility',
        '@muxui/react/styles.css',
        '@muxui/react/themes',
        '@muxui/react/themes.css',
        '@muxui/react/testing',
        '@muxui/react/text-editor',
        '@muxui/react/markdown',
      ].map((specifier) => [specifier, resolveAlias(specifier)]),
    ),
    {
      '@muxui/react': 'generated/index.mjs',
      '@muxui/react/compatibility': 'generated/compatibility.mjs',
      '@muxui/react/styles.css': 'generated/styles.css',
      '@muxui/react/themes': 'generated/themes.mjs',
      '@muxui/react/themes.css': 'generated/themes.css',
      '@muxui/react/testing': 'generated/testing.mjs',
      '@muxui/react/text-editor': 'generated/text-editor.mjs',
      '@muxui/react/markdown': 'generated/markdown.mjs',
    },
  );
  assert.equal(mux.aliases.length, Object.keys(exportsMap).length);
  // No prefix behavior: unlisted subpaths and lookalikes stay unaliased.
  for (const specifier of [
    '@muxui/react/generated/index.mjs',
    '@muxui/react-native',
    '@muxui/reactx',
  ]) {
    assert.equal(
      mux.aliases.some(({ find }) => find.test(specifier)),
      false,
      specifier,
    );
  }
  assert.deepEqual(Object.keys(mux.types), [
    '@muxui/react',
    '@muxui/react/themes',
    '@muxui/react/text-editor',
    '@muxui/react/markdown',
  ]);
});

test('local Vite config dedupes React and keeps the workspace root in fs.allow', () => {
  const root = muxFixture();
  const mux = resolveMuxLocal({ MUXUI_LOCAL: root });
  const config = muxLocalViteConfig(mux, '/workspace');
  assert.deepEqual(config.resolve.dedupe, ['react', 'react-dom']);
  assert.equal(config.resolve.alias, mux.aliases);
  assert.deepEqual(config.server.fs.allow, ['/workspace', root]);
});

test('local tsconfig maps public declarations and keeps @shared', () => {
  const root = muxFixture();
  const { extends: base, compilerOptions } = muxLocalTsconfig(
    resolveMuxLocal({ MUXUI_LOCAL: root }),
  );
  assert.equal(base, './tsconfig.json');
  assert.deepEqual(compilerOptions.paths['@shared/*'], ['../_shared/*']);
  assert.deepEqual(compilerOptions.paths['@muxui/react'], [
    path.join(root, 'generated/index.d.ts'),
  ]);
  assert.equal('@muxui/react/styles.css' in compilerOptions.paths, false);
});

function emitStamp(mux, npmPackageJson) {
  let emitted;
  muxSourcePlugin(mux, npmPackageJson).generateBundle.call({
    emitFile: (file) => (emitted = file),
  });
  return emitted;
}

const check = (text, variant) =>
  assertMuxSourceStamp(text, { where: 'stamp', variant, variants: ROLLBACK_VARIANTS });
const npmStamp = '{"source":"npm","version":"0.1.0-rc.1"}';
const localStamp = '{"source":"local"}';
const stampFor = (variant) => JSON.stringify(rollbackMuxStamp(variant));

test('the shell build stamps its Mux source and the stamp policy reads it back', () => {
  const npmPackage = path.join(tempDir(), 'package.json');
  fs.writeFileSync(npmPackage, JSON.stringify({ version: '0.1.0-rc.1' }));
  const mux = resolveMuxLocal({ MUXUI_LOCAL: muxFixture() });

  const npm = emitStamp(undefined, npmPackage);
  assert.equal(npm.fileName, 'muxui-source.json');
  assert.deepEqual(JSON.parse(npm.source), { source: 'npm', version: '0.1.0-rc.1' });
  const local = emitStamp(mux, npmPackage);
  assert.deepEqual(JSON.parse(local.source), { source: 'local' });

  assert.doesNotThrow(() => check(npm.source, undefined));
  assert.throws(() => check(local.source, undefined), /"source":"local".*MUXUI_LOCAL/s);
});

test('without a rollback variant only an npm stamp may ship', () => {
  assert.doesNotThrow(() => check(npmStamp, undefined));
  assert.throws(() => check(localStamp, undefined), /expected the published npm/);
  assert.throws(() => check(undefined, undefined), /missing/);
  assert.throws(() => check('not json', undefined), /not valid JSON/);
  assert.throws(() => check('{"source":"npm"', undefined), /not valid JSON/);
  assert.throws(
    () => check(stampFor('rollback-final-r2'), undefined),
    /expected the published npm/,
  );
});

test('a rollback variant ships only its own stamp, never npm, local, or missing', () => {
  for (const variant of ROLLBACK_VARIANTS) {
    assert.doesNotThrow(() => check(stampFor(variant), variant));
    const other = ROLLBACK_VARIANTS.find((name) => name !== variant);
    assert.throws(() => check(stampFor(other), variant), new RegExp(`expected ${variant}`));
    assert.throws(() => check(npmStamp, variant), new RegExp(`expected ${variant}`));
    assert.throws(() => check(localStamp, variant), new RegExp(`expected ${variant}`));
    assert.throws(() => check(undefined, variant), /missing/);
  }
});

test('an unknown BENTO_RELEASE_VARIANT is rejected even with a matching stamp', () => {
  const unknown = 'not-a-rollback-variant';
  assert.throws(() => check(stampFor(unknown), unknown), /not a rollback variant/);
  assert.throws(() => check(undefined, unknown), /not a rollback variant/);
  assert.throws(() => check(npmStamp, unknown), /not a rollback variant/);
});
