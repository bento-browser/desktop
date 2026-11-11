#!/usr/bin/env node
// Local behaviour test of Bento's panel renderer (reconcilePanelsSplitView in
// src/browser/base/content/bento-shell-mount.js) in a real build.
//
//   pnpm run test:panels -- --app <Bento.app or its Contents/MacOS/bento> [--headed] [--keep-profile]
//
// The default app is engine/obj-bento/dist/Bento.app under this repo. The suite
// launches the app on a fresh temporary profile with Marionette on a port the
// browser picks, dismisses onboarding, then walks one scenario: main tab only;
// main plus two panels made through the add-panel path; the main tab switched
// to another tab; each panel closed in turn. At every state it asserts the
// split-view membership and order, per-panel activity flags, geometry, absence
// of stale split-view state, and visible pixels (each panel's page colour).
//
// Exit codes: 0 pass, 1 failure (including a stale build and an app that does not
// start), 2 usage or setup error (a non-empty CI environment variable included). It is
// never run in CI, which builds no application.
//
// The pixel assertions have two levels, and both are required for every rendered browser:
// a snapshot of the panel's page (its own render) and a snapshot of the window at the
// browser's centre (what the compositor shows there). Technical notes:
// docs/technical/chrome-panel-rendering.md.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConnectionError, MarionetteClient } from './marionette-client.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_APP = path.join(repoRoot, 'engine', 'obj-bento', 'dist', 'Bento.app');
const MOUNT_DIR = path.join(repoRoot, 'src', 'browser', 'base', 'content');
// Chrome files the running app must serve byte-for-byte as the repo's sources.
const STALE_CHECK_FILES = ['bento-shell-mount.js', 'bento-shell-mount.css'];

const TOTAL_TIMEOUT_MS = 170_000;
const STARTUP_TIMEOUT_MS = 60_000;
const QUIT_TIMEOUT_MS = 15_000;
// Wide enough that main plus two default-width panels sit inside the window, so the
// window-level pixel samples cover every panel.
const WINDOW_SIZE = { width: 2600, height: 900 };
const COLOR_TOLERANCE = 10;

// Key bento-tools stores a tab's workspace id under (see WORKSPACE_SESSION_KEY in the mount script).
const WORKSPACE_TAB_KEY = 'extension:bento-tools@bento.app:bento.workspaceId';

// One solid-colour page per tab, so a blank or wrong page shows up as a wrong colour.
const PAGES = {
  main: { title: 'panel-suite-main', color: [229, 57, 53] },
  a: { title: 'panel-suite-a', color: [30, 136, 229] },
  b: { title: 'panel-suite-b', color: [67, 160, 71] },
  other: { title: 'panel-suite-other', color: [253, 216, 53] },
};

