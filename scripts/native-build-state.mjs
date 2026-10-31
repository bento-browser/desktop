import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertLocalBuildPaths, loadConfig, nativeBuildSettings } from './bento-build.mjs';
import { readEntry } from './read-entry.mjs';
import { git, replaySeriesChanges } from './series-replay.mjs';
import { builtinAddonSources, builtinAddonBuildBlock } from './install-builtin-addons.mjs';

export const NATIVE_BUILD_RECEIPT = '.bento-native-build.json';
const SCHEMA = 1;
const TOOLCHAIN_ENV = [
  'CC', 'CXX', 'AR', 'LD', 'RUSTC', 'CARGO', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS',
  'LDFLAGS', 'RUSTFLAGS', 'SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'BENTO_RUST_LTO',
  'BENTO_MACH_PYTHON', 'MOZBUILD_STATE_PATH', 'HOST_CC', 'HOST_CXX',
  'RUSTUP_TOOLCHAIN', 'CARGO_BUILD_TARGET', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
  // Explicit compilation/link/SDK options in Firefox's toolchain.configure.
  'HOST_CPPFLAGS', 'HOST_CFLAGS', 'HOST_CXXFLAGS', 'HOST_LDFLAGS',
  'AS', 'ASFLAGS', 'AR_FLAGS', 'LIBS', 'MOZ_OPTIMIZE_FLAGS', 'MOZ_DEBUG_FLAGS',
  'MACOS_SDK_DIR', 'IPHONEOS_SDK_DIR', 'IPHONEOS_DEPLOYMENT_TARGET',
  'TOOLCHAIN_PREFIX', 'COMPILER_WRAPPER', 'CCACHE', 'WASM_CC', 'WASM_CXX',
  'MOZ_HAZARD', 'MOZ_STDCXX_COMPAT', 'MOZ_FORCE_GOLD', 'MOZ_CLANG_RT_ASAN_LIB_PATH',
  'MOZ_SECURITY_HARDENING', 'MOZ_CODE_COVERAGE', 'ENABLE_CLANG_PLUGIN',
];

function stale(component) {
  const error = new Error(`native build is stale (${component}); run pnpm run build in this checkout before default launch`);
  error.code = 'BENTO_NATIVE_STALE';
  throw error;
}

function verificationFailure(error) {
  if (error.code === 'BENTO_NATIVE_STALE' || error.code === 'BENTO_USER_ERROR') throw error;
  stale(`verification failed: ${error.message.split('\n')[0]}`);
}

const hash = (content) => crypto.createHash('sha256').update(content).digest('hex');
const fingerprint = (value) => hash(JSON.stringify(value));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Only compiled source and build definitions are mapped. Whole patch files are
// still inputs, so changing any patch conservatively requires a full build.
function isNativeSource(relative) {
  return /\.(?:c|cc|cpp|cxx|m|mm|h|hh|hpp|hxx|rs|s|asm|inc|idl|webidl|ipdl|ipdlh|def|rc|py|configure)$/i.test(relative)
    || /(?:^|\/)(?:moz\.build|Makefile(?:\.[^/]+)?|Cargo\.(?:toml|lock)|configure(?:\.sh)?)$/.test(relative);
}

function filesUnder(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return filesUnder(path.join(directory, entry.name), `${relative}/`);
    if (entry.isSymbolicLink()) throw new Error(`native build source must not be a symlink: ${relative}`);
    return entry.isFile() && isNativeSource(relative) ? [relative] : [];
  });
}

