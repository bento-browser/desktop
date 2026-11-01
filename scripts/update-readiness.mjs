/**
 * What must hold before the updater is compiled in (bento.json `updates.enabled`),
 * what a build of a given mode compiles, and how the state a build was configured
 * with is read back.
 *
 * Firefox's updater trusts the certificates compiled into it, so enabling it is
 * gated on structural facts that can be checked from committed files: the
 * channel that selects Bento's certificates, the certificates themselves, the
 * update host, and the patches that wire both in. Artifact-level proof (the host
 * and both certificates inside the shipped binaries) lives in
 * validate-bento-artifacts.mjs. Whether a published release may reach users is a
 * separate question: publishReadinessProblems.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The only channel patches/experiments/04 maps to Bento's own update certificates. */
export const BENTO_CHANNEL = 'bento';
export const UPDATE_CERTIFICATE_DIR = 'branding/bento/update-certificates';
// The patches that make the updater trust Bento's certificates and ask Bento's host.
const UPDATER_PATCHES = [
  'patches/experiments/03-appupdate-host-configure.patch',
  'patches/experiments/04-updater-bento-certificates.patch',
];
const SHA256_HEX = /^[a-f0-9]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The updater state a build of `mode` must have: the one answer for every consumer
 * (mozconfig writer, package, update commands, artifact check). Only a release
 * build compiles the updater in, and only while bento.json enables it; dev and
 * debug builds never do, so the daily build cannot update itself.
 */
export function effectiveUpdaterState(config, mode) {
  return { enabled: config.updates?.enabled === true && mode === 'release', mode };
}

/**
 * Why `hostname` cannot be the update host, or undefined. It lands in a mozconfig
 * export and in the compiled update URL, so it must be a bare lowercase hostname:
 * no scheme, port, path, whitespace or quote.
 */
export function hostnameProblem(hostname) {
  return typeof hostname === 'string' && HOSTNAME.test(hostname)
    ? undefined
    : `updates.hostname (${JSON.stringify(hostname)}) must be a bare lowercase hostname with no scheme, port, path or whitespace`;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The committed update certificates (DER bytes) of the repository at `root`; a missing file is undefined. */
export function readUpdateCertificates(root) {
  const read = (name) => {
    const file = path.join(root, UPDATE_CERTIFICATE_DIR, name);
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  };
  return { primary: read('primary.der'), secondary: read('secondary.der') };
}

/**
 * What is wrong with enabling the updater, as one sentence per problem; an empty
 * list means the structural inputs hold. `root` is the repository holding the
 * committed certificates and patches/series.json.
 */
export function updaterReadinessProblems(bento, security, root) {
  const service = security.updateService ?? {};
  const certificates = readUpdateCertificates(root);
  const problems = [];

  const channel = bento.updates?.channel;
  if (channel !== BENTO_CHANNEL) {
    problems.push(
      `updates.channel (${JSON.stringify(channel)}) must be exactly "${BENTO_CHANNEL}": configure lowercases the channel, and every name but this one selects Mozilla's update certificates`,
    );
  }
  const hostProblem = hostnameProblem(bento.updates?.hostname);
  if (hostProblem) problems.push(hostProblem);

  for (const [name, bytes] of Object.entries(certificates)) {
    if (!bytes) problems.push(`${UPDATE_CERTIFICATE_DIR}/${name}.der is missing`);
  }
  for (const [field, name] of [
    ['marSigningKeyFingerprint', 'primary'],
    ['updaterCertificateFingerprint', 'primary'],
    ['backupCertificateFingerprint', 'secondary'],
  ]) {
    const bytes = certificates[name];
    if (bytes && service[field] !== sha256(bytes)) {
      problems.push(
        `updateService.${field} must be the lowercase SHA-256 of ${UPDATE_CERTIFICATE_DIR}/${name}.der (${sha256(bytes)})`,
      );
    }
  }

  let listed = [];
  try {
    listed = JSON.parse(fs.readFileSync(path.join(root, 'patches/series.json'), 'utf8')).series.map((entry) => entry.path);
  } catch {
    // An unreadable series lists nothing, so both patches are reported missing.
  }
  for (const patch of UPDATER_PATCHES) {
    if (!listed.includes(patch)) problems.push(`${patch} must be listed in patches/series.json`);
  }
  return problems;
}

/**
 * What stands between a built release and users: an isolated round trip, attested
 * and recorded, and, when `artifact` (`{ version, buildId, marSha256 }`) is given,
 * recorded for that exact artifact. The public gate and the publish script run
 * this; building does not.
 */
export function publishReadinessProblems(security, artifact) {
  const service = security.updateService ?? {};
  if (service.isolatedRoundTripVerified !== true) {
    return [
      'updateService.isolatedRoundTripVerified must be true once a signed update has installed against an isolated update host',
    ];
  }
  const trip = service.roundTrip;
  const recorded = trip
    && [trip.date, trip.fromVersion, trip.toVersion, trip.host].every((value) => typeof value === 'string' && value)
    && [trip.buildIds?.from, trip.buildIds?.to].every((value) => typeof value === 'string' && value)
    && SHA256_HEX.test(trip.marSha256);
  if (!recorded) {
    return [
      'updateService.roundTrip must record the round trip as { date, fromVersion, toVersion, buildIds: { from, to }, marSha256, host }',
    ];
  }
  if (!artifact) return [];
  const problems = [];
  if (trip.toVersion !== artifact.version) problems.push(`updateService.roundTrip is for version ${trip.toVersion}, not ${artifact.version}`);
  if (trip.buildIds.to !== artifact.buildId) problems.push(`updateService.roundTrip updated to build ${trip.buildIds.to}, not ${artifact.buildId}`);
  if (trip.marSha256 !== artifact.marSha256) problems.push('updateService.roundTrip is for a different MAR than this artifact (marSha256 differs)');
  return problems;
}

/** A mozconfig line without its trailing shell comment: an unquoted '#' that starts a word. */
function withoutComment(line) {
  let quote = '';
  let startsWord = true;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"') i++;
    } else if (/\s/.test(char)) {
      startsWord = true;
      continue;
    } else if (char === '#' && startsWord) {
      return line.slice(0, i);
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '\\') {
      i++;
    }
    startsWord = false;
  }
  return line;
}

