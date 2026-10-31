import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { main, nativeBuildSettings, recordEngineState, writeMozconfig } from './bento-build.mjs';
import { importSourceOverlays } from './import-sources.mjs';
import { installBuiltinAddons } from './install-builtin-addons.mjs';
import { assertNativeBuildFresh, assertNativeBuildInputsCurrent, NATIVE_BUILD_RECEIPT, withNativeBuildReceipt } from './native-build-state.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function put(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: path.join(root, 'engine'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, bundleName = 'Bento') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-native-state-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = { ...process.env };
  for (const name of ['BENTO_BUILD_MODE', 'BENTO_RELEASE', 'BENTO_OBJDIR', 'MOZCONFIG']) delete process.env[name];
  t.after(() => { process.env = previous; });
  const config = {
    schemaVersion: 1, brand: 'bento', build: { mode: 'dev', macosBundleName: bundleName },
    firefox: { product: 'firefox', version: '158.0', source: { sha256: '0'.repeat(64) } },
    brands: { bento: { release: { displayVersion: '0.0.1' } } },
    updates: { enabled: false, channel: 'bento', hostname: 'updates.invalid' },
  };
  put(root, 'bento.json', JSON.stringify(config));
  for (const platform of ['macos', 'linux', 'windows']) put(root, `configs/${platform}/mozconfig`, '. "$topsrcdir/../configs/common/mozconfig"\n');
  put(root, 'configs/common/mozconfig', 'ac_add_options --enable-application=browser\n');
  put(root, 'rust-toolchain.toml', '[toolchain]\nchannel="1.95.0"\n');
  put(root, 'engine/layout/one.cpp', 'old one\n');
  put(root, 'engine/layout/two.cpp', 'old two\n');
  put(root, 'engine/toolkit/moz.build', '');
  put(root, 'engine/browser/extensions/moz.build', '# upstream\nDIRS += ["webcompat"]\n');
  put(root, 'engine/mach', 'stub mach');
  put(root, 'engine/.gitignore', '/mozconfig\n/obj-*\n');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['update-ref', 'refs/bento/firefox-base/158.0', 'HEAD']);
  const base = { product: 'firefox', version: '158.0', tree: git(root, ['rev-parse', 'HEAD^{tree}']), contentTree: 'a'.repeat(64) };
  const series = ['one', 'two'].map((name) => {
    put(root, `engine/layout/${name}.cpp`, `new ${name}\n`);
    const patchPath = `patches/${name}.patch`;
    put(root, patchPath, git(root, ['diff', '--', `layout/${name}.cpp`]) + '\n');
    return { path: patchPath, id: name };
  });
  put(root, 'patches/series.json', JSON.stringify({ schemaVersion: 1, base, series }));
  put(root, '.bento/source-state.json', JSON.stringify({ product: 'firefox', version: '158.0', archiveSha256: config.firefox.source.sha256 }));
  put(root, 'src/layout/overlay.cpp', 'native overlay\n');
  put(root, 'engine/layout/overlay.cpp', 'native overlay\n');
  put(root, 'branding/bento/configure.sh', 'MOZ_APP_NAME=bento\n');
  put(root, 'engine/browser/branding/bento/configure.sh', 'MOZ_APP_NAME=bento\n');
  writeMozconfig(root);
  const settings = nativeBuildSettings(root);
  const receipt = path.join(settings.objdir, NATIVE_BUILD_RECEIPT);
  const xul = process.platform === 'darwin' ? `dist/${bundleName}.app/Contents/MacOS/XUL` : `dist/bin/${process.platform === 'win32' ? 'xul.dll' : 'libxul.so'}`;
  const binary = process.platform === 'darwin' ? `dist/${bundleName}.app/Contents/MacOS/bento` : `dist/bin/bento${process.platform === 'win32' ? '.exe' : ''}`;
  const output = () => {
    put(settings.objdir, xul, 'compiled native library');
    fs.chmodSync(put(settings.objdir, binary, '#!/bin/sh\nexit 0\n'), 0o755);
    put(settings.objdir, 'config.status', "substs = {\n 'CC': ['/compiler/clang', '-flag'],\n 'CXX': ['/compiler/clang++'],\n 'CC_VERSION': '21.1.8',\n 'RUSTC': '/compiler/rustc',\n 'RUSTC_VERSION': '1.95.0',\n}\n");
    put(settings.objdir, 'mozinfo.json', JSON.stringify({ os: 'test', processor: process.arch, bits: 64, debug: false, cc_type: 'clang' }));
  };
  return { root, settings, receipt, output, xul: path.join(settings.objdir, xul), executable: path.join(settings.objdir, binary) };
}

