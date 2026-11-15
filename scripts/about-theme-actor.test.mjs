// The about: page theme delivery: the BentoAboutThemeChild actor (src/browser/actors) and the
// publisher block of bento-shell-mount.js, run against stubs of the Firefox globals they use.
// The real Firefox behaviour (first paint, every process type, two windows) is proven in a
// built browser; these pin the logic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'BentoAboutTheme';
// Values made in the vm context have its prototypes; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A stand-in for Services.ppmm.sharedData and Services.cpmm.sharedData, shared by both. */
function sharedData() {
  const store = new Map();
  const listeners = [];
  return {
    store,
    flushes: 0,
    gets: 0,
    get(key) {
      this.gets += 1;
      return structuredClone(store.get(key));
    },
    set(key, value) {
      store.set(key, structuredClone(value));
    },
    flush() {
      this.flushes += 1;
      for (const listener of listeners) listener({ changedKeys: [KEY] });
    },
    addEventListener: (type, listener) => listeners.push(listener),
    listenerCount: () => listeners.length,
  };
}

function element(attributes = {}) {
  const values = new Map(Object.entries(attributes));
  const writes = [];
  return {
    writes,
    getAttribute: (name) => values.get(name) ?? null,
    setAttribute(name, value) {
      writes.push([name, value]);
      values.set(name, String(value));
    },
  };
}

// ─── Actor ───────────────────────────────────────────────────────────

function loadActor(data = sharedData()) {
  const source = readFileSync(
    resolve(ROOT, 'src/browser/actors/BentoAboutThemeChild.sys.mjs'),
    'utf8',
  ).replaceAll(/^export /gm, '');
  const exports = vm.runInNewContext(`${source}\n;({ BentoAboutThemeChild, lookupAboutTheme })`, {
    JSWindowActorChild: class {},
    Services: { cpmm: { sharedData: data } },
  });
  const page = (browserId, attributes) => {
    const actor = new exports.BentoAboutThemeChild();
    const root = element(attributes);
    actor.document = { documentElement: root };
    actor.browsingContext = { top: { browserId } };
    return {
      actor,
      root,
      insert: () => actor.handleEvent({ type: 'DOMDocElementInserted', target: actor.document }),
    };
  };
  return { ...exports, data, page };
}

test('the actor reads [theme, mode] for its browser; an unknown theme shows Default', () => {
  const { lookupAboutTheme } = loadActor();
  const entries = {
    1: ['standard-fern', 'dark'],
    2: ['Not A Theme', 'light'],
    3: [null, 'dark'],
    4: ['standard-fern', 'sepia'],
  };
  assert.deepEqual(plain(lookupAboutTheme(entries, 1)), ['standard-fern', 'dark']);
  assert.deepEqual(plain(lookupAboutTheme(entries, 2)), ['default', 'light']);
  assert.deepEqual(plain(lookupAboutTheme(entries, 3)), ['default', 'dark']);
  assert.equal(lookupAboutTheme(entries, 4), null, 'an invalid mode is no entry');
  assert.equal(lookupAboutTheme(entries, 5), null);
  assert.equal(lookupAboutTheme(undefined, 1), null, 'nothing published yet');
});

test('the actor themes its page root when the root is inserted, and only its own document', () => {
  const { data, page } = loadActor();
  data.set(KEY, { 7: ['standard-violet-dusk', 'dark'] });
  const one = page(7);
  one.actor.handleEvent({ type: 'DOMDocElementInserted', target: { other: true } });
  one.actor.handleEvent({ type: 'keydown', target: one.actor.document });
  assert.deepEqual(one.root.writes, []);
  one.insert();
  assert.deepEqual(one.root.writes, [
    ['data-bento-theme', 'standard-violet-dusk'],
    ['data-color-mode', 'dark'],
  ]);
});

test("a page whose browser no window published keeps Firefox's own look", () => {
  const { page } = loadActor();
  const orphan = page(9);
  orphan.insert();
  assert.deepEqual(orphan.root.writes, []);
});

test('a shared map change re-applies to live pages, writing only what changed', () => {
  const { data, page } = loadActor();
  data.set(KEY, { 1: ['default', 'light'], 2: ['standard-fern', 'light'] });
  const a = page(1);
  const b = page(2);
  a.insert();
  b.insert();
  assert.equal(data.listenerCount(), 1, 'one listener per process');
  data.set(KEY, { 1: ['default', 'dark'], 2: ['standard-fern', 'light'] });
  data.flush();
  assert.deepEqual(a.root.writes.slice(2), [['data-color-mode', 'dark']]);
  assert.deepEqual(b.root.writes.slice(2), [], 'an unchanged page is not touched');
  b.actor.didDestroy();
  data.set(KEY, { 1: ['default', 'dark'], 2: ['standard-lagoon', 'dark'] });
  data.flush();
  assert.equal(b.root.writes.length, 2, 'a destroyed actor no longer follows');
});

