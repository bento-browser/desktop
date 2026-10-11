// The mount script inserts three stylesheet links (tokens, theme, layout) and holds the chrome
// root invisible until every one that is not complete yet has fired load or error. These tests run
// the real functions from bento-shell-mount.js against a stub DOM. They guard two things: the link
// order (it fixes the cascade position bento-shell-mount.css had as an inline <style>) and that
// the gate unhides on every path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const MOUNT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/browser/base/content/bento-shell-mount.js',
);
const source = readFileSync(MOUNT, 'utf8');

const TOKENS = 'chrome://browser/content/bento-chrome-tokens.css';
const THEME = 'chrome://browser/content/bento-chrome-theme.css';
const LAYOUT = 'chrome://browser/content/bento-shell-mount.css';

/** Source of a top-level (2-space indented) function in the mount script. */
function mountFunction(name) {
  const start = source.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}

/** The single-line top-level statement matching `pattern`. */
function mountLine(pattern) {
  const match = new RegExp(`^  ${pattern}$`, 'm').exec(source);
  assert.ok(match, `${pattern} is missing`);
  return match[0];
}

// Exactly what the mount runs, in the order it runs it.
const PROGRAM = [
  mountLine('const BENTO_SHEET_GATE_TIMEOUT_MS = \\d+;'),
  mountFunction('gateFirstPaintOnSheets'),
  mountFunction('injectChromeTokens'),
  mountLine('const bentoTokensLink = injectChromeTokens\\(\\);'),
  mountFunction('injectChromeTheme'),
  mountLine('const bentoThemeLink = injectChromeTheme\\(\\);'),
  mountFunction('injectChromeStyles'),
  mountLine('injectChromeStyles\\(\\[bentoTokensLink, bentoThemeLink\\]\\);'),
].join('\n');

/**
 * Runs the program against a stub window. `cached` lists the hrefs whose sheet is complete as soon
 * as the link is inserted, like a shared sheet cache hit; any other link stays pending until the
 * test fires its load or error event.
 */
function run({ cached = [], inlineVisibility, breakListeners = false } = {}) {
  const inline = new Map(inlineVisibility ? [['visibility', inlineVisibility]] : []);
  const visibilityWrites = [];
  const style = {
    getPropertyValue: (name) => inline.get(name)?.value ?? '',
    getPropertyPriority: (name) => inline.get(name)?.priority ?? '',
    setProperty: (name, value, priority = '') => {
      if (name === 'visibility')
        visibilityWrites.push(`${value}${priority ? ' !' + priority : ''}`);
      inline.set(name, { value, priority });
    },
    removeProperty: (name) => {
      if (name === 'visibility') visibilityWrites.push('removed');
      inline.delete(name);
    },
  };

  const appended = [];
  const makeLink = () => {
    const handlers = { load: [], error: [] };
    return {
      sheet: null,
      handlers,
      addEventListener(type, handler) {
        if (breakListeners) throw new Error('addEventListener failed');
        handlers[type].push(handler);
      },
      // Delivers the event to the handlers registered for it, as {once: true} listeners.
      fire(type) {
        const pending = handlers[type].splice(0);
        for (const handler of pending) handler({ type });
      },
    };
  };
  const document = {
    createElement: () => makeLink(),
    documentElement: {
      style,
      appendChild(link) {
        appended.push(link);
        if (cached.includes(link.href)) link.sheet = {};
      },
    },
  };

  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const windowListeners = [];
  const window = {
    performance: { now: () => now },
    setTimeout: (fn, ms) => timers.set(nextTimer, { fn, at: now + ms }) && nextTimer++,
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
  };
  const logs = { warn: [], error: [] };
  const console = { warn: (...a) => logs.warn.push(a), error: (...a) => logs.error.push(a) };

  vm.runInNewContext(PROGRAM, { document, window, console });
  return {
    appended,
    window,
    logs,
    timers,
    visibility: () => (inline.get('visibility') ? inline.get('visibility').value : ''),
    visibilityWrites,
    byHref: (href) => appended.find((link) => link.href === href),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    unload: () =>
      windowListeners.filter(({ type }) => type === 'unload').forEach((l) => l.handler()),
  };
}