function copyLaunchScripts(f) {
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(f.root, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(f.root, 'node_modules'), 'dir');
  put(f.root, 'extensions/bento-shell/muxui-local.mjs', fs.readFileSync(path.join(repoRoot, 'extensions/bento-shell/muxui-local.mjs')));
}

function modifyJson(file, update) {
  const value = JSON.parse(fs.readFileSync(file));
  update(value);
  fs.writeFileSync(file, JSON.stringify(value));
}

test('only a successful full native build issues a receipt; ordinary UI and metadata remain eligible', async (t) => {
  const f = fixture(t);
  f.output();
  await assert.rejects(assertNativeBuildFresh(f.root), /missing or unreadable.*pnpm run build/);
  await withNativeBuildReceipt(f.root, f.output);
  const receipt = fs.readFileSync(f.receipt, 'utf8');
  assert.equal(await assertNativeBuildFresh(f.root), f.executable);
  await importSourceOverlays({ repoRoot: f.root });
  assert.equal(await assertNativeBuildFresh(f.root), f.executable, 'relinking identical native overlays does not require recompilation');
  put(f.root, 'src/browser/theme.css', 'changed colour');
  put(f.root, 'src/browser/mount.js', 'changed JS');
  put(f.root, 'extensions/bento-shell/dist/app.js', 'changed shell');
  put(f.root, 'engine/browser/mount.js', 'changed imported JS');
  put(f.settings.objdir, 'dist/application.ini', 'BuildID=unrelated metadata');
  modifyJson(path.join(f.root, 'bento.json'), (value) => { value.brands.bento.release.displayVersion = '0.0.2'; });
  writeMozconfig(f.root);
  recordEngineState(f.root);
  assert.equal(await assertNativeBuildFresh(f.root), f.executable);
  assert.equal(fs.readFileSync(f.receipt, 'utf8'), receipt, 'record/UI metadata never repair or reissue a receipt');
});

