import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings/SettingsStore';
import { BackupStore, type BackupContext } from './BackupStore';

describe('BackupStore privacy safety', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters private normal tabs, panels, layouts, and pins', async () => {
    const liveTabs = new Map([
      [1, { id: 1, url: 'https://regular.example/', incognito: false }],
      [2, { id: 2, url: 'https://private.example/', incognito: true }],
      [11, { id: 11, url: 'https://regular-panel.example/', incognito: false }],
      [12, { id: 12, url: 'https://private-panel.example/', incognito: true }],
    ]);
    vi.stubGlobal('browser', {
      tabs: { get: vi.fn(async (id: number) => liveTabs.get(id)) },
    });

    const store = new BackupStore({
      workspaces: {
        snapshot: () => ({
          workspaces: [{ id: 'workspace', name: 'Workspace', createdAt: 1 }],
        }),
      },
      tabs: {
        snapshot: () => [
          { id: 1, workspaceId: 'workspace', title: 'Regular', pinned: false },
          { id: 2, workspaceId: 'workspace', title: 'Private', pinned: false },
          { id: 11, workspaceId: 'workspace', title: 'Regular panel', pinned: false },
          { id: 12, workspaceId: 'workspace', title: 'Private panel', pinned: false },
        ],
      },
      panels: {
        getVisiblePanelIds: () => [11, 12],
        getMainWidth: () => undefined,
        getStripScroll: () => undefined,
        buildPanelPersistenceSnapshot: async (
          _workspaceId: string,
          resolveUrl: (tabId: number) => Promise<string | undefined>,
        ) => {
          const entries = [];
          for (const [tabId, panelKey] of [
            [11, 'regular-panel'],
            [12, 'private-panel'],
          ] as const) {
            const url = await resolveUrl(tabId);
            if (url) entries.push({ tabId, panelKey, url });
          }
          return {
            entries,
            layout: {
              root: entries.map((entry) => ({ kind: 'panel' as const, panelKey: entry.panelKey })),
            },
          };
        },
      },
      pinnedPanels: {
        entriesForWorkspaceDetailed: () => [
          { tabId: 11, order: 0 },
          { tabId: 12, order: 1 },
        ],
      },
      settings: { snapshot: () => DEFAULT_SETTINGS },
      savedPanels: { list: () => [] },
    } as unknown as BackupContext);

    const snapshot = await store.collectSnapshot();
    expect(snapshot.workspaces[0]).toMatchObject({
      tabs: [{ url: 'https://regular.example/' }],
      panels: [{ panelKey: 'regular-panel', url: 'https://regular-panel.example/' }],
      panelLayout: { root: [{ kind: 'panel', panelKey: 'regular-panel' }] },
      pinnedPanels: [
        { panelKey: 'regular-panel', url: 'https://regular-panel.example/', order: 0 },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private.example');
  });

  it('marks untagged version-one backups as legacy unknown', async () => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({
            'bento.backups': {
              version: 1,
              entries: [
                {
                  id: 'legacy',
                  createdAt: 1,
                  data: { schemaVersion: 2, bentoVersion: '0', exportedAt: 1, workspaces: [] },
                },
                {
                  id: 'safe',
                  createdAt: 2,
                  privacySafety: 'private-filtered-v1',
                  data: { schemaVersion: 2, bentoVersion: '0', exportedAt: 2, workspaces: [] },
                },
              ],
            },
          })),
        },
      },
    });

    const store = new BackupStore({} as BackupContext);
    await expect(store.listBackups()).resolves.toMatchObject([
      { id: 'legacy', privacySafety: 'legacy-unknown' },
      { id: 'safe', privacySafety: 'private-filtered-v1' },
    ]);
  });
});
