// The resolved colour mode that a window's sidebar publishes for its overlays.
// All private windows share one localStorage and one BroadcastChannel partition
// yet each has its own colour mode, so the publication is scoped to its window.
//
// The hook runs outside React (useEffect runs its callback at once, useRef is a plain box) against fake
// documents, one per window, on one shared storage and channel network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StoreState {
  current: { uiColorMode: string } | null;
  colorFlipAt?: number;
}

interface FakeDocument {
  attributes: Map<string, string>;
  osDark: boolean;
  mode: string;
  flipAt?: number;
  storageListeners: Set<(event: { key: string; newValue: string | null }) => void>;
  storeListeners: Set<(state: StoreState, previous: StoreState) => void>;
}

let active: FakeDocument;
let storage: Map<string, string>;
/** Every message posted on the channel, in order. */
let posted: Array<{ kind?: string; mode?: string; resolved?: string }>;
let channels: Array<{
  name: string;
  owner: FakeDocument;
  listeners: Set<(event: { data: unknown }) => void>;
  closed: boolean;
}>;

function freshDocument(): FakeDocument {
  return {
    attributes: new Map(),
    osDark: false,
    mode: 'light',
    storageListeners: new Set(),
    storeListeners: new Set(),
  };
}

const stateOf = (document: FakeDocument): StoreState => ({
  current: { uiColorMode: document.mode },
  colorFlipAt: document.flipAt,
});

/** What a settings/changed message does: the store sets its state and notifies its subscribers
 * inside that call, before React renders anything. */
function setStoreMode(document: FakeDocument, mode: string, flipAt?: number): void {
  const previous = stateOf(document);
  document.mode = mode;
  document.flipAt = flipAt;
  for (const listener of [...document.storeListeners]) {
    as(document, () => listener(stateOf(document), previous));
  }
}

/** Runs `fn` as the given document, whose globals the hook reads. */
function as<T>(document: FakeDocument, fn: () => T): T {
  const previous = active;
  active = document;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

class FakeChannel {
  readonly record: (typeof channels)[number];

  constructor(name: string) {
    this.record = { name, owner: active, listeners: new Set(), closed: false };
    channels.push(this.record);
  }

  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.record.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.record.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    posted.push(data as (typeof posted)[number]);
    for (const other of channels) {
      if (other === this.record || other.closed || other.name !== this.record.name) continue;
      for (const listener of other.listeners) as(other.owner, () => listener({ data }));
    }
  }

  close(): void {
    this.record.closed = true;
  }
}

/** Loads the hook as one document: an overlay (`stored`) or a sidebar, in a window. */
async function loadDocument({
  windowId,
  isPrivate,
  mode,
  stored,
  osDark = false,
}: {
  windowId: number;
  isPrivate: boolean;
  mode: string;
  stored: boolean;
  osDark?: boolean;
}) {
  const document: FakeDocument = { ...freshDocument(), mode, osDark };
  vi.stubGlobal('location', {
    hash: `#bentoWindowId=${windowId}${isPrivate ? '&bentoPrivate=1' : ''}`,
  });
  vi.resetModules();
  const { useFirefoxTheme } = await import('./useFirefoxTheme');
  as(document, () => useFirefoxTheme({ preferStoredSystemResolution: stored }));
  return {
    document,
    colorMode: () => document.attributes.get('data-color-mode'),
  };
}

