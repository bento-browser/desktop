// Message-count tests for the shell bus bootstrap. The real shell background
// and N real useToolsPort document instances talk over an in-memory
// BroadcastChannel; a fake bento-tools answers snapshot requests exactly like
// protocol-handler.ts does (one full snapshot per request, sent to every
// document). Counts are deterministic because the fake bus delivers in FIFO
// order and the fake tools replies synchronously.
//
// The fake channel is partitioned like Firefox's: a channel only reaches channels
// of the same partition ('regular' or 'private'), so a document in a private window
// cannot reach the background over it. Private documents use a fake of the
// BentoShellBus relay (actor and hub) instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, BentoSettings, Event } from '@shared/protocol';
import type { AudienceEvent } from '@shared/audience-event';
import { installFakeChromeTitle } from './fakeChromeTitle';

function audienceEvent(audience: AudienceEvent['audience'], event: Event): AudienceEvent {
  return { type: 'audience/event', audience, event };
}

/** Every shell document that calls initToolsPort(): sidebar, address bar, panel
 * trailer, workspace switcher, edit workspace, confirm, welcome, menu, workspace
 * palette, merge palette, palette, and the panel navigator tooltip. */
const DOCUMENTS = 12;
/** tabs, workspaces, settings, pinnedPanels, tabFolders, savedPanels. */
const SNAPSHOTS_PER_DOCUMENT = 6;

type BusData =
  | { kind: 'event'; event: Event; replayFor?: string }
  | { kind: 'action'; action: Action }
  | { kind: 'hello'; helloId?: string };

type Partition = 'regular' | 'private';

interface Delivery {
  toBackground: boolean;
  data: BusData;
}

const bus = {
  /** Partition new channels are created in (Firefox: privateBrowsingId). */
  partition: 'regular' as Partition,
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
    bus.partition = 'regular';
    bus.channels = [];
    bus.queue = [];
    bus.deliveries = [];
  },
};

/** Stands in for the BentoShellBus actor pair and parent-process hub. */
const relay = {
  listener: null as ((record: unknown) => void) | null,
  documents: new Map<string, { window: EventTarget; windowId: number }>(),
  /** False while the actor is not attached yet: upward messages are lost. */
  attached: true,
  /** Everything the hub delivered down to a document, by document id. */
  down: new Map<string, Array<{ kind: string; event?: { type: string }; helloId?: string }>>(),
  reset(): void {
    relay.listener = null;
    relay.documents = new Map();
    relay.attached = true;
    relay.down = new Map();
  },
  /** BentoShellBusHub.postToDocument */
  postToDocument(documentId: string, message: { kind: string }): boolean {
    const document = relay.documents.get(documentId);
    if (!document) return false;
    relay.down.set(documentId, [...(relay.down.get(documentId) ?? []), message]);
    document.window.dispatchEvent(
      new CustomEvent('bento-bus-down', { detail: JSON.stringify(message) }),
    );
    return true;
  },
  /** BentoShellBusHub.postFromChrome */
  fromChrome(windowId: number, isPrivate: boolean, message: object): void {
    relay.listener?.({ documentId: null, windowId, isPrivate, message });
  },
};

class FakeBroadcastChannel {
  readonly #listeners = new Set<(message: { data: BusData }) => void>();
  readonly partition = bus.partition;

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
      if (to !== this && to.name === this.name && to.partition === this.partition) {
        bus.queue.push({ to, data });
      }
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
  const disconnectListeners = new Set<() => void>();
  const requests: string[] = [];
  let workspaceIds = [...WORKSPACE_IDS];
  const themeIds: Record<string, string> = {};
  let activeId: string | null | undefined;
  let settings = {} as BentoSettings;
  const activeIdByWindow: Record<number, string> = {};

