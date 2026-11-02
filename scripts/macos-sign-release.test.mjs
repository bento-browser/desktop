import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODESIGN_TIMESTAMP_WRAPPER,
  findStagedApp,
  machOFiles,
  machSignArgs,
  parseSigningRecord,
  signRelease,
  signingMode,
} from './macos-sign-release.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const IDENTITY = 'Developer ID Application: Bento Test (ABCDE12345)';
const ADHOC_DETAILS = 'Signature=adhoc\nTeamIdentifier=not set\n';
const DEVELOPER_ID_DETAILS = [
  `Authority=${IDENTITY}`,
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Nov 2, 2026 at 10:00:00 AM',
  'TeamIdentifier=ABCDE12345',
].join('\n');
const ACCEPTED = JSON.stringify({ id: 'sub-1', status: 'Accepted' });

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-sign-test-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A checkout with a minimal bento.json, the brand's DMG layout files and a packaged app at
// <objDist>/bento/Bento.app holding two Mach-O files and two text files.
function fixture() {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'bento.json'), JSON.stringify({
    schemaVersion: 1,
    binaryName: 'bento',
    firefox: { product: 'firefox', version: '158.0' },
    brand: 'bento',
    brands: { bento: { release: { displayVersion: '1.2.3' } } },
    build: { mode: 'release' },
  }));
  fs.mkdirSync(path.join(root, 'branding', 'bento'), { recursive: true });
  for (const name of ['dsstore', 'background.png']) {
    fs.writeFileSync(path.join(root, 'branding', 'bento', name), name);
  }
  const objDist = path.join(root, 'engine', 'obj-bento', 'dist');
  const staged = path.join(objDist, 'bento', 'Bento.app');
  fs.mkdirSync(path.join(staged, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(staged, 'Contents', 'Resources'));
  fs.writeFileSync(path.join(staged, 'Contents', 'Resources', 'application.ini'), '[App]\nVendor=Mozilla\nName=Bento\n\n[Gecko]\nName=Gecko\n');
  const macho = Buffer.from('cffaedfe00000000', 'hex');
  fs.writeFileSync(path.join(staged, 'Contents', 'MacOS', 'bento'), macho);
  fs.writeFileSync(path.join(staged, 'Contents', 'MacOS', 'libx.dylib'), macho);
  fs.writeFileSync(path.join(staged, 'Contents', 'Info.plist'), '<plist/>');
  return { root, objDist, staged, outDir: path.join(root, 'dist', 'macos-signing') };
}

// Records every command and plays the ones the pipeline reads back: ditto and hdiutil
// write files, codesign -dvv reports `details` for the app and a timestamp (or none)
// for each nested Mach-O, notarytool answers `notary`. `staged` collects what the DMG
// staging directory held when hdiutil create ran.
function fakeRun({ details = ADHOC_DETAILS, timestamped = () => true, notary = ACCEPTED } = {}) {
  const calls = [];
  const staged = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    const reply = (stdout = '', stderr = '', status = 0) => ({ status, stdout, stderr });
    if (command === 'ditto' && args[0] !== '-c') {
      fs.cpSync(args[0], args[1], { recursive: true, verbatimSymlinks: true });
    } else if (command === 'hdiutil' && args[0] === 'create') {
      const stage = args[args.indexOf('-srcfolder') + 1];
      for (const entry of fs.readdirSync(stage)) {
        const link = fs.lstatSync(path.join(stage, entry)).isSymbolicLink();
        staged.push(link ? `${entry} -> ${fs.readlinkSync(path.join(stage, entry))}` : entry);
      }
      staged.push(...fs.readdirSync(path.join(stage, '.background')).map((name) => `.background/${name}`));
      fs.writeFileSync(args.at(-1), 'dmg');
    } else if (command === 'codesign' && args[0] === '-dvv') {
      return args[1].endsWith('.app')
        ? reply('', details)
        : reply('', timestamped(args[1]) ? 'Timestamp=Nov 2, 2026\n' : 'Signature size=9\n');
    } else if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'submit') {
      return reply(notary);
    } else if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'log') {
      return reply('{"issues":[{"message":"binary is not signed"}]}');
    }
    return reply();
  };
  return { run, calls, staged };
}

