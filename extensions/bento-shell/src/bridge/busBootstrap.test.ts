// Message-count tests for the shell bus bootstrap. The real shell background
// and N real useToolsPort document instances talk over an in-memory
// BroadcastChannel; a fake bento-tools answers snapshot requests exactly like
// protocol-handler.ts does (one full snapshot per request, sent to every
// document). Counts are deterministic because the fake bus delivers in FIFO
// order and the fake tools replies synchronously.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, BentoSettings, Event } from '@shared/protocol';
import { installFakeChromeTitle } from './fakeChromeTitle';

const DOCUMENTS = 11;
/** tabs, workspaces, settings, pinnedPanels, tabFolders, savedPanels. */
const SNAPSHOTS_PER_DOCUMENT = 6;

type BusData =
  | { kind: 'event'; event: Event; replayFor?: string }
  | { kind: 'action'; action: Action }
  | { kind: 'hello'; helloId?: string };

interface Delivery {
  toBackground: boolean;
  data: BusData;
}

const bus = {
  channels: [] as FakeBroadcastChannel[],
  queue: [] as Array<{ to: FakeBroadcastChannel; data: BusData }>,
  deliveries: [] as Delivery[],
  /** Deliver queued messages until the bus is quiet (handlers may enqueue more). */
  drain(): void {
    for (let next = bus.queue.shift(); next; next = bus.queue.shift()) {
      const data = structuredClone(next.data);
      bus.deliveries.push({ toBackground: next.to === bus.channels[0], data });
      next.to.receive(data);
    }
  },
  reset(): void {
    bus.channels = [];
    bus.queue = [];
    bus.deliveries = [];
  },
};

class FakeBroadcastChannel {
  readonly #listeners = new Set<(message: { data: BusData }) => void>();

  constructor(readonly name: string) {
    bus.channels.push(this);
  }

  addEventListener(_type: 'message', listener: (message: { data: BusData }) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (message: { data: BusData }) => void): void {
    this.#listeners.delete(listener);
  }

  postMessage(data: BusData): void {
    for (const to of bus.channels) {
      if (to !== this && to.name === this.name) bus.queue.push({ to, data });
    }
  }

  close(): void {
    bus.channels = bus.channels.filter((channel) => channel !== this);
  }

  receive(data: BusData): void {
    for (const listener of this.#listeners) listener({ data });
  }
}

const WORKSPACE_IDS = ['ws-1', 'ws-2'];

function panelsSync(workspaceId: string, tabId = 1): Event {
  return {
    type: 'panels/sync',
    workspaceId,
    panels: [{ tabId, url: 'https://example.com' }],
    layout: { root: [] },
    panelStatusByTabId: {},
  };
}

/** Stands in for bento-tools on the shell background's port. */
function createFakeTools() {
  const listeners = new Set<(message: object) => void>();
  const requests: string[] = [];
  let workspaceIds = [...WORKSPACE_IDS];
  let activeId: string | null | undefined;
  let settings = {} as BentoSettings;
  const activeIdByWindow: Record<number, string> = {};

  const emit = (event: Event) => {
    for (const listener of listeners) listener(event);
    bus.drain();
  };

  const snapshots = {
    'tabs/requestSnapshot': (): Event => ({
      type: 'tabs/snapshot',
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          title: 'One',
          active: true,
          pinned: false,
          audible: false,
          muted: false,
        },
      ],
    }),
    'workspaces/requestSnapshot': (): Event => ({
      type: 'workspaces/snapshot',
      workspaces: workspaceIds.map((id, index) => ({ id, name: id, createdAt: index })),
      activeId: activeId === undefined ? (workspaceIds[0] ?? null) : activeId,
      activeIdByWindow: { ...activeIdByWindow },
    }),
    'settings/requestSnapshot': (): Event => ({
      type: 'settings/snapshot',
      settings,
    }),
    'pinnedPanels/requestSnapshot': (): Event => ({ type: 'pinnedPanels/snapshot', entries: [] }),
    'tabFolders/requestSnapshot': (): Event => ({ type: 'tabFolders/snapshot', folders: [] }),
    'savedPanels/requestSnapshot': (): Event => ({ type: 'savedPanels/snapshot', items: [] }),
  } satisfies Partial<Record<Action['type'], () => Event>>;

  const port = {
    onMessage: { addListener: (listener: (message: object) => void) => listeners.add(listener) },
    onDisconnect: { addListener: () => {} },
    postMessage: (action: Action) => {
      requests.push(action.type);
      const reply = snapshots[action.type as keyof typeof snapshots];
      if (reply) emit(reply());
    },
  };

  return {
    port,
    requests,
    /** What bento-tools sends when the shell background's port connects. */
    boot(): void {
      emit({ type: 'tools/booted', version: '0.0.0' });
      for (const reply of Object.values(snapshots)) emit(reply());
      for (const id of workspaceIds) emit(panelsSync(id));
    },
    emit,
    removeWorkspace(id: string): void {
      workspaceIds = workspaceIds.filter((candidate) => candidate !== id);
    },
    /** Gives a window its own active workspace in every later snapshot. */
    assignWindow(windowId: number, workspaceId: string): void {
      activeIdByWindow[windowId] = workspaceId;
    },
    /** Replaces the settings every later snapshot carries. */
    setSettings(next: BentoSettings): void {
      settings = next;
    },
    /** Overrides the global fallback workspace (default: the first one). */
    setGlobalActive(workspaceId: string | null): void {
      activeId = workspaceId;
    },
  };
}

