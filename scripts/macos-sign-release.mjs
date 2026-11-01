#!/usr/bin/env node

// macOS release signing and repackaging, run by build-release.sh between the
// package and collect steps (docs/build-tooling.md, "macOS signing").
//
// Signs a copy of the packaged app with `mach macos-sign`, freezes it, and
// repackages it into a DMG. Ad-hoc by default; with
// BENTO_MACOS_SIGN_IDENTITY set it signs with that Developer ID identity,
// verifies timestamps, notarizes and staples the app and the DMG. An ad-hoc
// build is for local rehearsal only: other Macs reject it.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './bento-build.mjs';

export const SIGN_IDENTITY_ENV = 'BENTO_MACOS_SIGN_IDENTITY';
export const NOTARY_PROFILE_ENV = 'BENTO_NOTARY_PROFILE';
const DEFAULT_NOTARY_PROFILE = 'bento-notary';
const ROOT = path.resolve(import.meta.dirname, '..');

// Thin, fat and 64-bit fat Mach-O magic numbers, both byte orders.
const MACHO_MAGIC = new Set([
  'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
]);

// The brand files that give the DMG its window layout (MOZ_PKG_MAC_DSSTORE and
// MOZ_PKG_MAC_BACKGROUND in toolkit/moz.configure), and where they go in the image.
const DMG_LAYOUT = [
  ['dsstore', '.DS_Store'],
  ['background.png', '.background/background.png'],
];

// Puts --timestamp on the signing calls of `mach macos-sign` (it also calls
// codesign to strip and verify, which stay untouched).
export const CODESIGN_TIMESTAMP_WRAPPER = [
  '#!/bin/sh',
  'real="${BENTO_REAL_CODESIGN:-/usr/bin/codesign}"',
  'for arg in "$@"; do',
  '  [ "$arg" = "--sign" ] && exec "$real" --timestamp "$@"',
  'done',
  'exec "$real" "$@"',
  '',
].join('\n');

/**
 * Runs a command and returns { status, stdout, stderr }. `capture` pipes the
 * output; otherwise the child inherits the terminal. Tests inject a fake.
 */