const lines = (calls) => calls.map(({ command, args }) => [command, ...args].join(' '));
const sign = (setup, env = {}, run = fakeRun().run) =>
  signRelease({ root: setup.root, objDist: setup.objDist, outDir: setup.outDir, env, run, log: () => {} });
const developerIdEnv = { BENTO_MACOS_SIGN_IDENTITY: IDENTITY };

test('an unset identity is ad-hoc; a set identity is Developer ID; a blank or "-" identity is refused', () => {
  assert.deepEqual(signingMode({}), { mode: 'ad-hoc' });
  assert.deepEqual(signingMode(developerIdEnv), {
    mode: 'developer-id',
    identity: IDENTITY,
    notaryProfile: 'bento-notary',
  });
  assert.equal(signingMode({ ...developerIdEnv, BENTO_NOTARY_PROFILE: 'ci-profile' }).notaryProfile, 'ci-profile');
  assert.equal(signingMode({ ...developerIdEnv, BENTO_NOTARY_PROFILE: ' ' }).notaryProfile, 'bento-notary');
  for (const identity of ['', '  ', '-']) {
    assert.throws(() => signingMode({ BENTO_MACOS_SIGN_IDENTITY: identity }), /is set but/);
  }
});

test('mach macos-sign arguments per mode', () => {
  assert.deepEqual(machSignArgs('/w/Bento.app', { mode: 'ad-hoc' }), [
    'macos-sign', '-a', '/w/Bento.app', '-c', 'release', '-e', 'developer',
  ]);
  assert.deepEqual(machSignArgs('/w/Bento.app', { mode: 'developer-id', identity: IDENTITY }), [
    'macos-sign', '-a', '/w/Bento.app', '-c', 'release',
    '-s', IDENTITY, '-e', 'production-without-restricted',
  ]);
});

test('the staged app is found, and an app that links outside its bundle is refused', () => {
  const { objDist, staged } = fixture();
  const config = { binaryName: 'bento', build: {} };
  fs.symlinkSync('Info.plist', path.join(staged, 'Contents', 'inside-link'));
  assert.equal(findStagedApp(objDist, config), staged);

  fs.symlinkSync('../../../../bin/XUL', path.join(staged, 'Contents', 'MacOS', 'XUL'));
  assert.throws(() => findStagedApp(objDist, config), /links outside the bundle[\s\S]*MacOS\/XUL/);
  assert.throws(() => findStagedApp(path.join(objDist, 'nowhere'), config), /packaged app is missing/);
});

test('Mach-O files are found by magic number, not by name or by link', () => {
  const { staged } = fixture();
  fs.writeFileSync(path.join(staged, 'Contents', 'MacOS', 'script.dylib'), '#!/bin/sh\n');
  fs.symlinkSync('bento', path.join(staged, 'Contents', 'MacOS', 'bento-link'));
  assert.deepEqual(
    machOFiles(staged).map((file) => path.relative(staged, file)).sort(),
    ['Contents/MacOS/bento', 'Contents/MacOS/libx.dylib'],
  );
});

// The commands that build the DMG from the frozen app, in order.
const dmgCommands = (setup, app, dmg) => {
  const stage = path.join(setup.outDir, 'dmg-stage');
  return [
    `ditto ${app} ${path.join(stage, 'Bento.app')}`,
    `chmod -R a+rX,a-st,u+w,go-w ${stage}`,
    `hdiutil create -srcfolder ${stage} -volname Bento -fs HFS+ -format UDBZ -imagekey bzip2-level=9 ${dmg}`,
  ];
};

