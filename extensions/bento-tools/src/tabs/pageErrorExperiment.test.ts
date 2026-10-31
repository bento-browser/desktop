import { beforeEach, describe, expect, it, vi } from 'vitest';
import apiSource from '../../experiments/bento-tab-state/api.js?raw';

// Runs the experiment's real api.js against stand-ins for the Firefox objects it touches, to
// check what it reports: the mapping from a tab's document to a pageError, and the events.

type Fire = (tabId: number, pageError: string | null) => void;

interface FakeTab {
  id: number;
  isTab: boolean;
  attributes: Set<string>;
  linkedBrowser: { documentURI: ReturnType<typeof uri> | null };
  hasAttribute(name: string): boolean;
}

function uri(spec: string) {
  const [scheme = '', rest = ''] = spec.split(/:(.*)/s);
  const [filePath = '', query = ''] = rest.split('?');
  return { scheme, filePath, query };
}

function tab(id: number, spec: string | null, attributes: string[] = []): FakeTab {
  const set = new Set(attributes);
  return {
    id,
    isTab: true,
    attributes: set,
    linkedBrowser: { documentURI: spec === null ? null : uri(spec) },
    hasAttribute: (name) => set.has(name),
  };
}

class FakeObserver {
  static all: FakeObserver[] = [];
  disconnected = false;
  constructor(readonly callback: (records: { target: unknown }[]) => void) {
    FakeObserver.all.push(this);
  }
  observe = vi.fn();
  disconnect() {
    this.disconnected = true;
  }
}

function setup() {
  FakeObserver.all = [];
  /** Tab ids this extension may not see: getWrapper returns nothing for them. */
  const hiddenIds = new Set<number>();
  const callbacks = new Map<
    string,
    { init: (win: unknown) => void; uninit: (win: unknown) => void }
  >();
  const everyWindow = {
    readyWindows: [] as unknown[],
    registerCallback: vi.fn((id: string, init, uninit) => callbacks.set(id, { init, uninit })),
    unregisterCallback: vi.fn((id: string) => callbacks.delete(id)),
  };
  const scope: Record<string, unknown> = {};
  const globals = {
    globalThis: scope,
    ChromeUtils: { importESModule: () => ({ EveryWindow: everyWindow }) },
    ExtensionAPI: class {},
    ExtensionCommon: {
      EventManager: class {
        constructor(readonly options: { register: (fire: { async: Fire }) => () => void }) {}
        api() {
          return this.options;
        }
      },
    },
  };
  new Function(...Object.keys(globals), apiSource)(...Object.values(globals));
  const Api = scope.bentoTabState as new () => {
    getAPI(context: unknown): {
      bentoTabState: {
        getPageErrors(): Promise<{ tabId: number; pageError: string }[]>;
        onPageErrorChanged: { register(fire: { async: Fire }): () => void };
      };
    };
  };
  const { bentoTabState } = new Api().getAPI({
    extension: {
      tabManager: { getWrapper: (t: FakeTab) => (hiddenIds.has(t.id) ? undefined : { id: t.id }) },
    },
  });
  const fired: [number, string | null][] = [];
  const stop = bentoTabState.onPageErrorChanged.register({
    async: (tabId, pageError) => void fired.push([tabId, pageError]),
  });

  const listeners = new Set<{
    onLocationChange(browser: unknown, webProgress: { isTopLevel: boolean }): void;
  }>();
  /** A window with `tabs`, started like EveryWindow does after its delayed startup. */
  const startWindow = (tabs: FakeTab[]) => {
    const win = {
      MutationObserver: FakeObserver,
      gBrowser: {
        tabs,
        tabContainer: {},
        isTab: (t: FakeTab) => t.isTab,
        getTabForBrowser: (browser: FakeTab['linkedBrowser']) =>
          tabs.find((t) => t.linkedBrowser === browser),
        addTabsProgressListener: (l: Parameters<typeof listeners.add>[0]) => listeners.add(l),
        removeTabsProgressListener: (l: Parameters<typeof listeners.add>[0]) => listeners.delete(l),
      },
    };
    for (const { init } of callbacks.values()) init(win);
    everyWindow.readyWindows.push(win);
    return win;
  };
  const navigate = (t: FakeTab, spec: string, isTopLevel = true) => {
    t.linkedBrowser.documentURI = uri(spec);
    for (const l of listeners) l.onLocationChange(t.linkedBrowser, { isTopLevel });
  };
  return {
    bentoTabState,
    everyWindow,
    callbacks,
    fired,
    listeners,
    hiddenIds,
    startWindow,
    navigate,
    stop,
  };
}