test('the process reads the shared map once per change, however many pages are live', () => {
  const { data, page } = loadActor();
  data.set(KEY, { 1: ['default', 'light'] });
  const pages = [page(1), page(1), page(1)];
  for (const each of pages) each.insert();
  assert.equal(data.gets, 1, 'read once when the first page attached');
  data.set(KEY, { 1: ['standard-fern', 'dark'] });
  data.flush();
  assert.equal(data.gets, 2, 'one read for the change');
  for (const each of pages) {
    assert.deepEqual(each.root.writes.slice(2), [
      ['data-bento-theme', 'standard-fern'],
      ['data-color-mode', 'dark'],
    ]);
  }
  // A page that loads after the change reads the same copy.
  const late = page(1);
  late.insert();
  assert.equal(data.gets, 2);
  assert.deepEqual(late.root.writes, [
    ['data-bento-theme', 'standard-fern'],
    ['data-color-mode', 'dark'],
  ]);
});

// ─── Publisher (bento-shell-mount.js) ────────────────────────────────

const MOUNT = readFileSync(resolve(ROOT, 'src/browser/base/content/bento-shell-mount.js'), 'utf8');
const mountLine = (pattern) => {
  const match = new RegExp(`^  ${pattern}$`, 'm').exec(MOUNT);
  assert.ok(match, `${pattern} is missing`);
  return match[0];
};
const PUBLISHER = [
  mountLine("const BENTO_DEFAULT_THEME_ID = '[a-z]+';"),
  mountLine('const BENTO_THEME_ID_PATTERN = .*;'),
  MOUNT.slice(
    MOUNT.indexOf('  // About: page theming.'),
    MOUNT.indexOf('  function isBentoThemeableChromeDocument(doc) {'),
  ),
  ';({ registerAboutThemes, attachAboutThemePublisher, publishAboutTheme })',
].join('\n');

/**
 * A browser window running the publisher block. `browsers` are browser ids; `theme` and
 * `mode` are the chrome root's attributes. Windows built on one `world` share the shared
 * map, the window list and the registered sheets and actors.
 */
function chromeWindow(world, { browsers = [], theme, mode, sidebarURI } = {}) {
  const listeners = new Map();
  const timers = [];
  const root = element({ 'data-bento-theme': theme, 'data-color-mode': mode });
  const sidebarRoot = element();
  const sidebarDocument = sidebarURI
    ? { documentURI: sidebarURI, documentElement: sidebarRoot }
    : null;
  const window = {
    closed: false,
    gBrowser: { browsers: browsers.map((browserId) => ({ browserId })) },
    addEventListener(type, listener, options) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ listener, once: options?.once });
    },
    setTimeout: (fn) => timers.push(fn),
  };
  const document = {
    documentElement: root,
    getElementById: (id) => (id === 'sidebar' ? { contentDocument: sidebarDocument } : null),
  };
  const api = vm.runInNewContext(PUBLISHER, {
    window,
    document,
    console: { warn: (...args) => world.warnings.push(args.join(' ')) },
    Cc: { '@mozilla.org/content/style-sheet-service;1': { getService: () => world.sss } },
    Ci: { nsIStyleSheetService: {} },
    ChromeUtils: { registerWindowActor: (...args) => world.registerActor(...args) },
    Services: {
      io: { newURI: (spec) => ({ spec }) },
      ppmm: { sharedData: world.data },
      wm: { getEnumerator: () => world.windows },
    },
  });
  world.windows.push(window);
  const fire = (type, event = {}) => {
    for (const entry of listeners.get(type) ?? []) entry.listener({ type, ...event });
    listeners.set(
      type,
      (listeners.get(type) ?? []).filter((entry) => !entry.once),
    );
  };
  return {
    api,
    window,
    root,
    sidebarDocument,
    sidebarRoot,
    fire,
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
}

