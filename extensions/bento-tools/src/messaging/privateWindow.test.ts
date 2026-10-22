// What the protocol handler does for, and refuses from, a private window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Event } from '@shared/protocol';
import { handle, type HandlerContext } from './protocol-handler';
import { WorkspaceStore } from '../workspaces/WorkspaceStore';
import { createWindowHandoffGuard } from '../workspaces/EmptiedWorkspace';
import { createWindowRegistry } from './shell-action-intake';

const PRIVATE_WINDOW = 9;
const REGULAR_WINDOW = 1;

async function createContext(sourceWindowId: number | null) {
  const workspaces = new WorkspaceStore();
  await workspaces.init();
  const privateWorkspace = workspaces.ensurePrivate(PRIVATE_WINDOW);
  const privateTab = { id: 900, windowId: PRIVATE_WINDOW, workspaceId: privateWorkspace.id };
  const regularTab = { id: 5, windowId: REGULAR_WINDOW, workspaceId: 'ws-regular' };
  const send = vi.fn();
  const sendAudience = vi.fn();
  const settings = {
    update: vi.fn(async () => ({})),
    reset: vi.fn(async () => ({ settings: {} })),
  };
  const ctx = {
    tabs: {
      snapshot: vi.fn(() => [regularTab, privateTab]),
      snapshotRegular: vi.fn(() => [regularTab]),
      snapshotPrivate: vi.fn(() => [privateTab]),
      isPrivate: vi.fn((id: number) => id === privateTab.id),
      isClosing: vi.fn(() => false),
      assignWorkspace: vi.fn(),
    },
    workspaces,
    settings,
    panels: { getVisiblePanelIds: vi.fn(() => []) },
    pinnedPanels: { entries: vi.fn(() => [{ tabId: 5 }]) },
    tabFolders: {
      snapshot: vi.fn(() => [{ id: 'f1', workspaceId: 'ws-regular' }]),
      create: vi.fn(),
    },
    savedPanels: {},
    backup: {
      exportData: vi.fn(),
      requestList: vi.fn(),
      restore: vi.fn(),
      delete: vi.fn(),
      listBackups: vi.fn(),
    },
    send,
    sendAudience,
    syncPrivateWindow: vi.fn(),
    emitPanelsSync: vi.fn(),
    syncPanelMarkers: vi.fn(),
    handoff: createWindowHandoffGuard(),
    preferWorkspaceActivationTab: vi.fn(),
    sourceWindowId,
    sourceWindowPrivate: sourceWindowId === PRIVATE_WINDOW,
  } as unknown as HandlerContext;
  return { ctx, workspaces, privateWorkspace, send, sendAudience, settings };
}