  const emit = (event: Event | AudienceEvent) => {
    for (const listener of listeners) listener(event);
    bus.drain();
  };
  /** Actions that reached the port, in order, with their routing envelope. */
  const actions: Array<Action & { __windowId?: number }> = [];
  /** Private windows bento-tools knows: their Private workspace and one tab. */
  const privateWindows = new Map<number, { workspaceId: string; tabId: number }>();

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
      workspaces: workspaceIds.map((id, index) => ({
        id,
        name: id,
        createdAt: index,
        ...(themeIds[id] ? { themeId: themeIds[id] } : {}),
      })),
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
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.add(listener) },
    postMessage: (action: Action & { __windowId?: number }) => {
      requests.push(action.type);
      actions.push(action);
      if (action.type === 'settings/update') {
        // Applies whatever arrives, so a key the shell background should have kept
        // back shows up in the saved settings.
        settings = { ...settings, ...action.changes };
        emit({ type: 'settings/changed', settings });
        return;
      }
      const privateWindow =
        action.__windowId === undefined ? undefined : privateWindows.get(action.__windowId);
      if (privateWindow && action.__windowId !== undefined) {
        const audience = { privateWindowId: action.__windowId };
        if (action.type === 'tabs/requestSnapshot') {
          emit(
            audienceEvent(audience, {
              type: 'tabs/snapshot',
              tabs: [
                {
                  id: privateWindow.tabId,
                  windowId: action.__windowId,
                  index: 0,
                  title: 'Private tab',
                  active: true,
                  pinned: false,
                  audible: false,
                  muted: false,
                  workspaceId: privateWindow.workspaceId,
                },
              ],
            }),
          );
        } else if (action.type === 'workspaces/requestSnapshot') {
          emit(
            audienceEvent(audience, {
              type: 'workspaces/snapshot',
              workspaces: [
                { id: privateWindow.workspaceId, name: 'Private', createdAt: 0, private: true },
              ],
              activeId: null,
              activeIdByWindow: { [action.__windowId]: privateWindow.workspaceId },
            }),
          );
        } else {
          // Workspace-bound snapshots are empty for a private window; global ones are shared.
          if (action.type === 'settings/requestSnapshot') {
            emit(snapshots['settings/requestSnapshot']());
          } else if (action.type === 'savedPanels/requestSnapshot') {
            emit(snapshots['savedPanels/requestSnapshot']());
          } else if (action.type === 'pinnedPanels/requestSnapshot') {
            emit(audienceEvent(audience, { type: 'pinnedPanels/snapshot', entries: [] }));
          } else if (action.type === 'tabFolders/requestSnapshot') {
            emit(audienceEvent(audience, { type: 'tabFolders/snapshot', folders: [] }));
          }
        }
        return;
      }
      const reply = snapshots[action.type as keyof typeof snapshots];
      if (reply) emit(reply());
    },
  };

  return {
    port,
    requests,
    actions,
    /** Drops the port like a tools reload; the shell background reconnects. */
    disconnect(): void {
      for (const listener of disconnectListeners) listener();
    },
    /** Declares a private window with its Private workspace and one private tab. */
    addPrivateWindow(
      windowId: number,
      workspaceId = `private:${windowId}`,
      tabId = windowId * 100,
    ) {
      privateWindows.set(windowId, { workspaceId, tabId });
    },
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
    /** Gives a workspace a theme in every later snapshot. */
    setWorkspaceTheme(workspaceId: string, themeId: string): void {
      themeIds[workspaceId] = themeId;
    },
    /** Replaces the settings every later snapshot carries. */
    setSettings(next: BentoSettings): void {
      settings = next;
    },
    /** The saved settings, as bento-tools holds them. */
    savedSettings: () => settings,
    /** Overrides the global fallback workspace (default: the first one). */
    setGlobalActive(workspaceId: string | null): void {
      activeId = workspaceId;
    },
  };
}

/** Joins as the sidebar (title bridge on) when given the window it lives in.
 * `windowId` places an overlay document in a window without the title bridge. */
async function joinDocument({
  sidebarWindowId,
  windowId = sidebarWindowId,
}: { sidebarWindowId?: number; windowId?: number } = {}) {
  vi.resetModules();
  vi.stubGlobal('location', {
    hash: windowId === undefined ? '' : `#bentoWindowId=${windowId}`,
  });
  const { initToolsPort, enableSidePanelTitleBridge, dispatch } = await import('./useToolsPort');
  const { useTabsStore } = await import('../state/tabs');
  const { usePanelsStore } = await import('../state/panels');
  const { useSettingsStore } = await import('../state/settings');
  const { useWorkspacesStore, selectActiveIdForWindow } = await import('../state/workspaces');
  const applied = { panels: 0 };
  usePanelsStore.subscribe(() => (applied.panels += 1));
  initToolsPort();
  if (sidebarWindowId !== undefined) enableSidePanelTitleBridge();
  bus.drain();
  return {
    dispatch,
    useTabsStore,
    usePanelsStore,
    useSettingsStore,
    useWorkspacesStore,
    selectActiveIdForWindow,
    applied,
  };
}

