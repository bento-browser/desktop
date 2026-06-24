import { describe, expect, it, vi } from 'vitest';
import { TabFolderStore } from './TabFolderStore';

function mockStorage() {
  const storage = new Map<string, unknown>();
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(obj)) storage.set(key, value);
        }),
      },
    },
  });
}

describe('TabFolderStore', () => {
  it('creates, renames, collapses, reorders, and removes folders', async () => {
    mockStorage();
    vi.useFakeTimers();
    const store = new TabFolderStore();
    await store.init();
    const seen: unknown[] = [];
    store.onDeltas((deltas) => seen.push(...deltas));

    const a = store.create({ id: 'a', workspaceId: 'ws-1', name: 'A' });
    const b = store.create({ id: 'b', workspaceId: 'ws-1', name: 'B' });
    expect(a.order).toBe(0);
    expect(a.collapsed).toBe(false);
    expect(b.order).toBe(1);
    expect(store.rename('a', 'Renamed')).toBe(true);
    expect(store.setCollapsed('a', true)).toBe(true);
    expect(store.reorder('ws-1', ['b', 'a'])).toBe(true);
    expect(store.foldersForWorkspace('ws-1').map((folder) => folder.id)).toEqual(['b', 'a']);
    expect(store.delete('a')?.id).toBe('a');

    vi.runOnlyPendingTimers();
    expect(seen.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('allows callers to create a folder already collapsed', async () => {
    mockStorage();
    const store = new TabFolderStore();
    await store.init();

    const folder = store.create({
      id: 'collapsed-folder',
      workspaceId: 'ws-1',
      name: 'Collapsed',
      collapsed: true,
    });

    expect(folder.collapsed).toBe(true);
    expect(store.get('collapsed-folder')?.collapsed).toBe(true);
  });

  it('moves a folder to the end of another workspace', async () => {
    mockStorage();
    const store = new TabFolderStore();
    await store.init();

    store.create({ id: 'a', workspaceId: 'ws-1', name: 'A' });
    store.create({ id: 'b', workspaceId: 'ws-2', name: 'B' });
    store.create({ id: 'c', workspaceId: 'ws-2', name: 'C' });

    const moved = store.moveToWorkspace('a', 'ws-2');

    expect(moved).toMatchObject({ id: 'a', workspaceId: 'ws-2', order: 2 });
    expect(store.foldersForWorkspace('ws-1')).toEqual([]);
    expect(store.foldersForWorkspace('ws-2').map((folder) => folder.id)).toEqual(['b', 'c', 'a']);
  });
});