describe('private window protocol handling', () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('shell/hello', () => {
    it('never claims or creates a regular workspace', async () => {
      const { ctx, workspaces } = await createContext(PRIVATE_WINDOW);
      const assign = vi.spyOn(workspaces, 'assignAvailable');
      const create = vi.spyOn(workspaces, 'create');
      const before = workspaces.snapshot();

      handle({ type: 'shell/hello', windowId: PRIVATE_WINDOW }, ctx);

      expect(assign).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(workspaces.snapshot()).toEqual(before);
      expect(ctx.syncPrivateWindow).toHaveBeenCalledWith(PRIVATE_WINDOW);
    });

    it('is idempotent: the window keeps one Private workspace', async () => {
      const { ctx, workspaces, privateWorkspace } = await createContext(PRIVATE_WINDOW);

      handle({ type: 'shell/hello', windowId: PRIVATE_WINDOW }, ctx);
      handle({ type: 'shell/hello', windowId: PRIVATE_WINDOW }, ctx);

      expect(workspaces.privateWorkspaceOf(PRIVATE_WINDOW)).toBe(privateWorkspace);
    });
  });

  describe('refused from a private window', () => {
    const refused: Action[] = [
      { type: 'workspace/create', name: 'x' } as Action,
      { type: 'workspace/activate', id: 'ws-regular' },
      { type: 'workspace/delete', id: 'ws-regular' },
      { type: 'tab/assignWorkspace', id: 900, workspaceId: 'ws-regular' },
      { type: 'tabs/assignWorkspace', ids: [900], workspaceId: 'ws-regular' },
      { type: 'tabs/moveToNewWorkspace', ids: [900] },
      { type: 'tabFolder/create', name: 'f', tabIds: [900] } as Action,
      { type: 'tabs/setFolder', ids: [900], folderId: 'f1' },
      { type: 'pinnedPanel/add', tabId: 900 } as Action,
      { type: 'backup/export' },
      { type: 'backup/requestList' },
      { type: 'backup/restore', backupId: 'b1' },
      { type: 'backup/delete', backupId: 'b1' },
      { type: 'externalMerge/requestSources', requestId: 'r1' },
    ];

    it.each(refused)('drops $type', async (action) => {
      const { ctx, workspaces, send, sendAudience } = await createContext(PRIVATE_WINDOW);
      const spies = [
        vi.spyOn(workspaces, 'create'),
        vi.spyOn(workspaces, 'activate'),
        vi.spyOn(workspaces, 'delete'),
      ];
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      handle(action as never, ctx);
      await vi.advanceTimersByTimeAsync(100);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(ctx.tabs.assignWorkspace).not.toHaveBeenCalled();
      expect(Object.values(ctx.backup)).toSatisfy((fns: Array<ReturnType<typeof vi.fn>>) =>
        fns.every((fn) => fn.mock.calls.length === 0),
      );
      expect(send).not.toHaveBeenCalled();
      expect(sendAudience).not.toHaveBeenCalled();
    });
  });

  // A private window keeps its own sidebar collapse, hidden state and colour mode in
  // the shell background; the saved ones belong to the regular windows.
  describe('settings', () => {
    it('saves none of the window-local settings from a private window', async () => {
      const { ctx, settings } = await createContext(PRIVATE_WINDOW);

      handle(
        {
          type: 'settings/update',
          changes: { sidebarCollapsed: true, sidebarHidden: true, uiColorMode: 'dark' },
        },
        ctx,
      );

      expect(settings.update).not.toHaveBeenCalled();
    });

    it('still saves the other settings of a private update', async () => {
      const { ctx, settings } = await createContext(PRIVATE_WINDOW);

      handle(
        {
          type: 'settings/update',
          changes: { sidebarCollapsed: true, uiColorMode: 'dark', panelCornerRadiusPx: 12 },
        },
        ctx,
      );

      expect(settings.update).toHaveBeenCalledExactlyOnceWith({ panelCornerRadiusPx: 12 });
    });

    it('saves the window-local settings from a regular window', async () => {
      const { ctx, settings } = await createContext(REGULAR_WINDOW);
      const changes = {
        sidebarCollapsed: true,
        sidebarHidden: false,
        uiColorMode: 'dark',
      } as const;

      handle({ type: 'settings/update', changes }, ctx);

      expect(settings.update).toHaveBeenCalledExactlyOnceWith(changes);
    });

    it('does not let a private window reset the saved settings', async () => {
      const { ctx, settings } = await createContext(PRIVATE_WINDOW);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      handle({ type: 'settings/reset' }, ctx);
      await vi.advanceTimersByTimeAsync(100);

      expect(settings.reset).not.toHaveBeenCalled();
    });
  });

  describe('refused from a regular window', () => {
    it('moving a tab into a Private workspace, or a private tab out of one', async () => {
      const { ctx, privateWorkspace } = await createContext(REGULAR_WINDOW);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      handle({ type: 'tab/assignWorkspace', id: 5, workspaceId: privateWorkspace.id }, ctx);
      handle({ type: 'tabs/assignWorkspace', ids: [5], workspaceId: privateWorkspace.id }, ctx);
      handle({ type: 'tab/assignWorkspace', id: 900, workspaceId: 'ws-regular' }, ctx);
      handle({ type: 'tabs/assignWorkspace', ids: [5, 900], workspaceId: 'ws-regular' }, ctx);
      handle({ type: 'tabs/moveToNewWorkspace', ids: [900] }, ctx);
      await vi.advanceTimersByTimeAsync(100);

      expect(ctx.tabs.assignWorkspace).not.toHaveBeenCalled();
    });

    it('switching to a Private workspace', async () => {
      const { ctx, workspaces, privateWorkspace } = await createContext(REGULAR_WINDOW);

      handle({ type: 'workspace/activate', id: privateWorkspace.id }, ctx);

      expect(workspaces.getActiveId(REGULAR_WINDOW)).not.toBe(privateWorkspace.id);
      expect(workspaces.getActiveId(PRIVATE_WINDOW)).toBe(privateWorkspace.id);
    });
  });

  describe('snapshot replies go to the audience that asked', () => {
    function lastReply(mock: ReturnType<typeof vi.fn>, type: Event['type']) {
      return mock.mock.calls
        .map(([audience, event]) => ({ audience, event: event as Event }))
        .find(({ event }) => event.type === type);
    }

    it('a private window gets its own tab and Private workspace, and no pins or folders', async () => {
      const { ctx, sendAudience, privateWorkspace } = await createContext(PRIVATE_WINDOW);
      const audience = { privateWindowId: PRIVATE_WINDOW };

      handle({ type: 'tabs/requestSnapshot' }, ctx);
      handle({ type: 'workspaces/requestSnapshot' }, ctx);
      handle({ type: 'pinnedPanels/requestSnapshot' }, ctx);
      handle({ type: 'tabFolders/requestSnapshot' }, ctx);

      expect(lastReply(sendAudience, 'tabs/snapshot')).toEqual({
        audience,
        event: { type: 'tabs/snapshot', tabs: [expect.objectContaining({ id: 900 })] },
      });
      expect(lastReply(sendAudience, 'workspaces/snapshot')).toMatchObject({
        audience,
        event: {
          workspaces: [expect.objectContaining({ id: privateWorkspace.id, private: true })],
          activeId: null,
          activeIdByWindow: { [PRIVATE_WINDOW]: privateWorkspace.id },
        },
      });
      expect(lastReply(sendAudience, 'pinnedPanels/snapshot')?.event).toMatchObject({
        entries: [],
      });
      expect(lastReply(sendAudience, 'tabFolders/snapshot')?.event).toMatchObject({ folders: [] });
      expect(ctx.emitPanelsSync).toHaveBeenCalledWith(privateWorkspace.id);
    });

    it('a regular window gets the regular graph and never the Private workspace', async () => {
      const { ctx, sendAudience, privateWorkspace } = await createContext(REGULAR_WINDOW);

      handle({ type: 'tabs/requestSnapshot' }, ctx);
      handle({ type: 'workspaces/requestSnapshot' }, ctx);

      expect(lastReply(sendAudience, 'tabs/snapshot')).toEqual({
        audience: 'regular',
        event: { type: 'tabs/snapshot', tabs: [expect.objectContaining({ id: 5 })] },
      });
      const workspaces = lastReply(sendAudience, 'workspaces/snapshot');
      expect(workspaces?.audience).toBe('regular');
      expect(JSON.stringify(workspaces?.event)).not.toContain(privateWorkspace.id);
    });
  });
});

describe('window registry announces private windows first', () => {
  it('runs the hook before the window counts as live', async () => {
    const seen: string[] = [];
    const created: Array<(window: { id?: number; incognito?: boolean }) => void> = [];
    const registry = createWindowRegistry(
      {
        get: vi.fn(async () => ({ id: 3, incognito: true })),
        getAll: vi.fn(async () => [{ id: 1, incognito: false }]),
        onCreated: { addListener: (listener) => void created.push(listener) },
        onRemoved: { addListener: () => undefined },
      },
      50,
      (window) => seen.push(`hook ${window.id} ${registry.isLive(window.id ?? -1)}`),
    );

    await registry.confirm(1);
    created[0]!({ id: 2, incognito: true });
    await registry.confirm(3);

    expect(seen).toEqual(['hook 1 false', 'hook 2 false', 'hook 3 false']);
    expect(registry.isLive(2)).toBe(true);
    expect(registry.isLive(3)).toBe(true);
  });
});