test('each supported explicit compile, link and SDK environment input independently invalidates', async (t) => {
  const f = fixture(t);
  await withNativeBuildReceipt(f.root, f.output);
  for (const name of [
    'MACOS_SDK_DIR', 'MOZ_OPTIMIZE_FLAGS', 'ASFLAGS', 'AR_FLAGS', 'LIBS',
    'HOST_CPPFLAGS', 'HOST_CFLAGS', 'HOST_CXXFLAGS', 'HOST_LDFLAGS',
    'AS', 'MOZ_DEBUG_FLAGS', 'IPHONEOS_SDK_DIR', 'IPHONEOS_DEPLOYMENT_TARGET',
    'TOOLCHAIN_PREFIX', 'COMPILER_WRAPPER', 'CCACHE', 'WASM_CC', 'WASM_CXX',
    'MOZ_HAZARD', 'MOZ_STDCXX_COMPAT', 'MOZ_FORCE_GOLD', 'MOZ_CLANG_RT_ASAN_LIB_PATH',
    'MOZ_SECURITY_HARDENING', 'MOZ_CODE_COVERAGE', 'ENABLE_CLANG_PLUGIN',
  ]) {
    const previous = process.env[name];
    process.env[name] = `${previous || ''}-changed`;
    await assert.rejects(assertNativeBuildFresh(f.root), /declared toolchain environment/, name);
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
  process.env.MOZ_LOG = 'paint:5';
  assert.equal(await assertNativeBuildFresh(f.root), f.executable, 'runtime-only MOZ variables remain excluded');
});

test('patch bytes, order, base, source, config, mode and declared toolchains invalidate independently', async (t) => {
  const f = fixture(t);
  const changes = [
    ['patch bytes', () => fs.appendFileSync(path.join(f.root, 'patches/one.patch'), '\nmail metadata changed\n'), /patches\/one.patch/],
    ['patch order', () => modifyJson(path.join(f.root, 'patches/series.json'), (v) => v.series.reverse()), /patches\/series.json/],
    ['base', () => modifyJson(path.join(f.root, 'patches/series.json'), (v) => { v.base.contentTree = 'b'.repeat(64); }), /Firefox source\/base/],
    ['source identity', () => modifyJson(path.join(f.root, 'bento.json'), (v) => { v.firefox.source.sha256 = '1'.repeat(64); }), /Firefox source\/base/],
    ['config', () => fs.appendFileSync(path.join(f.root, 'configs/common/mozconfig'), '# changed\n'), /configs\/common\/mozconfig/],
    ['mode', () => { process.env.BENTO_BUILD_MODE = 'debug'; }, /canonical mozconfig|mode\/target/],
    ['native overlay', () => fs.appendFileSync(path.join(f.root, 'src/layout/overlay.cpp'), 'changed\n'), /src\/layout\/overlay.cpp/],
    ['build definition', () => put(f.root, 'src/layout/moz.build', 'SOURCES += ["overlay.cpp"]\n'), /src\/layout\/moz.build/],
    ['Rust pin', () => fs.appendFileSync(path.join(f.root, 'rust-toolchain.toml'), '# changed\n'), /rust-toolchain.toml/],
    ['toolchain declaration', () => { process.env.CC = '/other/compiler'; }, /declared toolchain/],
  ];
  const files = ['bento.json', 'patches/series.json', 'patches/one.patch', 'configs/common/mozconfig', 'src/layout/overlay.cpp', 'rust-toolchain.toml'];
  const saved = new Map(files.map((relative) => [relative, fs.readFileSync(path.join(f.root, relative))]));
  const cc = process.env.CC;
  for (const [name, change, pattern] of changes) {
    await withNativeBuildReceipt(f.root, f.output);
    change();
    await assert.rejects(assertNativeBuildFresh(f.root), pattern, name);
    for (const [relative, bytes] of saved) put(f.root, relative, bytes);
    fs.rmSync(path.join(f.root, 'src/layout/moz.build'), { force: true });
    delete process.env.BENTO_BUILD_MODE;
    if (cc === undefined) delete process.env.CC; else process.env.CC = cc;
  }
});

test('stale current native imports block compilation even if engine state was recorded', async (t) => {
  const f = fixture(t);
  for (const [file, pattern] of [['engine/layout/one.cpp', /native import.*one.cpp/], ['engine/layout/overlay.cpp', /native import.*overlay.cpp/]]) {
    const original = fs.readFileSync(path.join(f.root, file));
    put(f.root, file, 'stale imported C++\n');
    recordEngineState(f.root);
    let ran = false;
    await assert.rejects(withNativeBuildReceipt(f.root, () => { ran = true; f.output(); }), pattern);
    assert.equal(ran, false, 'stale import is rejected before mach');
    assert.equal(fs.existsSync(f.receipt), false);
    put(f.root, file, original);
  }
  modifyJson(path.join(f.root, 'patches/series.json'), (value) => { value.series = value.series.slice(1); });
  await assert.rejects(withNativeBuildReceipt(f.root, f.output), /native import.*one.cpp/, 'removed patches must be reset to the base before building');
});

test('supported built-in addon registration is current native import output, and its membership is build intent', async (t) => {
  const f = fixture(t);
  for (const name of ['bento-tools', 'bento-shell', 'ublock-origin']) {
    put(f.root, `extensions/${name}/manifest.json`, JSON.stringify({ applications: { gecko: { id: `${name}@test` } } }));
  }
  installBuiltinAddons({ repoRoot: f.root, release: false });
  const imported = fs.readFileSync(path.join(f.root, 'engine/browser/extensions/moz.build'));
  assertNativeBuildInputsCurrent(f.root);
  assert.equal(fs.existsSync(f.receipt), false, 'read-only import verification cannot issue a receipt');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'engine/browser/extensions/moz.build')), imported);
  await withNativeBuildReceipt(f.root, f.output);
  assert.equal(await assertNativeBuildFresh(f.root), f.executable);
  put(f.root, 'extensions/new-addon/manifest.json', JSON.stringify({ applications: { gecko: { id: 'new@test' } } }));
  await assert.rejects(assertNativeBuildFresh(f.root), /built-in add-on directories/);
  let compiled = false;
  await assert.rejects(withNativeBuildReceipt(f.root, () => { compiled = true; }), /native import.*extensions\/moz.build/);
  assert.equal(compiled, false, 'a stale owner block cannot compile after membership changes');
  installBuiltinAddons({ repoRoot: f.root, release: false });
  await withNativeBuildReceipt(f.root, f.output);
  assert.equal(await assertNativeBuildFresh(f.root), f.executable);
});

