// Wrangler's entry module. `release-descriptor` is aliased per environment to
// releases/<env>.json in wrangler.toml, so each deploy bundles its own descriptor.
// Validating at load makes an invalid descriptor fail the deploy, not the first request.

import descriptor from 'release-descriptor';

import { validateDescriptor } from './descriptor.mjs';
import { handleRequest } from './worker.mjs';

const release = validateDescriptor(descriptor);

export default {
  fetch: (request) => handleRequest(request, release),
};
