import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { marFileName, validateDescriptor } from '../update-service/descriptor.mjs';
import { ENVIRONMENTS, WRANGLER_VERSION, parseArgs, publish } from './ota-publish.mjs';

const GATE = ['pnpm', ['run', 'release:security-check:public']];
const CACHE = 'public, max-age=31536000, immutable';
const DISABLED = {
  serving: false,
  product: 'Bento',
  target: 'Darwin_aarch64-gcc3',
  channel: 'bento',
  release: null,
};
const digest = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
const wrangler = (...args) => ['dlx', `wrangler@${WRANGLER_VERSION}`, ...args];
const marBytesFor = (version, buildId) => Buffer.from(`mar ${version} ${buildId} `.repeat(50));
const dmgBytesFor = (version, buildId) => Buffer.from(`dmg ${version} ${buildId} `.repeat(70));

/**
 * A repository root, a release-out directory and a fake Cloudflare: `run` records every
 * command and simulates `wrangler r2 object put` by storing the file on the fake host,
 * and `fetch` answers HEAD, Range and GET from that store like an R2 custom domain.
 */
function setup(t, options = {}) {
  const {
    version = '0.0.3',
    buildId = '20261102120000',
    signing,
    roundTrip,
    uploadTransform = (bytes) => bytes,
    rangeStatus = 206,
    lengthOffset = 0,
    gateFails = false,
  } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const marBytes = marBytesFor(version, buildId);
  const dmgBytes = dmgBytesFor(version, buildId);
  const marName = marFileName(version, buildId);
  const dmgName = marName.replace(/\.mar$/, '.dmg');
  const releaseDir = path.join(dir, 'release-out');
  fs.mkdirSync(releaseDir);
  fs.writeFileSync(path.join(releaseDir, marName), marBytes);
  fs.writeFileSync(path.join(releaseDir, dmgName), dmgBytes);
  const manifest = {
    schemaVersion: 1,
    displayVersion: version,
    firefoxVersion: '158.0',
    files: [
      { name: marName, sha256: digest('sha256', marBytes), size: marBytes.length },
      { name: dmgName, sha256: digest('sha256', dmgBytes), size: dmgBytes.length },
    ],
    ...(signing && { signing }),
  };
  fs.writeFileSync(path.join(releaseDir, 'release-manifest.json'), JSON.stringify(manifest));

  // Both environments start disabled whatever the committed descriptors say.
  const root = path.join(dir, 'repo');
  const serviceDir = path.join(root, 'update-service');
  fs.mkdirSync(path.join(serviceDir, 'releases'), { recursive: true });
  for (const environment of Object.keys(ENVIRONMENTS)) {
    fs.writeFileSync(
      path.join(serviceDir, 'releases', `${environment}.json`),
      JSON.stringify(DISABLED),
    );
  }
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(
    path.join(root, 'config/release-security.json'),
    JSON.stringify({ updateService: roundTrip ? { roundTrip } : {} }),
  );

  const store = new Map();
  const requests = [];
  const calls = [];
  const run = (command, args, runOptions) => {
    calls.push({ command, args, cwd: runOptions?.cwd });
    if (gateFails && args.includes('release:security-check:public'))
      throw new Error('public gate failed');
    if (args.includes('put')) {
      const [bucket, name] = args[args.indexOf('put') + 1].split('/');
      const { downloadHost } = Object.values(ENVIRONMENTS).find(
        (environment) => environment.bucket === bucket,
      );
      store.set(
        `https://${downloadHost}/${name}`,
        uploadTransform(fs.readFileSync(args[args.indexOf('--file') + 1])),
      );
    }
  };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const key = `${url.origin}${url.pathname}`;
    const method = init.method ?? 'GET';
    requests.push({ method, key, range: init.headers?.Range });
    const bytes = store.get(key);
    if (!bytes) return new Response('not found', { status: 404 });
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(bytes.length + lengthOffset) },
      });
    }
    if (init.headers?.Range) {
      return new Response(bytes.subarray(0, 1), {
        status: rangeStatus,
        headers: { 'content-range': `bytes 0-0/${bytes.length}` },
      });
    }
    return new Response(bytes);
  };
  const ctx = {
    root,
    serviceDir,
    lockFile: options.lockFile ?? path.join(dir, 'ota-publish.lock'),
    run,
    fetch,
    log: () => {},
    processEnv: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
  };
  const descriptorPath = (environment) => path.join(serviceDir, 'releases', `${environment}.json`);
  return {
    ctx,
    calls,
    requests,
    store,
    releaseDir,
    marName,
    dmgName,
    marBytes,
    dmgBytes,
    serviceDir,
    root,
    descriptor: (environment) => JSON.parse(fs.readFileSync(descriptorPath(environment), 'utf8')),
    setDescriptor: (environment, descriptor) =>
      fs.writeFileSync(descriptorPath(environment), JSON.stringify(descriptor)),
    args: (flags, environment = 'test') =>
      parseArgs(['--env', environment, ...flags, '--release-dir', releaseDir]),
    commands: () => calls.map(({ command, args, cwd }) => [command, args, cwd]),
  };
}

