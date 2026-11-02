// Wrangler's entry module for the production environment (`main` in wrangler.toml).
// See entry-test.mjs for why each environment has its own.

import descriptor from './releases/production.json' with { type: 'json' };

import { createWorker } from './worker.mjs';

export default createWorker(descriptor);
