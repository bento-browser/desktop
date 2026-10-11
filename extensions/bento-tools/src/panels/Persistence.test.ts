import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPanel,
  emptyLayout,
  fillChooser,
  subdividePanel,
  type WorkspacePanelLayout,
} from './PanelLayout';
import { load, Persistence } from './Persistence';
import type { PersistedWorkspacePanels } from './PanelStore';

const STORAGE_KEY = 'bento.panels';

describe('panel Persistence headerHidden', () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, storage[key]])),
          ),
          set: vi.fn(async (payload: Record<string, unknown>) => {
            Object.assign(storage, payload);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: `https://${tabId}.example.test/`,
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips headerHidden on live and parked workspace entries', async () => {
    const liveLayout = emptyLayout();
    addPanel(liveLayout, 101);

    const parked: PersistedWorkspacePanels = {
      entries: [
        {
          panelKey: 'parked-panel',
          url: 'https://parked.example.test/',
          headerHidden: true,
        },
      ],
      layout: { root: [{ kind: 'panel', panelKey: 'parked-panel' }] },
    };

    const persistence = new Persistence();
    persistence.flushNow(
      new Map([['live-ws', liveLayout]]),
      new Map([['parked-ws', parked]]),
      new Map(),
      new Map([[101, true]]),
      new Map(),
      new Map(),
    );

    await vi.waitFor(() => expect(storage[STORAGE_KEY]).toBeTruthy());

    const loaded = await load();

    expect(loaded?.byWorkspace.get('live-ws')?.entries).toEqual([
      {
        panelKey: 'panel-0',
        url: 'https://101.example.test/',
        headerHidden: true,
      },
    ]);
    expect(loaded?.byWorkspace.get('parked-ws')?.entries).toEqual([
      {
        panelKey: 'parked-panel',
        url: 'https://parked.example.test/',
        headerHidden: true,
      },
    ]);
  });

  it('loads headerHidden only when the stored value is true', async () => {
    storage[STORAGE_KEY] = {
      version: 5,
      mainWidthByWorkspace: {},
      byWorkspace: {
        ws: {
          entries: [
            { panelKey: 'a', url: 'https://a.example.test/' },
            { panelKey: 'b', url: 'https://b.example.test/', headerHidden: false },
            { panelKey: 'c', url: 'https://c.example.test/', headerHidden: 'yes' },
            { panelKey: 'd', url: 'https://d.example.test/', headerHidden: true },
          ],
          panelLayout: {
            root: [
              { kind: 'panel', panelKey: 'a' },
              { kind: 'panel', panelKey: 'b' },
              { kind: 'panel', panelKey: 'c' },
              { kind: 'panel', panelKey: 'd' },
            ],
          },
        },
      },
    };

    const loaded = await load();

    expect(loaded?.byWorkspace.get('ws')?.entries).toEqual([
      { panelKey: 'a', url: 'https://a.example.test/' },
      { panelKey: 'b', url: 'https://b.example.test/' },
      { panelKey: 'c', url: 'https://c.example.test/' },
      { panelKey: 'd', url: 'https://d.example.test/', headerHidden: true },
    ]);
  });
});