function world() {
  const actors = [];
  const registered = new Set();
  return {
    data: sharedData(),
    windows: [],
    warnings: [],
    actors,
    sss: {
      USER_SHEET: 2,
      loads: [],
      sheetRegistered: (uri, type) => registered.has(`${type}:${uri.spec}`),
      loadAndRegisterSheet(uri, type) {
        this.loads.push([uri.spec, type]);
        registered.add(`${type}:${uri.spec}`);
      },
    },
    registerActor(name, options) {
      if (actors.some(([existing]) => existing === name)) {
        const error = new Error('already registered');
        error.name = 'NotSupportedError';
        throw error;
      }
      actors.push([name, options]);
    },
  };
}

const entries = (w) => structuredClone(w.data.get(KEY) ?? {});

test('the sheet registers once per process as a USER sheet, with one child-only actor', () => {
  const w = world();
  const a = chromeWindow(w);
  const b = chromeWindow(w);
  a.api.registerAboutThemes();
  b.api.registerAboutThemes();
  assert.deepEqual(w.sss.loads, [['chrome://browser/content/bento-about-themes.css', 2]]);
  assert.equal(w.actors.length, 1);
  assert.deepEqual(w.warnings, [], 'a second window registers quietly');
  const [name, options] = w.actors[0];
  assert.equal(name, 'BentoAboutTheme');
  assert.equal(options.parent, undefined, 'child only');
  assert.equal(options.child.esModuleURI, 'resource:///actors/BentoAboutThemeChild.sys.mjs');
  assert.deepEqual(plain(options.child.events), { DOMDocElementInserted: { capture: true } });
  assert.equal(options.allFrames, true);
  assert.equal(options.safeForUntrustedWebProcess, true);
  assert.deepEqual(plain(options.messageManagerGroups), ['browsers']);
  assert.ok(options.matches.includes('about:neterror?*'));
  assert.ok(!options.matches.some((match) => /preferences|settings/.test(match)));
});

test("each window publishes its own theme and mode, keeping the other window's entries", () => {
  const w = world();
  const a = chromeWindow(w, { browsers: [1, 2, 0], theme: 'standard-fern', mode: 'dark' });
  const b = chromeWindow(w, { browsers: [3], theme: 'default', mode: 'light' });
  a.api.publishAboutTheme();
  b.api.publishAboutTheme();
  assert.deepEqual(entries(w), {
    1: ['standard-fern', 'dark'],
    2: ['standard-fern', 'dark'],
    3: ['default', 'light'],
  });
  assert.equal(w.data.flushes, 2, 'each write is flushed');
  b.api.publishAboutTheme();
  assert.equal(w.data.flushes, 2, 'nothing changed, nothing written');
  // A mode write, then a theme without a sheet (the root then shows Default) and junk.
  a.root.setAttribute('data-color-mode', 'light');
  a.api.publishAboutTheme();
  assert.deepEqual(entries(w)[1], ['standard-fern', 'light']);
  a.root.setAttribute('data-bento-theme', 'Not A Theme');
  a.root.setAttribute('data-color-mode', 'sepia');
  a.api.publishAboutTheme();
  assert.deepEqual(entries(w)[2], ['default', 'light']);
  assert.deepEqual(entries(w)[3], ['default', 'light']);
});

test('tab events publish; a closed tab, and an unloaded window, remove their entries', () => {
  const w = world();
  const a = chromeWindow(w, { browsers: [1], theme: 'standard-fern', mode: 'dark' });
  const b = chromeWindow(w, { browsers: [5], theme: 'default', mode: 'light' });
  a.api.attachAboutThemePublisher();
  b.api.attachAboutThemePublisher();
  a.window.gBrowser.browsers.push({ browserId: 2 });
  a.fire('TabOpen');
  a.window.gBrowser.browsers.push({ browserId: 3 });
  a.fire('TabBrowserInserted');
  b.fire('load');
  assert.deepEqual(entries(w), {
    1: ['standard-fern', 'dark'],
    2: ['standard-fern', 'dark'],
    3: ['standard-fern', 'dark'],
    5: ['default', 'light'],
  });
  a.fire('TabClose', { target: { linkedBrowser: { browserId: 2 } }, detail: {} });
  assert.equal(entries(w)[2], undefined);
  a.window.closed = true;
  a.fire('unload');
  assert.deepEqual(entries(w), { 5: ['default', 'light'] });
});

