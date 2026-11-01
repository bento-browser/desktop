// The release descriptor: the one file per environment (releases/<env>.json) that
// tells the update Worker what to offer. Shared by the Worker (bundled by wrangler)
// and by scripts/ota-publish.mjs, so both agree on the shape. Plain JavaScript with
// no imports, so it runs unchanged under wrangler and node:test.

export const PRODUCT = 'Bento';
export const TARGET = 'Darwin_aarch64-gcc3';
export const CHANNEL = 'bento';

const DESCRIPTOR_KEYS = ['serving', 'product', 'target', 'channel', 'release'];
const RELEASE_KEYS = [
  'version',
  'buildId',
  'marUrl',
  'size',
  'sha512',
  'platformVersion',
  'detailsUrl',
];

/** `1.2.3` as [1, 2, 3], or null when it is not exactly three numeric components. */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match ? match.slice(1).map(Number) : null;
}

/** Negative, zero or positive like a sort comparator; both arguments come from parseVersion. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** The artifact name the publish script gives a MAR; the MAR URL must end with it. */
export function marFileName(version, buildId) {
  return `Bento-${version}-${buildId}-macos-arm64.mar`;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function unexpectedKeys(object, allowed, label) {
  const problems = [];
  for (const key of allowed) {
    if (!(key in object)) problems.push(`${label}.${key} is missing`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) problems.push(`${label}.${key} is not a known field`);
  }
  return problems;
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function releaseProblems(release) {
  if (!isPlainObject(release)) return ['release must be an object or null'];
  const problems = unexpectedKeys(release, RELEASE_KEYS, 'release');
  const { version, buildId, marUrl, size, sha512, platformVersion, detailsUrl } = release;

  if (!parseVersion(version)) problems.push('release.version must be major.minor.patch digits');
  if (!/^\d{14}$/.test(buildId ?? '')) problems.push('release.buildId must be 14 digits');
  if (!isHttpsUrl(marUrl)) {
    problems.push('release.marUrl must be an https URL without credentials');
  } else if (
    parseVersion(version) &&
    /^\d{14}$/.test(buildId ?? '') &&
    !new URL(marUrl).pathname.endsWith(`/${marFileName(version, buildId)}`)
  ) {
    problems.push(`release.marUrl must end with /${marFileName(version, buildId)}`);
  }
  if (!Number.isSafeInteger(size) || size <= 0)
    problems.push('release.size must be a positive integer');
  if (!/^[a-f0-9]{128}$/.test(sha512 ?? '')) {
    problems.push('release.sha512 must be 128 lowercase hex characters');
  }
  if (!/^\d+(\.\d+)+$/.test(platformVersion ?? '')) {
    problems.push('release.platformVersion must be dotted digits');
  }
  if (!isHttpsUrl(detailsUrl))
    problems.push('release.detailsUrl must be an https URL without credentials');
  return problems;
}

/**
 * Returns the descriptor when it matches the schema in docs/ota-updates.md, and throws
 * an Error listing every problem otherwise. Unknown and missing fields are both
 * problems: a typo must fail the deploy instead of quietly serving nothing.
 */
export function validateDescriptor(descriptor) {
  if (!isPlainObject(descriptor)) throw new Error('invalid release descriptor: not an object');
  const problems = unexpectedKeys(descriptor, DESCRIPTOR_KEYS, 'descriptor');
  if (typeof descriptor.serving !== 'boolean')
    problems.push('descriptor.serving must be true or false');
  for (const [key, expected] of [
    ['product', PRODUCT],
    ['target', TARGET],
    ['channel', CHANNEL],
  ]) {
    if (descriptor[key] !== expected)
      problems.push(`descriptor.${key} must be ${JSON.stringify(expected)}`);
  }
  if (descriptor.release != null) problems.push(...releaseProblems(descriptor.release));
  if (descriptor.serving === true && !descriptor.release) {
    problems.push('descriptor.serving is true but there is no release to serve');
  }
  if (problems.length > 0) {
    throw new Error(`invalid release descriptor:\n- ${problems.join('\n- ')}`);
  }
  return descriptor;
}