test('an ad-hoc run signs a copy, freezes it, builds the DMG and records no team', () => {
  const setup = fixture();
  const { run, calls, staged } = fakeRun();
  const machRaw = path.join(setup.root, 'scripts', 'mach-raw.sh');
  const app = path.join(setup.outDir, 'Bento.app');
  const dmg = path.join(setup.outDir, 'bento-1.2.3.signed.dmg');

  const result = sign(setup, {}, run);

  assert.deepEqual(lines(calls), [
    `ditto ${setup.staged} ${app}`,
    `bash ${machRaw} macos-sign -a ${app} -c release -e developer`,
    `codesign --verify --deep --strict --verbose=2 ${app}`,
    `codesign -dvv ${app}`,
    `chmod -R a-w ${app}`,
    ...dmgCommands(setup, app, dmg),
  ]);
  assert.equal(calls[1].options.cwd, setup.root);
  assert.deepEqual(staged.sort(), [
    '  -> /Applications', // the link is named " "
    '.DS_Store',
    '.background',
    '.background/background.png',
    'Bento.app',
  ]);
  assert.deepEqual(result.record, { mode: 'ad-hoc', teamId: null, notarized: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(setup.outDir, 'signing.json'), 'utf8')), result.record);
  assert.deepEqual(fs.readdirSync(setup.outDir).sort(), ['Bento.app', 'bento-1.2.3.signed.dmg', 'signing.json']);
  assert.ok(fs.existsSync(path.join(setup.staged, 'Contents', 'Info.plist')), 'the staged app is only copied');
});

test('a Developer ID run checks timestamps, notarizes and staples the app and the DMG', () => {
  const setup = fixture();
  const { run, calls } = fakeRun({ details: DEVELOPER_ID_DETAILS });
  const machRaw = path.join(setup.root, 'scripts', 'mach-raw.sh');
  const app = path.join(setup.outDir, 'Bento.app');
  const zip = path.join(setup.outDir, 'notarize.zip');
  const dmg = path.join(setup.outDir, 'bento-1.2.3.signed.dmg');
  const notarize = (file) =>
    `xcrun notarytool submit ${file} --keychain-profile bento-notary --wait --output-format json`;

  const result = sign(setup, developerIdEnv, run);

  // The two Mach-O files are scanned for timestamps between signing and verifying.
  const scan = [path.join(app, 'Contents/MacOS/bento'), path.join(app, 'Contents/MacOS/libx.dylib')];
  const seen = lines(calls);
  assert.deepEqual(seen.slice(0, 2), [
    `ditto ${setup.staged} ${app}`,
    `bash ${machRaw} macos-sign -a ${app} -c release -s ${IDENTITY} -e production-without-restricted`,
  ]);
  assert.deepEqual(seen.slice(2, 4).sort(), scan.map((file) => `codesign -dvv ${file}`));
  assert.deepEqual(seen.slice(4), [
    `codesign --verify --deep --strict --verbose=2 ${app}`,
    `codesign -dvv ${app}`,
    `ditto -c -k --keepParent ${app} ${zip}`,
    notarize(zip),
    `xcrun stapler staple ${app}`,
    `spctl -a -vv -t exec ${app}`,
    `chmod -R a-w ${app}`,
    ...dmgCommands(setup, app, dmg),
    `codesign --sign ${IDENTITY} --timestamp ${dmg}`,
    notarize(dmg),
    `xcrun stapler staple ${dmg}`,
  ]);
  assert.deepEqual(result.record, { mode: 'developer-id', teamId: 'ABCDE12345', notarized: true });
});