/** The lines of a mozconfig fragment that still say something once comments are removed. */
export function activeMozconfigLines(text) {
  return text.split(/\r?\n/).map((line) => withoutComment(line).trimEnd()).filter((line) => line.trim());
}

/**
 * Whether an active mozconfig line sets something Bento's generator owns about updates:
 * the updater (--enable-updater, --without-updater, an export of MOZ_UPDATER), MAR
 * signature verification (--enable-unverified-updates, MOZ_VERIFY_MAR_SIGNATURE), the
 * update channel (--enable-update-channel, MOZ_UPDATE_CHANNEL, MAR_CHANNEL_ID,
 * ACCEPTED_MAR_CHANNEL_IDS), or the update host (MOZ_APPUPDATE_HOST), in any spelling.
 * bento.json `updates.enabled`, `updates.channel` and `updates.hostname` are the only
 * switches: unverified updates would bypass signature checks if the updater came back,
 * a channel such as 'release' compiles Mozilla's certificates into the updater, and
 * another host would send every update check there. Bento's fragments may carry none
 * of them.
 */
export function overridesUpdateSettings(line) {
  return /updater|unverified[-_]updates|verify_mar_signature|update[-_]channel|mar_channel_id|appupdate_host/i.test(line);
}

// configure keys its arguments by option name, so the last updater flag wins;
// --with and --without are the same option as --enable and --disable.
const UPDATER_FLAG = /^--(enable|with|disable|without)-updater(?:=.*)?$/;

/**
 * The updater state a mozconfig configures: its last updater flag decides, and
 * with none Firefox builds the updater (build/moz.configure/update-programs.configure).
 */
export function mozconfigUpdaterState(text) {
  let enabled = true;
  for (const line of activeMozconfigLines(text)) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== 'ac_add_options') continue;
    for (const word of words.slice(1)) {
      const prefix = UPDATER_FLAG.exec(word.replace(/^["']|["']$/g, ''))?.[1];
      if (prefix) enabled = prefix === 'enable' || prefix === 'with';
    }
  }
  return enabled;
}

/**
 * What configure recorded in an object directory's config.status.json, or undefined
 * before the first configure: whether the updater is built (MOZ_UPDATER is '1'), the
 * update channel (MOZ_UPDATE_CHANNEL, already lowercased by configure), the update
 * host and the accepted MAR channels. It is the ground truth: a mozconfig can set
 * any of them in ways a text scan misses.
 */
export function configuredUpdateState(objDir) {
  const file = path.join(objDir, 'config.status.json');
  if (!fs.existsSync(file)) return undefined;
  const substs = JSON.parse(fs.readFileSync(file, 'utf8')).substs ?? {};
  return {
    updater: Boolean(substs.MOZ_UPDATER),
    channel: substs.MOZ_UPDATE_CHANNEL,
    host: substs.MOZ_APPUPDATE_HOST,
    acceptedChannels: substs.ACCEPTED_MAR_CHANNEL_IDS,
  };
}

/** Whether a channel recorded by configure is the one bento.json names (configure lowercases it). */
export function isBentoChannel(recorded, config) {
  return recorded === String(config.updates?.channel).toLowerCase();
}