/** Joins as an overlay document of a private window. The hub (not the page) supplies
 * `windowId`; `claimedWindowId` is what the page stamps in its own URL hash and
 * actions, which a hostile or confused page could set to anything. */
async function joinPrivateDocument({
  windowId,
  claimedWindowId = windowId,
  sidebar = false,
}: {
  windowId: number;
  claimedWindowId?: number;
  /** Joins as the window's sidebar, which writes to chrome's title. */
  sidebar?: boolean;
}) {
  vi.resetModules();
  bus.partition = 'private';
  const documentWindow = new EventTarget();
  vi.stubGlobal('window', documentWindow);
  vi.stubGlobal('location', { hash: `#bentoWindowId=${claimedWindowId}&bentoPrivate=1` });
  const documentId = `doc-${relay.documents.size + 1}`;
  relay.documents.set(documentId, { window: documentWindow, windowId });
  documentWindow.addEventListener('bento-bus-up', (event) => {
    if (!relay.attached) return;
    const detail = (event as CustomEvent<string>).detail;
    relay.listener?.({ documentId, windowId, isPrivate: true, message: JSON.parse(detail) });
  });
  const { initToolsPort, dispatch, enableSidePanelTitleBridge } = await import('./useToolsPort');
  const { useTabsStore } = await import('../state/tabs');
  const { useWorkspacesStore } = await import('../state/workspaces');
  const { useSettingsStore } = await import('../state/settings');
  initToolsPort();
  if (sidebar) enableSidePanelTitleBridge();
  bus.drain();
  bus.partition = 'regular';
  return {
    documentId,
    dispatch,
    useTabsStore,
    useWorkspacesStore,
    useSettingsStore,
  };
}

function snapshotDeliveriesToDocuments(): number {
  return bus.deliveries.filter(
    ({ toBackground, data }) =>
      !toBackground && data.kind === 'event' && data.event.type.endsWith('/snapshot'),
  ).length;
}