describe('panel Persistence write ordering', () => {
  let storage: Record<string, unknown>;
  let setMock: ReturnType<typeof vi.fn>;
  const slowReads = new Map<number, Promise<void>>();

  /** Tab 101 reports the "old" URL; every other tab id reports its own. */
  const urlFor = (tabId: number) =>
    tabId === 101 ? 'https://old.example.test/' : `https://${tabId}.example.test/`;

  const snapshot = (
    tabId: number,
    stripScroll = new Map<string, number>(),
  ): Parameters<Persistence['flushNow']> => {
    const layout = emptyLayout();
    addPanel(layout, tabId);
    return [new Map([['ws', layout]]), new Map(), new Map(), new Map(), new Map(), stripScroll];
  };

  const storedUrl = async () => (await load())?.byWorkspace.get('ws')?.entries[0]?.url;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    storage = {};
    slowReads.clear();
    setMock = vi.fn(async (payload: Record<string, unknown>) => {
      Object.assign(storage, payload);
    });
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, storage[key]])),
          ),
          set: setMock,
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => {
          await slowReads.get(tabId);
          return { id: tabId, url: urlFor(tabId) };
        }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never lets an older flush land after a newer one', async () => {
    let releaseOld!: () => void;
    slowReads.set(
      101,
      new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
    );
    const persistence = new Persistence();

    // The older flush carries a strip-scroll record the newer one drops.
    const older = persistence.flushNow(...snapshot(101, new Map([['ws', 40]])));
    const newer = persistence.flushNow(...snapshot(102));
    await settle();
    releaseOld();
    await Promise.all([older, newer]);

    expect(await storedUrl()).toBe(urlFor(102));
    expect(storage['bento.panelStripScroll']).toBeUndefined();
  });

  it('writes only the newest request queued behind an in-flight write', async () => {
    let releaseFirst!: () => void;
    slowReads.set(
      101,
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const persistence = new Persistence();

    const first = persistence.flushNow(...snapshot(101));
    const superseded = persistence.flushNow(...snapshot(102));
    const newest = persistence.flushNow(...snapshot(103));
    releaseFirst();
    await superseded;

    // A superseded caller resolves only once the write that replaced it has landed.
    expect(await storedUrl()).toBe(urlFor(103));
    await Promise.all([first, newest]);
    expect(setMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(browser.tabs.get)).not.toHaveBeenCalledWith(102);
  });

  it('keeps writing after a flush throws', async () => {
    const broken = new Map<string, WorkspacePanelLayout>();
    broken[Symbol.iterator] = () => {
      throw new Error('corrupt layout');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const persistence = new Persistence();

    await persistence.flushNow(broken, new Map(), new Map(), new Map(), new Map(), new Map());
    await persistence.flushNow(...snapshot(102));

    expect(errors).toHaveBeenCalled();
    expect(await storedUrl()).toBe(urlFor(102));
    errors.mockRestore();
  });

  it('coalesces a burst of scheduled saves into one trailing write of the latest state', async () => {
    vi.useFakeTimers();
    const persistence = new Persistence();

    for (const tabId of [102, 103, 104]) {
      persistence.schedule(...snapshot(tabId));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(setMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(await storedUrl()).toBe(urlFor(104));
  });

  it('lets an immediate flush replace a pending scheduled save', async () => {
    vi.useFakeTimers();
    const persistence = new Persistence();

    persistence.schedule(...snapshot(102));
    await persistence.flushNow(...snapshot(103));
    await vi.advanceTimersByTimeAsync(1000);

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(await storedUrl()).toBe(urlFor(103));
  });
});

describe('panel Persistence private tabs', () => {
  let storage: Record<string, unknown>;
  const privateTabIds = new Set<number>();

  const flush = (layout: WorkspacePanelLayout) =>
    new Persistence().flushNow(
      new Map([['ws', layout]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

  beforeEach(() => {
    storage = {};
    privateTabIds.clear();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, storage[key]])),
          ),
          set: vi.fn(async (payload: Record<string, unknown>) => {
            Object.assign(storage, payload);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: privateTabIds.has(tabId)
            ? `https://private-${tabId}.example.test/secret`
            : `https://${tabId}.example.test/`,
          incognito: privateTabIds.has(tabId),
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits a private panel from entries and layout while keeping regular ones', async () => {
    privateTabIds.add(201);
    const layout = emptyLayout();
    addPanel(layout, 201);
    addPanel(layout, 202);

    await flush(layout);

    expect(JSON.stringify(storage)).not.toContain('private-201');
    const loaded = (await load())?.byWorkspace.get('ws');
    expect(loaded?.entries).toEqual([{ panelKey: 'panel-1', url: 'https://202.example.test/' }]);
    expect(loaded?.layout.root).toEqual([{ kind: 'panel', panelKey: 'panel-1' }]);
  });

  it('stores nothing for a workspace whose panels are all private', async () => {
    privateTabIds.add(201);
    const layout = emptyLayout();
    addPanel(layout, 201);

    await flush(layout);

    expect(JSON.stringify(storage)).not.toContain('private-201');
    expect((await load())?.byWorkspace.has('ws')).toBe(false);
  });

  it('omits a whole group that contains a private panel', async () => {
    privateTabIds.add(2);
    const layout = emptyLayout();
    addPanel(layout, 1);
    subdividePanel(layout, 1, { groupId: 'group-1', chooserId: 'chooser-1' });
    fillChooser(layout, 'chooser-1', 'single', [2], {});

    await flush(layout);

    expect(JSON.stringify(storage)).not.toContain('private-2');
    expect((await load())?.byWorkspace.get('ws')?.layout.root ?? []).toEqual([]);
  });
});