function overlays(root) {
  const entries = filesUnder(path.join(root, 'src')).map((relative) => ({
    source: `src/${relative}`, destination: relative,
  }));
  for (const relative of filesUnder(path.join(root, 'branding', 'bento'))) {
    entries.push({ source: `branding/bento/${relative}`, destination: `browser/branding/bento/${relative}` });
  }
  return entries;
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function context(root) {
  assertLocalBuildPaths(root);
  root = fs.realpathSync(root);
  const settings = nativeBuildSettings(root);
  if (fs.existsSync(settings.objdir) && !contained(root, fs.realpathSync(settings.objdir))) {
    stale('object directory resolves outside checkout');
  }
  return { root, engine: path.join(root, 'engine'), settings, receipt: path.join(settings.objdir, NATIVE_BUILD_RECEIPT) };
}

function nativeInputs(ctx) {
  const { root, engine, settings } = ctx;
  const config = loadConfig(root);
  const manifest = json(path.join(root, 'patches', 'series.json'));
  const source = json(path.join(root, '.bento', 'source-state.json'));
  const baseRef = `refs/bento/firefox-base/${manifest.base.version}`;
  const baseTree = git(engine, ['rev-parse', `${baseRef}^{tree}`]).trim();
  if (manifest.base.product !== config.firefox.product || manifest.base.version !== config.firefox.version
      || source.product !== config.firefox.product || source.version !== config.firefox.version
      || source.archiveSha256 !== config.firefox.source.sha256 || manifest.base.tree !== baseTree) {
    stale('Firefox source/base identity; import the configured source first');
  }
  const inputs = {
    'Firefox source/base': fingerprint({ firefox: config.firefox, base: manifest.base, baseTree }),
    'patches/series.json': hash(fs.readFileSync(path.join(root, 'patches', 'series.json'))),
    'built-in add-on directories': fingerprint(addonNames(root)),
  };
  for (const entry of manifest.series) inputs[entry.path] = hash(fs.readFileSync(path.join(root, entry.path)));
  for (const entry of overlays(root)) inputs[entry.source] = hash(fs.readFileSync(path.join(root, entry.source)));
  for (const relative of ['configs/common/mozconfig', `configs/${settings.platform}/mozconfig`, 'mozconfig', 'rust-toolchain.toml']) {
    const file = path.join(root, relative);
    inputs[relative] = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
  }
  inputs['canonical mozconfig'] = hash(settings.mozconfig);
  inputs['resolved mode/target'] = fingerprint({
    mode: settings.mode, platform: process.platform, arch: process.arch,
    objdir: path.relative(root, settings.objdir),
  });
  inputs['declared toolchain environment'] = fingerprint(Object.fromEntries(TOOLCHAIN_ENV.map((name) => [name, process.env[name] || ''])));
  return inputs;
}

function addonNames(root) {
  return fs.existsSync(path.join(root, 'extensions'))
    ? builtinAddonSources(root).map((addon) => addon.name) : [];
}

function engineEntry(ctx, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) stale('invalid receipt engine path');
  const file = path.join(ctx.engine, relative);
  const entry = readEntry(file);
  if (!entry) return null;
  if (!entry.content) return { directory: true };
  return {
    mode: (entry.symlink ? fs.statSync(file).mode : entry.mode) & 0o111,
    digest: hash(entry.symlink ? fs.readFileSync(file) : entry.content),
  };
}

function engineSnapshot(ctx, paths) {
  return Object.fromEntries(paths.map((relative) => [relative, engineEntry(ctx, relative)]));
}

