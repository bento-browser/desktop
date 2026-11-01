#!/usr/bin/env node

// Checks the collected macOS DMG against its signing record (run by
// build-release.sh after collection). Mounts the DMG read-only, verifies the
// app's signature, and confirms it matches the record. When
// config/release-security.json platformSigning.macosDeveloperIdTeam is set,
// only a notarized Developer ID build for that team passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  codesignDetails,
  must,
  readSigningRecord,
  runCommand,
} from './macos-sign-release.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

export function requiredTeam(root = ROOT) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/release-security.json'), 'utf8'));
  return config.platformSigning?.macosDeveloperIdTeam ?? '';
}

/**
 * What is wrong with the build, given the record, what codesign reports for
 * the app (`observed`: verified, adhoc, teamId, authorities) and whether
 * `stapler validate` passed (`stapled`: app, dmg; needed only for a notarized
 * record or a required team).
 */
export function signingProblems({ record, observed, stapled, team = '' }) {
  const problems = [];
  if (!observed.verified) problems.push(`codesign --verify --deep --strict failed: ${observed.verifyDetail}`);
  if (record.mode === 'ad-hoc') {
    if (!observed.adhoc) problems.push('the record says ad-hoc but the app is not signed ad-hoc');
  } else {
    if (observed.adhoc) problems.push('the record says developer-id but the app is signed ad-hoc');
    if (observed.teamId !== record.teamId) {
      problems.push(`the record names team ${record.teamId} but the app is signed by ${observed.teamId ?? 'no team'}`);
    }
    if (!observed.authorities.some((name) => name.startsWith('Developer ID Application:'))) {
      problems.push('the app is not signed by a Developer ID Application certificate');
    }
  }
  if (team) {
    if (record.mode !== 'developer-id') {
      problems.push(`platformSigning.macosDeveloperIdTeam is ${team}, so only a Developer ID build can be released, but this build is ${record.mode}`);
    } else if (record.teamId !== team) {
      problems.push(`the build is signed by team ${record.teamId}, not ${team}`);
    }
    if (!record.notarized) problems.push('the build is not notarized');
  }
  if (record.notarized || team) {
    if (!stapled?.app) problems.push('xcrun stapler validate failed on the app');
    if (!stapled?.dmg) problems.push('xcrun stapler validate failed on the DMG');
  }
  return problems;
}

// Mounts the DMG read-only on a private mount point and always detaches it.
function withMountedDmg(run, dmg, use) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-signing-check-'));
  try {
    must(run, 'hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg], { capture: true });
  } catch (error) {
    fs.rmdirSync(mountPoint);
    throw error;
  }
  try {
    return use(mountPoint);
  } finally {
    if (run('hdiutil', ['detach', mountPoint], { capture: true }).status !== 0) {
      must(run, 'hdiutil', ['detach', '-force', mountPoint], { capture: true });
    }
    fs.rmdirSync(mountPoint);
  }
}

/** Observes the app inside `dmg` and returns the list of problems (empty when it matches). */
export function checkSigning({ dmg, record, team = '', run = runCommand }) {
  const needsStaple = record.notarized || Boolean(team);
  return withMountedDmg(run, dmg, (mountPoint) => {
    const apps = fs.readdirSync(mountPoint).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`expected one app in ${dmg}, found ${apps.length}`);
    const app = path.join(mountPoint, apps[0]);
    const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { capture: true });
    const details = codesignDetails(run, app);
    const validates = (target) => run('xcrun', ['stapler', 'validate', target], { capture: true }).status === 0;
    return signingProblems({
      record,
      observed: {
        verified: verify.status === 0,
        verifyDetail: verify.stderr.trim(),
        adhoc: details?.adhoc ?? false,
        teamId: details?.teamId ?? null,
        authorities: details?.authorities ?? [],
      },
      stapled: needsStaple ? { app: validates(app), dmg: validates(dmg) } : undefined,
      team,
    });
  });
}

function main(argv) {
  if (argv.length !== 2) throw new Error('usage: check-macos-signing.mjs <dmg> <signing.json>');
  const dmg = path.resolve(argv[0]);
  const record = readSigningRecord(path.resolve(argv[1]));
  const team = requiredTeam();
  const problems = checkSigning({ dmg, record, team });
  if (problems.length) throw new Error(`${path.basename(dmg)} does not match its signing record:\n- ${problems.join('\n- ')}`);
  process.stdout.write(
    `check-macos-signing: ${path.basename(dmg)} is ${record.mode}${record.teamId ? ` (team ${record.teamId})` : ''}, notarized ${record.notarized}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-macos-signing: ${error.message}\n`);
    process.exitCode = 1;
  }
}