describe('shell bus bootstrap', () => {
  let tools: ReturnType<typeof createFakeTools>;
  let windowRemoved: (id: number) => void;

  beforeEach(async () => {
    bus.reset();
    relay.reset();
    tools = createFakeTools();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    // The extension build defines this flag; here the dev build's value.
    vi.stubGlobal('__BENTO_DEV_RELOAD__', true);
    vi.stubGlobal('browser', {
      windows: { onRemoved: { addListener: (listener: (id: number) => void) => { windowRemoved = listener; } } },
      runtime: { connect: () => tools.port },
      commands: { onCommand: { addListener: () => {} } },
      bentoChrome: {
        onBusMessage: {
          addListener: (listener: (record: unknown) => void) => (relay.listener = listener),
        },
        postToDocument: async (documentId: string, message: { kind: string }) =>
          relay.postToDocument(documentId, message),
      },
    });
    vi.resetModules();
    // The background must be the first channel on the bus.
    await import('../background');
  });

  afterEach(() => {
    vi.useRealTimers();
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

  // The panel navigator tooltip used to skip initToolsPort(), so its stores stayed
  // empty and useWorkspaceTheme/useFirefoxTheme never had a theme or mode to apply.
  it('hydrates the inputs of the theme hooks in an overlay that only joins the bus', async () => {
    tools.assignWindow(7, 'ws-2');
    tools.setWorkspaceTheme('ws-2', 'teal');
    tools.setSettings({ uiColorMode: 'dark' } as BentoSettings);
    tools.boot();

    const tooltip = await joinDocument({ windowId: 7 });

    const workspaces = tooltip.useWorkspacesStore.getState();
    expect(tooltip.selectActiveIdForWindow(workspaces, 7)).toBe('ws-2');
    expect(workspaces.byId['ws-2']?.themeId).toBe('teal');
    expect(tooltip.useSettingsStore.getState().current?.uiColorMode).toBe('dark');
  });

  it('follows a later color mode change in that overlay', async () => {
    tools.setSettings({ uiColorMode: 'light' } as BentoSettings);
    tools.boot();
    const tooltip = await joinDocument({ windowId: 7 });
    expect(tooltip.useSettingsStore.getState().current?.uiColorMode).toBe('light');

    tools.emit({
      type: 'settings/changed',
      settings: { uiColorMode: 'dark' } as BentoSettings,
    });

    expect(tooltip.useSettingsStore.getState().current?.uiColorMode).toBe('dark');
  });

  it('replays cached panels to the joining document only', async () => {
    tools.boot();

    const first = await joinDocument();
    expect(first.applied.panels).toBe(WORKSPACE_IDS.length);

    await joinDocument();
    await joinDocument();

    expect(first.applied.panels).toBe(WORKSPACE_IDS.length);
  });

  describe('private windows', () => {
    const PRIVATE_WINDOW = 9;

    function tab(id: number, windowId: number, workspaceId: string) {
      return {
        id,
        windowId,
        index: 0,
        title: `Tab ${id}`,
        active: true,
        pinned: false,
        audible: false,
        muted: false,
        workspaceId,
      };
    }

    it('hydrates a private document only through the relay, with its own Private workspace', async () => {
      tools.addPrivateWindow(PRIVATE_WINDOW);
      tools.boot();
      bus.deliveries.length = 0;

      const privateDocument = await joinPrivateDocument({ windowId: PRIVATE_WINDOW });

      expect(relay.down.get(privateDocument.documentId)?.map(({ kind }) => kind)).toContain('ack');
      expect(Object.keys(privateDocument.useWorkspacesStore.getState().byId)).toEqual([
        `private:${PRIVATE_WINDOW}`,
      ]);
      expect(Object.keys(privateDocument.useTabsStore.getState().byId)).toEqual([
        String(PRIVATE_WINDOW * 100),
      ]);
      // Nothing crossed the BroadcastChannel partition boundary.
      expect(bus.deliveries).toEqual([]);
    });

    it('keeps private state out of regular documents and regular state out of private ones', async () => {
      tools.addPrivateWindow(PRIVATE_WINDOW);
      const regular = await joinDocument({ windowId: 1 });
      tools.boot();
      const privateDocument = await joinPrivateDocument({ windowId: PRIVATE_WINDOW });

      tools.emit(
        audienceEvent(
          { privateWindowId: PRIVATE_WINDOW },
          {
            type: 'tabs/changed',
            deltas: [{ kind: 'created', tab: tab(901, PRIVATE_WINDOW, 'private:9') }],
          },
        ),
      );
      tools.emit(
        audienceEvent('regular', {
          type: 'tabs/changed',
          deltas: [{ kind: 'created', tab: tab(5, 1, 'ws-1') }],
        }),
      );
      // Workspace-bound state that arrives unaddressed is treated as regular.
      tools.emit({
        type: 'workspaces/changed',
        deltas: [{ kind: 'created', workspace: { id: 'ws-new', name: 'New', createdAt: 5 } }],
      });

      const regularTabs = Object.keys(regular.useTabsStore.getState().byId);
      expect(regularTabs).toContain('5');
      expect(regularTabs).not.toContain('901');
      expect(regularTabs).not.toContain(String(PRIVATE_WINDOW * 100));
      expect(Object.keys(regular.useWorkspacesStore.getState().byId)).not.toContain(
        `private:${PRIVATE_WINDOW}`,
      );
      const privateTabs = Object.keys(privateDocument.useTabsStore.getState().byId);
      expect(privateTabs).toContain('901');
      expect(privateTabs).not.toContain('5');
      expect(Object.keys(privateDocument.useWorkspacesStore.getState().byId)).toEqual([
        `private:${PRIVATE_WINDOW}`,
      ]);
    });

    it("delivers a private window's events to that window only", async () => {
      tools.addPrivateWindow(9);
      tools.addPrivateWindow(10);
      tools.boot();
      const first = await joinPrivateDocument({ windowId: 9 });
      const second = await joinPrivateDocument({ windowId: 10 });

      tools.emit(
        audienceEvent(
          { privateWindowId: 10 },
          { type: 'tabs/changed', deltas: [{ kind: 'created', tab: tab(1001, 10, 'private:10') }] },
        ),
      );

      expect(Object.keys(first.useTabsStore.getState().byId)).not.toContain('1001');
      expect(Object.keys(second.useTabsStore.getState().byId)).toContain('1001');
    });

    it('keeps the focused panel of a private window from every other document', async () => {
      tools.addPrivateWindow(9);
      tools.addPrivateWindow(10);
      tools.boot();
      const first = await joinPrivateDocument({ windowId: 9 });
      const second = await joinPrivateDocument({ windowId: 10 });
      await joinDocument({ windowId: 1 });
      bus.deliveries.length = 0;
      const focused = { type: 'panel/focusedChanged', tabId: 900, windowId: 9 } as const;
      const focusedEvents = (documentId: string) =>
        (relay.down.get(documentId) ?? []).filter(({ event }) => event?.type === focused.type);

      // Wrapped for its window, as tools sends it.
      tools.emit(audienceEvent({ privateWindowId: 9 }, focused));
      expect(focusedEvents(first.documentId)).toHaveLength(1);
      expect(focusedEvents(second.documentId)).toEqual([]);
      expect(
        bus.deliveries.filter(({ data }) => 'event' in data && data.event.type === focused.type),
      ).toEqual([]);

      // Unwrapped: it never reaches a private document, whichever window it names.
      tools.emit({ ...focused });
      expect(focusedEvents(first.documentId)).toHaveLength(1);
      expect(focusedEvents(second.documentId)).toEqual([]);
    });

    it('never sends external merge events to a private document', async () => {
      tools.addPrivateWindow(PRIVATE_WINDOW);
      await joinDocument({ windowId: 1 });
      tools.boot();
      const privateDocument = await joinPrivateDocument({ windowId: PRIVATE_WINDOW });

      tools.emit({
        type: 'externalMerge/sources',
        requestId: 'r1',
        windowId: PRIVATE_WINDOW,
        sources: [],
      });
      tools.emit({ type: 'settings/changed', settings: { uiColorMode: 'dark' } as BentoSettings });

      const received = (relay.down.get(privateDocument.documentId) ?? [])
        .map(({ event }) => event?.type)
        .filter((type): type is string => type !== undefined);
      expect(received).toContain('settings/changed');
      expect(received.filter((type) => type.startsWith('externalMerge/'))).toEqual([]);
    });

    it('replaces the window id a private page claims with the one chrome gave the hub', async () => {
      tools.addPrivateWindow(PRIVATE_WINDOW);
      tools.boot();
      const privateDocument = await joinPrivateDocument({
        windowId: PRIVATE_WINDOW,
        claimedWindowId: 77,
      });
      tools.actions.length = 0;

      privateDocument.dispatch({ type: 'tab/close', id: 3 });
      privateDocument.dispatch({ type: 'shell/hello', windowId: 77 });

      expect(tools.actions).toEqual([
        { type: 'tab/close', id: 3, __windowId: PRIVATE_WINDOW },
        { type: 'shell/hello', windowId: PRIVATE_WINDOW, __windowId: PRIVATE_WINDOW },
      ]);
    });

    it('says shell/hello once per window, however many documents join', async () => {
      tools.boot();
      await joinPrivateDocument({ windowId: PRIVATE_WINDOW });
      await joinPrivateDocument({ windowId: PRIVATE_WINDOW });

      expect(tools.actions.filter(({ type }) => type === 'shell/hello')).toEqual([
        { type: 'shell/hello', windowId: PRIVATE_WINDOW, __windowId: PRIVATE_WINDOW },
      ]);
    });

    it('repeats hello until the relay answers', async () => {
      vi.useFakeTimers();
      tools.addPrivateWindow(PRIVATE_WINDOW);
      tools.boot();
      relay.attached = false;

      const privateDocument = await joinPrivateDocument({ windowId: PRIVATE_WINDOW });
      expect(relay.down.get(privateDocument.documentId)).toBeUndefined();
      expect(tools.actions.some(({ type }) => type === 'shell/hello')).toBe(false);

      relay.attached = true;
      await vi.advanceTimersByTimeAsync(600);

      expect(relay.down.get(privateDocument.documentId)?.map(({ kind }) => kind)).toContain('ack');
      expect(Object.keys(privateDocument.useWorkspacesStore.getState().byId)).toEqual([
        `private:${PRIVATE_WINDOW}`,
      ]);
    });

    it('says shell/hello again for every live private window when tools reconnects', async () => {
      vi.useFakeTimers();
      tools.addPrivateWindow(PRIVATE_WINDOW);
      tools.boot();
      await joinPrivateDocument({ windowId: PRIVATE_WINDOW });
      tools.actions.length = 0;

      tools.disconnect();
      await vi.advanceTimersByTimeAsync(300);

      expect(tools.actions).toContainEqual({
        type: 'shell/hello',
        windowId: PRIVATE_WINDOW,
        __windowId: PRIVATE_WINDOW,
      });
    });

    it('keeps menu and ui actions on the private partition, off the relay', async () => {
      tools.boot();
      const privateDocument = await joinPrivateDocument({ windowId: PRIVATE_WINDOW });
      bus.partition = 'private';
      const neighbour = new FakeBroadcastChannel('bento-shell-bus');
      bus.partition = 'regular';
      const heard: BusData[] = [];
      neighbour.addEventListener('message', ({ data }) => heard.push(data));
      tools.actions.length = 0;

      privateDocument.dispatch({
        type: 'ui/renameRequest',
        target: { kind: 'tab', id: 1 },
      } as never);
      privateDocument.dispatch({ type: 'menu/open' } as never);
      bus.drain();

      expect(heard.map((data) => data.kind === 'action' && data.action.type)).toEqual([
        'ui/renameRequest',
        'menu/open',
      ]);
      expect(tools.actions).toEqual([]);
    });

    it("relays an action chrome raises in a private window, and ignores other windows' claims", async () => {
      tools.boot();
      tools.actions.length = 0;

      relay.fromChrome(PRIVATE_WINDOW, true, {
        kind: 'action',
        action: {
          type: 'panel/openAt',
          url: 'https://example.com',
          sourceTabId: null,
          __windowId: 1,
        },
      });
      relay.fromChrome(4, false, { kind: 'action', action: { type: 'tab/close', id: 1 } });

      expect(tools.actions).toEqual([
        {
          type: 'panel/openAt',
          url: 'https://example.com',
          sourceTabId: null,
          __windowId: PRIVATE_WINDOW,
        },
      ]);
    });
  });

  describe('window-local sidebar state of private windows', () => {
    const SAVED = {
      uiColorMode: 'light',
      sidebarCollapsed: false,
      sidebarHidden: false,
      sidebarShortcutBehavior: 'collapse',
      panelShadowsEnabled: true,
      panelCornerRadiusPx: 6,
    } as BentoSettings;
    const LOCAL_KEYS = ['sidebarCollapsed', 'sidebarHidden', 'uiColorMode'] as const;

    /** The three window-local values a document shows. */
    function localView(document: {
      useSettingsStore: { getState(): { current: BentoSettings | null } };
    }) {
      const current = document.useSettingsStore.getState().current;
      return current && Object.fromEntries(LOCAL_KEYS.map((key) => [key, current[key]]));
    }
    const view = (uiColorMode: string, sidebarCollapsed: boolean, sidebarHidden: boolean) => ({
      uiColorMode,
      sidebarCollapsed,
      sidebarHidden,
    });
    const settingsUpdates = () => tools.actions.filter(({ type }) => type === 'settings/update');

    beforeEach(() => {
      tools.setSettings(SAVED);
      tools.addPrivateWindow(9);
      tools.addPrivateWindow(10);
      tools.boot();
    });

    it('keeps two private windows and a regular window independent, and saves nothing for a private one', async () => {
      const regular = await joinDocument({ windowId: 1 });
      const first = await joinPrivateDocument({ windowId: 9 });
      const second = await joinPrivateDocument({ windowId: 10 });
      tools.actions.length = 0;

      first.dispatch({
        type: 'settings/update',
        changes: { sidebarCollapsed: true, uiColorMode: 'dark' },
      });
      expect(localView(first)).toEqual(view('dark', true, false));
      expect(localView(second)).toEqual(view('light', false, false));
      expect(localView(regular)).toEqual(view('light', false, false));

      second.dispatch({ type: 'settings/update', changes: { sidebarHidden: true } });
      expect(localView(first)).toEqual(view('dark', true, false));
      expect(localView(second)).toEqual(view('light', false, true));
      expect(localView(regular)).toEqual(view('light', false, false));

      // The regular window keeps sharing the saved settings.
      regular.dispatch({
        type: 'settings/update',
        changes: { sidebarCollapsed: true, uiColorMode: 'system' },
      });
      bus.drain();
      expect(localView(regular)).toEqual(view('system', true, false));
      expect(tools.savedSettings()).toMatchObject({
        sidebarCollapsed: true,
        uiColorMode: 'system',
      });
      // An open private window does not follow a later regular change.
      expect(localView(first)).toEqual(view('dark', true, false));
      expect(localView(second)).toEqual(view('light', false, true));

      // Only the regular window's update reached tools.
      expect(settingsUpdates()).toEqual([
        {
          type: 'settings/update',
          changes: { sidebarCollapsed: true, uiColorMode: 'system' },
          __windowId: 1,
        },
      ]);
    });

    it('sends tools only the keys of a private update that are not window-local', async () => {
      const regular = await joinDocument({ windowId: 1 });
      const first = await joinPrivateDocument({ windowId: 9 });
      const second = await joinPrivateDocument({ windowId: 10 });
      tools.actions.length = 0;

      first.dispatch({
        type: 'settings/update',
        changes: { sidebarCollapsed: true, panelCornerRadiusPx: 12 },
      });

      expect(settingsUpdates()).toEqual([
        { type: 'settings/update', changes: { panelCornerRadiusPx: 12 }, __windowId: 9 },
      ]);
      expect(tools.savedSettings()).toMatchObject({
        sidebarCollapsed: false,
        panelCornerRadiusPx: 12,
      });
      // The shared key reaches every window; the local one stays with the sender.
      expect(regular.useSettingsStore.getState().current?.panelCornerRadiusPx).toBe(12);
      expect(second.useSettingsStore.getState().current?.panelCornerRadiusPx).toBe(12);
      expect(localView(first)).toEqual(view('light', true, false));
      expect(localView(second)).toEqual(view('light', false, false));
      expect(localView(regular)).toEqual(view('light', false, false));
    });

    it('starts a new private window from the saved values as they are then', async () => {
      tools.emit({
        type: 'settings/changed',
        settings: { ...SAVED, uiColorMode: 'dark', sidebarCollapsed: true },
      });
      const first = await joinPrivateDocument({ windowId: 9 });
      expect(localView(first)).toEqual(view('dark', true, false));

      tools.emit({
        type: 'settings/changed',
        settings: { ...SAVED, uiColorMode: 'light', sidebarCollapsed: false },
      });
      const second = await joinPrivateDocument({ windowId: 10 });

      expect(localView(second)).toEqual(view('light', false, false));
      expect(localView(first)).toEqual(view('dark', true, false));
    });

    it("gives a private window's later documents the window's own values", async () => {
      const first = await joinPrivateDocument({ windowId: 9 });
      first.dispatch({
        type: 'settings/update',
        changes: { uiColorMode: 'dark', sidebarHidden: true },
      });

      const overlay = await joinPrivateDocument({ windowId: 9 });

      expect(localView(overlay)).toEqual(view('dark', false, true));
      first.dispatch({ type: 'settings/update', changes: { sidebarCollapsed: true } });
      expect(localView(overlay)).toEqual(view('dark', true, true));
    });

    it('applies an update chrome raises in a private window to that window only', async () => {
      const first = await joinPrivateDocument({ windowId: 9 });
      const second = await joinPrivateDocument({ windowId: 10 });
      tools.actions.length = 0;

      // Cmd+S in the window's chrome.
      relay.fromChrome(9, true, {
        kind: 'action',
        action: {
          type: 'settings/update',
          changes: { sidebarHidden: false, sidebarCollapsed: true },
        },
      });

      expect(localView(first)).toEqual(view('light', true, false));
      expect(localView(second)).toEqual(view('light', false, false));
      expect(settingsUpdates()).toEqual([]);
    });

    it('ignores a window-local value of the wrong type', async () => {
      const first = await joinPrivateDocument({ windowId: 9 });
      tools.actions.length = 0;

      first.dispatch({
        type: 'settings/update',
        changes: { sidebarCollapsed: 'yes', uiColorMode: 'purple' } as never,
      });

      expect(localView(first)).toEqual(view('light', false, false));
      expect(settingsUpdates()).toEqual([]);
    });

    it("preserves a private owner across document reload and forgets it only when its native window closes", async () => {
      const first = await joinPrivateDocument({ windowId: 9 });
      first.dispatch({ type: 'settings/update', changes: { sidebarCollapsed: true } });
      tools.emit({ type: 'settings/changed', settings: { ...SAVED, uiColorMode: 'dark' } });
      expect(localView(first)).toEqual(view('light', true, false));

      relay.listener?.({
        documentId: first.documentId,
        windowId: 9,
        isPrivate: true,
        message: { kind: 'document-closed' },
      });
      const reopened = await joinPrivateDocument({ windowId: 9 });

      expect(localView(reopened)).toEqual(view('light', true, false));
      windowRemoved(9);
      const nextWindow = await joinPrivateDocument({ windowId: 9 });
      // The fake tools snapshot on rejoin is SAVED (light), a new owner.
      expect(localView(nextWindow)).toEqual(view('light', false, false));
    });

    describe('in the chrome payload', () => {
      let chromeTitle: ReturnType<typeof installFakeChromeTitle>;
      type ChromePanels = {
        workspaceId: string;
        sidebarCollapsed?: boolean;
        sidebarHidden?: boolean;
        uiColorMode?: string;
        panelCornerRadiusPx?: number;
        scrollToPanelTabId?: number;
      };

      function chromePanels(): ChromePanels[] {
        chromeTitle.settle();
        return chromeTitle.observed
          .filter((title) => title.startsWith('BENTO_PANELS:'))
          .map((title) =>
            JSON.parse(Buffer.from(title.split(':')[2] ?? '', 'base64').toString('utf8')),
          );
      }

      const privatePanelsSync = (extra: { scrollToPanelTabId?: number } = {}) =>
        ({
          type: 'panels/sync',
          workspaceId: 'private:9',
          windowId: 9,
          panels: [{ tabId: 900, url: 'https://example.com' }],
          layout: { root: [] },
          panelStatusByTabId: {},
          ...extra,
        }) satisfies Event;

      beforeEach(() => {
        chromeTitle = installFakeChromeTitle({ documentElement: { getAttribute: () => null } });
      });

      it("carries the window's own values to its chrome, and not a regular change", async () => {
        const sidebar = await joinPrivateDocument({ windowId: 9, sidebar: true });
        // A panels/sync for the window's Private workspace, as tools emits it.
        tools.emit(
          audienceEvent({ privateWindowId: 9 }, privatePanelsSync({ scrollToPanelTabId: 900 })),
        );
        expect(chromePanels().at(-1)).toMatchObject({
          workspaceId: 'private:9',
          sidebarCollapsed: false,
          uiColorMode: 'light',
        });
        const written = chromePanels().length;

        // Cmd+S in this window's chrome.
        relay.fromChrome(9, true, {
          kind: 'action',
          action: {
            type: 'settings/update',
            changes: { sidebarHidden: false, sidebarCollapsed: true },
          },
        });
        sidebar.dispatch({ type: 'settings/update', changes: { uiColorMode: 'dark' } });

        const payloads = chromePanels();
        expect(payloads.length).toBeGreaterThan(written);
        expect(payloads.at(-1)).toMatchObject({
          workspaceId: 'private:9',
          sidebarCollapsed: true,
          uiColorMode: 'dark',
        });
        // A resend is a presentation change, not a request to scroll to the panel again.
        expect(payloads.slice(written).map((payload) => payload.scrollToPanelTabId)).toEqual(
          payloads.slice(written).map(() => undefined),
        );

        // A regular window changes the saved values, and bento-tools re-fires the
        // panels/sync of the private workspace as well.
        tools.emit({
          type: 'settings/changed',
          settings: {
            ...SAVED,
            sidebarCollapsed: false,
            uiColorMode: 'system',
            panelCornerRadiusPx: 9,
          },
        });
        tools.emit(audienceEvent({ privateWindowId: 9 }, privatePanelsSync()));
        expect(chromePanels().at(-1)).toMatchObject({
          sidebarCollapsed: true,
          uiColorMode: 'dark',
          panelCornerRadiusPx: 9,
        });
      });
    });
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