/** Joins as the sidebar (title bridge on) when given the window it lives in. */
async function joinDocument({ sidebarWindowId }: { sidebarWindowId?: number } = {}) {
  vi.resetModules();
  vi.stubGlobal('location', {
    hash: sidebarWindowId === undefined ? '' : `#bentoWindowId=${sidebarWindowId}`,
  });
  const { initToolsPort, enableSidePanelTitleBridge } = await import('./useToolsPort');
  const { useTabsStore } = await import('../state/tabs');
  const { usePanelsStore } = await import('../state/panels');
  const applied = { panels: 0 };
  usePanelsStore.subscribe(() => (applied.panels += 1));
  initToolsPort();
  if (sidebarWindowId !== undefined) enableSidePanelTitleBridge();
  bus.drain();
  return { useTabsStore, usePanelsStore, applied };
}

function snapshotDeliveriesToDocuments(): number {
  return bus.deliveries.filter(
    ({ toBackground, data }) =>
      !toBackground && data.kind === 'event' && data.event.type.endsWith('/snapshot'),
  ).length;
}

describe('shell bus bootstrap', () => {
  let tools: ReturnType<typeof createFakeTools>;

  beforeEach(async () => {
    bus.reset();
    tools = createFakeTools();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    // The extension build defines this flag; here the dev build's value.
    vi.stubGlobal('__BENTO_DEV_RELOAD__', true);
    vi.stubGlobal('browser', {
      runtime: { connect: () => tools.port },
      commands: { onCommand: { addListener: () => {} } },
      bentoChrome: {
        bindBackground: async () => ({ currentGeneration: 0 }),
        listDocuments: async () => [],
        onDocumentMounted: { addListener: () => {} },
        onDocumentChanged: { addListener: () => {} },
        onDocumentRemoved: { addListener: () => {} },
      },
    });
    vi.resetModules();
    // The background must be the first channel on the bus.
    await import('../background');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends each late-joining document one snapshot burst, not one per replay', async () => {
    tools.boot();
    tools.requests.length = 0;
    bus.deliveries.length = 0;

    const documents = [];
    for (let i = 0; i < DOCUMENTS; i += 1) documents.push(await joinDocument());

    for (const document of documents) {
      expect(document.useTabsStore.getState().hydrated).toBe(true);
    }
    expect(tools.requests).toHaveLength(DOCUMENTS * SNAPSHOTS_PER_DOCUMENT);
    // Each reply is still broadcast to every document present at that moment.
    expect(snapshotDeliveriesToDocuments()).toBe(
      SNAPSHOTS_PER_DOCUMENT * ((DOCUMENTS * (DOCUMENTS + 1)) / 2),
    );
  });

  it('needs no snapshot requests for documents that were listening when tools booted', async () => {
    const documents = [];
    for (let i = 0; i < DOCUMENTS; i += 1) documents.push(await joinDocument());
    expect(tools.requests).toHaveLength(0);

    tools.boot();

    for (const document of documents) {
      expect(document.useTabsStore.getState().hydrated).toBe(true);
    }
    expect(tools.requests).toHaveLength(0);
  });

  it('replays cached panels to the joining document only', async () => {
    tools.boot();

    const first = await joinDocument();
    expect(first.applied.panels).toBe(WORKSPACE_IDS.length);

    await joinDocument();
    await joinDocument();

    expect(first.applied.panels).toBe(WORKSPACE_IDS.length);
  });

  describe('replay cache pruning', () => {
    beforeEach(() => tools.boot());

    it('drops a workspace after its removal delta', async () => {
      tools.emit({ type: 'workspaces/changed', deltas: [{ kind: 'removed', id: 'ws-2' }] });

      const joiner = await joinDocument();

      expect([...joiner.usePanelsStore.getState().byWorkspace.keys()]).toEqual(['ws-1']);
    });

    it('drops workspaces missing from an authoritative snapshot', async () => {
      tools.removeWorkspace('ws-2');
      tools.emit({
        type: 'workspaces/snapshot',
        workspaces: [{ id: 'ws-1', name: 'ws-1', createdAt: 0 }],
        activeId: 'ws-1',
        activeIdByWindow: {},
      });

      const joiner = await joinDocument();

      expect([...joiner.usePanelsStore.getState().byWorkspace.keys()]).toEqual(['ws-1']);
    });
  });

  describe('sidebar forwarding of panels to chrome', () => {
    const WINDOW_ID = 7;
    /** Every settings field the chrome BENTO_PANELS consumer reads
     * (handlePanelsTitle in bento-shell-mount.js), with non-default values. */
    const CHROME_SETTINGS = {
      uiColorMode: 'dark',
      sidebarCollapsed: true,
      sidebarHidden: true,
      sidebarShortcutBehavior: 'hide',
      defaultPanelWidthPx: 555,
      customPanelSizes: [333, 444],
      panelCycleWraparound: true,
      panelShadowsEnabled: false,
      panelCornerRadiusPx: 9,
      panelSplitterSizePx: 5,
    } satisfies Partial<BentoSettings>;
    const persistedSettings = CHROME_SETTINGS as BentoSettings;
    type ChromePanels = {
      workspaceId: string;
      windowId?: number;
      panels: unknown[];
    } & Partial<typeof CHROME_SETTINGS>;
    let chromeTitle: ReturnType<typeof installFakeChromeTitle>;

    /** Every BENTO_PANELS title chrome observed from the sidebar, decoded. */
    function chromePanels(): ChromePanels[] {
      chromeTitle.settle();
      return chromeTitle.observed
        .filter((title) => title.startsWith('BENTO_PANELS:'))
        .map((title) =>
          JSON.parse(Buffer.from(title.split(':')[2] ?? '', 'base64').toString('utf8')),
        );
    }

    beforeEach(() => {
      chromeTitle = installFakeChromeTitle({ documentElement: { getAttribute: () => null } });
    });

    it('forwards the active workspace with settings to a late sidebar whose cached panels arrive first', async () => {
      tools.assignWindow(WINDOW_ID, 'ws-2');
      tools.setSettings(persistedSettings);
      tools.boot();

      await joinDocument({ sidebarWindowId: WINDOW_ID });

      expect(new Set(chromePanels().map(({ workspaceId }) => workspaceId))).toEqual(
        new Set(['ws-2']),
      );
      expect(chromePanels().at(-1)).toMatchObject({
        windowId: WINDOW_ID,
        panels: [{ tabId: 1 }],
        ...CHROME_SETTINGS,
      });
    });

    it('forwards a held replay when the window is assigned a workspace afterwards', async () => {
      tools.setGlobalActive(null);
      tools.boot();

      await joinDocument({ sidebarWindowId: WINDOW_ID });
      expect(chromePanels()).toEqual([]);

      tools.emit({
        type: 'workspaces/changed',
        deltas: [{ kind: 'activated', id: 'ws-2', windowId: WINDOW_ID }],
      });

      expect(chromePanels().map(({ workspaceId }) => workspaceId)).toEqual(['ws-2']);
    });

    it('forwards a live boot once, without a held duplicate', async () => {
      tools.assignWindow(WINDOW_ID, 'ws-2');
      await joinDocument({ sidebarWindowId: WINDOW_ID });

      tools.boot();

      expect(chromePanels().map(({ workspaceId }) => workspaceId)).toEqual(['ws-2']);
    });

    // A late sidebar in an assigned window can see these three arrive in any
    // order: bento-tools sends them as separate events and the replayed
    // panels race the snapshots.
    it.each([
      ['panels', 'workspace', 'settings'],
      ['panels', 'settings', 'workspace'],
      ['workspace', 'panels', 'settings'],
      ['workspace', 'settings', 'panels'],
      ['settings', 'panels', 'workspace'],
      ['settings', 'workspace', 'panels'],
    ] as const)('converges on the active workspace and settings: %s, %s, %s', async (...order) => {
      const arrivals: Record<(typeof order)[number], Event[]> = {
        panels: [panelsSync('ws-1', 1), panelsSync('ws-2', 2)],
        workspace: [
          {
            type: 'workspaces/snapshot',
            workspaces: WORKSPACE_IDS.map((id, index) => ({ id, name: id, createdAt: index })),
            activeId: 'ws-1',
            activeIdByWindow: { [WINDOW_ID]: 'ws-2' },
          },
        ],
        settings: [{ type: 'settings/snapshot', settings: persistedSettings }],
      };
      await joinDocument({ sidebarWindowId: WINDOW_ID });
      const sidebar = bus.channels.at(-1);
      if (!sidebar) throw new Error('sidebar did not connect');

      for (const step of order) {
        for (const event of arrivals[step]) {
          bus.queue.push({ to: sidebar, data: { kind: 'event', event } });
          bus.drain();
        }
      }

      const written = chromePanels();
      expect(written.length).toBeGreaterThan(0);
      expect(written.every(({ workspaceId }) => workspaceId === 'ws-2')).toBe(true);
      expect(written.at(-1)).toMatchObject({ panels: [{ tabId: 2 }], ...CHROME_SETTINGS });
      // A re-forward must carry something new, never repeat the last write.
      written.slice(1).forEach((write, i) => expect(write).not.toEqual(written[i]));
    });

    // Profile with the welcome flow not completed: the settings snapshot both
    // re-forwards the held panels and flips welcomeShouldShow. App.tsx's welcome
    // effect then runs after the handler, still in the same task, and its
    // BENTO_OPEN_WELCOME title used to replace the BENTO_PANELS one before chrome
    // could observe it, leaving chrome without panels and settings.
    it('delivers panels and settings when the first-run welcome request follows in the same task', async () => {
      await joinDocument({ sidebarWindowId: WINDOW_ID });
      const sidebar = bus.channels.at(-1);
      if (!sidebar) throw new Error('sidebar did not connect');
      const { useSettingsStore } = await import('../state/settings');
      const { startWelcomeRequests } = await import('./useWelcome');
      let welcomeStarted = false;
      useSettingsStore.subscribe((state) => {
        if (welcomeStarted || state.current === null || state.current.welcomeSeen) return;
        welcomeStarted = true;
        queueMicrotask(startWelcomeRequests);
      });
      const arrive = (event: Event) => {
        bus.queue.push({ to: sidebar, data: { kind: 'event', event } });
        bus.drain();
      };

      arrive(panelsSync('ws-2', 2));
      arrive({
        type: 'workspaces/snapshot',
        workspaces: WORKSPACE_IDS.map((id, index) => ({ id, name: id, createdAt: index })),
        activeId: 'ws-1',
        activeIdByWindow: { [WINDOW_ID]: 'ws-2' },
      });
      chromeTitle.settle();
      arrive({
        type: 'settings/snapshot',
        settings: { ...persistedSettings, welcomeSeen: false },
      });
      await Promise.resolve();

      expect(chromePanels().at(-1)).toMatchObject({ panels: [{ tabId: 2 }], ...CHROME_SETTINGS });
      expect(chromeTitle.observed.some((title) => title.startsWith('BENTO_OPEN_WELCOME_'))).toBe(
        true,
      );
    });
  });
});
