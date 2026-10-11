import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Persistence } from './Persistence';

const STORAGE_KEY = 'bento.pinnedPanels';

const state = (...urls: string[]) => ({
  entries: urls.map((url, order) => ({ workspaceId: 'ws', url, order })),
});

describe('pinned-panel Persistence', () => {
  let storage: Record<string, unknown>;
  let writes: string[][];
  let inFlight: number;
  let maxInFlight: number;
  let releaseFirstSet: (() => void) | undefined;

  beforeEach(() => {
    storage = {};
    writes = [];
    inFlight = 0;
    maxInFlight = 0;
    releaseFirstSet = undefined;
    let firstSet = true;
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (payload: Record<string, unknown>) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (firstSet && STORAGE_KEY in payload) {
              firstSet = false;
              await new Promise<void>((resolve) => (releaseFirstSet = resolve));
            }
            Object.assign(storage, payload);
            if (STORAGE_KEY in payload) {
              const stored = payload[STORAGE_KEY] as { entries: Array<{ url: string }> };
              writes.push(stored.entries.map((entry) => entry.url));
            }
            inFlight--;
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes one at a time and collapses queued states to the newest', async () => {
    const persistence = new Persistence();

    const first = persistence.flushNow(state('a'));
    await vi.waitFor(() => expect(releaseFirstSet).toBeDefined());
    const skipped = persistence.flushNow(state('a', 'b'));
    const newest = persistence.flushNow(state('a', 'b', 'c'));
    releaseFirstSet?.();
    await Promise.all([first, skipped, newest]);

    expect(maxInFlight).toBe(1);
    expect(writes).toEqual([['a'], ['a', 'b', 'c']]);
  });
});
