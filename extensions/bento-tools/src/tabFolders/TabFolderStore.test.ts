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
});
