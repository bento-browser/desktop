// A private window's temporary "Private" workspace: kept out of every regular list
// and out of every store that writes to disk.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDelta } from '@shared/protocol';
import { WorkspaceStore } from './WorkspaceStore';
import { isEphemeralWorkspaceId } from './ephemeral';
import { Persistence as FolderPersistence } from '../tabFolders/Persistence';
import { Persistence as PinPersistence } from '../pinnedPanels/Persistence';
import { Persistence as PanelPersistence } from '../panels/Persistence';
import { emptyLayout, addPanel } from '../panels/PanelLayout';

describe('WorkspaceStore Private workspace', () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (payload: Record<string, unknown>) => {
            Object.assign(storage, payload);
          }),
        },
      },
      windows: { getAll: vi.fn(async () => []) },
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

  async function readyStore() {
    const store = new WorkspaceStore();
    await store.init();
    await vi.advanceTimersByTimeAsync(1000);
    return store;
  }

  it('is an in-memory workspace named Private, owned by one window', async () => {
    const store = await readyStore();

    const workspace = store.ensurePrivate(9);

    expect(workspace).toMatchObject({ name: 'Private', private: true });
    expect(isEphemeralWorkspaceId(workspace.id)).toBe(true);
    expect(store.ensurePrivate(9)).toBe(workspace);
    expect(store.getActiveId(9)).toBe(workspace.id);
    expect(store.privateWindowOf(workspace.id)).toBe(9);
    expect(store.snapshotForPrivateWindow(9)).toEqual({
      workspaces: [workspace],
      activeId: null,
      activeIdByWindow: { 9: workspace.id },
    });
  });

  it('never appears in the regular snapshot, the regular delta stream, or the other windows', async () => {
    const store = await readyStore();
    const regularDeltas: WorkspaceDelta[] = [];
    store.onDeltas((deltas) => void regularDeltas.push(...deltas));
    const privateDeltas: Array<[number, WorkspaceDelta[]]> = [];
    store.onPrivateDeltas((windowId, deltas) => privateDeltas.push([windowId, deltas]));

    const workspace = store.ensurePrivate(9);
    await vi.advanceTimersByTimeAsync(1000);

    const snapshot = store.snapshot();
    expect(snapshot.workspaces.map(({ id }) => id)).not.toContain(workspace.id);
    expect(Object.values(snapshot.activeIdByWindow)).not.toContain(workspace.id);
    expect(snapshot.activeId).not.toBe(workspace.id);
    expect(store.has(workspace.id)).toBe(false);
    expect(store.getActiveId(2)).not.toBe(workspace.id);
    expect(regularDeltas).toEqual([]);
    expect(privateDeltas).toEqual([
      [
        9,
        [
          { kind: 'created', workspace },
          { kind: 'activated', id: workspace.id, windowId: 9 },
        ],
      ],
    ]);
  });

  it('writes nothing to storage or the session store', async () => {
    const store = await readyStore();
    store.create({ name: 'Work' }, 1);
    await vi.advanceTimersByTimeAsync(1000);
    vi.mocked(browser.storage.local.set).mockClear();
    vi.mocked(browser.sessions.setWindowValue).mockClear();

    const workspace = store.ensurePrivate(9);
    store.rename('x', 'y');
    await store.persistCurrentState();
    await vi.advanceTimersByTimeAsync(1000);

    expect(JSON.stringify(storage)).not.toContain(workspace.id);
    expect(JSON.stringify(vi.mocked(browser.storage.local.set).mock.calls)).not.toContain(
      workspace.id,
    );
    expect(browser.sessions.setWindowValue).not.toHaveBeenCalled();
  });

  it('never gives a private window a regular workspace, and refuses every cross switch', async () => {
    const store = await readyStore();
    const regular = store.snapshot().workspaces[0]!;
    const privateWorkspace = store.ensurePrivate(9);

    expect(store.assignAvailable(9)).toBeNull();
    expect(store.activate(regular.id, 9)).toBe('noop');
    expect(store.activate(privateWorkspace.id, 1)).toBe('noop');
    expect(store.getActiveId(9)).toBe(privateWorkspace.id);
    expect(store.snapshot().activeIdByWindow[9]).toBeUndefined();
    expect(() => store.create({ name: 'New' }, 9)).toThrow(/private window/);
  });

  it('is among the shown workspaces a chrome-bound change must re-sync, until its window goes', async () => {
    const store = await readyStore();
    const regular = store.snapshot().workspaces[0]!;
    store.activate(regular.id, 1);
    const privateWorkspace = store.ensurePrivate(9);

    expect(store.shownWorkspaceIds()).toEqual(new Set([regular.id, privateWorkspace.id]));

    store.forgetPrivateWindow(9);
    expect(store.shownWorkspaceIds()).toEqual(new Set([regular.id]));
  });

  it('exists for its own window only; workspace mutations keep the regular-only check', async () => {
    const store = await readyStore();
    const regular = store.snapshot().workspaces[0]!;
    const mine = store.ensurePrivate(9);
    const other = store.ensurePrivate(10);

    expect(store.hasForWindow(mine.id, 9)).toBe(true);
    expect(store.hasForWindow(other.id, 9)).toBe(false);
    expect(store.hasForWindow(regular.id, 9)).toBe(false);
    expect(store.hasForWindow(mine.id, 1)).toBe(false);
    expect(store.hasForWindow(regular.id, 1)).toBe(true);
    expect(store.hasForWindow(regular.id, null)).toBe(true);
    expect(store.has(mine.id)).toBe(false);
  });

  it('is not picked as a replacement when a regular workspace is deleted', async () => {
    const store = await readyStore();
    const first = store.snapshot().workspaces[0]!;
    store.activate(first.id, 1);
    store.ensurePrivate(9);

    store.delete(first.id);

    expect(store.snapshot().workspaces).toEqual([]);
    expect(store.getActiveId(1)).toBeNull();
  });

  it('is discarded with its window and announced as removed to that window only', async () => {
    const store = await readyStore();
    const privateDeltas: Array<[number, WorkspaceDelta[]]> = [];
    const workspace = store.ensurePrivate(9);
    store.onPrivateDeltas((windowId, deltas) => privateDeltas.push([windowId, deltas]));

    expect(store.forgetPrivateWindow(9)).toBe(workspace);

    expect(privateDeltas).toEqual([[9, [{ kind: 'removed', id: workspace.id }]]]);
    expect(store.privateWorkspaceOf(9)).toBeUndefined();
    expect(store.ensurePrivate(9).id).not.toBe(workspace.id);
  });
});

