import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type HandlerContext } from './protocol-handler';

function createCloseContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    tabs: {
      markClosing: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockReturnValue([]),
      isClosing: vi.fn().mockReturnValue(false),
    },
    workspaces: {
      getActiveId: vi.fn().mockReturnValue('ws-1'),
    },
    settings: {},
    panels: {
      findWorkspacesContainingTab: vi.fn().mockReturnValue(['ws-1']),
      getPanelLayoutStatus: vi.fn().mockReturnValue('root-panel'),
      remove: vi.fn().mockReturnValue(true),
    },
    pinnedPanels: {},
    savedPanels: {},
    backup: {},
    send: vi.fn(),
    emitPanelsSync: vi.fn(),
    syncPanelMarkers: vi.fn(),
    sourceWindowId: 1,
    ...overrides,
  } as unknown as HandlerContext;
}

describe('protocol handler panel close', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 123 }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('preserves panel session markers when closing a panel for Cmd+Shift+T restore', async () => {
    const ctx = createCloseContext();

    handle({ type: 'tab/close', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(123);
    });
    expect(browser.sessions.removeTabValue).not.toHaveBeenCalled();
    expect(ctx.panels.remove).toHaveBeenCalledWith('ws-1', 123);
    expect(ctx.syncPanelMarkers).toHaveBeenCalledWith('ws-1');
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1');
  });
});
