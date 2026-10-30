// Panel, pin and folder actions name tabs by id. A regular window must never name a
// private tab, and a private window only its own; and the panel operations that need a
// workspace must find a private window's Private workspace.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Event } from '@shared/protocol';
import { handle, type HandlerContext } from './protocol-handler';
import { WorkspaceStore } from '../workspaces/WorkspaceStore';
import { createWindowHandoffGuard } from '../workspaces/EmptiedWorkspace';

const REGULAR_WINDOW = 1;
const PRIVATE_WINDOW = 9;
const OTHER_PRIVATE_WINDOW = 10;
const REGULAR_TAB = 5;
const PRIVATE_TAB = 900;
const OTHER_PRIVATE_TAB = 1000;

/** An object that records every property read, standing for a store the action must not reach. */
function untouched(label: string) {
  const touched: string[] = [];
  const proxy = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(`${label}.${String(property)}`);
        return vi.fn();
      },
    },
  );
  return { proxy, touched };
}

async function createContext(sourceWindowId: number) {
  const workspaces = new WorkspaceStore();
  await workspaces.init();
  const regular = workspaces.snapshot().workspaces[0]!;
  workspaces.activate(regular.id, REGULAR_WINDOW);
  const privateWorkspace = workspaces.ensurePrivate(PRIVATE_WINDOW);
  const otherPrivateWorkspace = workspaces.ensurePrivate(OTHER_PRIVATE_WINDOW);

  const windowOfPrivateTab = new Map([
    [PRIVATE_TAB, PRIVATE_WINDOW],
    [OTHER_PRIVATE_TAB, OTHER_PRIVATE_WINDOW],
  ]);
  const tabRows = [
    { id: REGULAR_TAB, windowId: REGULAR_WINDOW, workspaceId: regular.id },
    { id: PRIVATE_TAB, windowId: PRIVATE_WINDOW, workspaceId: privateWorkspace.id },
    {
      id: OTHER_PRIVATE_TAB,
      windowId: OTHER_PRIVATE_WINDOW,
      workspaceId: otherPrivateWorkspace.id,
    },
  ];
  const panels = untouched('panels');
  const pinnedPanels = untouched('pinnedPanels');
  const tabFolders = untouched('tabFolders');
  const send = vi.fn();
  const sendAudience = vi.fn();
  const ctx = {
    tabs: {
      snapshot: vi.fn(() => tabRows),
      isPrivate: vi.fn((id: number) => windowOfPrivateTab.has(id)),
      privateWindowOfTab: vi.fn((id: number) => windowOfPrivateTab.get(id)),
      isClosing: vi.fn(() => false),
      assignWorkspace: vi.fn(),
      assignWorkspaceEagerly: vi.fn(),
      setFolder: vi.fn(),
      markClosing: vi.fn(async () => undefined),
      unmarkClosing: vi.fn(async () => undefined),
    },
    workspaces,
    settings: { snapshot: vi.fn(() => ({ defaultPanelWidthPx: 0 })) },
    panels: panels.proxy,
    pinnedPanels: pinnedPanels.proxy,
    tabFolders: tabFolders.proxy,
    savedPanels: { save: vi.fn(async () => undefined), list: vi.fn(() => []) },
    send,
    sendAudience,
    emitPanelsSync: vi.fn(),
    syncPanelMarkers: vi.fn(),
    handoff: createWindowHandoffGuard(),
    preferWorkspaceActivationTab: vi.fn(),
    sourceWindowId,
    sourceWindowPrivate: sourceWindowId !== REGULAR_WINDOW,
  } as unknown as HandlerContext;
  return {
    ctx,
    workspaces,
    regular,
    privateWorkspace,
    send,
    sendAudience,
    touched: [...panels.touched, ...pinnedPanels.touched, ...tabFolders.touched] as string[],
    touchedLists: {
      panels: panels.touched,
      pinnedPanels: pinnedPanels.touched,
      tabFolders: tabFolders.touched,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('browser', {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    windows: { getAll: vi.fn(async () => []), update: vi.fn() },
    sessions: {
      getWindowValue: vi.fn(async () => undefined),
      setWindowValue: vi.fn(async () => undefined),
      removeWindowValue: vi.fn(async () => undefined),
    },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every action that names `tab`, in a window whose workspace is `workspaceId`. */
function actionsNaming(tab: number, workspaceId: string): Action[] {
  return [
    { type: 'panel/add', id: tab },
    { type: 'panel/addDevtools', tabId: tab, forTabId: null, inspectedTabId: REGULAR_TAB },
    { type: 'panel/addDevtools', tabId: 77, forTabId: tab, inspectedTabId: 77 },
    { type: 'panel/addDevtools', tabId: 77, forTabId: null, inspectedTabId: tab },
    { type: 'panel/openAt', url: 'https://example.com/', sourceTabId: tab },
    { type: 'panel/remove', id: tab },
    { type: 'panel/setWidth', id: tab, widthPx: 320 },
    { type: 'panel/setHeaderHidden', id: tab, hidden: true },
    { type: 'panel/focus', workspaceId, id: tab },
    { type: 'panel/focusedChanged', tabId: tab },
    { type: 'panelLayout/movePanel', tabId: tab, target: { type: 'root', index: 0 } },
    { type: 'panelLayout/subdivide', tabId: tab },
    { type: 'panelLayout/splitTopPanel', tabId: tab },
    { type: 'panelLayout/splitBottomPanel', tabId: tab },
    { type: 'panelLayout/breakOut', tabId: tab },
  ];
}

describe('a regular window naming a private tab', () => {
  it.each([
    'panel/add',
    'panel/addDevtools',
    'panel/openAt',
    'panel/remove',
    'panel/setWidth',
    'panel/setHeaderHidden',
    'panel/focus',
    'panel/focusedChanged',
    'panelLayout/movePanel',
    'panelLayout/subdivide',
    'panelLayout/splitTopPanel',
    'panelLayout/splitBottomPanel',
    'panelLayout/breakOut',
  ])('is refused for %s, touching no panel store', async (type) => {
    const { ctx, regular, touchedLists, send, sendAudience } = await createContext(REGULAR_WINDOW);

    for (const action of actionsNaming(PRIVATE_TAB, regular.id).filter((a) => a.type === type)) {
      handle(action as never, ctx);
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(touchedLists.panels).toEqual([]);
    expect(ctx.emitPanelsSync).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sendAudience).not.toHaveBeenCalled();
  });

  it('cannot pin or file a private tab', async () => {
    const { ctx, regular, touchedLists } = await createContext(REGULAR_WINDOW);

    handle({ type: 'pinnedPanel/add', workspaceId: regular.id, tabId: PRIVATE_TAB }, ctx);
    handle({ type: 'tabs/setFolder', ids: [REGULAR_TAB, PRIVATE_TAB], folderId: 'f1' }, ctx);
    handle({ type: 'tabFolder/create', name: 'f', tabIds: [PRIVATE_TAB] } as never, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(touchedLists.pinnedPanels).toEqual([]);
    expect(touchedLists.tabFolders).toEqual([]);
    expect(ctx.tabs.setFolder).not.toHaveBeenCalled();
  });

  it('still adds its own tab as a panel of its workspace', async () => {
    const { ctx, regular } = await createContext(REGULAR_WINDOW);
    const add = vi.fn(() => false);
    (ctx as unknown as { panels: unknown }).panels = { add };

    handle({ type: 'panel/add', id: REGULAR_TAB }, ctx);

    expect(add).toHaveBeenCalledWith(regular.id, REGULAR_TAB);
  });
});

describe('a private window naming a tab that is not its own', () => {
  const foreign = [
    ['a regular tab', REGULAR_TAB],
    ["another private window's tab", OTHER_PRIVATE_TAB],
    ['a tab nobody knows', 4242],
  ] as const;

  it.each(foreign)('is refused for %s, touching no panel store', async (_label, tab) => {
    const { ctx, privateWorkspace, touchedLists, send, sendAudience } =
      await createContext(PRIVATE_WINDOW);

    for (const action of actionsNaming(tab, privateWorkspace.id)) handle(action as never, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(touchedLists.panels).toEqual([]);
    expect(ctx.emitPanelsSync).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sendAudience).not.toHaveBeenCalled();
  });

  it('still adds its own tab as a panel of its Private workspace', async () => {
    const { ctx, privateWorkspace } = await createContext(PRIVATE_WINDOW);
    const add = vi.fn(() => false);
    (ctx as unknown as { panels: unknown }).panels = { add };

    handle({ type: 'panel/add', id: PRIVATE_TAB }, ctx);

    expect(add).toHaveBeenCalledWith(privateWorkspace.id, PRIVATE_TAB);
  });
});

describe('panel operations find the Private workspace', () => {
  it('focuses a private panel chosen from the palette', async () => {
    const { ctx, privateWorkspace } = await createContext(PRIVATE_WINDOW);
    (ctx as unknown as { panels: unknown }).panels = {
      findWorkspacesContainingPanelOrSubPanel: vi.fn(() => [privateWorkspace.id]),
    };

    handle({ type: 'panel/focus', workspaceId: privateWorkspace.id, id: PRIVATE_TAB }, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(ctx.emitPanelsSync).toHaveBeenCalledWith(privateWorkspace.id, {
      scrollToPanelTabId: PRIVATE_TAB,
      windowId: PRIVATE_WINDOW,
    });
  });

  it("does not focus a panel of a workspace that is not the window's own", async () => {
    const { ctx, regular, workspaces } = await createContext(PRIVATE_WINDOW);
    const other = workspaces.privateWorkspaceOf(OTHER_PRIVATE_WINDOW)!;
    (ctx as unknown as { panels: unknown }).panels = {
      findWorkspacesContainingPanelOrSubPanel: vi.fn(() => [regular.id, other.id]),
    };

    handle({ type: 'panel/focus', workspaceId: regular.id, id: PRIVATE_TAB }, ctx);
    handle({ type: 'panel/focus', workspaceId: other.id, id: PRIVATE_TAB }, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(ctx.emitPanelsSync).not.toHaveBeenCalled();
  });

  it('records the strip scroll of its Private workspace, and only that', async () => {
    const { ctx, privateWorkspace, regular } = await createContext(PRIVATE_WINDOW);
    const setStripScroll = vi.fn();
    (ctx as unknown as { panels: unknown }).panels = { setStripScroll };

    handle(
      { type: 'panel/setStripScroll', workspaceId: privateWorkspace.id, scrollLeft: 120 },
      ctx,
    );
    handle({ type: 'panel/setStripScroll', workspaceId: regular.id, scrollLeft: 5 }, ctx);

    expect(setStripScroll.mock.calls).toEqual([[privateWorkspace.id, 120]]);
  });

  it('puts a private panel back when the user keeps its tab on a close prompt', async () => {
    const { ctx, privateWorkspace } = await createContext(PRIVATE_WINDOW);
    vi.stubGlobal('browser', {
      ...browser,
      sessions: {
        ...browser.sessions,
        getTabValue: vi.fn(async () => undefined),
        removeTabValue: vi.fn(async () => undefined),
      },
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: PRIVATE_WINDOW })),
        update: vi.fn(async () => ({ id: PRIVATE_TAB })),
        // The tab survives: the page's beforeunload prompt was answered with "Stay".
        remove: vi.fn(async () => undefined),
      },
    });
    const location = { workspaceId: privateWorkspace.id, rootIndex: 1 };
    const insertAtRestoreLocation = vi.fn(() => true);
    (ctx as unknown as { panels: unknown }).panels = {
      findWorkspacesContainingTab: vi.fn(() => [privateWorkspace.id]),
      isDevtoolsPanel: vi.fn(() => false),
      getPanelLayoutStatus: vi.fn(() => 'root-panel'),
      getPanelRestoreLocation: vi.fn(() => location),
      getWidth: vi.fn(() => undefined),
      getHeaderHidden: vi.fn(() => false),
      remove: vi.fn(() => true),
      insertAtRestoreLocation,
      getPanels: vi.fn(() => []),
    };
    (ctx as unknown as { pinnedPanels: unknown }).pinnedPanels = { removeForTab: vi.fn() };

    handle({ type: 'tab/close', id: PRIVATE_TAB }, ctx);

    await vi.waitFor(() => expect(ctx.tabs.unmarkClosing).toHaveBeenCalledWith(PRIVATE_TAB));
    await vi.waitFor(() =>
      expect(insertAtRestoreLocation).toHaveBeenCalledWith(
        privateWorkspace.id,
        PRIVATE_TAB,
        location,
      ),
    );
    expect(browser.tabs.remove).toHaveBeenCalledWith(PRIVATE_TAB);
    expect(ctx.tabs.markClosing).toHaveBeenCalledWith(PRIVATE_TAB, {
      preserveSessionMembership: true,
    });
    expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(PRIVATE_TAB, privateWorkspace.id, {});
  });
});

describe('panel/focusedChanged', () => {
  it("goes to the asking private window's documents only", async () => {
    const { ctx, send, sendAudience } = await createContext(PRIVATE_WINDOW);

    handle({ type: 'panel/focusedChanged', tabId: PRIVATE_TAB }, ctx);

    expect(sendAudience).toHaveBeenCalledWith(
      { privateWindowId: PRIVATE_WINDOW },
      { type: 'panel/focusedChanged', tabId: PRIVATE_TAB, windowId: PRIVATE_WINDOW },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('goes to the regular documents from a regular window', async () => {
    const { ctx, send, sendAudience } = await createContext(REGULAR_WINDOW);

    handle({ type: 'panel/focusedChanged', tabId: REGULAR_TAB }, ctx);

    expect(sendAudience).toHaveBeenCalledWith('regular', {
      type: 'panel/focusedChanged',
      tabId: REGULAR_TAB,
      windowId: REGULAR_WINDOW,
    } satisfies Event);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Save panel', () => {
  const save: Action = {
    type: 'savedPanels/save',
    url: 'https://private.example/',
    title: 'Secret',
  };

  it('is refused from a private window: nothing reaches the shared bookmarks', async () => {
    const { ctx } = await createContext(PRIVATE_WINDOW);

    handle(save, ctx);

    expect(ctx.savedPanels.save).not.toHaveBeenCalled();
  });

  it('still saves from a regular window', async () => {
    const { ctx } = await createContext(REGULAR_WINDOW);

    handle(save, ctx);

    expect(ctx.savedPanels.save).toHaveBeenCalledWith(
      'https://private.example/',
      'Secret',
      undefined,
    );
  });
});

describe('DevTools panel marker', () => {
  function stubSessions() {
    const setTabValue = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      sessions: { setTabValue, removeTabValue: vi.fn(async () => undefined) },
    });
    return setTabValue;
  }

  it('is not written for a DevTools panel of a private window', async () => {
    const { ctx, privateWorkspace } = await createContext(PRIVATE_WINDOW);
    const setTabValue = stubSessions();
    const addDevtoolsPanel = vi.fn(() => true);
    (ctx as unknown as { panels: unknown }).panels = { addDevtoolsPanel };

    handle(
      {
        type: 'panel/addDevtools',
        tabId: PRIVATE_TAB,
        forTabId: null,
        inspectedTabId: PRIVATE_TAB,
      },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(addDevtoolsPanel).toHaveBeenCalledWith(
      privateWorkspace.id,
      PRIVATE_TAB,
      null,
      PRIVATE_TAB,
    );
    expect(setTabValue).not.toHaveBeenCalled();
  });

  it('is written for a DevTools panel of a regular window', async () => {
    const { ctx } = await createContext(REGULAR_WINDOW);
    const setTabValue = stubSessions();
    (ctx as unknown as { panels: unknown }).panels = { addDevtoolsPanel: vi.fn(() => true) };

    handle(
      {
        type: 'panel/addDevtools',
        tabId: REGULAR_TAB,
        forTabId: null,
        inspectedTabId: REGULAR_TAB,
      },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(setTabValue).toHaveBeenCalledWith(REGULAR_TAB, 'bento.isDevtoolsPanel', '1');
  });
});