function requireCurrentImports(ctx) {
  const expectedOverlays = overlays(ctx.root);
  const overlayPaths = new Set(expectedOverlays.map((entry) => entry.destination));
  const paths = new Set(['mozconfig']);
  const changes = replaySeriesChanges(ctx.root);
  const manifest = json(path.join(ctx.root, 'patches', 'series.json'));
  const baseRef = `refs/bento/firefox-base/${manifest.base.version}`;
  const addons = addonNames(ctx.root);
  const addonBuildPath = 'browser/extensions/moz.build';
  const addonSuffix = `\n\n${builtinAddonBuildBlock(addons)}\n`;
  if (addons.length && !changes.has(addonBuildPath)) {
    const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(git(ctx.engine, ['ls-tree', '-z', baseRef, '--', addonBuildPath]));
    if (!match) stale(`native import engine/${addonBuildPath} has no source base`);
    changes.set(addonBuildPath, { status: 'M', mode: match[1], oid: match[2] });
  }
  // A removed patch can leave its old native edit imported. Compare tracked
  // native changes outside the current replay to the base as well.
  for (const relative of git(ctx.engine, ['diff', '--name-only', '-z', baseRef]).split('\0').filter(Boolean)) {
    if (!isNativeSource(relative) || changes.has(relative) || overlayPaths.has(relative)) continue;
    const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(git(ctx.engine, ['ls-tree', '-z', baseRef, '--', relative]));
    if (match) changes.set(relative, { status: 'M', mode: match[1], oid: match[2] });
  }
  for (const [relative, change] of changes) {
    if (!isNativeSource(relative) || overlayPaths.has(relative)) continue;
    paths.add(relative);
    const entry = readEntry(path.join(ctx.engine, relative));
    if (change.status === 'D') {
      if (entry?.content) stale(`native import engine/${relative} should be deleted`);
    } else {
      const mode = entry?.symlink ? '120000' : entry?.mode & 0o100 ? '100755' : '100644';
      let content = entry?.content;
      if (relative === addonBuildPath && content) {
        const source = content.toString('utf8');
        // Only the current installer's exact generated suffix is owned here.
        // Compare every upstream byte/mode; snapshot the full final file below.
        if (source.endsWith(addonSuffix)) content = Buffer.from(`${source.slice(0, -addonSuffix.length)}\n`);
        else if (addons.length) stale(`native import engine/${relative} differs from current add-on registration; run pnpm run import first`);
      }
      const oid = content && git(ctx.engine, ['hash-object', '--no-filters', '--stdin'], { input: content }).trim();
      if (change.mode !== mode || change.oid !== oid) stale(`native import engine/${relative} differs from current patches; run pnpm run import first`);
    }
  }
  for (const entry of expectedOverlays) {
    paths.add(entry.destination);
    const actual = engineEntry(ctx, entry.destination);
    if (actual?.digest !== hash(fs.readFileSync(path.join(ctx.root, entry.source)))) {
      stale(`native import engine/${entry.destination} differs from ${entry.source}; run pnpm run import first`);
    }
  }
  if (fs.readFileSync(path.join(ctx.engine, 'mozconfig'), 'utf8') !== ctx.settings.mozconfig) stale('engine/mozconfig differs from canonical intent');
  return [...paths].sort();
}

/** Read-only equivalent of the full build's native input/import preflight. */
export function assertNativeBuildInputsCurrent(root) {
  try {
    const ctx = context(root);
    nativeInputs(ctx);
    requireCurrentImports(ctx);
  } catch (error) { verificationFailure(error); }
}

function changed(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].find((key) => fingerprint(before[key] ?? null) !== fingerprint(after[key] ?? null));
}

function compilerEvidence(ctx) {
  const status = fs.readFileSync(path.join(ctx.settings.objdir, 'config.status'), 'utf8');
  const evidence = {};
  for (const name of ['CC', 'CXX', 'CC_VERSION', 'HOST_CC_VERSION', 'RUSTC', 'RUSTC_VERSION', 'RUSTC_COMMIT', 'RUST_TARGET']) {
    // Read configure's compiler evidence as text; never execute config.status or
    // invoke rustup/compiler discovery during launch.
    evidence[name] = new RegExp(`^\\s*'${name}': (?:\\[\\s*)?'([^'\\n]*)'`, 'm').exec(status)?.[1] ?? null;
  }
  if (!evidence.CC || !evidence.CC_VERSION || !evidence.RUSTC || !evidence.RUSTC_VERSION) stale('missing configured compiler evidence');
  const info = json(path.join(ctx.settings.objdir, 'mozinfo.json'));
  evidence.target = Object.fromEntries(['os', 'processor', 'bits', 'debug', 'cc_type', 'toolkit'].map((name) => [name, info[name] ?? null]));
  return evidence;
}

