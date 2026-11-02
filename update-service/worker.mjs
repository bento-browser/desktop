// Bento update metadata service. Answers Firefox's stock update URL
//   /update/6/%PRODUCT%/%VERSION%/%BUILD_ID%/%BUILD_TARGET%/%LOCALE%/%CHANNEL%/
//   %OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml
// from one release descriptor (see descriptor.mjs and docs/ota-updates.md).
//
// The client reads the answer like this: a well-formed <updates/> is "no update",
// while a non-XML body or error status is a failed check that the user can see.
// So every valid request gets 200 XML, and only a request that is not an update
// check at all gets a plain-text 400.

import { compareVersions, parseVersion, validateDescriptor } from './descriptor.mjs';

const URL_FIELDS = [
  'product',
  'version',
  'buildId',
  'target',
  'locale',
  'channel',
  'osVersion',
  'systemCapabilities',
  'distribution',
  'distributionVersion',
];

const NO_UPDATE = '<?xml version="1.0"?>\n<updates/>\n';

function lenientDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// OS_VERSION is encoded twice by the client, so a field may be neither valid nor
// worth decoding strictly. Only the structure of the path decides a 400.
function parseUpdatePath(pathname) {
  const parts = pathname.split('/');
  const fieldCount = URL_FIELDS.length;
  if (
    parts.length !== fieldCount + 4 ||
    parts[0] !== '' ||
    parts[1] !== 'update' ||
    parts[2] !== '6' ||
    parts[fieldCount + 3] !== 'update.xml'
  ) {
    return null;
  }
  const values = parts.slice(3, fieldCount + 3);
  if (values.includes('')) return null;
  return Object.fromEntries(URL_FIELDS.map((field, i) => [field, lenientDecode(values[i])]));
}

function xmlEscape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character],
  );
}

function offerXml(release, clientVersion) {
  const offered = parseVersion(release.version);
  const type = offered[0] > clientVersion[0] ? 'major' : 'minor';
  const version = xmlEscape(release.version);
  return `<?xml version="1.0"?>
<updates>
  <update type="${type}" displayVersion="${version}" appVersion="${version}" platformVersion="${xmlEscape(release.platformVersion)}" buildID="${xmlEscape(release.buildId)}" detailsURL="${xmlEscape(release.detailsUrl)}">
    <patch type="complete" URL="${xmlEscape(release.marUrl)}" size="${xmlEscape(release.size)}" hashFunction="sha512" hashValue="${xmlEscape(release.sha512)}"/>
  </update>
</updates>
`;
}

function respond(status, body, contentType, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

const xml = (body) => respond(200, body, 'text/xml; charset=utf-8');
const text = (status, body, headers) => respond(status, body, 'text/plain; charset=utf-8', headers);

/**
 * The response for an update check at `url` against a release descriptor. The query
 * string is ignored (foreground checks add `force=1`). The release is offered only
 * when the descriptor is serving and its version is strictly higher than the client's;
 * the client's BuildID does not matter because versions are never republished.
 */
export function selectResponse(url, descriptor) {
  const request = parseUpdatePath(new URL(url).pathname);
  if (!request) return text(400, 'Not a Bento update check.\n');

  const { serving, release } = descriptor;
  if (
    !serving ||
    !release ||
    request.product !== descriptor.product ||
    request.target !== descriptor.target ||
    request.channel !== descriptor.channel
  ) {
    return xml(NO_UPDATE);
  }
  const clientVersion = parseVersion(request.version);
  const offered = parseVersion(release.version);
  if (!clientVersion || !offered || compareVersions(offered, clientVersion) <= 0) {
    return xml(NO_UPDATE);
  }
  return xml(offerXml(release, clientVersion));
}

/** The Worker's fetch logic: update checks are GET, and HEAD gets the same headers without a body. */
export function handleRequest(request, descriptor) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
  }
  const response = selectResponse(request.url, descriptor);
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

/**
 * The Worker module for one environment's descriptor. Validating here, when the module
 * loads, makes an invalid descriptor fail the deploy and not the first request.
 */
export function createWorker(descriptor) {
  const validated = validateDescriptor(descriptor);
  return { fetch: (request) => handleRequest(request, validated) };
}