function pageUrl(label) {
  const { title, color } = PAGES[label];
  const html = `<!doctype html><title>${title}</title><body style="margin:0;background:rgb(${color.join(',')})">`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// The browser can re-serialize a data: URL, so a page is recognised by its encoded <title>.
function labelOfUrl(url) {
  if (!url.startsWith('data:text/html')) return null;
  return Object.keys(PAGES).find((label) => url.includes(`%3E${PAGES[label].title}%3C`)) ?? null;
}

class SuiteError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SuiteError';
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[panel-suite] ${message}`);

// ---------------------------------------------------------------------------
// Chrome side. Each function below is serialized with toString() and run as
// fn(window, ...args) in the browser window's chrome sandbox, so it must be
// self-contained (no module-scope names) and reach every browser global through
// `win`. It returns JSON-friendly data.
// ---------------------------------------------------------------------------

async function chromeAppInfo(win, files) {
  const hashes = {};
  for (const file of files) {
    const response = await win.fetch('chrome://browser/content/' + file);
    const digest = await win.crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    hashes[file] = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  }
  const info = win.Services.appinfo;
  return {
    name: info.name,
    version: info.version,
    platformVersion: info.platformVersion,
    buildId: info.appBuildID,
    hashes,
  };
}

function chromeReady(win) {
  return Boolean(
    win.gBrowserInit?.delayedStartupFinished &&
    win.gBrowser?.tabpanels &&
    win.BentoFirefoxCompat &&
    win.document.getElementById('bento-shell-host'),
  );
}

function chromeCompat(win) {
  const result = win.BentoFirefoxCompat.check();
  return {
    probed: result.probed,
    missing: Array.from(result.missing),
    deferred: Array.from(result.deferred),
  };
}

function chromeWelcome(win) {
  const host = win.document.getElementById('bento-welcome-host');
  const frame = win.document.getElementById('bento-welcome-frame');
  const style = host ? win.getComputedStyle(host) : null;
  return {
    display: style?.display ?? null,
    opacity: style?.opacity ?? null,
    frameLoaded: /bentoWindowId=\d+/.test(frame?.currentURI?.spec ?? ''),
  };
}

// Runs in the welcome page's content process (see chromeSendWelcomeDone).
function welcomeFrameScript(content, Cu) {
  const hash = new content.URLSearchParams(content.location.hash.slice(1));
  const channel = new content.BroadcastChannel('bento-shell-bus');
  const action = {
    type: 'settings/update',
    changes: { welcomeSeen: true },
    __windowId: Number(hash.get('bentoWindowId')),
  };
  channel.postMessage(Cu.cloneInto({ kind: 'action', action }, content));
  content.setTimeout(() => {
    content.document.title = 'BENTO_CLOSE_WELCOME_' + Date.now();
    channel.close();
  }, 300);
}

// What the Ready step's Start browsing sends (finishOnboarding in the shell's
// welcome page): the welcomeSeen setting over the shell bus, then the close title
// chrome watches. No other mechanism skips onboarding on a fresh profile.
function chromeSendWelcomeDone(win, frameScriptSource) {
  const frame = win.document.getElementById('bento-welcome-frame');
  const body = '(' + frameScriptSource + ')(content, Cu)';
  frame.messageManager.loadFrameScript('data:,' + encodeURIComponent(body), false);
  return true;
}

function chromeResize(win, width, height) {
  win.resizeTo(width, height);
  return { width: win.innerWidth, height: win.innerHeight };
}

function chromeTabs(win, workspaceKey) {
  const { gBrowser, SessionStore } = win;
  return gBrowser.tabs.map((tab) => {
    const browser = tab.linkedBrowser;
    const panel = tab.linkedPanel ? win.document.getElementById(tab.linkedPanel) : null;
    let workspace = null;
    try {
      workspace = JSON.parse(SessionStore.getCustomTabValue(tab, workspaceKey) || 'null');
    } catch {
      workspace = null;
    }
    return {
      linkedPanel: tab.linkedPanel,
      url: browser.currentURI.spec,
      loading: Boolean(browser.webProgress?.isLoadingDocument),
      selected: tab.selected,
      grantPending: Boolean(tab.bentoAddPanelGrant),
      panelTabId: panel?.dataset.bentoPanelTabId ?? null,
      inSplit: (gBrowser.tabpanels.splitViewPanels ?? []).includes(tab.linkedPanel),
      workspace,
    };
  });
}

function chromeLoad(win, linkedPanel, url) {
  const { gBrowser, Services } = win;
  const tab = linkedPanel
    ? gBrowser.tabs.find((candidate) => candidate.linkedPanel === linkedPanel)
    : gBrowser.selectedTab;
  tab.linkedBrowser.loadURI(Services.io.newURI(url), {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  return tab.linkedPanel;
}

function chromeOpenTab(win, url) {
  const { gBrowser, Services } = win;
  const tab = gBrowser.addTab(url, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    inBackground: true,
  });
  return tab.linkedPanel;
}

function chromeSelectTab(win, linkedPanel) {
  win.gBrowser.selectedTab = win.gBrowser.tabs.find((tab) => tab.linkedPanel === linkedPanel);
  return true;
}

// The panel navigator's Add panel button runs addNewPanel, the same function the
// trailer's Enter key and the splitter menu call. The navigator is hidden while a
// workspace has no panels, but the button still dispatches click.
function chromeClickAddPanel(win) {
  const button = win.document.querySelector('#bento-panel-nav button[aria-label="Add panel"]');
  if (!button) return false;
  button.click();
  return true;
}

// The header's Close panel button: removePanel fades the panel, then asks bento-tools to close the tab.
function chromeClosePanel(win, linkedPanel) {
  const panel = win.document.getElementById(linkedPanel);
  const button = panel?.querySelector('.bento-panel-header button[aria-label="Close panel"]');
  if (!button) return false;
  win.__bentoPanelSuite = { closed: [...(win.__bentoPanelSuite?.closed ?? []), panel] };
  button.click();
  return true;
}

// Facts about the panel renderer's current state. The Node side judges them.
async function chromeCollect(win) {
  const { gBrowser, document } = win;
  const tabpanels = gBrowser.tabpanels;
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom };
  };
  const average = (bitmap) => {
    const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const sum = [0, 0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 4; c++) sum[c] += data[i + c];
    return sum.map((value) => Math.round(value / (data.length / 4)));
  };
  const BACKDROP = 'rgb(255, 0, 255)';
  // Each sample is { color } or { error }. The page's own render, whether or not it is composited
  // into the window.
  const contentColor = async (browser) => {
    try {
      const bitmap = await browser.browsingContext.currentWindowGlobal.drawSnapshot(
        null,
        0.1,
        BACKDROP,
      );
      return { color: average(bitmap) };
    } catch (error) {
      return { error: 'page snapshot failed: ' + String(error) };
    }
  };
  // What the window shows at the centre of the browser.
  const windowColor = async (rect) => {
    const x = (rect.l + rect.r) / 2;
    const y = (rect.t + rect.b) / 2;
    if (!(x >= 4 && y >= 4 && x <= win.innerWidth - 4 && y <= win.innerHeight - 4)) {
      return {
        error: `the centre (${Math.round(x)}, ${Math.round(y)}) is outside the ${win.innerWidth}x${win.innerHeight} window`,
      };
    }
    try {
      const area = new win.DOMRect(x - 4, y - 4, 8, 8);
      const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(area, 1, BACKDROP);
      return { color: average(bitmap) };
    } catch (error) {
      return { error: 'window snapshot failed: ' + String(error) };
    }
  };

  const splitViewPanels = Array.from(tabpanels.splitViewPanels ?? []);
  const panels = Array.from(tabpanels.children)
    .filter((element) => element.classList.contains('browserSidebarContainer'))
    .map((element) => ({
      id: element.id,
      classes: Array.from(element.classList),
      order: element.style.order,
      main: element.dataset.bentoMainPanel ?? null,
      panelTabId: element.dataset.bentoPanelTabId ?? null,
      column: element.hasAttribute('column'),
      header: Boolean(
        element.querySelector(':scope > .bento-panel-header[data-bento-injected="1"]'),
      ),
      closeButton: Boolean(
        element.querySelector('.bento-panel-header button[aria-label="Close panel"]'),
      ),
      rect: rectOf(element),
    }));
  const tabs = [];
  for (const tab of gBrowser.tabs) {
    const browser = tab.linkedBrowser;
    const marker = Object.getOwnPropertyDescriptor(tab, 'splitview');
    const entry = {
      url: browser.currentURI.spec,
      linkedPanel: tab.linkedPanel,
      bcId: browser.browsingContext?.id ?? null,
      selected: tab.selected,
      docShellIsActive: browser.docShellIsActive,
      renderLayers: browser.renderLayers,
      ownSplitview: Boolean(marker),
      browserRect: rectOf(browser),
      pixels: null,
    };
    if (tab.selected || splitViewPanels.includes(tab.linkedPanel)) {
      entry.pixels = {
        content: await contentColor(browser),
        window: await windowColor(entry.browserRect),
      };
    }
    tabs.push(entry);
  }
  const closed = (win.__bentoPanelSuite?.closed ?? []).map((element) => ({
    id: element.id,
    connected: element.isConnected,
    classes: Array.from(element.classList),
  }));
  return {
    tabpanels: {
      classes: Array.from(tabpanels.classList),
      splitviewAttr: tabpanels.hasAttribute('splitview'),
      splitViewPanels,
      rect: rectOf(tabpanels),
      scrollLeft: tabpanels.scrollLeft,
      scrollWidth: tabpanels.scrollWidth,
      trailer: Boolean(document.getElementById('bento-add-panel-trailer')),
    },
    activeSplitView: gBrowser.activeSplitView
      ? Array.from(gBrowser.activeSplitView.tabs, (tab) => tab.linkedPanel)
      : null,
    viewport: { width: win.innerWidth, height: win.innerHeight },
    panels,
    tabs,
    closed,
  };
}

// ---------------------------------------------------------------------------
// Invariants (pure).
// ---------------------------------------------------------------------------

// Split-view state a panel that is not rendered must not keep.
const SPLIT_CLASSES = [
  'split-view-panel',
  'split-view-panel-active',
  'bento-panel--focused',
  'bento-panel--cycle-focused',
];

function near(actual, expected) {
  return actual
    .slice(0, 3)
    .every((value, index) => Math.abs(value - expected[index]) <= COLOR_TOLERANCE);
}

/**
 * Judges collected facts against `expect.order`, the labels in render order
 * (the main slot first). Returns the failures; empty means the state holds.
 */
export function checkState(facts, expect) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const labelOf = (tab) => labelOfUrl(tab.url) ?? `<${tab.url.slice(0, 60)}>`;
  const split = expect.order.length > 1;
  const { tabpanels } = facts;

  const expectedTabs = expect.order.map((label) =>
    facts.tabs.filter((tab) => labelOf(tab) === label),
  );
  expectedTabs.forEach((matches, index) => {
    if (matches.length !== 1)
      fail(`${expect.order[index]}: expected one tab with its page, found ${matches.length}`);
  });
  if (failures.length) return failures;
  const rendered = expectedTabs.map((matches) => matches[0]);
  const renderedIds = rendered.map((tab) => tab.linkedPanel);

  const selected = facts.tabs.find((tab) => tab.selected);
  if (!selected || labelOf(selected) !== expect.order[0]) {
    fail(`selected tab is ${selected ? labelOf(selected) : 'none'}, expected ${expect.order[0]}`);
  }

  // Split-view membership and tabpanels state.
  const hasSplitClasses = ['bento-split-active', 'bento-flat-panel-layout'].every((name) =>
    tabpanels.classes.includes(name),
  );
  const hasAnySplitClass = ['bento-split-active', 'bento-flat-panel-layout'].some((name) =>
    tabpanels.classes.includes(name),
  );
  if (split) {
    if (!hasSplitClasses)
      fail(
        `tabpanels lacks bento-split-active/bento-flat-panel-layout (has: ${tabpanels.classes.join(' ') || 'none'})`,
      );
    if (!tabpanels.splitviewAttr)
      fail("tabpanels lacks Firefox's [splitview] attribute: the split view is not active");
    if (!tabpanels.trailer) fail('add-panel trailer is missing');
    if (JSON.stringify(tabpanels.splitViewPanels) !== JSON.stringify(renderedIds)) {
      fail(
        `tabpanels.splitViewPanels is [${tabpanels.splitViewPanels.join(', ')}], expected [${renderedIds.join(', ')}] (${expect.order.join(', ')})`,
      );
    }
    const active = facts.activeSplitView ?? [];
    if (JSON.stringify([...active].sort()) !== JSON.stringify([...renderedIds].sort())) {
      fail(
        `gBrowser.activeSplitView holds [${active.join(', ')}], expected [${renderedIds.join(', ')}]`,
      );
    }
    const byOrder = facts.panels
      .filter((panel) => panel.order !== '' && tabpanels.splitViewPanels.includes(panel.id))
      .sort((left, right) => Number(left.order) - Number(right.order))
      .map((panel) => panel.id);
    if (JSON.stringify(byOrder) !== JSON.stringify(renderedIds)) {
      fail(
        `render order (CSS order) is [${byOrder.join(', ')}], expected [${renderedIds.join(', ')}]`,
      );
    }
  } else {
    if (hasAnySplitClass)
      fail(`tabpanels keeps split classes at main only (${tabpanels.classes.join(' ')})`);
    // The main-only teardown must also drop the id of a panel that already closed, or
    // Firefox keeps tabpanels [splitview] set (see "Panel suite" in chrome-panel-rendering.md).
    if (tabpanels.splitViewPanels.length) {
      const ids = tabpanels.splitViewPanels.map((id) =>
        facts.panels.some((panel) => panel.id === id) ? id : `${id} (no element: a closed panel)`,
      );
      fail(`tabpanels.splitViewPanels not cleared at main only: [${ids.join(', ')}]`);
    }
    if (tabpanels.splitviewAttr) fail('tabpanels [splitview] attribute is still set at main only');
    if (facts.activeSplitView)
      fail(`gBrowser.activeSplitView not cleared: [${facts.activeSplitView.join(', ')}]`);
    if (tabpanels.trailer) fail('add-panel trailer still present at main only');
  }

  // Each rendered panel.
  const tp = tabpanels.rect;
  const strip = { l: 0, r: tabpanels.scrollWidth };
  let previousRight = null;
  rendered.forEach((tab, index) => {
    const label = expect.order[index];
    const panel = facts.panels.find((candidate) => candidate.id === tab.linkedPanel);
    if (!panel)
      return fail(`${label}: panel element ${tab.linkedPanel} is not a child of tabpanels`);
    if (!tab.docShellIsActive) fail(`${label}: docShellIsActive is false`);
    if (!tab.renderLayers) fail(`${label}: renderLayers is false`);
    if (split) {
      for (const name of ['split-view-panel', 'split-view-panel-active']) {
        if (!panel.classes.includes(name)) fail(`${label}: panel lacks .${name}`);
      }
      if (panel.order !== String(index * 2))
        fail(`${label}: CSS order is "${panel.order}", expected ${index * 2}`);
      if (!tab.ownSplitview) fail(`${label}: tab has no Bento split-view marker`);
      if (index === 0) {
        if (panel.main !== '1') fail(`${label}: main panel flag is not set`);
      } else {
        if (panel.main !== null) fail(`${label}: side panel carries the main panel flag`);
        if (panel.panelTabId === null) fail(`${label}: side panel has no panel tab id`);
        if (!panel.header) fail(`${label}: side panel has no injected header`);
        if (!panel.closeButton) fail(`${label}: side panel header has no Close panel button`);
      }
    }
    const { rect } = panel;
    const width = rect.r - rect.l;
    const height = rect.b - rect.t;
    if (width < 50 || height < 50)
      fail(`${label}: panel rect is ${Math.round(width)}x${Math.round(height)}`);
    const x = { l: rect.l - tp.l + tabpanels.scrollLeft, r: rect.r - tp.l + tabpanels.scrollLeft };
    if (rect.t < tp.t - 1 || rect.b > tp.b + 1 || x.l < strip.l - 1 || x.r > strip.r + 1) {
      fail(`${label}: panel rect is outside tabpanels`);
    }
    if (previousRight !== null && rect.l < previousRight - 1)
      fail(`${label}: panel overlaps the one before it`);
    previousRight = rect.r;
    if (!split && width < (tp.r - tp.l) * 0.9)
      fail(
        `${label}: main-only panel is ${Math.round(width)}px wide in a ${Math.round(tp.r - tp.l)}px tabpanels`,
      );

    // The browser itself must be visible: sized, inside its panel and inside the window.
    const { browserRect } = tab;
    const inside = (inner, outer) =>
      inner.l >= outer.l - 1 &&
      inner.t >= outer.t - 1 &&
      inner.r <= outer.r + 1 &&
      inner.b <= outer.b + 1;
    const browserWidth = browserRect.r - browserRect.l;
    const browserHeight = browserRect.b - browserRect.t;
    if (browserWidth < 50 || browserHeight < 50) {
      fail(`${label}: browser rect is ${Math.round(browserWidth)}x${Math.round(browserHeight)}`);
    }
    if (!inside(browserRect, rect)) fail(`${label}: browser rect is outside its panel`);
    const { width: windowWidth, height: windowHeight } = facts.viewport;
    if (!inside(browserRect, { l: 0, t: 0, r: windowWidth, b: windowHeight })) {
      fail(`${label}: browser rect is outside the ${windowWidth}x${windowHeight} window`);
    }

    // Both samples are required: a missing one is a failure, never a skip.
    const expected = PAGES[label].color;
    for (const [name, sample, what] of [
      ['content', tab.pixels?.content, 'page renders'],
      ['window', tab.pixels?.window, 'window shows'],
    ]) {
      if (!sample) fail(`${label}: no ${name} sample was taken`);
      else if (sample.error) fail(`${label}: ${name} sample unavailable, ${sample.error}`);
      else if (!near(sample.color, expected)) {
        fail(`${label}: ${what} rgb(${sample.color.slice(0, 3)}), expected rgb(${expected})`);
      }
    }
  });

  // Nothing outside the render list keeps split-view state. At main only nothing is split, so
  // every tab is checked, the surviving main tab included.
  const unsplit = split
    ? facts.tabs.filter((tab) => !renderedIds.includes(tab.linkedPanel))
    : facts.tabs;
  for (const tab of unsplit) {
    const label = labelOf(tab);
    const panel = facts.panels.find((candidate) => candidate.id === tab.linkedPanel);
    if (tab.ownSplitview) fail(`${label}: tab keeps a Bento split-view marker`);
    if (tabpanels.splitViewPanels.includes(tab.linkedPanel))
      fail(`${label}: still in tabpanels.splitViewPanels`);
    if (!panel) continue;
    const stale = SPLIT_CLASSES.filter((name) => panel.classes.includes(name));
    if (stale.length) fail(`${label}: panel keeps .${stale.join(' .')}`);
    if (panel.main !== null || panel.panelTabId !== null)
      fail(`${label}: panel keeps Bento panel data attributes`);
    if (panel.order !== '' || panel.column) fail(`${label}: panel keeps inline order or [column]`);
  }
  for (const entry of facts.closed) {
    if (entry.connected && SPLIT_CLASSES.some((name) => entry.classes.includes(name))) {
      fail(`closed panel ${entry.id} is still in the DOM with .${entry.classes.join(' .')}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Running the app.
// ---------------------------------------------------------------------------

function resolveApp(argument) {
  const given = path.resolve(argument ?? DEFAULT_APP);
  const binary = given.endsWith('.app') ? path.join(given, 'Contents', 'MacOS', 'bento') : given;
  try {
    fs.accessSync(binary, fs.constants.X_OK);
  } catch {
    throw new SuiteError(
      `no executable at ${binary}. Pass --app <Bento.app or its Contents/MacOS/bento>`,
    );
  }
  return { binary, app: given };
}

function launchApp({ binary, headed, profileDir, logPath }) {
  fs.writeFileSync(path.join(profileDir, 'user.js'), 'user_pref("marionette.port", 0);\n');
  const args = [
    '--new-instance',
    '--marionette',
    ...(headed ? [] : ['--headless']),
    '--profile',
    profileDir,
  ];
  const output = fs.openSync(logPath, 'a');
  const child = spawn(binary, args, {
    // Firefox 159 reads system access at startup; grant it only to this test process.
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    stdio: ['ignore', output, output],
  });
  fs.closeSync(output);
  const handle = { child, exited: false, spawnError: null };
  child.once('exit', () => {
    handle.exited = true;
  });
  child.once('error', (error) => {
    handle.exited = true;
    handle.spawnError = error;
  });
  return handle;
}

// Retries only while the server is not ready: the port file is not written, or the connection is
// refused or reset. A failure after the connection (the session handshake) is a real protocol
// error: the client is closed, because a session left open makes Firefox refuse the next
// connection, and the error is thrown as it is.
async function connectMarionette(handle, profileDir, deadline) {
  const portFile = path.join(profileDir, 'MarionetteActivePort');
  const end = Math.min(Date.now() + STARTUP_TIMEOUT_MS, deadline);
  while (Date.now() < end) {
    if (handle.exited) {
      throw new SuiteError(
        `the app exited before Marionette came up${handle.spawnError ? `: ${handle.spawnError.message}` : ''}`,
      );
    }
    const port = Number.parseInt(
      fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : '',
      10,
    );
    if (port > 0) {
      let client = null;
      try {
        client = await MarionetteClient.connect({ port, timeoutMs: 3000 });
      } catch (error) {
        if (!(error instanceof ConnectionError)) throw error;
      }
      if (client) {
        try {
          await client.start();
          return client;
        } catch (error) {
          client.close();
          throw error;
        }
      }
    }
    await sleep(250);
  }
  throw new SuiteError(`Marionette did not come up within ${STARTUP_TIMEOUT_MS} ms`);
}

// Quits through Marionette, then signals only the process this run spawned.
async function stopApp(handle, client) {
  const exited = async (ms) => {
    const end = Date.now() + ms;
    while (!handle.exited && Date.now() < end) await sleep(100);
    return handle.exited;
  };
  if (handle.exited) return;
  if (client) {
    await client.quit();
    if (await exited(QUIT_TIMEOUT_MS)) return;
  }
  handle.child.kill('SIGTERM');
  if (await exited(10_000)) return;
  handle.child.kill('SIGKILL');
  await exited(5000);
}

// ---------------------------------------------------------------------------
// Scenario.
// ---------------------------------------------------------------------------

class Suite {
  constructor(client, deadline) {
    this.client = client;
    this.deadline = deadline;
    this.steps = [];
    this.lastFacts = null;
  }

  async inWindow(fn, ...args) {
    const script = `return Promise.resolve((${fn})(window, ...arguments)).then((value) => JSON.stringify(value ?? null));`;
    const raw = await this.client.executeScript(script, args, { timeoutMs: 40_000 });
    return JSON.parse(raw);
  }

  /** Polls `probe` until it returns a defined value; every wait is bounded and named. */
  async waitFor(name, probe, { timeoutMs = 10_000, intervalMs = 250, note } = {}) {
    const end = Math.min(Date.now() + timeoutMs, this.deadline);
    for (;;) {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
      if (Date.now() >= end) {
        const reason =
          Date.now() >= this.deadline ? 'the suite deadline passed' : `${timeoutMs} ms`;
        throw new SuiteError(
          `timed out (${reason}) waiting for ${name}${note ? `: ${note()}` : ''}`,
        );
      }
      await sleep(intervalMs);
    }
  }

  step(message) {
    this.steps.push(message);
    log(message);
  }

  async checkApp(appPath) {
    const info = await this.inWindow(chromeAppInfo, STALE_CHECK_FILES);
    this.step(
      `app ${appPath}: ${info.name} ${info.version}, Firefox ${info.platformVersion}, BuildID ${info.buildId}`,
    );
    const sourceHashes = Object.fromEntries(
      STALE_CHECK_FILES.map((file) => [
        file,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(MOUNT_DIR, file)))
          .digest('hex'),
      ]),
    );
    const stale = STALE_CHECK_FILES.filter((file) => sourceHashes[file] !== info.hashes[file]);
    if (stale.length) {
      const named = stale.map(
        (file) =>
          `${file} (app ${info.hashes[file].slice(0, 8)}, source ${sourceHashes[file].slice(0, 8)})`,
      );
      throw new SuiteError(
        `stale build: the app serves a different ${named.join(' and ')} than src/browser/base/content. Refresh the build with \`pnpm run build\` (see the dev loop table in CLAUDE.md), then rerun.`,
        { stale, appHashes: info.hashes, sourceHashes },
      );
    }
    this.step(`build is current (${STALE_CHECK_FILES.join(', ')} match src/browser/base/content)`);
  }

  async checkCompat() {
    const result = await this.inWindow(chromeCompat);
    if (result.missing.length)
      throw new SuiteError(
        `BentoFirefoxCompat.check() reports missing: ${result.missing.join(', ')}`,
      );
    this.step(
      `BentoFirefoxCompat.check(): ${result.probed} probed, 0 missing, ${result.deferred.length} deferred`,
    );
  }

  async dismissOnboarding() {
    await this.waitFor(
      'the welcome overlay to open',
      async () => {
        const state = await this.inWindow(chromeWelcome);
        return state.frameLoaded && state.display !== 'none' ? state : undefined;
      },
      { timeoutMs: 40_000 },
    );
    let lastSent = 0;
    await this.waitFor(
      'onboarding to close after the welcomeSeen setting',
      async () => {
        const state = await this.inWindow(chromeWelcome);
        if (state.display === 'none') return state;
        // The bus message can be lost while the shell background is still starting; repeat it.
        if (Date.now() - lastSent > 3000) {
          lastSent = Date.now();
          await this.inWindow(chromeSendWelcomeDone, welcomeFrameScript.toString());
        }
        return undefined;
      },
      { timeoutMs: 30_000, intervalMs: 400 },
    );
    this.step('onboarding skipped (welcomeSeen set through the shell bus)');
  }

  async tabs() {
    return this.inWindow(chromeTabs, WORKSPACE_TAB_KEY);
  }

  /** Waits for bento-tools to give the tab a workspace, the sign it took the tab over. */
  async waitForWorkspace(linkedPanel, name) {
    return this.waitFor(
      `bento-tools to adopt ${name} (workspace id)`,
      async () => {
        const tab = (await this.tabs()).find((candidate) => candidate.linkedPanel === linkedPanel);
        return tab?.workspace ?? undefined;
      },
      { timeoutMs: 15_000 },
    );
  }

  async loadAndWait(linkedPanel, label) {
    const target = await this.inWindow(chromeLoad, linkedPanel, pageUrl(label));
    await this.waitFor(`${label} page to load`, async () => {
      const tab = (await this.tabs()).find((candidate) => candidate.linkedPanel === target);
      return tab && labelOfUrl(tab.url) === label && !tab.loading ? target : undefined;
    });
    return target;
  }

  /** Creates a panel through the add-panel button, then loads its colour page. */
  async addPanel(label) {
    const before = new Set((await this.tabs()).map((tab) => tab.linkedPanel));
    if (!(await this.inWindow(chromeClickAddPanel)))
      throw new SuiteError('the panel navigator Add panel button is missing');
    let latest = [];
    const panel = await this.waitFor(
      `the new tab to become a side panel for ${label}`,
      async () => {
        latest = (await this.tabs()).filter((tab) => !before.has(tab.linkedPanel));
        const fresh = latest.length === 1 ? latest[0] : null;
        return fresh && !fresh.grantPending && fresh.panelTabId !== null && fresh.inSplit
          ? fresh
          : undefined;
      },
      { note: () => JSON.stringify(latest) },
    );
    // addNewPanel sends the panel to the new-tab page once bento-tools has taken the grant.
    await this.waitFor(`the new panel to leave the add-panel marker URL (${label})`, async () => {
      const tab = (await this.tabs()).find(
        (candidate) => candidate.linkedPanel === panel.linkedPanel,
      );
      return tab && !tab.url.startsWith('about:blank?bento_add_as_panel') && !tab.loading
        ? tab
        : undefined;
    });
    await this.loadAndWait(panel.linkedPanel, label);
    return panel.linkedPanel;
  }

  async collect(state) {
    return this.inWindow(chromeCollect, { purpose: 'collect', state });
  }

  /** Waits until a state holds twice in a row with unchanged geometry (panel enter motion is over). */
  async settle(state, expect) {
    let failures = ['not collected'];
    let previous = null;
    const facts = await this.waitFor(
      `state "${state}" to satisfy its invariants`,
      async () => {
        const collected = await this.collect(state);
        this.lastFacts = collected;
        failures = checkState(collected, expect);
        if (failures.length) {
          previous = null;
          return undefined;
        }
        const signature = JSON.stringify([
          collected.panels.map((panel) => panel.rect),
          collected.tabpanels.rect,
        ]);
        if (signature !== previous) {
          previous = signature;
          return undefined;
        }
        return collected;
      },
      { timeoutMs: 15_000, note: () => failures.join('; ') },
    );
    this.step(`state "${state}": ok (${expect.order.join(', ')})`);
    return facts;
  }

  bcIds(facts, labels) {
    return Object.fromEntries(
      labels.map((label) => [label, facts.tabs.find((tab) => labelOfUrl(tab.url) === label)?.bcId]),
    );
  }

  async run(appPath) {
    await this.waitFor(
      'the browser window and the Bento mount to be ready',
      async () => ((await this.inWindow(chromeReady)) ? true : undefined),
      { timeoutMs: STARTUP_TIMEOUT_MS },
    );
    await this.checkApp(appPath);
    await this.checkCompat();
    await this.dismissOnboarding();
    // Every rendered browser's centre must fit in the window for its window-level sample, so
    // a window that cannot be this large fails the run.
    let reached = null;
    await this.waitFor(
      `the window to resize to ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`,
      async () => {
        reached = await this.inWindow(chromeResize, WINDOW_SIZE.width, WINDOW_SIZE.height);
        return reached.width === WINDOW_SIZE.width && reached.height === WINDOW_SIZE.height
          ? reached
          : undefined;
      },
      { timeoutMs: 5000, note: () => `it is ${reached?.width}x${reached?.height}` },
    );
    this.step(`window ${reached.width}x${reached.height}`);

    // The window's first tab has no stored workspace id (tools adopts it differently from later tabs).
    await this.loadAndWait(null, 'main');
    await this.settle('main only', { order: ['main'] });

    const a = await this.addPanel('a');
    const b = await this.addPanel('b');
    const withPanels = await this.settle('main plus two panels', { order: ['main', 'a', 'b'] });
    const ids = this.bcIds(withPanels, ['main', 'a', 'b']);

    const other = await this.inWindow(chromeOpenTab, pageUrl('other'));
    await this.waitForWorkspace(other, 'the second main tab');
    await this.waitFor('the second main tab to load', async () => {
      const tab = (await this.tabs()).find((candidate) => candidate.linkedPanel === other);
      return tab && labelOfUrl(tab.url) === 'other' && !tab.loading ? tab : undefined;
    });
    await this.inWindow(chromeSelectTab, other);
    const switched = await this.settle('main tab switched', { order: ['other', 'a', 'b'] });
    const after = this.bcIds(switched, ['main', 'a', 'b']);
    for (const label of ['main', 'a', 'b']) {
      if (after[label] !== ids[label])
        throw new SuiteError(
          `${label}: browsing context id changed across the main-tab switch (${ids[label]} to ${after[label]})`,
        );
    }
    this.step(`browsing context ids unchanged across the switch (${JSON.stringify(ids)})`);

    await this.closePanel(a, 'a');
    await this.settle('first panel closed', { order: ['other', 'b'] });
    await this.closePanel(b, 'b');
    await this.settle('back to main only', { order: ['other'] });
  }

  async closePanel(linkedPanel, label) {
    if (!(await this.inWindow(chromeClosePanel, linkedPanel)))
      throw new SuiteError(`${label}: Close panel button not found`);
    await this.waitFor(
      `the ${label} tab to close`,
      async () =>
        (await this.tabs()).some((tab) => tab.linkedPanel === linkedPanel) ? undefined : true,
      { timeoutMs: 15_000 },
    );
    this.step(`closed panel ${label}`);
  }
}

