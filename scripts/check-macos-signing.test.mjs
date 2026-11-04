import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { checkSigning, requiredTeam, signingProblems } from './check-macos-signing.mjs';
import { sha256Of, UBLOCK_XPI } from './shipped-ublock.mjs';

const TEAM = 'ABCDE12345';
const XPI_BYTES = 'signed uBlock Origin xpi';
const XPI_SHA256 = sha256Of(XPI_BYTES);
const adHocRecord = { mode: 'ad-hoc', teamId: null, notarized: false };
const developerIdRecord = { mode: 'developer-id', teamId: TEAM, notarized: true };
const adHocApp = { verified: true, adhoc: true, teamId: null, authorities: [] };
const developerIdApp = {
  verified: true,
  adhoc: false,
  teamId: TEAM,
  authorities: [`Developer ID Application: Bento Test (${TEAM})`, 'Apple Root CA'],
};
const developerIdDmg = { ...developerIdApp };
const stapled = { app: true, dmg: true };

test('an ad-hoc record passes with no team recorded, and needs no stapled ticket', () => {
  assert.deepEqual(signingProblems({ record: adHocRecord, observed: adHocApp }), []);
});

test('a recorded team refuses an ad-hoc build and accepts only that team, notarized and stapled', () => {
  assert.match(
    signingProblems({ record: adHocRecord, observed: adHocApp, team: TEAM }).join('\n'),
    /only a Developer ID build can be released, but this build is ad-hoc[\s\S]*not notarized[\s\S]*stapler validate failed on the app/,
  );
  assert.deepEqual(
    signingProblems({ record: developerIdRecord, observed: developerIdApp, observedDmg: developerIdDmg, stapled, team: TEAM }),
    [],
  );
  assert.match(
    signingProblems({
      record: { ...developerIdRecord, teamId: 'ZZZZZ99999' },
      observed: { ...developerIdApp, teamId: 'ZZZZZ99999' },
      observedDmg: { ...developerIdDmg, teamId: 'ZZZZZ99999' },
      stapled,
      team: TEAM,
    }).join('\n'),
    /signed by team ZZZZZ99999, not ABCDE12345/,
  );
  assert.deepEqual(
    signingProblems({
      record: developerIdRecord,
      observed: developerIdApp,
      observedDmg: developerIdDmg,
      stapled: { app: true, dmg: false },
      team: TEAM,
    }),
    ['xcrun stapler validate failed on the DMG'],
  );
});

test('the app must match the record it was built with', () => {
  assert.match(
    signingProblems({ record: developerIdRecord, observed: adHocApp, observedDmg: developerIdDmg, stapled }).join('\n'),
    /developer-id but the app is signed ad-hoc/,
  );
  assert.match(
    signingProblems({ record: adHocRecord, observed: developerIdApp }).join('\n'),
    /says ad-hoc but the app is not signed ad-hoc/,
  );
  assert.match(
    signingProblems({
      record: developerIdRecord,
      observed: { ...developerIdApp, teamId: 'ZZZZZ99999' },
      observedDmg: developerIdDmg,
      stapled,
    }).join('\n'),
    /names team ABCDE12345 but the app is signed by ZZZZZ99999/,
  );
  assert.match(
    signingProblems({
      record: developerIdRecord,
      observed: { ...developerIdApp, authorities: ['Apple Development: Someone'] },
      observedDmg: developerIdDmg,
      stapled,
    }).join('\n'),
    /not signed by a Developer ID Application certificate/,
  );
  assert.match(
    signingProblems({ record: adHocRecord, observed: { ...adHocApp, verified: false, verifyDetail: 'a sealed resource is missing' } }).join('\n'),
    /--strict failed: a sealed resource is missing/,
  );
});

