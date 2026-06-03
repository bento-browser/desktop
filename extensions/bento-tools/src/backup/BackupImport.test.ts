import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BentoExportSchema } from '@shared/protocol';
import { DEFAULT_SETTINGS } from '../settings/SettingsStore';
import { BackupStore, type BackupContext } from './BackupStore';
import { executeImport, type ImportContext } from './ImportExecutor';
import { validateExportSchema } from './ExportSchema';

const panelLayout: NonNullable<BentoExportSchema['workspaces'][number]['panelLayout']> = {
  root: [
    { kind: 'panel', panelKey: 'panel-0' },
    {
      kind: 'group',
      axis: 'vertical',
      id: 'vertical-1',
      ratio: 0.62,
      children: [
        { kind: 'panel', panelKey: 'panel-1' },
        {
          kind: 'group',
          axis: 'horizontal',
          id: 'horizontal-1',
          ratio: 0.38,
          children: [
            { kind: 'panel', panelKey: 'panel-2' },
            { kind: 'panel', panelKey: 'panel-3' },
          ],
        },
      ],
    },
  ],
};

describe('workspace backup import/export', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports current panel layout, panel widths, main width, and strip scroll', async () => {
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn(async (tabId: number) => {
          const tabs = new Map<number, { id: number; url: string }>([
            [1, { id: 1, url: 'https://main.example.test/' }],
            [11, { id: 11, url: 'https://panel-a.example.test/' }],
            [12, { id: 12, url: 'https://panel-b.example.test/' }],
            [13, { id: 13, url: 'https://panel-c.example.test/' }],
            [14, { id: 14, url: 'https://panel-d.example.test/' }],
          ]);
          const tab = tabs.get(tabId);
          if (!tab) throw new Error(`Missing tab ${tabId}`);
          return tab;
        }),
      },
    });

    const backup = new BackupStore({
      workspaces: {
        snapshot: () => ({
          workspaces: [
            {
              id: 'workspace-1',
              name: 'Workspace 1',
              createdAt: 123,
              themeId: 'ocean',
              icon: 'W',
            },
          ],
        }),
      },
      tabs: {
        snapshot: () => [
          { id: 1, workspaceId: 'workspace-1', title: 'Main', pinned: false },
          { id: 11, workspaceId: 'workspace-1', title: 'Panel A', pinned: false },
          { id: 12, workspaceId: 'workspace-1', title: 'Panel B', pinned: false },
          { id: 13, workspaceId: 'workspace-1', title: 'Panel C', pinned: false },
          { id: 14, workspaceId: 'workspace-1', title: 'Panel D', pinned: false },
        ],
      },
      panels: {
        getVisiblePanelIds: () => [11, 12, 13, 14],
        getMainWidth: () => 720,
        getStripScroll: () => 144,
        buildPanelPersistenceSnapshot: async () => ({
          entries: [
            {
              panelKey: 'panel-0',
              tabId: 11,
              url: 'https://panel-a.example.test/',
              widthPx: 360,
            },
            {
              panelKey: 'panel-1',
              tabId: 12,
              url: 'https://panel-b.example.test/',
              widthPx: 460,
            },
            { panelKey: 'panel-2', tabId: 13, url: 'https://panel-c.example.test/' },
            { panelKey: 'panel-3', tabId: 14, url: 'https://panel-d.example.test/' },
          ],
          layout: panelLayout,
        }),
      },
      pinnedPanels: {
        entriesForWorkspaceDetailed: () => [{ tabId: 13, order: 0 }],
      },
      settings: {
        snapshot: () => DEFAULT_SETTINGS,
      },
      savedPanels: {
        list: () => [{ title: 'Saved', url: 'https://saved.example.test/' }],
      },
    } as unknown as BackupContext);

    const snapshot = await backup.collectSnapshot();

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.workspaces[0]).toMatchObject({
      id: 'workspace-1',
      mainWidthPx: 720,
      stripScrollLeft: 144,
      tabs: [{ url: 'https://main.example.test/' }],
      panels: [
        { panelKey: 'panel-0', url: 'https://panel-a.example.test/', widthPx: 360 },
        { panelKey: 'panel-1', url: 'https://panel-b.example.test/', widthPx: 460 },
        { panelKey: 'panel-2', url: 'https://panel-c.example.test/' },
        { panelKey: 'panel-3', url: 'https://panel-d.example.test/' },
      ],
      panelLayout,
      pinnedPanels: [{ panelKey: 'panel-2', url: 'https://panel-c.example.test/', order: 0 }],
    });
  });

  it('imports panel layout state onto the new workspace', async () => {
    let nextTabId = 100;
    vi.stubGlobal('browser', {
      tabs: {
        create: vi.fn(async (options: { url: string }) => ({
          id: nextTabId++,
          url: options.url,
          active: false,
          pinned: false,
        })),
      },
    });

    const setWidth = vi.fn();
    const setMainWidth = vi.fn();
    const setStripScroll = vi.fn();
    const restorePersistedLayout = vi.fn();
    const addPinnedPanel = vi.fn();

    const ctx = {
      workspaces: {
        snapshot: () => ({ workspaces: [] }),
        create: vi.fn(() => ({ id: 'imported-workspace', name: 'Imported', createdAt: 456 })),
      },
      tabs: {
        assignWorkspace: vi.fn(async () => undefined),
      },
      panels: {
        setWidth,
        setMainWidth,
        setStripScroll,
        restorePersistedLayout,
      },
      pinnedPanels: {
        add: addPinnedPanel,
      },
      settings: {
        update: vi.fn(),
      },
      savedPanels: {
        save: vi.fn(),
      },
    } as unknown as ImportContext;

    const data: BentoExportSchema = {
      schemaVersion: 2,
      bentoVersion: '0.0.0',
      exportedAt: 789,
      workspaces: [
        {
          id: 'source-workspace',
          name: 'Imported',
          createdAt: 123,
          tabs: [],
          panels: [
            { panelKey: 'panel-0', url: 'https://panel-a.example.test/', widthPx: 360 },
            { panelKey: 'panel-1', url: 'https://panel-b.example.test/', widthPx: 460 },
            { panelKey: 'panel-2', url: 'https://panel-c.example.test/' },
            { panelKey: 'panel-3', url: 'https://panel-d.example.test/' },
          ],
          mainWidthPx: 720,
          stripScrollLeft: 144,
          panelLayout,
          pinnedPanels: [{ panelKey: 'panel-2', order: 0 }],
        },
      ],
      savedPanels: [],
    };

    const summary = await executeImport(
      data,
      { importSettings: false, importSavedPanels: false, replaceExisting: false },
      ctx,
    );

    expect(summary).toMatchObject({
      workspacesCreated: 1,
      tabsOpened: 4,
      panelsRestored: 4,
    });
    expect(setMainWidth).toHaveBeenCalledWith('imported-workspace', 720);
    expect(setStripScroll).toHaveBeenCalledWith('imported-workspace', 144);
    expect(setWidth).toHaveBeenCalledWith(100, 360);
    expect(setWidth).toHaveBeenCalledWith(101, 460);
    expect(restorePersistedLayout).toHaveBeenCalledTimes(1);
    const [, restoredLayout, restoredMap] = restorePersistedLayout.mock.calls[0]!;
    expect(restoredLayout).toBe(panelLayout);
    expect(Array.from((restoredMap as Map<string, number>).entries())).toEqual([
      ['panel-0', 100],
      ['panel-1', 101],
      ['panel-2', 102],
      ['panel-3', 103],
    ]);
    expect(addPinnedPanel).toHaveBeenCalledWith('imported-workspace', 102);
  });

  it('validates optional v2 workspace layout fields', () => {
    const valid: BentoExportSchema = {
      schemaVersion: 2,
      bentoVersion: '0.0.0',
      exportedAt: 1,
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Workspace 1',
          createdAt: 1,
          tabs: [],
          panels: [],
          mainWidthPx: 720,
          stripScrollLeft: 0,
          panelLayout: { root: [] },
          pinnedPanels: [],
        },
      ],
      savedPanels: [],
    };

    expect(validateExportSchema(valid)).toBe(valid);
    expect(validateExportSchema({ ...valid, schemaVersion: 1 })).toBeNull();
    expect(
      validateExportSchema({
        ...valid,
        workspaces: [{ ...valid.workspaces[0]!, mainWidthPx: '720' }],
      }),
    ).toBeNull();
    expect(
      validateExportSchema({
        ...valid,
        workspaces: [{ ...valid.workspaces[0]!, stripScrollLeft: -1 }],
      }),
    ).toBeNull();
  });
});
