// Message-count tests for the shell bus bootstrap. The real shell background
// and N real useToolsPort document instances talk over an in-memory
// BroadcastChannel; a fake bento-tools answers snapshot requests exactly like
// protocol-handler.ts does (one full snapshot per request, sent to every
// document). Counts are deterministic because the fake bus delivers in FIFO
// order and the fake tools replies synchronously.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, BentoSettings, Event } from '@shared/protocol';

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

function panelsSync(workspaceId: string): Event {
  return {
    type: 'panels/sync',
    workspaceId,
    panels: [{ tabId: 1, url: 'https://example.com' }],
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
      settings: {} as BentoSettings,
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
    /** Every BENTO_PANELS title the sidebar wrote, decoded. */
    let chromePanels: Array<{ workspaceId: string; windowId?: number; panels: unknown[] }>;

    beforeEach(() => {
      chromePanels = [];
      vi.stubGlobal('document', {
        documentElement: { getAttribute: () => null },
        set title(value: string) {
          const payload = value.split(':')[2] ?? '';
          chromePanels.push(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')));
        },
      });
    });

    it('forwards once for a late sidebar whose cached panels arrive before its workspace', async () => {
      tools.assignWindow(WINDOW_ID, 'ws-2');
      tools.boot();

      await joinDocument({ sidebarWindowId: WINDOW_ID });

      expect(chromePanels.map(({ workspaceId }) => workspaceId)).toEqual(['ws-2']);
      expect(chromePanels[0]).toMatchObject({ windowId: WINDOW_ID, panels: [{ tabId: 1 }] });
    });

    it('forwards a held replay when the window is assigned a workspace afterwards', async () => {
      tools.setGlobalActive(null);
      tools.boot();

      await joinDocument({ sidebarWindowId: WINDOW_ID });
      expect(chromePanels).toEqual([]);

      tools.emit({
        type: 'workspaces/changed',
        deltas: [{ kind: 'activated', id: 'ws-2', windowId: WINDOW_ID }],
      });

      expect(chromePanels.map(({ workspaceId }) => workspaceId)).toEqual(['ws-2']);
    });

    it('forwards a live boot once, without a held duplicate', async () => {
      tools.assignWindow(WINDOW_ID, 'ws-2');
      await joinDocument({ sidebarWindowId: WINDOW_ID });

      tools.boot();

      expect(chromePanels.map(({ workspaceId }) => workspaceId)).toEqual(['ws-2']);
    });
  });
});