test('a developer-id DMG must carry its own valid signature from the recorded team', () => {
  const problems = (observedDmg, team = '') =>
    signingProblems({ record: developerIdRecord, observed: developerIdApp, observedDmg, stapled, team });
  assert.deepEqual(problems(developerIdDmg), []);
  assert.deepEqual(problems(developerIdDmg, TEAM), []);
  assert.match(
    problems({ ...developerIdDmg, verified: false, verifyDetail: 'invalid signature (code or signature have been modified)' }).join('\n'),
    /--strict failed on the DMG: invalid signature/,
  );
  assert.match(
    problems({ ...developerIdDmg, authorities: ['Apple Development: Someone'] }).join('\n'),
    /the DMG is not signed by a Developer ID Application certificate/,
  );
  assert.match(
    problems({ ...developerIdDmg, adhoc: true, teamId: null, authorities: [] }).join('\n'),
    /the DMG should be signed by team ABCDE12345 but is signed by no team/,
  );
  assert.match(
    problems({ ...developerIdDmg, teamId: 'ZZZZZ99999' }, TEAM).join('\n'),
    /the DMG should be signed by team ABCDE12345 but is signed by ZZZZZ99999/,
  );
  assert.deepEqual(
    signingProblems({ record: developerIdRecord, observed: developerIdApp, stapled }),
    ['the DMG signature was not checked'],
  );
  // An ad-hoc DMG is unsigned by design: whatever codesign says about it is not read.
  assert.deepEqual(
    signingProblems({ record: adHocRecord, observed: adHocApp, observedDmg: { ...developerIdDmg, verified: false, authorities: [] } }),
    [],
  );
});

test('a notarized record needs stapled tickets even when no team is required yet', () => {
  assert.deepEqual(
    signingProblems({
      record: developerIdRecord,
      observed: developerIdApp,
      observedDmg: developerIdDmg,
      stapled: { app: false, dmg: false },
    }),
    ['xcrun stapler validate failed on the app', 'xcrun stapler validate failed on the DMG'],
  );
});

test('the required team comes from config/release-security.json', () => {
  assert.equal(requiredTeam(path.resolve(import.meta.dirname, '..')), '');
});

// A fake hdiutil that mounts a directory holding `apps` (each with the uBlock Origin XPI `xpi`
// ships, none when null), and codesign/stapler answers.
function mountedDmg({ apps = ['Bento.app'], verify = 0, dmgVerify = 0, dmgTeam = TEAM, stapler = 0, xpi = XPI_BYTES, xpiName = UBLOCK_XPI } = {}) {
  const calls = [];
  let mountPoint;
  const run = (command, args) => {
    calls.push([command, ...args]);
    const reply = (status = 0, stderr = '') => ({ status, stdout: '', stderr });
    if (command === 'hdiutil' && args[0] === 'attach') {
      mountPoint = args[args.indexOf('-mountpoint') + 1];
      for (const app of apps) {
        const extensions = path.join(mountPoint, app, 'Contents', 'Resources', 'distribution', 'extensions');
        fs.mkdirSync(extensions, { recursive: true });
        if (xpi !== null) fs.writeFileSync(path.join(extensions, xpiName), xpi);
      }
    } else if (command === 'codesign' && args[0] === '--verify') {
      if (args.at(-1).endsWith('.dmg')) return reply(dmgVerify, dmgVerify ? 'invalid signature' : '');
      return reply(verify, verify ? 'a sealed resource is missing' : '');
    } else if (command === 'codesign' && args[0] === '-dvv') {
      const team = args[1].endsWith('.dmg') ? dmgTeam : TEAM;
      return reply(0, `Authority=Developer ID Application: Bento Test (${team})\nTeamIdentifier=${team}\n`);
    } else if (command === 'xcrun') {
      return reply(stapler);
    } else if (command === 'hdiutil' && args[0] === 'detach') {
      for (const app of apps) fs.rmSync(path.join(mountPoint, app), { recursive: true });
    }
    return reply();
  };
  return { run, calls, mountPoint: () => mountPoint };
}