test('a tab another window adopts keeps its entry, and that window republishes it', () => {
  const w = world();
  const a = chromeWindow(w, { browsers: [1], theme: 'default', mode: 'dark' });
  const b = chromeWindow(w, { browsers: [7, 8], theme: 'standard-lagoon', mode: 'light' });
  a.api.attachAboutThemePublisher();
  b.api.attachAboutThemePublisher();
  a.api.publishAboutTheme();
  b.api.publishAboutTheme();
  // Bento's close handover: B's tab 7 moves into A, then B closes.
  b.fire('TabClose', { target: { linkedBrowser: { browserId: 7 } }, detail: { adoptedBy: {} } });
  b.window.gBrowser.browsers = b.window.gBrowser.browsers.filter(
    ({ browserId }) => browserId !== 7,
  );
  a.window.gBrowser.browsers.push({ browserId: 7 });
  a.fire('SwapDocShells');
  assert.deepEqual(entries(w)[7], ['standard-lagoon', 'light'], 'published once the swap is done');
  a.runTimers();
  assert.deepEqual(entries(w)[7], ['default', 'dark']);
  b.window.closed = true;
  b.fire('unload');
  assert.deepEqual(entries(w), { 1: ['default', 'dark'], 7: ['default', 'dark'] });
});

test('a discarded tab drops its entry, a restored one publishes its new id, and close cleans up', () => {
  const w = world();
  const a = chromeWindow(w, { browsers: [1, 2, 3], theme: 'standard-fern', mode: 'dark' });
  a.api.attachAboutThemePublisher();
  a.fire('load');
  const [, second, third] = a.window.gBrowser.browsers;
  assert.deepEqual(Object.keys(entries(w)), ['1', '2', '3']);
  // Discarding removes the frame loader: the same browser element now reads id 0.
  second.browserId = 0;
  a.fire('TabBrowserDiscarded');
  assert.deepEqual(Object.keys(entries(w)), ['1', '3']);
  // Restoring inserts it again with a new id.
  second.browserId = 12;
  a.fire('TabBrowserInserted');
  assert.deepEqual(entries(w)[12], ['standard-fern', 'dark']);
  assert.deepEqual(Object.keys(entries(w)), ['1', '3', '12']);
  // A tab closed while discarded is found by the id it last had, even with no discard event.
  third.browserId = 0;
  a.fire('TabClose', { target: { linkedBrowser: third }, detail: {} });
  assert.deepEqual(Object.keys(entries(w)), ['1', '12']);
  a.fire('TabClose', { target: { linkedBrowser: second }, detail: {} });
  assert.deepEqual(Object.keys(entries(w)), ['1']);
  // A browser whose id changed without an event is reconciled on the next publish.
  a.window.gBrowser.browsers = [a.window.gBrowser.browsers[0]];
  a.window.gBrowser.browsers[0].browserId = 20;
  a.api.publishAboutTheme();
  assert.deepEqual(Object.keys(entries(w)), ['20']);
});

test('a release keeps an id that another open window shows', () => {
  const w = world();
  const a = chromeWindow(w, { browsers: [4], theme: 'default', mode: 'light' });
  const b = chromeWindow(w, { browsers: [4], theme: 'default', mode: 'light' });
  a.api.attachAboutThemePublisher();
  a.api.publishAboutTheme();
  a.fire('TabClose', { target: { linkedBrowser: { browserId: 4 } }, detail: {} });
  assert.deepEqual(entries(w), { 4: ['default', 'light'] });
  b.window.closed = true;
  a.fire('TabClose', { target: { linkedBrowser: { browserId: 4 } }, detail: {} });
  assert.deepEqual(entries(w), {});
});

test('the Passwords sidebar gets the window theme on its root, other sidebar pages do not', () => {
  const w = world();
  const megalist = chromeWindow(w, {
    theme: 'standard-violet-dusk',
    mode: 'dark',
    sidebarURI: 'chrome://global/content/megalist/megalist.html',
  });
  megalist.api.attachAboutThemePublisher();
  megalist.fire('DOMDocElementInserted', { target: megalist.sidebarDocument });
  assert.deepEqual(megalist.sidebarRoot.writes, [
    ['data-bento-theme', 'standard-violet-dusk'],
    ['data-color-mode', 'dark'],
  ]);
  megalist.root.setAttribute('data-color-mode', 'light');
  megalist.api.publishAboutTheme();
  assert.deepEqual(megalist.sidebarRoot.writes.at(-1), ['data-color-mode', 'light']);

  const history = chromeWindow(w, {
    theme: 'default',
    mode: 'dark',
    sidebarURI: 'chrome://browser/content/sidebar/sidebar-history.html',
  });
  history.api.attachAboutThemePublisher();
  history.fire('DOMDocElementInserted', { target: history.sidebarDocument });
  history.api.publishAboutTheme();
  assert.deepEqual(history.sidebarRoot.writes, []);
});