beforeEach(() => {
  storage = new Map();
  channels = [];
  posted = [];
  active = freshDocument();
  vi.doMock('react', () => ({
    useEffect: (effect: () => void) => effect(),
    useRef: (initial: unknown) => ({ current: initial }),
  }));
  vi.doMock('../state/settings', () => ({
    // The selector form is what React renders with; getState and subscribe are what the
    // store notifies outside React.
    useSettingsStore: Object.assign(
      (select: (state: unknown) => unknown) => select(stateOf(active)),
      {
        getState: () => stateOf(active),
        subscribe: (listener: (state: StoreState, previous: StoreState) => void) => {
          const owner = active;
          owner.storeListeners.add(listener);
          return () => owner.storeListeners.delete(listener);
        },
      },
    ),
  }));
  // A frame is 16 ms of the (fake or real) timers.
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('document', {
    hidden: false,
    // A change that waits for its time listens for the document hiding.
    addEventListener: () => {},
    removeEventListener: () => {},
    // The element belongs to the document that was active when it was read, so a timer that
    // fires later still acts on its own document.
    get documentElement() {
      const { attributes } = active;
      return {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        getAttribute: (name: string) => attributes.get(name) ?? null,
        removeAttribute: (name: string) => attributes.delete(name),
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    },
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: never) => {
      if (type === 'storage') active.storageListeners.add(listener);
    },
    removeEventListener: (type: string, listener: never) => {
      if (type === 'storage') active.storageListeners.delete(listener);
    },
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('color-scheme') && active.osDark,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const changed = storage.get(key) !== value;
      storage.set(key, value);
      if (!changed) return;
      // A storage event reaches the other documents sharing the storage.
      const writer = active;
      for (const other of new Set(channels.map(({ owner }) => owner))) {
        if (other === writer) continue;
        for (const listener of other.storageListeners) {
          as(other, () => listener({ key, newValue: value }));
        }
      }
    },
  });
});

afterEach(() => {
  vi.doUnmock('react');
  vi.doUnmock('../state/settings');
  vi.unstubAllGlobals();
});

describe('resolved colour mode of private windows', () => {
  // The OS is light. Window 1 resolves Auto to dark through its sidebar's published
  // value; window 2's overlay has its own, different, sidebar.
  it("takes only its own window's published mode, from a message and from storage", async () => {
    const overlay1 = await loadDocument({
      windowId: 1,
      isPrivate: true,
      mode: 'system',
      stored: true,
    });
    const overlay2 = await loadDocument({
      windowId: 2,
      isPrivate: true,
      mode: 'system',
      stored: true,
    });
    expect(overlay1.colorMode()).toBe('light');
    expect(overlay2.colorMode()).toBe('light');

    // Window 1's sidebar is dark and publishes it.
    const sidebar1 = await loadDocument({
      windowId: 1,
      isPrivate: true,
      mode: 'dark',
      stored: false,
    });

    expect(sidebar1.colorMode()).toBe('dark');
    expect(overlay1.colorMode()).toBe('dark');
    expect(overlay2.colorMode()).toBe('light');

    // Window 2's sidebar is light: window 1's overlay keeps what its own sidebar said.
    await loadDocument({ windowId: 2, isPrivate: true, mode: 'light', stored: false });
    expect(overlay1.colorMode()).toBe('dark');
    expect(overlay2.colorMode()).toBe('light');
  });

  it('ignores a message that names another window', async () => {
    const overlay = await loadDocument({
      windowId: 1,
      isPrivate: true,
      mode: 'system',
      stored: true,
    });
    const elsewhere = as(freshDocument(), () => new FakeChannel('bento-shell-bus'));

    elsewhere.postMessage({ kind: 'resolved-color-mode', resolved: 'dark', windowId: 2 });
    expect(overlay.colorMode()).toBe('light');

    elsewhere.postMessage({ kind: 'resolved-color-mode', resolved: 'dark', windowId: 1 });
    expect(overlay.colorMode()).toBe('dark');
  });

  it('keeps the first-paint hint for boot.js and the unscoped key in a regular window', async () => {
    await loadDocument({ windowId: 1, isPrivate: false, mode: 'dark', stored: false });
    expect(storage.get('resolved-color-mode')).toBe('dark');
    expect([...storage.keys()].filter((key) => key.includes('@'))).toEqual([]);

    await loadDocument({ windowId: 2, isPrivate: true, mode: 'light', stored: false });
    expect(storage.get('resolved-color-mode@2')).toBe('light');
  });
});