async function writeFailureArtifacts({ suite, client, error, profileDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-panel-suite-failure-'));
  const dump = {
    error: error.message,
    detail: error.detail ?? null,
    steps: suite?.steps ?? [],
    facts: suite?.lastFacts ?? null,
    profile: profileDir,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(dump, null, 2));
  if (client) {
    try {
      const shot = await client.command(
        'WebDriver:TakeScreenshot',
        { full: false, hash: false, scroll: false },
        { timeoutMs: 15_000 },
      );
      fs.writeFileSync(path.join(dir, 'window.png'), Buffer.from(shot.value, 'base64'));
    } catch (screenshotError) {
      fs.writeFileSync(path.join(dir, 'window.png.error.txt'), String(screenshotError));
    }
  }
  return dir;
}

/** Runs the suite against one app and resolves with the process exit code. */
export async function runPanelSuite({ app, headed = false, keepProfile = false }) {
  const { binary, app: appPath } = resolveApp(app);
  const started = Date.now();
  const deadline = started + TOTAL_TIMEOUT_MS;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-panel-suite-profile-'));
  const logPath = path.join(profileDir, 'launch.log');
  const handle = launchApp({ binary, headed, profileDir, logPath });
  log(
    `launched pid ${handle.child.pid} (${headed ? 'headed' : 'headless'}), profile ${profileDir}`,
  );
  let client = null;
  let suite = null;
  let failure = null;
  const watchdog = setTimeout(() => {
    handle.child.kill('SIGKILL');
    console.error('[panel-suite] FAIL: the suite watchdog expired; the app was killed');
    process.exit(1);
  }, TOTAL_TIMEOUT_MS + 60_000);
  watchdog.unref();
  // Ctrl-C or a terminate signal to this runner stops the app it spawned and keeps the profile.
  const interrupted = (signal) => {
    handle.child.kill('SIGKILL');
    console.error(
      `[panel-suite] interrupted by ${signal}; the app was killed, profile kept: ${profileDir}`,
    );
    process.exit(1);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    client = await connectMarionette(handle, profileDir, deadline);
    suite = new Suite(client, deadline);
    await suite.run(appPath);
  } catch (error) {
    failure = error;
  }
  let artifacts = null;
  if (failure)
    artifacts = await writeFailureArtifacts({ suite, client, error: failure, profileDir }).catch(
      () => null,
    );
  await stopApp(handle, client);
  client?.close();
  clearTimeout(watchdog);
  process.off('SIGINT', interrupted);
  process.off('SIGTERM', interrupted);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failure) {
    console.error(`[panel-suite] FAIL after ${seconds}s: ${failure.message}`);
    if (artifacts) console.error(`[panel-suite] state dump and window screenshot: ${artifacts}`);
    console.error(`[panel-suite] profile kept: ${profileDir} (launch log: ${logPath})`);
    return 1;
  }
  if (keepProfile) log(`profile kept: ${profileDir}`);
  else fs.rmSync(profileDir, { recursive: true, force: true });
  log(`PASS in ${seconds}s`);
  return 0;
}

const USAGE = `usage: pnpm run test:panels -- [--app <Bento.app or Contents/MacOS/bento>] [--headed] [--keep-profile]
  --app           the build to test (default: engine/obj-bento/dist/Bento.app)
  --headed        show the window instead of running headless
  --keep-profile  keep the temporary profile after a pass (a failure always keeps it)`;

async function main(argv) {
  let values;
  try {
    // `pnpm run script -- --flag` can hand the script a literal leading `--`.
    ({ values } = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : argv,
      options: {
        app: { type: 'string' },
        headed: { type: 'boolean' },
        'keep-profile': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (process.env.CI) {
    console.error(
      '[panel-suite] this suite is local only: CI builds no application, so there is no app to launch',
    );
    return 2;
  }
  try {
    resolveApp(values.app);
  } catch (error) {
    console.error(`[panel-suite] ${error.message}`);
    return 2;
  }
  return runPanelSuite({
    app: values.app,
    headed: values.headed,
    keepProfile: values['keep-profile'],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
