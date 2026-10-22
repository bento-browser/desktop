import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanelMarkerSync } from './PanelMarkerSync';
import { planPanelRestore } from './PanelRestore';
import { PanelStore } from './PanelStore';
import { readPanelMarker, setPanelMarker } from './SessionMarker';

const entries = [
  { panelKey: 'panel-0', url: 'https://top.example/' },
  { panelKey: 'panel-1', url: 'https://bottom.example/' },
];
// A top and a bottom panel in one vertical subdivision.
const initialLayout = {
  root: [
    {
      kind: 'group',
      id: 'split',
      axis: 'vertical',
      ratio: 0.5,
      children: [
        { kind: 'panel', panelKey: 'panel-0' },
        { kind: 'panel', panelKey: 'panel-1' },
      ],
    },
  ],
};
const TOP = 10;
const BOTTOM = 20;

type StoredPanels = { byWorkspace: Record<string, { entries: unknown; panelLayout: unknown }> };

describe('panel marker keys', () => {
  let storage: Record<string, unknown>;
  let tabValues: Map<string, unknown>;
  /** The address a panel reports: a blank page while it restores, or its real page. */
  let tabUrl: (tabId: number) => string;
  const blank = () => 'about:blank';
  const readable = (tabId: number) => (tabId === TOP ? entries[0]!.url : entries[1]!.url);

  beforeEach(() => {
    storage = {
      // An inactive workspace with a subdivision: a top and a bottom panel.
      'bento.panels': {
        version: 5,
        byWorkspace: {
          ws: {
            entries,
            panelLayout: initialLayout,
          },
        },
        mainWidthByWorkspace: {},
      },
    };
    tabValues = new Map();
    tabUrl = blank;
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) =>
            Object.fromEntries(
              [keys].flat().flatMap((key) => (key in storage ? [[key, storage[key]]] : [])),
            ),
          ),
          set: vi.fn(
            async (values: Record<string, unknown>) => void Object.assign(storage, values),
          ),
          remove: vi.fn(async () => undefined),
        },
      },
      sessions: {
        getTabValue: vi.fn(async (id: number, key: string) => tabValues.get(`${id}:${key}`)),
        setTabValue: vi.fn(async (id: number, key: string, value: unknown) => {
          tabValues.set(`${id}:${key}`, value);
        }),
        removeTabValue: vi.fn(async (id: number, key: string) => {
          tabValues.delete(`${id}:${key}`);
        }),
      },
      tabs: { get: vi.fn(async (id: number) => ({ id, url: tabUrl(id) })) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function markPanels(): Promise<void> {
    await setPanelMarker(TOP, 'ws', {
      rootIndex: 0,
      containingRootNodeId: 'split',
      panelKey: 'panel-0',
    });
    await setPanelMarker(BOTTOM, 'ws', {
      rootIndex: 0,
      containingRootNodeId: 'split',
      panelKey: 'panel-1',
    });
  }

  /** A browser start in which the workspace stays inactive, so its entries are never applied. */
  async function startWithInactiveWorkspace() {
    const panels = new PanelStore();
    await panels.init();
    const markerSync = createPanelMarkerSync(panels);
    for (const tabId of [TOP, BOTTOM]) {
      const marker = (await readPanelMarker(tabId))!;
      markerSync.captureKey(tabId, marker);
      panels.insertAtRestoreLocation('ws', tabId, marker);
    }
    markerSync.sync('ws');
    await panels.persistCurrentState();
    return { panels, markerSync };
  }

  async function boundTabs(panels: PanelStore): Promise<number[]> {
    const markers = await Promise.all([TOP, BOTTOM].map((tabId) => readPanelMarker(tabId)));
    const plan = planPanelRestore(
      panels.peekAllPersistedEntries().get('ws')!,
      [{ id: TOP }, { id: BOTTOM }],
      [TOP, BOTTOM].map((tabId, index) => ({ tabId, panelKey: markers[index]!.panelKey })),
    );
    return plan.map((step) => step.tabId!);
  }

  // The addresses matter: a flush writes a panel only when its address is readable, and a pinned
  // panel reports a blank page until SessionStore sets its saved address.
  it.each([
    ['blank', blank],
    ['readable', readable],
  ])(
    'keeps an inactive subdivided workspace bound to the right tabs through two restarts (%s addresses)',
    async (_name, urlOf) => {
      tabUrl = urlOf;
      await markPanels();

      const first = await startWithInactiveWorkspace();
      // Until the entries are applied the layout holds only the panels that came back, in marker
      // order: numbered from it, the bottom panel would be panel-0.
      expect(first.panels.getPanelKey('ws', BOTTOM)).toBe('panel-0');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await readPanelMarker(TOP))?.panelKey).toBe('panel-0');
      expect((await readPanelMarker(BOTTOM))?.panelKey).toBe('panel-1');

      const second = await startWithInactiveWorkspace();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The stored entries and layout are the ones the workspace had, not the temporary ones.
      expect(second.panels.peekAllPersistedEntries().get('ws')).toEqual(entries);
      expect((storage['bento.panels'] as StoredPanels).byWorkspace.ws).toEqual({
        entries,
        panelLayout: initialLayout,
      });
      // Top entry on the top tab, bottom entry on the bottom tab, after both restarts.
      expect(await boundTabs(second.panels)).toEqual([TOP, BOTTOM]);
    },
  );

  it('keeps the stored entries when the window of an inactive workspace closes', async () => {
    tabUrl = readable;
    await markPanels();
    const { panels } = await startWithInactiveWorkspace();

    // Both panels report their address, but the layout they sit in is the temporary one.
    expect(panels.parkWorkspaceWithResolvedUrls('ws', readable)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(panels.getPanels('ws')).toEqual([]);
    expect(panels.peekAllPersistedEntries().get('ws')).toEqual(entries);
    expect((storage['bento.panels'] as StoredPanels).byWorkspace.ws).toEqual({
      entries,
      panelLayout: initialLayout,
    });
  });

  it('drops the entry of a panel closed before its workspace was activated', async () => {
    tabUrl = readable;
    await markPanels();
    const { panels, markerSync } = await startWithInactiveWorkspace();

    // What the tab removal does: the tab leaves the live layout and the browser event arrives.
    panels.remove('ws', TOP);
    markerSync.tabRemoved(TOP, { isWindowClosing: false });
    await panels.persistCurrentState();

    // Only the bottom entry is left, with its key and its layout node as they were.
    expect(panels.peekAllPersistedEntries().get('ws')).toEqual([entries[1]]);
    expect((storage['bento.panels'] as StoredPanels).byWorkspace.ws).toEqual({
      entries: [entries[1]],
      panelLayout: { root: [{ kind: 'panel', panelKey: 'panel-1' }] },
    });
    expect(markerSync.capturedKey(TOP)).toBeUndefined();
    // Activating the workspace binds it to the tab that is still open and opens nothing.
    const plan = planPanelRestore(
      panels.peekAllPersistedEntries().get('ws')!,
      [{ id: BOTTOM }],
      [{ tabId: BOTTOM, panelKey: markerSync.capturedKey(BOTTOM) }],
    );
    expect(plan.map((step) => step.tabId)).toEqual([BOTTOM]);

    // With its last entry gone the workspace has nothing to apply.
    panels.remove('ws', BOTTOM);
    markerSync.tabRemoved(BOTTOM, { isWindowClosing: false });
    await panels.persistCurrentState();
    expect(panels.workspacesWithPersistedUrls()).toEqual([]);
    expect((storage['bento.panels'] as StoredPanels).byWorkspace.ws).toBeUndefined();
  });

  it('keeps the entry of a panel whose window closes', async () => {
    tabUrl = readable;
    await markPanels();
    const { panels, markerSync } = await startWithInactiveWorkspace();

    // The window parks its workspace, then each of its tabs is removed with it.
    panels.parkWorkspaceWithResolvedUrls('ws', readable);
    markerSync.tabRemoved(TOP, { isWindowClosing: true });
    markerSync.tabRemoved(BOTTOM, { isWindowClosing: true });
    await panels.persistCurrentState();

    expect(panels.peekAllPersistedEntries().get('ws')).toEqual(entries);
    expect((storage['bento.panels'] as StoredPanels).byWorkspace.ws).toEqual({
      entries,
      panelLayout: initialLayout,
    });
    expect(markerSync.capturedKey(TOP)).toBeUndefined();
  });

  it('writes the keys of the applied layout once the entries are bound', async () => {
    await markPanels();
    const { panels, markerSync } = await startWithInactiveWorkspace();

    // What restorePanelsForWorkspace does: bind by the captured keys, apply the layout, sync.
    const persisted = panels.takePersistedWorkspace('ws')!;
    const plan = planPanelRestore(
      persisted.entries,
      [{ id: TOP }, { id: BOTTOM }],
      [TOP, BOTTOM].map((tabId) => ({ tabId, panelKey: markerSync.capturedKey(tabId) })),
    );
    panels.restorePersistedLayout(
      'ws',
      persisted.layout,
      new Map(plan.map((step) => [step.entry.panelKey, step.tabId!])),
    );
    markerSync.releaseKeys([TOP, BOTTOM]);
    markerSync.sync('ws');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(plan.map((step) => step.tabId)).toEqual([TOP, BOTTOM]);
    expect(panels.getPanelKey('ws', TOP)).toBe('panel-0');
    expect((await readPanelMarker(TOP))?.panelKey).toBe('panel-0');
    expect((await readPanelMarker(BOTTOM))?.panelKey).toBe('panel-1');
  });

  it('still rewrites the markers of a workspace with nothing left to apply', async () => {
    const panels = new PanelStore();
    await panels.init();
    panels.add('other', 5);
    panels.add('other', 6);

    createPanelMarkerSync(panels).sync('other');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await readPanelMarker(5))?.panelKey).toBe(panels.getPanelKey('other', 5));
    expect((await readPanelMarker(6))?.panelKey).toBe(panels.getPanelKey('other', 6));
  });

  it('keeps the first key read for a tab and ignores workspaces with nothing to apply', async () => {
    const panels = new PanelStore();
    await panels.init();
    const markerSync = createPanelMarkerSync(panels);

    markerSync.captureKey(TOP, { workspaceId: 'ws', rootIndex: 0, panelKey: 'panel-0' });
    // A later read finds a marker some sync has since rewritten.
    markerSync.captureKey(TOP, { workspaceId: 'ws', rootIndex: 0, panelKey: 'panel-1' });
    markerSync.captureKey(BOTTOM, { workspaceId: 'ws', rootIndex: 0 });
    markerSync.captureKey(30, { workspaceId: 'applied', rootIndex: 0, panelKey: 'panel-0' });

    expect(markerSync.capturedKey(TOP)).toBe('panel-0');
    expect(markerSync.capturedKey(BOTTOM)).toBeUndefined();
    expect(markerSync.capturedKey(30)).toBeUndefined();

    markerSync.releaseKeys([TOP]);
    expect(markerSync.capturedKey(TOP)).toBeUndefined();
  });
});

describe('panel markers of a private window', () => {
  it('writes none for the Private workspace', () => {
    const getVisiblePanelIds = vi.fn(() => [10]);
    const markers = createPanelMarkerSync({
      getVisiblePanelIds,
      isDevtoolsPanel: vi.fn(() => false),
      getPanelRestoreLocation: vi.fn(),
      getPanelKey: vi.fn(),
      workspacesWithPersistedUrls: vi.fn(() => []),
      dropPersistedPanel: vi.fn(),
    } as unknown as Parameters<typeof createPanelMarkerSync>[0]);

    markers.sync('private:abc');

    expect(getVisiblePanelIds).not.toHaveBeenCalled();
  });
});