test('links are inserted in the order tokens, theme, layout, at the end of the root', () => {
  // The program above lists the calls in a fixed order, so check their order in the script itself.
  const positions = [
    'const bentoTokensLink = injectChromeTokens();',
    'const bentoThemeLink = injectChromeTheme();',
    'injectChromeStyles([bentoTokensLink, bentoThemeLink]);',
  ].map((call) => source.indexOf(`\n  ${call}\n`));
  assert.ok(positions[0] > 0 && positions[0] < positions[1] && positions[1] < positions[2]);
  const env = run({ cached: [TOKENS, THEME, LAYOUT] });
  assert.deepEqual(
    env.appended.map((link) => link.href),
    [TOKENS, THEME, LAYOUT],
  );
  assert.ok(env.appended.every((link) => link.rel === 'stylesheet'));
});

test('sheets already in the cache never hide the root', () => {
  const env = run({ cached: [TOKENS, THEME, LAYOUT] });
  assert.deepEqual(env.visibilityWrites, []);
  assert.equal(env.window.__bentoSheetGate, undefined);
  assert.equal(env.timers.size, 0);
});

test('the root stays hidden until the last pending link loads', () => {
  const env = run();
  assert.equal(env.visibility(), 'hidden');
  assert.deepEqual(env.visibilityWrites, ['hidden !important']);
  env.byHref(TOKENS).fire('load');
  env.byHref(THEME).fire('load');
  assert.equal(env.visibility(), 'hidden');
  env.advance(30);
  env.byHref(LAYOUT).fire('load');
  assert.equal(env.visibility(), '');
  assert.deepEqual(
    { ...env.window.__bentoSheetGate },
    { pending: 3, releasedBy: 'load', heldMs: 30 },
  );
  assert.equal(env.timers.size, 0, 'the safety timer is cancelled');
});

test('only the links without a complete sheet are waited on', () => {
  const env = run({ cached: [TOKENS, THEME] });
  assert.equal(env.visibility(), 'hidden');
  env.byHref(LAYOUT).fire('load');
  assert.equal(env.visibility(), '');
  assert.equal(env.window.__bentoSheetGate.pending, 1);
});

test('a failed link counts as settled and the root is shown', () => {
  const env = run({ cached: [TOKENS] });
  env.byHref(THEME).fire('error');
  assert.equal(env.visibility(), 'hidden');
  env.byHref(LAYOUT).fire('load');
  assert.equal(env.visibility(), '');
  assert.equal(env.window.__bentoSheetGate.releasedBy, 'error');
});

test('a link that fires twice cannot release the others early', () => {
  const env = run({ cached: [TOKENS] });
  env.byHref(THEME).fire('load');
  env.byHref(THEME).fire('error');
  assert.equal(env.visibility(), 'hidden');
});

test('the timeout shows the root, warns once, and later events change nothing', () => {
  const env = run();
  env.advance(1999);
  assert.equal(env.visibility(), 'hidden');
  env.advance(1);
  assert.equal(env.visibility(), '');
  assert.equal(env.logs.warn.length, 1);
  assert.equal(env.window.__bentoSheetGate.releasedBy, 'timeout');
  for (const link of env.appended) link.fire('load');
  assert.deepEqual(env.visibilityWrites, ['hidden !important', 'removed']);
  assert.equal(env.logs.warn.length, 1);
});

test('closing the window releases the gate', () => {
  const env = run();
  env.unload();
  assert.equal(env.visibility(), '');
  assert.equal(env.window.__bentoSheetGate.releasedBy, 'unload');
});

test('an inline visibility that was already there is put back', () => {
  const env = run({ inlineVisibility: { value: 'collapse', priority: 'important' } });
  for (const link of env.appended) link.fire('load');
  assert.equal(env.visibility(), 'collapse');
  assert.deepEqual(env.visibilityWrites, ['hidden !important', 'collapse !important']);
});

test('a failure while arming the gate still shows the root', () => {
  const env = run({ breakListeners: true });
  assert.equal(env.visibility(), '');
  assert.equal(env.logs.error.length, 1);
  assert.equal(env.window.__bentoSheetGate.releasedBy, 'exception');
  assert.equal(env.timers.size, 0);
});