test('parses the environment, the operations and the release directory', () => {
  assert.deepEqual(
    parseArgs(['--env', 'test', '--assets', '--promote', '--release-dir', '/tmp/out']),
    {
      environment: 'test',
      assets: true,
      promote: true,
      withdraw: false,
      releaseDir: '/tmp/out',
    },
  );
  assert.equal(parseArgs(['--env', 'production', '--withdraw']).withdraw, true);
  assert.equal(parseArgs(['--env', 'test', '--promote']).assets, false);
  assert.equal(path.basename(parseArgs(['--env', 'test', '--assets']).releaseDir), 'release-out');
});

test('rejects bad arguments', () => {
  for (const argv of [
    [],
    ['--assets'],
    ['--env', 'staging', '--assets'],
    ['--env', 'test'],
    ['--env', 'test', '--withdraw', '--assets'],
    ['--env', 'test', '--withdraw', '--promote'],
    ['--env', 'test', '--deploy'],
    ['--env', 'test', '--assets', 'extra'],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      /--env|--assets|--withdraw|Unknown option|Unexpected argument/,
      argv.join(' '),
    );
  }
});

test('the wrangler version is one exact release', () => {
  assert.match(WRANGLER_VERSION, /^\d+\.\d+\.\d+$/);
});

test('test environment: uploads, verifies, rewrites the descriptor and deploys, with no gate', async (t) => {
  const s = setup(t);
  await publish(s.args(['--assets', '--promote']), s.ctx);

  const marPath = path.join(s.releaseDir, s.marName);
  const dmgPath = path.join(s.releaseDir, s.dmgName);
  assert.deepEqual(s.commands(), [
    [
      'pnpm',
      wrangler(
        'r2',
        'object',
        'put',
        `bento-updates-test/${s.marName}`,
        '--file',
        marPath,
        '--content-type',
        'application/octet-stream',
        '--cache-control',
        CACHE,
        '--remote',
      ),
      s.serviceDir,
    ],
    [
      'pnpm',
      wrangler(
        'r2',
        'object',
        'put',
        `bento-updates-test/${s.dmgName}`,
        '--file',
        dmgPath,
        '--content-type',
        'application/x-apple-diskimage',
        '--cache-control',
        CACHE,
        '--remote',
      ),
      s.serviceDir,
    ],
    ['pnpm', wrangler('deploy', '--env', 'test'), s.serviceDir],
  ]);

  const descriptor = s.descriptor('test');
  assert.deepEqual(descriptor, {
    serving: true,
    product: 'Bento',
    target: 'Darwin_aarch64-gcc3',
    channel: 'bento',
    release: {
      version: '0.0.3',
      buildId: '20261102120000',
      marUrl: `https://dl-test.bentobrowser.app/${s.marName}`,
      size: s.marBytes.length,
      sha512: digest('sha512', s.marBytes),
      platformVersion: '158.0',
      detailsUrl: 'https://bentobrowser.app/release-notes/0.0.3/',
    },
  });
  validateDescriptor(descriptor);
  assert.equal(s.descriptor('production').serving, false, 'the other environment is untouched');

  // Each uploaded file: existence check, HEAD, Range, full GET; promote reuses that verification.
  const marUrl = `https://dl-test.bentobrowser.app/${s.marName}`;
  const marRequests = s.requests.filter(({ key }) => key === marUrl);
  assert.deepEqual(
    marRequests.map(({ method, range }) => [method, range]),
    [
      ['HEAD', undefined],
      ['HEAD', undefined],
      ['GET', 'bytes=0-0'],
      ['GET', undefined],
    ],
  );
});

const BUILD_ID = '20261102120000';
const developerId = { mode: 'developer-id', teamId: 'ABCDE12345', notarized: true };
// A matching round-trip record for the 0.1.0 MAR the fixtures build.
const roundTrip = (changes = {}) => ({
  toVersion: '0.1.0',
  buildIds: { from: '20260901000000', to: BUILD_ID },
  marSha256: digest('sha256', marBytesFor('0.1.0', BUILD_ID)),
  ...changes,
});