test('addon-owned import comparison rejects changed build directives inside or outside its exact current block', async (t) => {
  const f = fixture(t);
  put(f.root, 'extensions/bento-shell/manifest.json', JSON.stringify({ applications: { gecko: { id: 'shell@test' } } }));
  installBuiltinAddons({ repoRoot: f.root, release: false });
  const file = path.join(f.root, 'engine/browser/extensions/moz.build');
  const legitimate = fs.readFileSync(file, 'utf8');
  const cases = [
    legitimate.replace('# END BENTO', 'SOURCES += ["injected.cpp"]\n# END BENTO'),
    legitimate.replace('["bento-shell"]', '["bento-shell", "unowned-addon"]'),
    legitimate.replace('["webcompat"]', '["other-upstream"]'),
    `${legitimate}SOURCES += ["outside.cpp"]\n`,
    legitimate.replace('# BEGIN BENTO BUILTIN ADDONS', '# BEGIN BENTO BUILTIN ADDONS\n# BEGIN BENTO BUILTIN ADDONS'),
    '# upstream\nDIRS += ["webcompat"]\n',
  ];
  for (const content of cases) {
    put(f.root, 'engine/browser/extensions/moz.build', content);
    recordEngineState(f.root);
    let compiled = false;
    await assert.rejects(withNativeBuildReceipt(f.root, () => { compiled = true; }), /native import.*extensions\/moz.build/);
    assert.equal(compiled, false);
    assert.equal(fs.existsSync(f.receipt), false);
  }
  put(f.root, 'engine/browser/extensions/moz.build', legitimate);
  fs.chmodSync(file, 0o755);
  await assert.rejects(withNativeBuildReceipt(f.root, f.output), /native import.*extensions\/moz.build/, 'the owner transform cannot hide a mode change');
  fs.chmodSync(file, 0o644);
  await assert.rejects(withNativeBuildReceipt(f.root, () => {
    f.output();
    put(f.root, 'engine/browser/extensions/moz.build', cases[0]);
  }), /native engine changed during build: browser\/extensions\/moz.build/);
  assert.equal(fs.existsSync(f.receipt), false);
  put(f.root, 'engine/browser/extensions/moz.build', legitimate);
  await withNativeBuildReceipt(f.root, f.output);
  put(f.root, 'engine/browser/extensions/moz.build', cases[0]);
  await assert.rejects(assertNativeBuildFresh(f.root), /native engine changed: browser\/extensions\/moz.build/, 'receipt snapshots retain the full generated file');
});

test('native engine bytes, configured compiler/target and actual XUL changes invalidate a receipt', async (t) => {
  const f = fixture(t);
  await withNativeBuildReceipt(f.root, f.output);
  put(f.root, 'engine/layout/one.cpp', 'manual native change');
  await assert.rejects(assertNativeBuildFresh(f.root), /native engine changed: layout\/one.cpp/);
  put(f.root, 'engine/layout/one.cpp', 'new one\n');
  fs.appendFileSync(f.xul, 'different binary');
  await assert.rejects(assertNativeBuildFresh(f.root), /XUL changed/);
  f.output();
  modifyJson(path.join(f.settings.objdir, 'mozinfo.json'), (value) => { value.processor = 'different-target'; });
  await assert.rejects(assertNativeBuildFresh(f.root), /configured compiler\/target/);
  f.output();
  fs.writeFileSync(path.join(f.settings.objdir, 'config.status'), fs.readFileSync(path.join(f.settings.objdir, 'config.status'), 'utf8').replace('21.1.8', '22.0.0'));
  await assert.rejects(assertNativeBuildFresh(f.root), /configured compiler\/target/);
});

test('failed builds and changes during compilation cannot bless the XUL', async (t) => {
  const f = fixture(t);
  await withNativeBuildReceipt(f.root, f.output);
  await assert.rejects(withNativeBuildReceipt(f.root, () => { throw new Error('stub compile failed'); }), /stub compile failed/);
  assert.equal(fs.existsSync(f.receipt), false);
  await assert.rejects(withNativeBuildReceipt(f.root, () => {
    f.output();
    fs.appendFileSync(path.join(f.root, 'patches/one.patch'), '\nchanged during build\n');
  }), /native input changed during build/);
  assert.equal(fs.existsSync(f.receipt), false);
  fs.writeFileSync(path.join(f.root, 'patches/one.patch'), fs.readFileSync(path.join(f.root, 'patches/one.patch'), 'utf8').replace('\nchanged during build\n', ''));
  await assert.rejects(withNativeBuildReceipt(f.root, () => {
    f.output();
    put(f.root, 'engine/layout/one.cpp', 'changed during compile\n');
  }), /native engine changed during build/);
  assert.equal(fs.existsSync(f.receipt), false);
});

