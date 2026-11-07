#!/usr/bin/env node

/**
 * Publishes a Bento release to an update environment. Runs only on the maintainer's
 * Mac, never in CI (scripts/ci-build-guard.mjs refuses it there). Needs
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
 *
 *   node scripts/ota-publish.mjs --env test|production [--assets] [--promote]
 *   node scripts/ota-publish.mjs --env test|production --withdraw
 *   --release-dir <dir>   the build's output, default release-out (archived builds)
 *
 * --assets   upload the MAR and DMG to the environment's R2 bucket, then verify them
 *            through its download host. Objects are immutable: an existing object is
 *            accepted only when it is byte-identical, never overwritten.
 * --promote  verify the hosted MAR, rewrite update-service/releases/<env>.json from the
 *            release and deploy the Worker, which starts offering it.
 * --withdraw set serving to false and deploy. Needs no release and no gate.
 *
 * --assets and --promote refuse an older or republished version before uploading or
 * deploying anything. Production operations other than --withdraw first run the public
 * release gate and require evidence that this exact artifact was tested. Every run
 * holds an exclusive per-user lock shared by every checkout. See docs/ota-updates.md.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseCliArgs } from 'node:util';

import {
  CHANNEL,
  PRODUCT,
  TARGET,
  compareVersions,
  parseVersion,
  validateDescriptor,
} from '../update-service/descriptor.mjs';

// Pinned exactly: the tool that deploys to Cloudflare must not change underneath a release.
export const WRANGLER_VERSION = '4.156.0';

export const ENVIRONMENTS = {
  test: { bucket: 'bento-updates-test', downloadHost: 'dl-test.bentobrowser.app' },
  production: { bucket: 'bento-updates', downloadHost: 'dl.bentobrowser.app' },
};

const FIRST_PUBLIC_VERSION = [0, 1, 0];
const RELEASE_NOTES_URL = 'https://bentobrowser.app/release-notes';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_TYPES = { mar: 'application/octet-stream', dmg: 'application/x-apple-diskimage' };
// The client asks for the bytes as stored, so verification does too.
const AS_STORED = { 'Accept-Encoding': 'identity' };

const USAGE = `usage: node scripts/ota-publish.mjs --env test|production (--assets [--promote] | --promote | --withdraw) [--release-dir <dir>]`;

function fail(message) {
  throw new Error(message);
}

/** Parses argv (without node and the script) into `{ environment, assets, promote, withdraw, releaseDir }`. */
export function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseCliArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        env: { type: 'string' },
        assets: { type: 'boolean' },
        promote: { type: 'boolean' },
        withdraw: { type: 'boolean' },
        'release-dir': { type: 'string' },
      },
    }));
  } catch (error) {
    fail(`${error.message}\n${USAGE}`);
  }
  if (!Object.hasOwn(ENVIRONMENTS, values.env ?? ''))
    fail(`--env must be test or production\n${USAGE}`);
  const { assets = false, promote = false, withdraw = false } = values;
  if (!assets && !promote && !withdraw) fail(`choose --assets, --promote or --withdraw\n${USAGE}`);
  if (withdraw && (assets || promote))
    fail(`--withdraw cannot be combined with --assets or --promote\n${USAGE}`);
  return {
    environment: values.env,
    assets,
    promote,
    withdraw,
    releaseDir: path.resolve(
      values['release-dir'] ?? path.join(import.meta.dirname, '..', 'release-out'),
    ),
  };
}

async function digestFile(file) {
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
}

/**
 * Reads a build's output directory. Size and digests come from the files themselves;
 * release-manifest.json supplies the Firefox version and the signing record, and must
 * agree with the files it lists.
 */
export async function loadRelease(releaseDir) {
  const where = path.relative(process.cwd(), releaseDir) || '.';
  const manifestFile = path.join(releaseDir, 'release-manifest.json');
  if (!fs.existsSync(manifestFile))
    fail(`${where}/release-manifest.json is missing; run pnpm run release:metadata`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  const mars = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).filter((name) => name.endsWith('.mar'))
    : [];
  if (mars.length !== 1) fail(`expected exactly one .mar in ${where}, found ${mars.length}`);
  const match = /^Bento-(\d+\.\d+\.\d+)-(\d{14})-macos-arm64\.mar$/.exec(mars[0]);
  if (!match) fail(`${mars[0]} is not named Bento-<version>-<buildid>-macos-arm64.mar`);
  const [, version, buildId] = match;
  const dmgName = mars[0].replace(/\.mar$/, '.dmg');
  if (!fs.existsSync(path.join(releaseDir, dmgName))) fail(`${where}/${dmgName} is missing`);
  if (manifest.displayVersion !== version) {
    fail(
      `release-manifest.json displayVersion ${manifest.displayVersion} does not match ${mars[0]}`,
    );
  }

  const files = {};
  for (const [kind, name] of [
    ['mar', mars[0]],
    ['dmg', dmgName],
  ]) {
    const file = path.join(releaseDir, name);
    files[kind] = { name, path: file, ...(await digestFile(file)) };
    const listed = manifest.files?.find((entry) => entry.name === name);
    if (listed?.sha256 !== files[kind].sha256 || listed?.size !== files[kind].size) {
      fail(
        `${name} does not match release-manifest.json; rebuild the release or regenerate its metadata`,
      );
    }
  }
  return {
    version,
    buildId,
    platformVersion: manifest.firefoxVersion,
    signingMode: manifest.signing?.mode ?? 'ad-hoc',
    mar: files.mar,
    dmg: files.dmg,
  };
}