test('the DMG is mounted read-only, the app checked, and the DMG always detached', () => {
  const ok = mountedDmg();
  assert.deepEqual(checkSigning({ ublockSha256: XPI_SHA256, dmg: '/r/Bento.dmg', record: developerIdRecord, team: TEAM, run: ok.run }), []);
  const app = path.join(ok.mountPoint(), 'Bento.app');
  assert.deepEqual(ok.calls, [
    ['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', ok.mountPoint(), '/r/Bento.dmg'],
    ['codesign', '--verify', '--deep', '--strict', '--verbose=2', app],
    ['codesign', '-dvv', app],
    ['codesign', '--verify', '--strict', '--verbose=2', '/r/Bento.dmg'],
    ['codesign', '-dvv', '/r/Bento.dmg'],
    ['xcrun', 'stapler', 'validate', app],
    ['xcrun', 'stapler', 'validate', '/r/Bento.dmg'],
    ['hdiutil', 'detach', ok.mountPoint()],
  ]);
  assert.ok(!fs.existsSync(ok.mountPoint()), 'the mount point is removed');

  const broken = mountedDmg({ verify: 1, stapler: 1 });
  const problems = checkSigning({ ublockSha256: XPI_SHA256, dmg: '/r/Bento.dmg', record: developerIdRecord, team: TEAM, run: broken.run });
  assert.match(problems.join('\n'), /--strict failed: a sealed resource is missing[\s\S]*stapler validate failed on the app/);
  assert.deepEqual(broken.calls.at(-1), ['hdiutil', 'detach', broken.mountPoint()]);

  const badDmg = mountedDmg({ dmgVerify: 1 });
  assert.match(
    checkSigning({ ublockSha256: XPI_SHA256, dmg: '/r/Bento.dmg', record: developerIdRecord, team: TEAM, run: badDmg.run }).join('\n'),
    /--strict failed on the DMG: invalid signature/,
  );
  const otherTeam = mountedDmg({ dmgTeam: 'ZZZZZ99999' });
  assert.match(
    checkSigning({ ublockSha256: XPI_SHA256, dmg: '/r/Bento.dmg', record: developerIdRecord, team: TEAM, run: otherTeam.run }).join('\n'),
    /the DMG should be signed by team ABCDE12345 but is signed by ZZZZZ99999/,
  );

  const two = mountedDmg({ apps: ['Bento.app', 'Other.app'] });
  assert.throws(() => checkSigning({ ublockSha256: XPI_SHA256, dmg: '/r/Bento.dmg', record: adHocRecord, run: two.run }), /expected one app/);
  assert.deepEqual(two.calls.at(-1), ['hdiutil', 'detach', two.mountPoint()]);
});

test('the app inside the DMG must ship the recorded uBlock Origin XPI at its exact path', () => {
  const check = (options) => checkSigning({
    ublockSha256: XPI_SHA256,
    dmg: '/r/Bento.dmg',
    record: developerIdRecord,
    team: TEAM,
    run: mountedDmg(options).run,
  });
  assert.deepEqual(check({}), []);
  assert.match(check({ xpi: 'an older or repacked xpi' }).join('\n'), /has SHA-256 [0-9a-f]{64}, but the recorded uBlock Origin XPI is /);
  assert.match(check({ xpi: null }).join('\n'), /is missing: the app must ship the uBlock Origin XPI at exactly this path/);
  assert.match(check({ xpiName: 'other@test.xpi' }).join('\n'), /is missing: the app must ship/);
});

test('an ad-hoc record with no team skips stapler validation', () => {
  const adHoc = mountedDmg();
  const run = (command, args) =>
    command === 'codesign' && args[0] === '-dvv'
      ? { status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' }
      : adHoc.run(command, args);
  assert.deepEqual(checkSigning({ ublockSha256: XPI_SHA256, dmg: '/r/Bento.dmg', record: adHocRecord, run }), []);
  assert.ok(!adHoc.calls.some(([command]) => command === 'xcrun'));
  assert.ok(!adHoc.calls.some((call) => call.at(-1) === '/r/Bento.dmg' && call[0] === 'codesign'), 'an ad-hoc DMG is not signature-checked');
});