export function runCommand(command, args, { cwd, env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Runs a command that must succeed; the error carries whatever it printed. */
export function must(run, command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

/**
 * Unset identity is an ad-hoc build. A set but blank identity, or the ad-hoc
 * identity "-", is refused so a misconfigured Developer ID run cannot pass as
 * a signed build.
 */
export function signingMode(env = process.env) {
  const identity = env[SIGN_IDENTITY_ENV];
  if (identity === undefined) return { mode: 'ad-hoc' };
  const trimmed = identity.trim();
  if (!trimmed || trimmed === '-') {
    throw new Error(
      `${SIGN_IDENTITY_ENV} is set but ${trimmed ? 'is the ad-hoc identity "-"' : 'is empty'}; unset it for an ad-hoc build or name a Developer ID Application identity`,
    );
  }
  return {
    mode: 'developer-id',
    identity: trimmed,
    notaryProfile: env[NOTARY_PROFILE_ENV]?.trim() || DEFAULT_NOTARY_PROFILE,
  };
}

/**
 * Arguments for `mach macos-sign`. The channel is always `release`: mach maps
 * only Mozilla's bundle ids to a channel, so `auto` fails for Bento's. Ad-hoc
 * signing only accepts developer entitlements; Developer ID signing drops the
 * restricted entitlements the team has not been granted.
 */
export function machSignArgs(app, { mode, identity }) {
  const signing = mode === 'developer-id'
    ? ['-s', identity, '-e', 'production-without-restricted']
    : ['-e', 'developer'];
  return ['macos-sign', '-a', app, '-c', 'release', ...signing];
}

/** The `{ mode, teamId, notarized }` record the release manifest carries. */
export function parseSigningRecord(value) {
  const keys = value && typeof value === 'object' ? Object.keys(value).sort().join() : '';
  if (keys !== 'mode,notarized,teamId') throw new Error('signing record must have exactly mode, teamId and notarized');
  const { mode, teamId, notarized } = value;
  if (typeof notarized !== 'boolean') throw new Error('signing record notarized must be true or false');
  if (mode === 'ad-hoc') {
    if (teamId !== null || notarized) throw new Error('an ad-hoc signing record has no team and is not notarized');
  } else if (mode === 'developer-id') {
    if (!/^[A-Z0-9]{10}$/.test(teamId ?? '')) throw new Error('a developer-id signing record needs a ten-character teamId');
  } else {
    throw new Error('signing record mode must be "ad-hoc" or "developer-id"');
  }
  return { mode, teamId, notarized };
}

export function readSigningRecord(file) {
  return parseSigningRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** The fields of `codesign -dvv` output that the pipeline and the check decide on. */
export function parseCodesignDetails(output) {
  const field = (name) => output.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim();
  const teamId = field('TeamIdentifier');
  return {
    adhoc: field('Signature') === 'adhoc',
    teamId: teamId && teamId !== 'not set' ? teamId : null,
    authorities: [...output.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1].trim()),
    timestamped: /^Timestamp=/m.test(output),
  };
}

/** `codesign -dvv` of a path, or undefined when it has no signature. codesign prints to stderr. */
export function codesignDetails(run, target) {
  const result = run('codesign', ['-dvv', target], { capture: true });
  return result.status === 0 ? parseCodesignDetails(`${result.stdout}\n${result.stderr}`) : undefined;
}

function* walkBundle(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    yield { file, entry };
    if (entry.isDirectory()) yield* walkBundle(file);
  }
}

/**
 * The staged app `mach package` leaves at <objDist>/<binaryName>/<Bundle>.app,
 * the one the MAR is built from too. The unbundled app at <objDist>/<Bundle>.app
 * links into the objdir and cannot be signed, so a link leaving the bundle is
 * refused.
 */
export function findStagedApp(objDist, config) {
  const app = path.join(objDist, config.binaryName, `${config.build?.macosBundleName || 'Bento'}.app`);
  if (!fs.lstatSync(app, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`packaged app is missing: ${app}; run the package step first`);
  }
  const escaping = [];
  for (const { file, entry } of walkBundle(app)) {
    if (!entry.isSymbolicLink()) continue;
    const link = fs.readlinkSync(file);
    if (path.relative(app, path.resolve(path.dirname(file), link)).startsWith('..')) {
      escaping.push(`${path.relative(app, file)} -> ${link}`);
    }
  }
  if (escaping.length) {
    throw new Error(`${app} links outside the bundle, so it is not a packaged app:\n  ${escaping.join('\n  ')}`);
  }
  return app;
}

/** Every Mach-O file in the bundle, symlinks excluded. */
export function machOFiles(app) {
  const files = [];
  const head = Buffer.alloc(4);
  for (const { file, entry } of walkBundle(app)) {
    if (!entry.isFile()) continue;
    const fd = fs.openSync(file, 'r');
    try {
      if (fs.readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGIC.has(head.toString('hex'))) files.push(file);
    } finally {
      fs.closeSync(fd);
    }
  }
  return files;
}

/** Bundle-relative paths of Mach-O files that are unsigned or lack a secure timestamp. */
export function missingTimestamps(run, app) {
  return machOFiles(app)
    .filter((file) => !codesignDetails(run, file)?.timestamped)
    .map((file) => path.relative(app, file));
}

function notarizationOutcome(stdout) {
  const text = stdout.trim();
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return undefined;
}

/** Submits to Apple and waits. Anything but an Accepted status fails with Apple's log. */
function notarize(run, file, profile, log) {
  log(`notarizing ${path.basename(file)}; waiting for Apple`);
  const keychain = ['--keychain-profile', profile];
  const submit = run(
    'xcrun',
    ['notarytool', 'submit', file, ...keychain, '--wait', '--output-format', 'json'],
    { capture: true },
  );
  const outcome = notarizationOutcome(submit.stdout);
  if (submit.status === 0 && outcome?.status === 'Accepted') return;
  let detail = (submit.stderr || submit.stdout).trim();
  if (outcome?.id) {
    const report = run('xcrun', ['notarytool', 'log', outcome.id, ...keychain], { capture: true });
    detail = (report.stdout || report.stderr || detail).trim();
  }
  throw new Error(`notarization of ${path.basename(file)} was not accepted (${outcome?.status ?? 'no status'})\n${detail}`);
}

// The DMG volume name, which mach package takes from the app's application.ini.
function volumeName(app) {
  const ini = fs.readFileSync(path.join(app, 'Contents', 'Resources', 'application.ini'), 'utf8');
  const section = ini.split(/^\[/m).find((part) => part.startsWith('App]')) ?? '';
  const value = (key) => section.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim();
  const name = value('CodeName') || value('Name');
  if (!name) throw new Error(`no [App] Name in ${app}/Contents/Resources/application.ini`);
  return name;
}

/**
 * Builds the compressed read-only DMG: the app, the brand's window layout files
 * and a " " link to /Applications. Neither `mach repackage dmg` (it resolves
 * Linux-only DMG toolchains and always fails with "DMG tool not found" on a Mac)
 * nor mach package's `hdiutil makehybrid` (it stamps com.apple.FinderInfo on
 * every file, so the mounted app fails `codesign --verify --strict`) is used.
 * The custom volume icon is not reproduced: its flag is not carried over.
 */
function buildDmg({ run, app, brandDir, outDir, dmg }) {
  const stage = path.join(outDir, 'dmg-stage');
  fs.mkdirSync(stage);
  must(run, 'ditto', [app, path.join(stage, path.basename(app))]);
  for (const [name, target] of DMG_LAYOUT) {
    const source = path.join(brandDir, name);
    if (!fs.existsSync(source)) throw new Error(`DMG layout file is missing: ${source}`);
    fs.mkdirSync(path.dirname(path.join(stage, target)), { recursive: true });
    fs.copyFileSync(source, path.join(stage, target));
  }
  fs.symlinkSync('/Applications', path.join(stage, ' '));
  must(run, 'chmod', ['-R', 'a+rX,a-st,u+w,go-w', stage]);
  must(run, 'hdiutil', [
    'create', '-srcfolder', stage, '-volname', volumeName(app), '-fs', 'HFS+',
    '-format', 'UDBZ', '-imagekey', 'bzip2-level=9', dmg,
  ], { capture: true });
  fs.rmSync(stage, { recursive: true, force: true });
}

/**
 * Signs and repackages the packaged app into `outDir` (default dist/macos-signing):
 *   <Bundle>.app              the frozen signed app (a later step builds the MAR from it)
 *   bento-<version>.signed.dmg  the repackaged DMG
 *   signing.json              the record the release manifest and the check read
 * `outDir` is rebuilt from scratch on every run.
 */
export function signRelease({
  root = ROOT,
  objDist,
  outDir = path.join(root, 'dist', 'macos-signing'),
  env = process.env,
  run = runCommand,
  log = (message) => process.stdout.write(`macos-sign-release: ${message}\n`),
}) {
  const config = loadConfig(root);
  const signing = signingMode(env);
  const developerId = signing.mode === 'developer-id';
  const staged = findStagedApp(objDist, config);
  const version = config.brands[config.brand].release.displayVersion;
  const machRaw = path.join(root, 'scripts', 'mach-raw.sh');
  const mach = (args, options) => must(run, 'bash', [machRaw, ...args], { cwd: root, ...options });

  // A previous run left the app read-only (the freeze below).
  if (fs.existsSync(outDir)) {
    must(run, 'chmod', ['-R', 'u+w', outDir]);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const app = path.join(outDir, path.basename(staged));
  const dmg = path.join(outDir, `bento-${version}.signed.dmg`);

  log(`${signing.mode} signing a copy of ${staged}`);
  must(run, 'ditto', [staged, app]);
  mach(machSignArgs(app, signing));

  if (developerId) {
    // Notarization needs a secure timestamp on every nested binary. codesign
    // only timestamps by default for some signatures, so re-sign through a
    // wrapper that asks for one when any is missing.
    let missing = missingTimestamps(run, app);
    if (missing.length) {
      log(`${missing.length} binaries have no secure timestamp; re-signing with --timestamp`);
      const wrapperDir = path.join(outDir, 'bin');
      fs.mkdirSync(wrapperDir);
      fs.writeFileSync(path.join(wrapperDir, 'codesign'), CODESIGN_TIMESTAMP_WRAPPER, { mode: 0o755 });
      mach(machSignArgs(app, signing), {
        env: { PATH: `${wrapperDir}${path.delimiter}${env.PATH ?? process.env.PATH}` },
      });
      missing = missingTimestamps(run, app);
    }
    if (missing.length) {
      throw new Error(`these binaries have no secure timestamp after signing:\n  ${missing.join('\n  ')}`);
    }
  }
  must(run, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { capture: true });

  // Before notarizing: the signature must be what the mode promises.
  const details = codesignDetails(run, app);
  if (!details) throw new Error(`${app} has no signature after signing`);
  if (developerId) {
    if (!details.teamId || !details.authorities.some((name) => name.startsWith('Developer ID Application:'))) {
      throw new Error(`${SIGN_IDENTITY_ENV} did not produce a Developer ID Application signature (team ${details.teamId ?? 'not set'})`);
    }
    const zip = path.join(outDir, 'notarize.zip');
    must(run, 'ditto', ['-c', '-k', '--keepParent', app, zip]);
    notarize(run, zip, signing.notaryProfile, log);
    fs.rmSync(zip, { force: true });
    must(run, 'xcrun', ['stapler', 'staple', app]);
    must(run, 'spctl', ['-a', '-vv', '-t', 'exec', app], { capture: true });
  } else if (!details.adhoc) {
    throw new Error('the ad-hoc build is not signed ad-hoc');
  }

  // Freeze: nothing may change the signed bytes from here on (a MAR is built
  // from this directory, and it must match what ships in the DMG).
  must(run, 'chmod', ['-R', 'a-w', app]);
  buildDmg({ run, app, brandDir: path.join(root, 'branding', config.brand), outDir, dmg });

  if (developerId) {
    must(run, 'codesign', ['--sign', signing.identity, '--timestamp', dmg]);
    notarize(run, dmg, signing.notaryProfile, log);
    must(run, 'xcrun', ['stapler', 'staple', dmg]);
  }

  const record = parseSigningRecord({
    mode: signing.mode,
    teamId: developerId ? details.teamId : null,
    notarized: developerId,
  });
  fs.writeFileSync(path.join(outDir, 'signing.json'), `${JSON.stringify(record, null, 2)}\n`);
  log(`wrote ${dmg} (${record.mode}${record.teamId ? `, team ${record.teamId}` : ''}, notarized ${record.notarized})`);
  return { app, dmg, record, outDir };
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--obj-dist') {
    throw new Error('usage: macos-sign-release.mjs --obj-dist <objdir>/dist');
  }
  signRelease({ objDist: path.resolve(argv[1]) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`macos-sign-release: ${error.message}\n`);
    process.exitCode = 1;
  }
}