test('production: runs the gate first, then uploads and deploys the production Worker', async (t) => {
  const s = setup(t, { version: '0.1.0', signing: developerId, roundTrip: roundTrip() });
  await publish(s.args(['--assets', '--promote'], 'production'), s.ctx);

  assert.deepEqual(s.commands()[0], [...GATE, s.root]);
  assert.deepEqual(
    s
      .commands()
      .slice(1)
      .map(([, args]) => args.slice(0, 6)),
    [
      wrangler('r2', 'object', 'put', `bento-updates/${s.marName}`),
      wrangler('r2', 'object', 'put', `bento-updates/${s.dmgName}`),
      wrangler('deploy', '--env', 'production'),
    ],
  );
  assert.equal(
    s.descriptor('production').release.marUrl,
    `https://dl.bentobrowser.app/${s.marName}`,
  );
  assert.equal(s.descriptor('production').serving, true);
  assert.equal(s.descriptor('test').serving, false);
});

test('production refuses every unmet condition before touching Cloudflare', async (t) => {
  const cases = [
    [
      'version below 0.1.0',
      { version: '0.0.9', signing: developerId, roundTrip: roundTrip({ toVersion: '0.0.9' }) },
      /below 0\.1\.0/,
    ],
    [
      'ad-hoc signing',
      {
        version: '0.1.0',
        signing: { mode: 'ad-hoc', teamId: null, notarized: false },
        roundTrip: roundTrip(),
      },
      /signing\.mode is "ad-hoc"/,
    ],
    [
      'no signing record',
      { version: '0.1.0', roundTrip: roundTrip() },
      /signing\.mode is "ad-hoc"/,
    ],
    ['no round trip', { version: '0.1.0', signing: developerId }, /roundTrip is not recorded/],
    [
      'round trip for another version',
      { version: '0.1.0', signing: developerId, roundTrip: roundTrip({ toVersion: '0.0.9' }) },
      /toVersion 0\.0\.9 is not 0\.1\.0/,
    ],
    [
      'round trip for another build',
      {
        version: '0.1.0',
        signing: developerId,
        roundTrip: roundTrip({ buildIds: { to: '20250101000000' } }),
      },
      /buildIds\.to 20250101000000/,
    ],
    [
      'round trip for another MAR',
      {
        version: '0.1.0',
        signing: developerId,
        roundTrip: roundTrip({ marSha256: 'ab'.repeat(32) }),
      },
      /marSha256 is not the SHA-256 of this MAR/,
    ],
  ];
  for (const [name, options, message] of cases) {
    const s = setup(t, options);
    for (const flags of [['--assets'], ['--promote']]) {
      await assert.rejects(publish(s.args(flags, 'production'), s.ctx), message, name);
    }
    assert.deepEqual(
      s.commands(),
      [
        [...GATE, s.root],
        [...GATE, s.root],
      ],
      `${name}: only the gate ran`,
    );
    assert.equal(s.descriptor('production').serving, false, name);
  }
});

test('production stops when the public gate fails', async (t) => {
  const s = setup(t, { gateFails: true });
  await assert.rejects(publish(s.args(['--promote'], 'production'), s.ctx), /public gate failed/);
  assert.deepEqual(s.commands(), [[...GATE, s.root]]);
});

test('withdraw needs no gate, no release and keeps the release on record', async (t) => {
  const s = setup(t, { gateFails: true });
  await publish(s.args(['--assets', '--promote']), s.ctx);
  const served = s.descriptor('test');
  s.setDescriptor('production', served);
  s.calls.length = 0;

  for (const environment of ['test', 'production']) {
    await publish(
      { ...s.args(['--withdraw'], environment), releaseDir: path.join(s.root, 'no-such-dir') },
      s.ctx,
    );
    assert.deepEqual(s.descriptor(environment), { ...served, serving: false }, environment);
  }
  assert.deepEqual(s.commands(), [
    ['pnpm', wrangler('deploy', '--env', 'test'), s.serviceDir],
    ['pnpm', wrangler('deploy', '--env', 'production'), s.serviceDir],
  ]);
});

