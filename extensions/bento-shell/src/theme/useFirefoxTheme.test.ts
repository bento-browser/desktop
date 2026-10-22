// The resolved colour mode that a window's sidebar publishes for its overlays.
// All private windows share one localStorage and one BroadcastChannel partition
// yet each has its own colour mode, so the publication is scoped to its window.
//
// The hook runs outside React (useEffect runs its callback at once) against fake
// documents, one per window, on one shared storage and channel network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeDocument {
  attributes: Map<string, string>;
  osDark: boolean;
  mode: string;
  storageListeners: Set<(event: { key: string; newValue: string | null }) => void>;
}

let active: FakeDocument;
let storage: Map<string, string>;
let channels: Array<{
  name: string;
  owner: FakeDocument;
  listeners: Set<(event: { data: unknown }) => void>;
  closed: boolean;
}>;

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
  const document: FakeDocument = {
    attributes: new Map(),
    osDark,
    mode,
    storageListeners: new Set(),
  };
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
  active = { attributes: new Map(), osDark: false, mode: 'light', storageListeners: new Set() };
  vi.doMock('react', () => ({ useEffect: (effect: () => void) => effect() }));
  vi.doMock('../state/settings', () => ({
    useSettingsStore: (select: (state: unknown) => unknown) =>
      select({ current: { uiColorMode: active.mode } }),
  }));
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('document', {
    get documentElement() {
      return {
        setAttribute: (name: string, value: string) => active.attributes.set(name, value),
        getAttribute: (name: string) => active.attributes.get(name) ?? null,
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
  vi.stubGlobal('matchMedia', () => ({
    matches: active.osDark,
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
    const elsewhere = as(
      { attributes: new Map(), osDark: false, mode: 'light', storageListeners: new Set() },
      () => new FakeChannel('bento-shell-bus'),
    );

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
