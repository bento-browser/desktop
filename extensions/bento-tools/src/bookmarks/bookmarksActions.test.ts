import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Event } from '@shared/protocol';
import { handle, type HandlerContext } from '../messaging/protocol-handler';
import { createWindowHandoffGuard } from '../workspaces/EmptiedWorkspace';
import { BookmarksStore } from './BookmarksStore';
import { STORAGE_KEY } from './Persistence';

const REGULAR_WINDOW = 1;
const PRIVATE_WINDOW = 9;

async function createBookmarks(): Promise<BookmarksStore> {
  const bookmarks = new BookmarksStore();
  await bookmarks.init();
  return bookmarks;
}

/** A handler context with only what the Bookmarks actions and the panel and tab open paths read. */
function createContext(bookmarks: BookmarksStore, sourceWindowId: number) {
  const send = vi.fn<(event: Event) => void>();
  const sendAudience = vi.fn<(audience: unknown, event: Event) => void>();
  const panels = {
    getRootNodeIds: vi.fn(() => ['panel:1']),
    insertAt: vi.fn(() => true),
    setWidth: vi.fn(),
  };
  const tabs = { assignWorkspaceEagerly: vi.fn() };
  const ctx = {
    bookmarks,
    tabs,
    panels,
    workspaces: { getActiveId: vi.fn(() => 'ws-1') },
    settings: { snapshot: vi.fn(() => ({ defaultPanelWidthPx: 0 })) },
    send,
    sendAudience,
    emitPanelsSync: vi.fn(),
    syncPanelMarkers: vi.fn(),
    handoff: createWindowHandoffGuard(),
    preferWorkspaceActivationTab: vi.fn(),
    sourceWindowId,
    sourceWindowPrivate: sourceWindowId === PRIVATE_WINDOW,
  } as unknown as HandlerContext;
  return { ctx, send, sendAudience, panels, tabs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('browser', {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    tabs: {
      create: vi.fn(async () => ({ id: 77, windowId: REGULAR_WINDOW })),
      update: vi.fn(async () => ({ id: 77 })),
      get: vi.fn(async () => {
        throw new Error('Invalid tab ID');
      }),
    },
    bookmarks: { getTree: vi.fn(async () => []) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every `bookmarks/` action, with ids that do not exist: refusal must come before any store call. */
const ALL_ACTIONS: Action[] = [
  { type: 'bookmarks/requestSnapshot' },
  { type: 'bookmarks/space/create', name: 'x' },
  { type: 'bookmarks/space/update', id: 'x', name: 'y' },
  { type: 'bookmarks/space/delete', id: 'x' },
  { type: 'bookmarks/space/select', id: 'x' },
  { type: 'bookmarks/group/create', spaceId: 'x', name: 'y' },
  { type: 'bookmarks/group/update', id: 'x', name: 'y' },
  { type: 'bookmarks/group/delete', id: 'x' },
  { type: 'bookmarks/group/move', id: 'x', spaceId: 'y', beforeId: null },
  { type: 'bookmarks/item/create', groupId: 'x', beforeId: null, item: { kind: 'note', text: '' } },
  { type: 'bookmarks/item/update', id: 'x', text: 'y' },
  { type: 'bookmarks/item/delete', id: 'x' },
  { type: 'bookmarks/item/move', id: 'x', groupId: 'y', beforeId: null },
  { type: 'bookmarks/item/open', id: 'x', where: 'tab' },
  { type: 'bookmarks/tabs/save', spaceId: 'x', groupId: null, tabIds: [1] },
  { type: 'bookmarks/import/firefox' },
  { type: 'bookmarks/import/dismiss' },
];

describe('bookmarks actions through the protocol handler', () => {
  it('replies to requestSnapshot to the asking window only', async () => {
    const bookmarks = await createBookmarks();
    const { ctx, send, sendAudience } = createContext(bookmarks, REGULAR_WINDOW);

    handle({ type: 'bookmarks/requestSnapshot' }, ctx);

    expect(sendAudience).toHaveBeenCalledWith('regular', {
      type: 'bookmarks/snapshot',
      snapshot: bookmarks.snapshot(),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('holds actions that arrive before the stored data has loaded', async () => {
    const stored = new Map<string, unknown>();
    const read = vi.fn(async (key: string) => ({ [key]: stored.get(key) }));
    vi.mocked(browser.storage.local.get).mockImplementation(read as never);
    vi.mocked(browser.storage.local.set).mockImplementation((async (
      values: Record<string, unknown>,
    ) => {
      for (const [key, value] of Object.entries(values)) stored.set(key, value);
    }) as never);
    const first = await createBookmarks();
    first.createGroup(first.snapshot().spaces[0]!.id, 'Stored');
    await first.flush();

    let releaseRead = () => {};
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    read.mockImplementationOnce(async (key) => {
      await gate;
      return { [key]: stored.get(key) };
    });
    const bookmarks = new BookmarksStore();
    const init = bookmarks.init();
    const { ctx, sendAudience } = createContext(bookmarks, REGULAR_WINDOW);

    // The shell may act before the store has read anything.
    const spaceId = crypto.randomUUID();
    handle({ type: 'bookmarks/space/create', id: spaceId, name: 'Early' }, ctx);
    handle({ type: 'bookmarks/requestSnapshot' }, ctx);
    expect(bookmarks.snapshot().spaces).toEqual([]);
    expect(sendAudience).not.toHaveBeenCalled();

    releaseRead();
    await init;
    await bookmarks.flush();

    const snapshot = bookmarks.snapshot();
    expect(snapshot.groups.map((group) => group.name)).toEqual(['Stored']);
    expect(snapshot.spaces.map((space) => space.name)).toEqual(['Personal', 'Early']);
    // The reply carries the state after the queued create.
    expect(sendAudience).toHaveBeenCalledWith('regular', {
      type: 'bookmarks/snapshot',
      snapshot,
    });
    const written = stored.get(STORAGE_KEY) as { groups: unknown[]; spaces: unknown[] };
    expect(written.groups).toHaveLength(1);
    expect(written.spaces).toHaveLength(2);
  });

  it('refuses mutations after a failed load and retries it on requestSnapshot', async () => {
    const stored = new Map<string, unknown>();
    vi.mocked(browser.storage.local.get).mockImplementation((async (key: string) => ({
      [key]: stored.get(key),
    })) as never);
    const first = await createBookmarks();
    first.createGroup(first.snapshot().spaces[0]!.id, 'Stored');
    await first.flush();
    const writes = vi.mocked(browser.storage.local.set);
    writes.mockClear();

    vi.mocked(browser.storage.local.get).mockRejectedValueOnce(new Error('disk'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bookmarks = new BookmarksStore();
    await bookmarks.init();
    const { ctx, sendAudience } = createContext(bookmarks, REGULAR_WINDOW);

    handle({ type: 'bookmarks/space/create', name: 'Refused' }, ctx);
    handle({ type: 'bookmarks/import/dismiss' }, ctx);
    await vi.advanceTimersByTimeAsync(100);
    expect(bookmarks.snapshot()).toMatchObject({ status: 'loadFailed', spaces: [] });
    expect(writes).not.toHaveBeenCalled();

    // Retry: the reply is the loaded state, and edits work again.
    stored.set(STORAGE_KEY, {
      spaces: [{ id: 's1', name: 'Back', order: 0 }],
      groups: [],
      items: [],
    });
    handle({ type: 'bookmarks/requestSnapshot' }, ctx);
    await vi.waitFor(() => expect(sendAudience).toHaveBeenCalled());
    const reply = sendAudience.mock.calls.at(-1)![1] as Extract<
      Event,
      { type: 'bookmarks/snapshot' }
    >;
    expect(reply.snapshot.status).toBe('ready');
    expect(reply.snapshot.spaces.map((space) => space.name)).toEqual(['Back']);
    handle({ type: 'bookmarks/space/create', name: 'Accepted' }, ctx);
    expect(bookmarks.snapshot().spaces.map((space) => space.name)).toEqual(['Back', 'Accepted']);
  });

  it('passes client ids, to-do state and the tabs/save placement through', async () => {
    const bookmarks = await createBookmarks();
    const { ctx } = createContext(bookmarks, REGULAR_WINDOW);
    const [spaceId, groupId, todoId, tabItemId] = Array.from({ length: 4 }, () =>
      crypto.randomUUID(),
    );
    vi.mocked(browser.tabs.get).mockImplementation((async (id: number) => ({
      id,
      url: `https://tab${id}.example/`,
      title: `Tab ${id}`,
    })) as never);

    handle({ type: 'bookmarks/space/create', id: spaceId, name: 'Work' }, ctx);
    handle({ type: 'bookmarks/group/create', id: groupId, spaceId: spaceId!, name: 'Inbox' }, ctx);
    handle(
      {
        type: 'bookmarks/item/create',
        id: todoId,
        groupId: groupId!,
        beforeId: null,
        item: { kind: 'todo', text: 'Ship', done: true },
      },
      ctx,
    );
    handle(
      {
        type: 'bookmarks/tabs/save',
        spaceId: spaceId!,
        groupId: groupId!,
        tabIds: [7],
        beforeId: todoId!,
        ids: [tabItemId!],
      },
      ctx,
    );
    await vi.waitFor(() => expect(bookmarks.snapshot().items).toHaveLength(2));

    const snapshot = bookmarks.snapshot();
    expect(snapshot.spaces.at(-1)).toMatchObject({ id: spaceId, name: 'Work' });
    expect(snapshot.groups[0]).toMatchObject({ id: groupId, spaceId });
    expect(snapshot.items.map((item) => item.id)).toEqual([tabItemId, todoId]);
    expect(snapshot.items[1]).toMatchObject({ kind: 'todo', done: true });
  });

  it('applies mutations to the store', async () => {
    const bookmarks = await createBookmarks();
    const { ctx } = createContext(bookmarks, REGULAR_WINDOW);
    const spaceId = bookmarks.snapshot().spaces[0]!.id;

    handle({ type: 'bookmarks/group/create', spaceId, name: 'Reading' }, ctx);
    const groupId = bookmarks.snapshot().groups[0]!.id;
    handle(
      {
        type: 'bookmarks/item/create',
        groupId,
        beforeId: null,
        item: { kind: 'link', url: 'https://example.com/', title: 'Example' },
      },
      ctx,
    );
    handle(
      { type: 'bookmarks/item/update', id: bookmarks.snapshot().items[0]!.id, title: 'Ex' },
      ctx,
    );
    handle({ type: 'bookmarks/space/update', id: spaceId, color: 'red' }, ctx);
    handle({ type: 'bookmarks/import/dismiss' }, ctx);

    const snapshot = bookmarks.snapshot();
    expect(snapshot.groups[0]).toMatchObject({ name: 'Reading' });
    expect(snapshot.items[0]).toMatchObject({ kind: 'link', title: 'Ex' });
    expect(snapshot.spaces[0]!.color).toBe('red');
    expect(snapshot.firefoxImportOffered).toBe(true);
  });

  it('refuses every bookmarks action from a private window without touching the store', async () => {
    const bookmarks = await createBookmarks();
    const touched = vi.spyOn(bookmarks, 'snapshot');
    const { ctx, send, sendAudience } = createContext(bookmarks, PRIVATE_WINDOW);
    const before = bookmarks.snapshot();
    touched.mockClear();

    for (const action of ALL_ACTIONS) handle(action, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(touched).not.toHaveBeenCalled();
    expect(bookmarks.snapshot()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
    expect(sendAudience).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(browser.bookmarks.getTree).not.toHaveBeenCalled();
  });

  it('opens a link as a panel at the end of the strip, on the panel/openAt path', async () => {
    const bookmarks = await createBookmarks();
    const { ctx, panels, tabs } = createContext(bookmarks, REGULAR_WINDOW);
    const groupId = bookmarks.createGroup(bookmarks.snapshot().spaces[0]!.id, 'G')!;
    const id = bookmarks.createItem(groupId, null, {
      kind: 'link',
      url: 'https://example.com/x',
      title: 'X',
    })!;

    handle({ type: 'bookmarks/item/open', id, where: 'panel' }, ctx);

    await vi.waitFor(() => expect(panels.insertAt).toHaveBeenCalledWith('ws-1', 77, 1));
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/x',
      active: false,
      windowId: REGULAR_WINDOW,
    });
    expect(tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(77, 'ws-1');
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1', {
      scrollToPanelTabId: 77,
      scrollToPanelReveal: 'right-edge',
    });
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it('opens a link as a new active tab in the active workspace', async () => {
    const bookmarks = await createBookmarks();
    const { ctx, panels, tabs } = createContext(bookmarks, REGULAR_WINDOW);
    const groupId = bookmarks.createGroup(bookmarks.snapshot().spaces[0]!.id, 'G')!;
    const id = bookmarks.createItem(groupId, null, {
      kind: 'link',
      url: 'https://example.com/y',
      title: 'Y',
    })!;

    handle({ type: 'bookmarks/item/open', id, where: 'tab' }, ctx);

    await vi.waitFor(() => expect(browser.tabs.update).toHaveBeenCalledWith(77, { active: true }));
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/y',
      active: false,
      windowId: REGULAR_WINDOW,
    });
    expect(tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(77, 'ws-1');
    expect(panels.insertAt).not.toHaveBeenCalled();
  });

  it('opens nothing for a note or an unknown id', async () => {
    const bookmarks = await createBookmarks();
    const { ctx } = createContext(bookmarks, REGULAR_WINDOW);
    const groupId = bookmarks.createGroup(bookmarks.snapshot().spaces[0]!.id, 'G')!;
    const note = bookmarks.createItem(groupId, null, { kind: 'note', text: 'n' })!;

    handle({ type: 'bookmarks/item/open', id: note, where: 'panel' }, ctx);
    handle({ type: 'bookmarks/item/open', id: 'missing', where: 'tab' }, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
});