/** What stops a release from reaching production, one sentence each; empty means allowed. */
export function productionProblems(release, security) {
  const problems = [];
  if (compareVersions(parseVersion(release.version), FIRST_PUBLIC_VERSION) < 0) {
    problems.push(
      `version ${release.version} is below 0.1.0; private v0.0.X builds are never published`,
    );
  }
  if (release.signingMode !== 'developer-id') {
    problems.push(
      `release-manifest.json signing.mode is "${release.signingMode}", production needs "developer-id"`,
    );
  }
  const trip = security.updateService?.roundTrip;
  if (!trip) {
    problems.push('config/release-security.json updateService.roundTrip is not recorded');
  } else {
    if (trip.toVersion !== release.version) {
      problems.push(`roundTrip.toVersion ${trip.toVersion} is not ${release.version}`);
    }
    if (trip.buildIds?.to !== release.buildId) {
      problems.push(`roundTrip.buildIds.to ${trip.buildIds?.to} is not ${release.buildId}`);
    }
    if (String(trip.marSha256).toLowerCase() !== release.mar.sha256) {
      problems.push('roundTrip.marSha256 is not the SHA-256 of this MAR');
    }
  }
  return problems;
}

async function exists(ctx, url) {
  // A unique query bypasses any cached 404 for the plain URL.
  const response = await ctx.fetch(`${url}?publish-check=${crypto.randomUUID()}`, {
    method: 'HEAD',
  });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  fail(`HEAD ${url} answered ${response.status}; cannot tell whether the object exists`);
}

/** Checks the object a client would download: length, a 206 range answer, then every byte. */
async function verifyHosted(ctx, url, file) {
  const head = await ctx.fetch(url, { method: 'HEAD', headers: AS_STORED });
  if (head.status !== 200) fail(`HEAD ${url} answered ${head.status}`);
  if (head.headers.get('content-length') !== String(file.size)) {
    fail(
      `HEAD ${url}: Content-Length ${head.headers.get('content-length')} is not the local size ${file.size}`,
    );
  }

  const range = await ctx.fetch(url, { headers: { ...AS_STORED, Range: 'bytes=0-0' } });
  await range.arrayBuffer();
  if (range.status !== 206) fail(`Range request for ${url} answered ${range.status}, expected 206`);
  if (range.headers.get('content-range') !== `bytes 0-0/${file.size}`) {
    fail(`Range request for ${url}: Content-Range ${range.headers.get('content-range')} is wrong`);
  }

  const full = await ctx.fetch(url, { headers: AS_STORED });
  if (full.status !== 200) fail(`GET ${url} answered ${full.status}`);
  const hash = crypto.createHash('sha512');
  let bytes = 0;
  for await (const chunk of full.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== file.size || hash.digest('hex') !== file.sha512) {
    fail(`${url} does not download as the local ${file.name} (${bytes} bytes, SHA-512 differs)`);
  }
}

const wrangler = (...args) => ['dlx', `wrangler@${WRANGLER_VERSION}`, ...args];

async function publishAssets(ctx, release, verified) {
  const { bucket, downloadHost } = ENVIRONMENTS[ctx.environment];
  for (const [kind, file] of [
    ['mar', release.mar],
    ['dmg', release.dmg],
  ]) {
    const url = `https://${downloadHost}/${file.name}`;
    if (await exists(ctx, url)) {
      try {
        await verifyHosted(ctx, url, file);
      } catch (error) {
        fail(
          `${url} already exists and does not match the local file, so it is not overwritten (${error.message}); publish a higher version`,
        );
      }
      ctx.log(`${file.name} is already hosted and identical`);
    } else {
      ctx.log(`uploading ${file.name} to ${bucket}`);
      await ctx.run(
        'pnpm',
        wrangler(
          'r2',
          'object',
          'put',
          `${bucket}/${file.name}`,
          '--file',
          file.path,
          '--content-type',
          CONTENT_TYPES[kind],
          '--cache-control',
          CACHE_CONTROL,
          '--remote',
        ),
        { cwd: ctx.serviceDir },
      );
      await verifyHosted(ctx, url, file);
      ctx.log(`${file.name} verified at ${url}`);
    }
    verified.add(url);
  }
}

const descriptorFile = (ctx) => path.join(ctx.serviceDir, 'releases', `${ctx.environment}.json`);
const readDescriptor = (ctx) => JSON.parse(fs.readFileSync(descriptorFile(ctx), 'utf8'));

function writeDescriptor(ctx, descriptor) {
  validateDescriptor(descriptor);
  fs.writeFileSync(descriptorFile(ctx), `${JSON.stringify(descriptor, null, 2)}\n`);
}

