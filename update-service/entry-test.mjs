// Wrangler's entry module for the test environment (`main` in wrangler.toml). One
// module per environment, because wrangler reads `alias` only from the top level of the
// config and so cannot bundle a different descriptor per environment.

import descriptor from './releases/test.json' with { type: 'json' };

import { createWorker } from './worker.mjs';

export default createWorker(descriptor);