describe('bentoTabState document mapping', () => {
  it.each([
    ['about:tabcrashed?e=tabcrashed&u=https%3A//example.org/', 'crashed'],
    ['about:restartrequired?e=restartrequired&u=https%3A//example.org/', 'crashed'],
    ['about:certerror?e=nssBadCert&u=https%3A//expired.example/', 'certificate-warning'],
    ['about:neterror?e=nssBadCert&u=https%3A//x/', 'certificate-warning'],
    ['about:neterror?e=nssFailure2&u=https%3A//x/', 'certificate-warning'],
    ['about:neterror?u=https%3A//x/&e=nssFailure2', 'certificate-warning'],
    ['about:neterror?e=dnsNotFound&u=https%3A//nope.invalid/', 'unavailable'],
    ['about:neterror?e=connectionFailure', 'unavailable'],
    ['about:neterror?e=nssFailure2x', 'unavailable'],
    ['about:neterror', 'unavailable'],
    ['about:httpsonlyerror?e=httpsOnlyError&u=http%3A//x/', 'unavailable'],
    ['about:neterror?e=blockedByPolicy&u=https%3A//x/', 'blocked'],
    ['about:blocked?e=malwareBlocked&u=https%3A//x/&o=1', 'blocked'],
    ['about:restricted?e=restrictedcontent&u=https%3A//x/', 'blocked'],
  ])('maps %s to %s', async (spec, expected) => {
    const { bentoTabState, startWindow } = setup();
    startWindow([tab(1, spec)]);

    expect(await bentoTabState.getPageErrors()).toEqual([{ tabId: 1, pageError: expected }]);
  });

  it('reports nothing for websites, other internal pages and lookalike names', async () => {
    const { bentoTabState, startWindow } = setup();
    startWindow(
      [
        'https://example.org/',
        // The experiment never reads the favicon, so one a website declares changes nothing.
        'https://example.org/?icon=chrome://global/skin/icons/warning.svg',
        'file:///page.html',
        'about:blank',
        'about:preferences',
        'about:sessionrestore',
        'about:framecrashed',
        'about:neterrors',
        'about:tabcrashedx',
        'chrome://browser/content/blockedSite.xhtml',
        'moz-extension://abc/page.html',
      ].map((spec, i) => tab(i + 1, spec)),
    );

    expect(await bentoTabState.getPageErrors()).toEqual([]);
  });

  it('counts the crashed attribute before the page document exists, and the document without it', async () => {
    const { bentoTabState, startWindow } = setup();
    startWindow([
      tab(1, 'about:blank', ['crashed']),
      tab(2, null, ['crashed']),
      // A tab adopted from another window: the docshell moved, the attribute did not.
      tab(3, 'about:tabcrashed?e=tabcrashed'),
      // An error page wins over a stale attribute.
      tab(4, 'about:neterror?e=dnsNotFound', ['crashed']),
    ]);

    expect(await bentoTabState.getPageErrors()).toEqual([
      { tabId: 1, pageError: 'crashed' },
      { tabId: 2, pageError: 'crashed' },
      { tabId: 3, pageError: 'crashed' },
      { tabId: 4, pageError: 'unavailable' },
    ]);
  });
});

describe('bentoTabState events', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('reports a tab that already showed a failure page when its window starts being watched', () => {
    t.startWindow([tab(1, 'https://example.org/'), tab(2, 'about:neterror?e=dnsNotFound')]);

    expect(t.fired).toEqual([[2, 'unavailable']]);
  });

  it('reports the first navigation to a failure page and the one that ends it', () => {
    const tabs = [tab(1, 'https://example.org/')];
    t.startWindow(tabs);

    t.navigate(tabs[0]!, 'about:certerror?e=nssBadCert');
    t.navigate(tabs[0]!, 'about:certerror?e=nssBadCert&again=1');
    t.navigate(tabs[0]!, 'https://example.org/ok');
    t.navigate(tabs[0]!, 'https://example.org/next');

    expect(t.fired).toEqual([
      [1, 'certificate-warning'],
      [1, null],
    ]);
  });

  it('ignores subframe location changes', () => {
    const tabs = [tab(1, 'https://example.org/')];
    t.startWindow(tabs);

    t.navigate(tabs[0]!, 'about:neterror?e=dnsNotFound', false);

    expect(t.fired).toEqual([]);
  });

  it('follows the crashed attribute and ignores records about tab children', () => {
    const tabs = [tab(1, 'https://example.org/')];
    const child = { ...tab(9, null), isTab: false };
    t.startWindow(tabs);
    const [observer] = FakeObserver.all;

    tabs[0]!.attributes.add('crashed');
    observer!.callback([{ target: tabs[0] }, { target: child }, { target: tabs[0] }]);
    tabs[0]!.attributes.delete('crashed');
    observer!.callback([{ target: tabs[0] }]);

    expect(t.fired).toEqual([
      [1, 'crashed'],
      [1, null],
    ]);
  });

  it('keeps what a read told it, so a later navigation clears a state read after a move', async () => {
    const tabs = [tab(1, 'https://example.org/')];
    t.startWindow(tabs);
    // The tab's docshell is swapped in from another window: no location change reports it.
    tabs[0]!.linkedBrowser.documentURI = uri('about:tabcrashed?e=tabcrashed');

    expect(await t.bentoTabState.getPageErrors()).toEqual([{ tabId: 1, pageError: 'crashed' }]);
    t.navigate(tabs[0]!, 'https://example.org/');

    expect(t.fired).toEqual([[1, null]]);
  });

  it('skips a tab this extension may not see', async () => {
    t.hiddenIds.add(1);
    const tabs = [tab(1, 'about:tabcrashed?e=tabcrashed')];
    t.startWindow(tabs);
    t.navigate(tabs[0]!, 'about:neterror?e=dnsNotFound');

    expect(t.fired).toEqual([]);
    expect(await t.bentoTabState.getPageErrors()).toEqual([]);
  });

  it('stops listening when its window goes away or the listener is removed', () => {
    const win = t.startWindow([tab(1, 'https://example.org/')]);
    expect(t.listeners.size).toBe(1);

    for (const { uninit } of t.callbacks.values()) uninit(win);
    expect(FakeObserver.all[0]!.disconnected).toBe(true);
    expect(t.listeners.size).toBe(0);

    t.stop();
    expect(t.everyWindow.unregisterCallback).toHaveBeenCalledTimes(1);
  });
});