test('binaries without a timestamp are re-signed through a --timestamp wrapper, once', () => {
  const setup = fixture();
  let scans = 0;
  const { run, calls } = fakeRun({
    details: DEVELOPER_ID_DETAILS,
    timestamped: () => (scans += 1) > 2, // both files lack one on the first pass only
  });
  sign(setup, developerIdEnv, run);

  const signs = calls.filter(({ command, args }) => command === 'bash' && args[1] === 'macos-sign');
  assert.equal(signs.length, 2);
  const wrapperDir = path.join(setup.outDir, 'bin');
  assert.equal(signs[0].options.env, undefined);
  assert.ok(signs[1].options.env.PATH.startsWith(`${wrapperDir}${path.delimiter}`));
  assert.ok(fs.statSync(path.join(wrapperDir, 'codesign')).mode & 0o100, 'the wrapper is executable');

  const never = fixture();
  const stuck = fakeRun({ details: DEVELOPER_ID_DETAILS, timestamped: () => false });
  assert.throws(() => sign(never, developerIdEnv, stuck.run), /no secure timestamp after signing:\n {2}Contents\/MacOS\//);
  assert.ok(!stuck.calls.some(({ command }) => command === 'xcrun'), 'nothing is submitted to Apple');
});

test('the wrapper adds --timestamp to signing calls only', () => {
  const dir = tempDir();
  const wrapper = path.join(dir, 'codesign');
  const stub = path.join(dir, 'real-codesign');
  fs.writeFileSync(wrapper, CODESIGN_TIMESTAMP_WRAPPER, { mode: 0o755 });
  fs.writeFileSync(stub, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
  const call = (...args) =>
    execFileSync(wrapper, args, { encoding: 'utf8', env: { ...process.env, BENTO_REAL_CODESIGN: stub } }).trim();

  assert.equal(call('--sign', 'ID', '--force', '/app'), '--timestamp --sign ID --force /app');
  assert.equal(call('--remove-signature', '/app'), '--remove-signature /app');
  assert.equal(call('-vv', '/app'), '-vv /app');
});

test('a rejected notarization fails with Apple\'s log and staples nothing', () => {
  const setup = fixture();
  const { run, calls } = fakeRun({
    details: DEVELOPER_ID_DETAILS,
    notary: JSON.stringify({ id: 'sub-9', status: 'Invalid' }),
  });
  assert.throws(
    () => sign(setup, developerIdEnv, run),
    /not accepted \(Invalid\)\n\{"issues":\[\{"message":"binary is not signed"\}\]\}/,
  );
  assert.ok(lines(calls).includes('xcrun notarytool log sub-9 --keychain-profile bento-notary'));
  assert.ok(!lines(calls).some((line) => line.includes('stapler')));
  assert.ok(!fs.existsSync(path.join(setup.outDir, 'signing.json')));
});

test('a missing DMG layout file stops the build', () => {
  const setup = fixture();
  fs.rmSync(path.join(setup.root, 'branding', 'bento', 'dsstore'));
  assert.throws(() => sign(setup), /DMG layout file is missing: .*dsstore/);
});

test('a signature that does not match the requested mode is refused', () => {
  const notDeveloperId = fakeRun({ details: 'Authority=Apple Development: Someone (ABCDE12345)\nTeamIdentifier=ABCDE12345\n' });
  assert.throws(
    () => sign(fixture(), developerIdEnv, notDeveloperId.run),
    /did not produce a Developer ID Application signature/,
  );
  assert.ok(!notDeveloperId.calls.some(({ command }) => command === 'xcrun'), 'nothing is submitted to Apple');

  const notAdhoc = fakeRun({ details: DEVELOPER_ID_DETAILS });
  assert.throws(() => sign(fixture(), {}, notAdhoc.run), /not signed ad-hoc/);
});

test('signing records have one of two shapes', () => {
  const adHoc = { mode: 'ad-hoc', teamId: null, notarized: false };
  const developerId = { mode: 'developer-id', teamId: 'ABCDE12345', notarized: true };
  assert.deepEqual(parseSigningRecord(adHoc), adHoc);
  assert.deepEqual(parseSigningRecord(developerId), developerId);
  for (const bad of [
    null,
    { ...adHoc, extra: 1 },
    { mode: 'ad-hoc', notarized: false },
    { ...adHoc, teamId: 'ABCDE12345' },
    { ...adHoc, notarized: true },
    { ...developerId, teamId: null },
    { ...developerId, teamId: 'abc' },
    { ...developerId, notarized: 'yes' },
    { ...developerId, mode: 'signed' },
  ]) {
    assert.throws(() => parseSigningRecord(bad), /signing record/, JSON.stringify(bad));
  }
});

test('the release manifest carries the signing record, or null without one', () => {
  const dir = tempDir();
  const outputDir = path.join(dir, 'out');
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, 'Bento-1.2.3-macos.dmg'), 'dmg');
  const record = path.join(dir, 'signing.json');
  fs.writeFileSync(record, JSON.stringify({ mode: 'developer-id', teamId: 'ABCDE12345', notarized: true }));
  const manifestOf = (...extra) => {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts/generate-release-metadata.mjs'), outputDir, ...extra], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return JSON.parse(fs.readFileSync(path.join(outputDir, 'release-manifest.json'), 'utf8'));
  };

  assert.deepEqual(manifestOf(record).signing, { mode: 'developer-id', teamId: 'ABCDE12345', notarized: true });
  assert.equal(manifestOf().signing, null);
  fs.writeFileSync(record, JSON.stringify({ mode: 'ad-hoc', teamId: 'ABCDE12345', notarized: false }));
  assert.throws(() => manifestOf(record), /signing record/);
});