describe('persistence boundaries skip the Private workspace', () => {
  let storage: Record<string, unknown>;
  const PRIVATE_ID = 'private:abc';

  beforeEach(() => {
    storage = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) =>
            Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, storage[k]])),
          ),
          set: vi.fn(
            async (payload: Record<string, unknown>) => void Object.assign(storage, payload),
          ),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          }),
        },
      },
      tabs: { get: vi.fn(async (id: number) => ({ id, url: `https://${id}.example.test/` })) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tab folders', async () => {
    const persistence = new FolderPersistence();
    persistence.schedule({
      folders: [
        { id: 'f1', workspaceId: 'ws-1', name: 'Kept', order: 0, collapsed: false, createdAt: 1 },
        {
          id: 'f2',
          workspaceId: PRIVATE_ID,
          name: 'Secret',
          order: 0,
          collapsed: false,
          createdAt: 1,
        },
      ],
    });
    await vi.waitFor(() => expect(storage['bento.tabFolders']).toBeTruthy(), { timeout: 2000 });

    expect(JSON.stringify(storage)).not.toContain('Secret');
    expect(JSON.stringify(storage)).toContain('Kept');
  });

  it('pinned panels', async () => {
    const persistence = new PinPersistence();
    await persistence.flushNow({
      entries: [
        { workspaceId: 'ws-1', url: 'https://kept.example.test/', order: 0 },
        { workspaceId: PRIVATE_ID, url: 'https://secret.example.test/', order: 0 },
      ],
    });

    expect(JSON.stringify(storage)).not.toContain('secret');
    expect(JSON.stringify(storage)).toContain('kept');
  });

  it('panel layouts, main widths and strip scroll positions', async () => {
    const regularLayout = emptyLayout();
    addPanel(regularLayout, 101);
    const privateLayout = emptyLayout();
    addPanel(privateLayout, 202);

    await new PanelPersistence().flushNow(
      new Map([
        ['ws-1', regularLayout],
        [PRIVATE_ID, privateLayout],
      ]),
      new Map(),
      new Map([[202, 480]]),
      new Map(),
      new Map([
        ['ws-1', 700],
        [PRIVATE_ID, 800],
      ]),
      new Map([
        ['ws-1', 10],
        [PRIVATE_ID, 20],
      ]),
    );

    const written = JSON.stringify(storage);
    expect(written).toContain('101.example.test');
    expect(written).not.toContain('202.example.test');
    expect(written).not.toContain(PRIVATE_ID);
  });
});