test('an existing object is never overwritten, but an identical one is accepted', async (t) => {
  const different = setup(t);
  different.store.set(
    `https://dl-test.bentobrowser.app/${different.marName}`,
    Buffer.from('other bytes'),
  );
  await assert.rejects(
    publish(different.args(['--assets']), different.ctx),
    /already exists and does not match.*not overwritten/s,
  );
  assert.deepEqual(different.commands(), []);

  const identical = setup(t);
  identical.store.set(
    `https://dl-test.bentobrowser.app/${identical.marName}`,
    identical.marBytes,
  );
  await publish(identical.args(['--assets']), identical.ctx);
  assert.deepEqual(
    identical.commands().map(([, args]) => args[5]),
    [`bento-updates-test/${identical.dmgName}`],
    'only the DMG is uploaded',
  );
});

test('an upload that does not verify through the download host fails', async (t) => {
  for (const [name, options, message] of [
    [
      'longer object',
      { uploadTransform: (bytes) => Buffer.concat([bytes, Buffer.from('x')]) },
      /Content-Length \d+ is not the local size/,
    ],
    [
      'same length, other bytes',
      { uploadTransform: (bytes) => Buffer.concat([bytes.subarray(1), Buffer.from('x')]) },
      /does not download as the local/,
    ],
    [
      'wrong Content-Length header',
      { lengthOffset: 1 },
      /Content-Length \d+ is not the local size/,
    ],
    ['no range support', { rangeStatus: 200 }, /answered 200, expected 206/],
  ]) {
    const s = setup(t, options);
    await assert.rejects(publish(s.args(['--assets', '--promote']), s.ctx), message, name);
    assert.ok(
      !s.commands().some(([, args]) => args.includes('deploy')),
      `${name}: nothing deployed`,
    );
    assert.equal(s.descriptor('test').serving, false, name);
  }
});

test('promote alone verifies the hosted MAR first and leaves the descriptor alone when it is missing', async (t) => {
  const s = setup(t);
  const before = JSON.stringify(s.descriptor('test'));
  await assert.rejects(publish(s.args(['--promote']), s.ctx), /answered 404/);
  assert.equal(JSON.stringify(s.descriptor('test')), before);
  assert.deepEqual(s.commands(), []);

  s.store.set(`https://dl-test.bentobrowser.app/${s.marName}`, s.marBytes);
  await publish(s.args(['--promote']), s.ctx);
  assert.deepEqual(s.commands(), [['pnpm', wrangler('deploy', '--env', 'test'), s.serviceDir]]);
  assert.equal(s.descriptor('test').release.version, '0.0.3');
});

test('the same release may be served again after a withdrawal, by --promote or --assets', async (t) => {
  const s = setup(t);
  await publish(s.args(['--assets', '--promote']), s.ctx);
  const live = s.descriptor('test');

  await publish(s.args(['--withdraw']), s.ctx);
  await publish(s.args(['--promote']), s.ctx);
  await publish(s.args(['--assets']), s.ctx);
  assert.deepEqual(
    s.descriptor('test'),
    live,
    'the same release is served again after a withdrawal',
  );
});

test('an older or republished version is refused before anything is uploaded or deployed', async (t) => {
  const named = (version, buildId, changes = {}) => ({
    ...DISABLED,
    serving: true,
    release: {
      version,
      buildId,
      marUrl: `https://dl-test.bentobrowser.app/${marFileName(version, buildId)}`,
      size: 1,
      sha512: 'cd'.repeat(64),
      platformVersion: '158.0',
      detailsUrl: `https://bentobrowser.app/release-notes/${version}/`,
      ...changes,
    },
  });
  const s = setup(t); // builds 0.0.3 (20261102120000)
  for (const [name, live, message] of [
    ['a higher version is live', named('0.0.4', '20261102120000'), /already names 0\.0\.4/],
    [
      'the same version has another BuildID',
      named('0.0.3', '20250101000000'),
      /already names 0\.0\.3 \(20250101000000\)/,
    ],
    [
      'the same version and BuildID have another MAR',
      named('0.0.3', '20261102120000'),
      /already names 0\.0\.3 \(20261102120000\).*strictly higher/,
    ],
  ]) {
    s.setDescriptor('test', live);
    for (const flags of [['--assets'], ['--promote'], ['--assets', '--promote']]) {
      await assert.rejects(publish(s.args(flags), s.ctx), message, `${name}: ${flags}`);
    }
    assert.deepEqual(s.commands(), [], `${name}: nothing uploaded or deployed`);
    assert.deepEqual(s.requests, [], `${name}: storage never contacted`);
    assert.deepEqual(s.descriptor('test'), live, `${name}: descriptor untouched`);
  }
});