describe('applying a settings change', () => {
  afterEach(() => vi.useRealTimers());

  it('applies, fades and records the mode inside the store update, before React renders it', async () => {
    vi.useFakeTimers();
    const sidebar = await loadDocument({
      windowId: 1,
      isPrivate: false,
      mode: 'light',
      stored: false,
    });
    expect(sidebar.document.attributes.has('data-bento-mode-fade')).toBe(false);

    // No render and no effect run between the set and these reads.
    setStoreMode(sidebar.document, 'dark');
    expect(sidebar.colorMode()).toBe('dark');
    expect(sidebar.document.attributes.get('data-muxui-color-scheme')).toBe('dark');
    expect(sidebar.document.attributes.has('data-bento-mode-fade')).toBe(true);
    expect(storage.get('color-mode')).toBe('dark');
    expect(storage.get('resolved-color-mode')).toBe('dark');
  });

  it('waits for the change time, and announces the mode only when it applies', async () => {
    vi.useFakeTimers();
    // The fake clock's animation frames carry the time since it started.
    const start = Date.now();
    vi.stubGlobal('performance', { now: () => Date.now() - start });
    const sidebar = await loadDocument({
      windowId: 1,
      isPrivate: false,
      mode: 'light',
      stored: false,
    });
    const announced = channels.length;

    setStoreMode(sidebar.document, 'dark', Date.now() + 120);
    expect(sidebar.colorMode()).toBe('light');
    expect(storage.get('color-mode')).toBe('dark');
    // An overlay in Auto applies a published mode at once, so nothing goes out before the flip.
    expect(storage.get('resolved-color-mode')).toBe('light');
    expect(channels).toHaveLength(announced);

    // The timer acts on whichever document is active, as it does in a real page.
    as(sidebar.document, () => vi.advanceTimersByTime(140));
    expect(sidebar.colorMode()).toBe('dark');
    expect(storage.get('resolved-color-mode')).toBe('dark');
    expect(channels.length).toBeGreaterThan(announced);
  });

  it('resolves Auto when the change applies, so an OS change missed while it waited is not shown', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.stubGlobal('performance', { now: () => Date.now() - start });
    // Explicit light with the OS dark. The Auto listeners are installed by an effect that only
    // runs once React has rendered the Auto pref, which this hook instance never does here.
    const sidebar = await loadDocument({
      windowId: 1,
      isPrivate: false,
      mode: 'light',
      stored: false,
      osDark: true,
    });

    setStoreMode(sidebar.document, 'system', Date.now() + 120);
    expect(sidebar.colorMode()).toBe('light');
    // The OS turns light during the wait, before anything listens: no event is heard.
    sidebar.document.osDark = false;
    as(sidebar.document, () => vi.advanceTimersByTime(140));

    // Resolved light when it applied (not the dark of the request), and that is what was stored
    // and announced.
    expect(sidebar.colorMode()).toBe('light');
    expect(sidebar.document.attributes.get('data-bento-color-mode-pref')).toBe('system');
    expect(sidebar.document.attributes.has('data-bento-mode-fade')).toBe(false);
    expect(storage.get('resolved-color-mode')).toBe('light');
    expect(posted.filter(({ mode }) => mode === 'system')).toEqual([
      expect.objectContaining({ kind: 'resolved-color-mode', resolved: 'light' }),
    ]);
  });

  it('applies and announces a pref once, however many times the store repeats it', async () => {
    vi.useFakeTimers();
    const sidebar = await loadDocument({
      windowId: 1,
      isPrivate: false,
      mode: 'light',
      stored: false,
    });
    const writes: string[] = [];
    const root = sidebar.document.attributes;
    const set = root.set.bind(root);
    root.set = (key, value) => {
      if (key === 'data-bento-mode-fade') writes.push(value);
      return set(key, value);
    };

    setStoreMode(sidebar.document, 'dark');
    // Another setting changed: the store notifies again with the same mode.
    setStoreMode(sidebar.document, 'dark');
    expect(writes).toHaveLength(1);
    expect(channels.filter(({ closed }) => closed)).toHaveLength(channels.length);
    const publications = channels.length;
    setStoreMode(sidebar.document, 'dark');
    expect(channels).toHaveLength(publications);
  });

  it('a second change during the fade keeps the attribute and restarts the wait', async () => {
    vi.useFakeTimers();
    const sidebar = await loadDocument({
      windowId: 1,
      isPrivate: false,
      mode: 'light',
      stored: false,
    });
    setStoreMode(sidebar.document, 'dark');
    vi.advanceTimersByTime(80);
    setStoreMode(sidebar.document, 'light');
    expect(sidebar.document.attributes.has('data-bento-mode-fade')).toBe(true);
    // The first change's wait (1 s with no computed style here) no longer ends the fade.
    vi.advanceTimersByTime(950);
    expect(sidebar.document.attributes.has('data-bento-mode-fade')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(sidebar.document.attributes.has('data-bento-mode-fade')).toBe(false);
  });
});