test('driver full build issues, UI/import/record do not repair, and default launch fails before invoking an old binary', async (t) => {
  const f = fixture(t);
  copyLaunchScripts(f);
  put(f.root, 'engine/mach', 'stub mach');
  put(f.root, 'scripts/mach-raw.sh', '#!/bin/sh\nif [ "$2" = faster ]; then exit 0; fi\nnode scripts/stub-native-output.mjs\n');
  put(f.root, 'scripts/stub-native-output.mjs', `import fs from 'node:fs';\nconst files = ${JSON.stringify({ [f.xul]: 'stub XUL', [path.join(f.settings.objdir, 'config.status')]: " 'CC': ['clang'],\n 'CC_VERSION': '21',\n 'RUSTC': 'rustc',\n 'RUSTC_VERSION': '1.95',\n", [path.join(f.settings.objdir, 'mozinfo.json')]: '{"processor":"test"}' })};\nfor (const [file, bytes] of Object.entries(files)) { fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), {recursive:true}); fs.writeFileSync(file, bytes); }\n`);
  const executable = put(f.root, path.relative(f.root, f.executable), '#!/bin/sh\nprintf launched > "$BENTO_TEST_LAUNCH_MARKER"\n');
  fs.chmodSync(executable, 0o755);
  const marker = path.join(f.root, 'launched');
  const launch = (extra = {}) => spawnSync('bash', [path.join(f.root, 'scripts/dev-launch.sh'), path.join(f.root, 'fake-profile')], {
    encoding: 'utf8', env: { ...process.env, BENTO_BIN: '', BENTO_TEST_LAUNCH_MARKER: marker, ...extra },
  });
  const old = launch();
  assert.equal(old.status, 1);
  assert.match(old.stderr, /missing or unreadable.*pnpm run build/);
  assert.equal(fs.existsSync(marker), false);
  await importSourceOverlays({ repoRoot: f.root });
  await main(['build'], f.root);
  assert.equal(await assertNativeBuildFresh(f.root), f.executable);
  assert.equal(launch().status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'launched');
  fs.rmSync(marker);
  const receipt = fs.readFileSync(f.receipt, 'utf8');
  await importSourceOverlays({ repoRoot: f.root });
  await main(['build', '--ui'], f.root);
  assert.equal(fs.readFileSync(f.receipt, 'utf8'), receipt);
  assert.equal(await assertNativeBuildFresh(f.root), f.executable);
  fs.rmSync(f.receipt);
  await importSourceOverlays({ repoRoot: f.root });
  recordEngineState(f.root);
  await main(['build', '--ui'], f.root);
  assert.equal(fs.existsSync(f.receipt), false);
  assert.equal(launch().status, 1);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(launch({ BENTO_BIN: executable }).status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'launched');
});

test('default launch uses the verified custom macOS bundle and preserves its logical executable path', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const f = fixture(t, 'Custom');
  copyLaunchScripts(f);
  await withNativeBuildReceipt(f.root, f.output);
  // An owned build symlink must retain its Custom.app launch spelling. A
  // realpath return could change bundle lookup even though ownership is valid.
  const binary = put(f.settings.objdir, 'dist/bin/bento', '#!/bin/sh\nprintf "%s" "$0" > "$BENTO_TEST_LAUNCH_MARKER"\n');
  fs.chmodSync(binary, 0o755);
  fs.unlinkSync(f.executable);
  fs.symlinkSync(binary, f.executable);
  fs.chmodSync(put(f.settings.objdir, 'dist/Bento.app/Contents/MacOS/bento', '#!/bin/sh\nprintf stale-default > "$BENTO_TEST_LAUNCH_MARKER"\n'), 0o755);
  put(f.settings.objdir, 'dist/Bento.app/Contents/MacOS/XUL', 'retained stale default XUL');
  const marker = path.join(f.root, 'launched');
  // The CLI child needs the same synthetic host on non-macOS test runners.
  const preload = put(f.root, 'fake-macos.mjs', "Object.defineProperty(process, 'platform', { value: 'darwin' });\n");
  const env = { ...process.env, BENTO_BIN: '', BENTO_TEST_LAUNCH_MARKER: marker, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}` };
  const check = spawnSync(process.execPath, [path.join(f.root, 'scripts/bento-build.mjs'), 'native-check'], { env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, `${f.executable}\n`);
  const launch = spawnSync('bash', [path.join(f.root, 'scripts/dev-launch.sh'), path.join(f.root, 'fake-profile')], { env, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), f.executable, 'the retained stale Bento.app was not launched');
  fs.unlinkSync(f.executable);
  const foreign = put(f.root, 'outside-objdir/bento', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(foreign, 0o755);
  fs.symlinkSync(foreign, f.executable);
  await assert.rejects(assertNativeBuildFresh(f.root), /executable resolves outside object directory/);
});