test('fails clearly when the release directory is incomplete or inconsistent', async (t) => {
  const missing = (name) => {
    const s = setup(t);
    fs.rmSync(
      path.join(s.releaseDir, name === 'mar' ? s.marName : name === 'dmg' ? s.dmgName : name),
    );
    return s;
  };
  let s = missing('release-manifest.json');
  await assert.rejects(publish(s.args(['--assets']), s.ctx), /release-manifest\.json is missing/);
  s = missing('mar');
  await assert.rejects(publish(s.args(['--assets']), s.ctx), /exactly one \.mar .*found 0/);
  s = missing('dmg');
  await assert.rejects(publish(s.args(['--assets']), s.ctx), /\.dmg is missing/);

  s = setup(t);
  fs.writeFileSync(path.join(s.releaseDir, s.marName), 'changed after the manifest was written');
  await assert.rejects(
    publish(s.args(['--assets']), s.ctx),
    /does not match release-manifest\.json/,
  );

  s = setup(t);
  fs.renameSync(path.join(s.releaseDir, s.marName), path.join(s.releaseDir, 'output.mar'));
  await assert.rejects(
    publish(s.args(['--assets']), s.ctx),
    /is not named Bento-<version>-<buildid>-macos-arm64\.mar/,
  );

  s = setup(t);
  const manifestPath = path.join(s.releaseDir, 'release-manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      displayVersion: '0.0.9',
    }),
  );
  await assert.rejects(
    publish(s.args(['--assets']), s.ctx),
    /displayVersion 0\.0\.9 does not match/,
  );
  assert.deepEqual(s.commands(), []);
});

test('needs Cloudflare credentials before doing anything', async (t) => {
  const s = setup(t);
  for (const processEnv of [
    {},
    { CLOUDFLARE_API_TOKEN: 'token' },
    { CLOUDFLARE_ACCOUNT_ID: 'account' },
  ]) {
    await assert.rejects(
      publish(s.args(['--assets']), { ...s.ctx, processEnv }),
      /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/,
    );
    await assert.rejects(
      publish(s.args(['--withdraw'], 'production'), { ...s.ctx, processEnv }),
      /CLOUDFLARE_API_TOKEN/,
    );
  }
  assert.deepEqual(s.commands(), []);
});

test('a held lock refuses a second run from any checkout, and every run releases its own lock', async (t) => {
  const s = setup(t);
  const lock = s.ctx.lockFile;
  const holder = '{"pid":1,"started":"2026-11-02T12:00:00.000Z"}\n';
  fs.writeFileSync(lock, holder);

  for (const flags of [['--assets', '--promote'], ['--withdraw']]) {
    await assert.rejects(
      publish(s.args(flags), s.ctx),
      /ota-publish\.lock exists.*"pid":1/s,
      flags.join(' '),
    );
  }
  const otherCheckout = setup(t, { lockFile: lock });
  await assert.rejects(
    publish(otherCheckout.args(['--assets']), otherCheckout.ctx),
    /ota-publish\.lock exists/,
  );
  assert.deepEqual(otherCheckout.commands(), []);
  assert.deepEqual(s.commands(), []);
  assert.deepEqual(s.requests, []);
  assert.equal(fs.readFileSync(lock, 'utf8'), holder, 'a refused run leaves the holder lock alone');
  fs.rmSync(lock);

  const heldDuringRun = [];
  const ctx = {
    ...s.ctx,
    run: (...args) => {
      heldDuringRun.push(fs.existsSync(lock));
      return s.ctx.run(...args);
    },
  };
  await publish(s.args(['--assets']), ctx);
  assert.deepEqual(heldDuringRun, [true, true], 'held while uploading');
  assert.ok(!fs.existsSync(lock), 'released after a successful run');

  await assert.rejects(
    publish({ ...s.args(['--assets']), releaseDir: path.join(s.root, 'no-such-dir') }, s.ctx),
    /release-manifest\.json is missing/,
  );
  assert.ok(!fs.existsSync(lock), 'released after a failed run');
});

test('every wrangler call runs the pinned version from the service directory', async (t) => {
  const s = setup(t);
  await publish(s.args(['--assets', '--promote']), s.ctx);
  await publish(s.args(['--withdraw']), s.ctx);
  assert.ok(s.calls.length >= 4);
  for (const { command, args, cwd } of s.calls) {
    assert.equal(command, 'pnpm');
    assert.deepEqual(args.slice(0, 2), ['dlx', `wrangler@${WRANGLER_VERSION}`]);
    assert.equal(cwd, s.serviceDir);
  }
});