/**
 * Versions only ever rise (docs/ota-updates.md); the one repeat allowed is the same
 * release, to serve it again after a withdrawal or a failed deploy. Checked before
 * anything is uploaded, so a republished version never reaches storage.
 */
function assertNotRepublished(ctx, release) {
  const live = readDescriptor(ctx).release;
  if (!live) return;
  const order = compareVersions(parseVersion(release.version), parseVersion(live.version));
  const same =
    order === 0 && live.buildId === release.buildId && live.sha512 === release.mar.sha512;
  if (order < 0 || (order === 0 && !same)) {
    fail(
      `${ctx.environment} already names ${live.version} (${live.buildId}); publish a strictly higher version, never an older or republished one`,
    );
  }
}

const deploy = (ctx) =>
  ctx.run('pnpm', wrangler('deploy', '--env', ctx.environment), { cwd: ctx.serviceDir });

async function promote(ctx, release, verified) {
  const marUrl = `https://${ENVIRONMENTS[ctx.environment].downloadHost}/${release.mar.name}`;
  if (!verified.has(marUrl)) await verifyHosted(ctx, marUrl, release.mar);

  writeDescriptor(ctx, {
    serving: true,
    product: PRODUCT,
    target: TARGET,
    channel: CHANNEL,
    release: {
      version: release.version,
      buildId: release.buildId,
      marUrl,
      size: release.mar.size,
      sha512: release.mar.sha512,
      platformVersion: release.platformVersion,
      detailsUrl: `${RELEASE_NOTES_URL}/${release.version}/`,
    },
  });
  await deploy(ctx);
  ctx.log(
    `${ctx.environment} now offers ${release.version} (buildID ${release.buildId}, ${release.mar.size} bytes, SHA-512 ${release.mar.sha512})`,
  );
  ctx.log(`commit update-service/releases/${ctx.environment}.json`);
}

async function withdraw(ctx) {
  writeDescriptor(ctx, { ...readDescriptor(ctx), serving: false });
  await deploy(ctx);
  ctx.log(
    `${ctx.environment} no longer offers an update; commit update-service/releases/${ctx.environment}.json`,
  );
}

/**
 * Takes the exclusive local publish lock and returns the function that releases it.
 * Object immutability is a HEAD followed by a PUT, so two runs could both see "missing"
 * and upload different bytes to one key; the lock stops a second run from starting.
 * The file lives outside the checkout so runs from different worktrees or clones share it.
 * A run that is killed leaves the file behind, and the error says how to clear it.
 */
function acquireLock(ctx) {
  const file = ctx.lockFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const holder = { pid: process.pid, started: new Date().toISOString() };
    fs.writeFileSync(file, `${JSON.stringify(holder)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fail(
      `${file} exists, so another ota-publish run may be active (${fs.readFileSync(file, 'utf8').trim()}); wait for it, or delete the file if that run was killed`,
    );
  }
  return () => fs.rmSync(file, { force: true });
}

async function runOperations(args, context) {
  if (args.withdraw) return withdraw(context);

  const production = args.environment === 'production';
  if (production)
    await context.run('pnpm', ['run', 'release:security-check:public'], { cwd: context.root });
  const release = await loadRelease(args.releaseDir);
  if (production) {
    const security = JSON.parse(
      fs.readFileSync(path.join(context.root, 'config/release-security.json'), 'utf8'),
    );
    const problems = productionProblems(release, security);
    if (problems.length > 0) fail(`production publish refused:\n- ${problems.join('\n- ')}`);
  }
  assertNotRepublished(context, release);

  const verified = new Set();
  if (args.assets) await publishAssets(context, release, verified);
  if (args.promote) await promote(context, release, verified);
}

/**
 * Runs the requested operations under the publish lock. `ctx` carries everything
 * outside the repository (`root`, `serviceDir`, `lockFile`, `run` for commands, `fetch`,
 * `log`, `processEnv`) so tests can fake it.
 */
export async function publish(args, ctx) {
  const context = { ...ctx, environment: args.environment };
  if (!context.processEnv.CLOUDFLARE_API_TOKEN || !context.processEnv.CLOUDFLARE_ACCOUNT_ID) {
    fail('set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment');
  }
  const unlock = acquireLock(context);
  try {
    await runOperations(args, context);
  } finally {
    unlock();
  }
}

function defaultContext() {
  const root = path.resolve(import.meta.dirname, '..');
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  return {
    root,
    serviceDir: path.join(root, 'update-service'),
    // Per user ($TMPDIR on macOS), shared by every checkout, cleared on reboot.
    lockFile: path.join(os.tmpdir(), 'bento-ota-publish.lock'),
    run: (command, args, options) =>
      execFileSync(command, args, { stdio: 'inherit', env, ...options }),
    fetch: globalThis.fetch,
    log: (message) => console.log(`ota-publish: ${message}`),
    processEnv: process.env,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await publish(parseArgs(process.argv.slice(2)), defaultContext());
  } catch (error) {
    console.error(`ota-publish: ${error.message}`);
    process.exitCode = 1;
  }
}
