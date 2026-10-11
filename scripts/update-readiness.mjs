/**
 * Readiness inputs for compiling the updater in (bento.json `updates.enabled`), and
 * how the updater state a build was configured with is read back.
 *
 * Bento ships with the updater compiled out until it owns a signed update path.
 * The release gate (check-release-security.mjs) and the build driver
 * (bento-build.mjs) both refuse `updates.enabled: true` while any input below is
 * missing from config/release-security.json. The inputs are recorded
 * attestations, so a person must have done the work they claim before setting them.
 */

import fs from 'node:fs';
import path from 'node:path';

// Firefox compiles Mozilla's own update certificates into the updater for any
// channel except the ones Bento could patch, and these names select Mozilla's keys.
// configure lowercases the channel (build/moz.configure/init.configure), so
// 'Release' and 'NIGHTLY' select them too.
const MOZILLA_CHANNELS = new Set(['default', 'release', 'beta', 'esr', 'aurora']);
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** Returns what is missing, as one sentence per problem; an empty list means ready. */
export function updaterReadinessProblems(bento, security) {
  const channel = bento.updates?.channel;
  const service = security.updateService ?? {};
  const signingKey = service.marSigningKeyFingerprint;
  const compiledCertificate = service.updaterCertificateFingerprint;
  const problems = [];

  const normalizedChannel = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  if (!normalizedChannel || MOZILLA_CHANNELS.has(normalizedChannel) || normalizedChannel.startsWith('nightly')) {
    problems.push(
      `updates.channel (${JSON.stringify(channel)}) must be a Bento-owned channel, not one of Mozilla's`,
    );
  }
  if (normalizedChannel && channel !== normalizedChannel) {
    problems.push(
      `updates.channel (${JSON.stringify(channel)}) must be lowercase with no surrounding whitespace; configure lowercases it before choosing certificates`,
    );
  }
  if (!SHA256_HEX.test(signingKey ?? '')) {
    problems.push(
      'updateService.marSigningKeyFingerprint must be the SHA-256 fingerprint of the MAR signing key',
    );
  }
  if (
    !SHA256_HEX.test(compiledCertificate ?? '') ||
    compiledCertificate.toLowerCase() !== signingKey?.toLowerCase()
  ) {
    problems.push(
      'updateService.updaterCertificateFingerprint must equal marSigningKeyFingerprint: the certificate compiled into the updater has to be the one that signs the MARs',
    );
  }
  if (service.hostCompiledIn !== true) {
    problems.push(
      'updateService.hostCompiledIn must be true once the update host reaches configure before compilation',
    );
  }
  if (service.isolatedRoundTripVerified !== true) {
    problems.push(
      'updateService.isolatedRoundTripVerified must be true once a signed update has installed against an isolated update host',
    );
  }
  return problems;
}

/** The lines of a mozconfig fragment that are neither blank nor comments. */
export function activeMozconfigLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
}

/**
 * Whether an active mozconfig line touches the updater in any spelling
 * (--enable-updater, --without-updater, an export of MOZ_UPDATER). bento.json
 * `updates.enabled` is the only switch, so Bento's fragments may not carry one.
 */
export function overridesUpdater(line) {
  return /updater/i.test(line);
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
    const words = line.replace(/(^|\s)#.*/, '').trim().split(/\s+/);
    if (words[0] !== 'ac_add_options') continue;
    for (const word of words.slice(1)) {
      const prefix = UPDATER_FLAG.exec(word.replace(/^["']|["']$/g, ''))?.[1];
      if (prefix) enabled = prefix === 'enable' || prefix === 'with';
    }
  }
  return enabled;
}

/**
 * The updater state configure recorded in an object directory (MOZ_UPDATER in
 * config.status.json is '1' when the updater is built), or undefined before the
 * first configure. It is the ground truth: a mozconfig can set the flag in ways
 * a text scan misses.
 */
export function configuredUpdaterState(objDir) {
  const file = path.join(objDir, 'config.status.json');
  if (!fs.existsSync(file)) return undefined;
  return Boolean(JSON.parse(fs.readFileSync(file, 'utf8')).substs?.MOZ_UPDATER);
}
