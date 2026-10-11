/**
 * Readiness inputs for compiling the updater in (bento.json `updates.enabled`).
 *
 * Bento ships with the updater compiled out until it owns a signed update path.
 * The release gate (check-release-security.mjs) and the build driver
 * (bento-build.mjs) both refuse `updates.enabled: true` while any input below is
 * missing from config/release-security.json. The inputs are recorded
 * attestations, so a person must have done the work they claim before setting them.
 */

// Firefox compiles Mozilla's own update certificates into the updater for any
// channel except the ones Bento could patch, and these names select Mozilla's keys.
const MOZILLA_CHANNELS = new Set(['default', 'release', 'beta', 'esr', 'aurora']);
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** Returns what is missing, as one sentence per problem; an empty list means ready. */
export function updaterReadinessProblems(bento, security) {
  const channel = bento.updates?.channel;
  const service = security.updateService ?? {};
  const signingKey = service.marSigningKeyFingerprint;
  const compiledCertificate = service.updaterCertificateFingerprint;
  const problems = [];

  if (!channel || MOZILLA_CHANNELS.has(channel) || channel.startsWith('nightly')) {
    problems.push(
      `updates.channel (${JSON.stringify(channel)}) must be a Bento-owned channel, not one of Mozilla's`,
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