function nativeOutputPaths(ctx) {
  const config = loadConfig(ctx.root);
  const directory = process.platform === 'darwin'
    ? `dist/${config.build.macosBundleName || 'Bento'}.app/Contents/MacOS`
    : 'dist/bin';
  return {
    xul: `${directory}/${process.platform === 'darwin' ? 'XUL' : process.platform === 'win32' ? 'xul.dll' : 'libxul.so'}`,
    executable: path.join(ctx.settings.objdir, directory, `${config.binaryName || 'bento'}${process.platform === 'win32' ? '.exe' : ''}`),
  };
}

function verifiedExecutable(ctx) {
  const { executable } = nativeOutputPaths(ctx);
  if (!contained(ctx.settings.objdir, executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile()) stale('missing produced executable');
  if (!contained(fs.realpathSync(ctx.settings.objdir), fs.realpathSync(executable))) stale('executable resolves outside object directory');
  fs.accessSync(executable, fs.constants.X_OK);
  // Preserve the logical app-bundle path: resolving an owned build symlink here
  // could change the application's bundle/resource lookup at launch.
  return executable;
}

async function xulDigest(ctx) {
  const { xul: relative } = nativeOutputPaths(ctx);
  const file = path.join(ctx.settings.objdir, relative);
  if (!fs.existsSync(file)) stale(`missing produced XUL: ${relative}`);
  if (!contained(fs.realpathSync(ctx.settings.objdir), fs.realpathSync(file))) stale('XUL resolves outside object directory');
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return { path: relative, digest: digest.digest('hex') };
}

/** Only the successful full native build path may issue this receipt. */
export async function withNativeBuildReceipt(root, build) {
  try {
    await buildWithReceipt(root, build);
  } catch (error) {
    verificationFailure(error);
  }
}

async function buildWithReceipt(root, build) {
  const ctx = context(root);
  fs.rmSync(ctx.receipt, { force: true });
  const inputs = nativeInputs(ctx);
  const paths = requireCurrentImports(ctx);
  const engine = engineSnapshot(ctx, paths);
  await build();
  const xul = await xulDigest(ctx);
  const compiler = compilerEvidence(ctx);
  const after = context(root);
  const inputChange = changed(inputs, nativeInputs(after));
  if (inputChange) stale(`native input changed during build: ${inputChange}`);
  const engineChange = changed(engine, engineSnapshot(after, paths));
  if (engineChange) stale(`native engine changed during build: ${engineChange}`);
  const temporary = `${ctx.receipt}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA, checkout: ctx.root, inputs, engine, compiler, xul }, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, ctx.receipt);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Read-only default-launch gate; import/UI builds cannot create or repair it. */
export async function assertNativeBuildFresh(root) {
  try {
    return await checkReceipt(root);
  } catch (error) {
    verificationFailure(error);
  }
}

async function checkReceipt(root) {
  const ctx = context(root);
  let receipt;
  try { receipt = json(ctx.receipt); } catch { stale(`missing or unreadable ${NATIVE_BUILD_RECEIPT}`); }
  if (receipt.schemaVersion !== SCHEMA || receipt.checkout !== ctx.root || !receipt.inputs || !receipt.engine || !receipt.compiler || !receipt.xul) stale('invalid native build receipt');
  const inputChange = changed(receipt.inputs, nativeInputs(ctx));
  if (inputChange) stale(`native input changed: ${inputChange}`);
  const engineChange = changed(receipt.engine, engineSnapshot(ctx, Object.keys(receipt.engine)));
  if (engineChange) stale(`native engine changed: ${engineChange}`);
  if (fingerprint(receipt.compiler) !== fingerprint(compilerEvidence(ctx))) stale('configured compiler/target changed');
  if (fingerprint(receipt.xul) !== fingerprint(await xulDigest(ctx))) stale('XUL changed');
  return verifiedExecutable(ctx);
}
