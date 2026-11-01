import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { checkSigning, requiredTeam, signingProblems } from './check-macos-signing.mjs';

const TEAM = 'ABCDE12345';
const adHocRecord = { mode: 'ad-hoc', teamId: null, notarized: false };
const developerIdRecord = { mode: 'developer-id', teamId: TEAM, notarized: true };
const adHocApp = { verified: true, adhoc: true, teamId: null, authorities: [] };
const developerIdApp = {
  verified: true,
  adhoc: false,
  teamId: TEAM,
  authorities: [`Developer ID Application: Bento Test (${TEAM})`, 'Apple Root CA'],
};
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
    signingProblems({ record: developerIdRecord, observed: developerIdApp, stapled, team: TEAM }),
    [],
  );
  assert.match(
    signingProblems({
      record: { ...developerIdRecord, teamId: 'ZZZZZ99999' },
      observed: { ...developerIdApp, teamId: 'ZZZZZ99999' },
      stapled,
      team: TEAM,
    }).join('\n'),
    /signed by team ZZZZZ99999, not ABCDE12345/,
  );
  assert.deepEqual(
    signingProblems({
      record: developerIdRecord,
      observed: developerIdApp,
      stapled: { app: true, dmg: false },
      team: TEAM,
    }),
    ['xcrun stapler validate failed on the DMG'],
  );
});

test('the app must match the record it was built with', () => {
  assert.match(
    signingProblems({ record: developerIdRecord, observed: adHocApp, stapled }).join('\n'),
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
      stapled,
    }).join('\n'),
    /names team ABCDE12345 but the app is signed by ZZZZZ99999/,
  );
  assert.match(
    signingProblems({
      record: developerIdRecord,
      observed: { ...developerIdApp, authorities: ['Apple Development: Someone'] },
      stapled,
    }).join('\n'),
    /not signed by a Developer ID Application certificate/,
  );
  assert.match(
    signingProblems({ record: adHocRecord, observed: { ...adHocApp, verified: false, verifyDetail: 'a sealed resource is missing' } }).join('\n'),
    /--strict failed: a sealed resource is missing/,
  );
});

test('a notarized record needs stapled tickets even when no team is required yet', () => {
  assert.deepEqual(
    signingProblems({ record: developerIdRecord, observed: developerIdApp, stapled: { app: false, dmg: false } }),
    ['xcrun stapler validate failed on the app', 'xcrun stapler validate failed on the DMG'],
  );
});

test('the required team comes from config/release-security.json', () => {
  assert.equal(requiredTeam(path.resolve(import.meta.dirname, '..')), '');
});

// A fake hdiutil that mounts a directory holding `apps`, and codesign/stapler answers.
function mountedDmg({ apps = ['Bento.app'], verify = 0, stapler = 0 } = {}) {
  const calls = [];
  let mountPoint;
  const run = (command, args) => {
    calls.push([command, ...args]);
    const reply = (status = 0, stderr = '') => ({ status, stdout: '', stderr });
    if (command === 'hdiutil' && args[0] === 'attach') {
      mountPoint = args[args.indexOf('-mountpoint') + 1];
      for (const app of apps) fs.mkdirSync(path.join(mountPoint, app));
    } else if (command === 'codesign' && args[0] === '--verify') {
      return reply(verify, verify ? 'a sealed resource is missing' : '');
    } else if (command === 'codesign' && args[0] === '-dvv') {
      return reply(0, `Authority=Developer ID Application: Bento Test (${TEAM})\nTeamIdentifier=${TEAM}\n`);
    } else if (command === 'xcrun') {
      return reply(stapler);
    } else if (command === 'hdiutil' && args[0] === 'detach') {
      for (const app of apps) fs.rmdirSync(path.join(mountPoint, app));
    }
    return reply();
  };
  return { run, calls, mountPoint: () => mountPoint };
}

test('the DMG is mounted read-only, the app checked, and the DMG always detached', () => {
  const ok = mountedDmg();
  assert.deepEqual(checkSigning({ dmg: '/r/Bento.dmg', record: developerIdRecord, team: TEAM, run: ok.run }), []);
  const app = path.join(ok.mountPoint(), 'Bento.app');
  assert.deepEqual(ok.calls, [
    ['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', ok.mountPoint(), '/r/Bento.dmg'],
    ['codesign', '--verify', '--deep', '--strict', '--verbose=2', app],
    ['codesign', '-dvv', app],
    ['xcrun', 'stapler', 'validate', app],
    ['xcrun', 'stapler', 'validate', '/r/Bento.dmg'],
    ['hdiutil', 'detach', ok.mountPoint()],
  ]);
  assert.ok(!fs.existsSync(ok.mountPoint()), 'the mount point is removed');

  const broken = mountedDmg({ verify: 1, stapler: 1 });
  const problems = checkSigning({ dmg: '/r/Bento.dmg', record: developerIdRecord, team: TEAM, run: broken.run });
  assert.match(problems.join('\n'), /--strict failed: a sealed resource is missing[\s\S]*stapler validate failed on the app/);
  assert.deepEqual(broken.calls.at(-1), ['hdiutil', 'detach', broken.mountPoint()]);

  const two = mountedDmg({ apps: ['Bento.app', 'Other.app'] });
  assert.throws(() => checkSigning({ dmg: '/r/Bento.dmg', record: adHocRecord, run: two.run }), /expected one app/);
  assert.deepEqual(two.calls.at(-1), ['hdiutil', 'detach', two.mountPoint()]);
});

test('an ad-hoc record with no team skips stapler validation', () => {
  const adHoc = mountedDmg();
  const run = (command, args) =>
    command === 'codesign' && args[0] === '-dvv'
      ? { status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' }
      : adHoc.run(command, args);
  assert.deepEqual(checkSigning({ dmg: '/r/Bento.dmg', record: adHocRecord, run }), []);
  assert.ok(!adHoc.calls.some(([command]) => command === 'xcrun'));
});
