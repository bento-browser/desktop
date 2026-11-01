import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Drives the real show, hide, toggle and Esc paths of bento-shell-mount.js
// against the real overlay manager and its real overlay table. The mount is one
// 20,000-line script that needs Firefox to run, so this extracts the functions
// by name from its source and evaluates them in a context with a fake DOM, fake
// timers and computed style, and fake frames whose message managers record what chrome sends an
// overlay (the toolbar scrim is a recording stub). A function that is renamed or
// removed fails extraction instead of silently leaving the test behind.

// Values built inside the vm context come from another realm.
const plain = (value) => JSON.parse(JSON.stringify(value));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNT = fs.readFileSync(
  path.join(ROOT, 'src/browser/base/content/bento-shell-mount.js'),
  'utf8',
);

/** The Settings palette's frame script source, as the string the mount script builds. */
const SETTINGS_FRAME_SCRIPT_SRC = (() => {
  const start = MOUNT.indexOf('const SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_SRC =');
  const end = MOUNT.indexOf('const SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_URL', start);
  assert.ok(start !== -1 && end !== -1, 'the Settings frame script source is missing');
  const expression = MOUNT.slice(start, end).replace(
    'const SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_SRC =',
    '',
  );
  return vm.runInNewContext(expression);
})();

/** The Bookmarks view's frame script source, as the string the mount script builds. */
const BOOKMARKS_FRAME_SCRIPT_SRC = (() => {
  const start = MOUNT.indexOf('const BOOKMARKS_VIEW_FRAME_SCRIPT_SRC =');
  const end = MOUNT.indexOf('const BOOKMARKS_VIEW_FRAME_SCRIPT_URL', start);
  assert.ok(start !== -1 && end !== -1, 'the Bookmarks view frame script source is missing');
  const expression = MOUNT.slice(start, end).replace(
    'const BOOKMARKS_VIEW_FRAME_SCRIPT_SRC =',
    '',
  );
  return vm.runInNewContext(expression);
})();

// ─── Extraction ──────────────────────────────────────────────────────────────

/** Index just past the bracket that closes the one opened at `open`. */
function skipBalanced(source, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[source[open]]];
  let i = open + 1;
  while (i < source.length && stack.length > 0) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
    } else if (c === "'" || c === '"') {
      i += 1;
      while (source[i] !== c) i += source[i] === '\\' ? 2 : 1;
    } else if (c === '`') {
      i += 1;
      while (source[i] !== '`') {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '$' && source[i + 1] === '{') i = skipBalanced(source, i + 1) - 1;
        else i += 1;
      }
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === stack.at(-1)) {
      stack.pop();
    }
    i += 1;
  }
  assert.equal(stack.length, 0, 'unbalanced source while extracting');
  return i;
}

function extractFunction(name) {
  const header = MOUNT.includes(`\n  async function ${name}(`)
    ? `\n  async function ${name}(` : `\n  function ${name}(`;
  const start = MOUNT.indexOf(header);
  assert.ok(start !== -1, `bento-shell-mount.js has no function ${name}`);
  assert.equal(MOUNT.indexOf(header, start + 1), -1, `function ${name} is declared twice`);
  const open = start + header.length - 1;
  const bodyStart = MOUNT.indexOf('{', skipBalanced(MOUNT, open));
  return MOUNT.slice(start + 1, skipBalanced(MOUNT, bodyStart));
}

function extractConst(name) {
  const match = new RegExp(`^  const ${name} = [^;]*;`, 'm').exec(MOUNT);
  assert.ok(match, `bento-shell-mount.js has no const ${name}`);
  return match[0];
}

function extractOverlaysSection() {
  const begin = '// @bento-overlays:begin';
  const end = '// @bento-overlays:end';
  return MOUNT.slice(MOUNT.indexOf(begin) + begin.length, MOUNT.indexOf(end));
}

/** The `const overlays = createOverlayManager({ ... });` statement with its real table. */
function extractOverlaysTable() {
  const start = MOUNT.indexOf('  const overlays = createOverlayManager({');
  assert.ok(start !== -1, 'bento-shell-mount.js has no overlays table');
  const open = MOUNT.indexOf('(', start);
  return MOUNT.slice(start, skipBalanced(MOUNT, open) + 1);
}

const FUNCTIONS = [
  'motionList',
  'motionTimeMs',
  'measureMotion',
  'cancelMotion',
  'afterMotion',
  'hideOverlayHostAfterFade',
  'overlayEntry',
  'createOverlayFrame',
  'openOverlay',
  'focusOverlayFrame',
  'isOverlayOpen',
  'dismissPalette',
  'dismissMergePalette',
  'dismissWorkspacePalette',
  'dismissSettingsPalette',
  'isPaletteVisible',
  'showPalette',
  'hidePalette',
  'togglePalette',
  'isWorkspacePaletteVisible',
  'showWorkspacePalette',
  'hideWorkspacePalette',
  'nextMergePaletteNonce',
  'isMergePaletteVisible',
  'showMergePalette',
  'hideMergePalette',
  'toggleMergePalette',
  'isSettingsPaletteVisible',
  'showSettingsPalette',
  'hideSettingsPalette',
  'handleSettingsTargetTitle',
  'isBookmarksViewVisible',
  'isBookmarksViewOpen',
  'showBookmarksView',
  'hideBookmarksView',
  'toggleBookmarksView',
  'isOverlayAboveBookmarksViewShown',
  'shownBrowsers',
  'isTabDialogShowing',
  'isPageContainerShown',
  'restoreBookmarksViewFocus',
  'focusReturnTarget',
  'returnFocusAfterOverlay',
  'isBentoBookmarksActive',
  'isBookmarkPopupOpen',
  'readBookmarkPopupAnchor',
  'shiftBookmarkPopupAnchor',
  'readBookmarkPopupRequest',
  'nextBookmarkPopupId',
  'showBookmarkPopup',
  'hideBookmarkPopup',
  'handleBookmarkPopupCloseTitle',
  'handleBookmarkPopupOpenTitle',
  'handleBookmarkedTabsTitle',
  'getSelectedPanelBookmarkAnchor',
  'cancelBookmarkPopupRequest',
  'takeBookmarkPopupRequest',
  'openBookmarkPopupForSelectedTab',
  'requestBookmarkPopup',
  'openBookmarkPopupFromPanelHeader',
  'isBentoSavableUrlSpec',
  'isSelectedTabBookmarkTarget',
  'canShowBookmarkPopup',
  'sidebarAddressUrlMatchesActiveMain',
  'setPanelBookmarkButtonState',
  'drawPanelBookmarkButton',
  'updatePanelBookmarkButtonState',
  'refreshPanelHeaderBookmarkButtons',
  'patchBookmarkPageCommand',
  'attachBookmarkPopupListeners',
  'applyBookmarksToolbar',
  'isBookmarksToolbarShown',
  'createBookmarksToolbarHostWhenShown',
  'createBookmarksToolbarHost',
  'removeBookmarksToolbarHost',
  'parseSidebarAddressTitlePayload',
  'decodeAddrbarPayload',
  'closeBookmarksViewForDialog',
  'closeBookmarksViewForShownDialog',
  'recheckBookmarksViewDialogLater',
  'attachBookmarksViewDialogListener',
  'retargetLibraryKeyToBookmarksView',
  'restoreLibraryKey',
  'applyChromeBookmarksEnabled',
  'setAddrbarOverSidebarRow',
  'syncAddrbarOverSidebarRow',
  'handleSidebarAddressReadyTitle',
  'isAddrbarVisible',
  'nextAddrbarOpenId',
  'positionAddrbarHost',
  'clearPendingAddrbarReveal',
  'prepareAddrbarHostForOpen',
  'revealPendingAddrbar',
  'retryPendingAddrbarOpen',
  'getAddrbarFocusPreservingFrame',
  'showAddrbar',
  'openAddressEntry',
  'cancelAddrbarOpenRequest',
  'requestAddrbarOpen',
  'takeAddrbarOpenRequest',
  'handleAddrbarOpenAnswer',
  'hideAddrbar',
  'isConfirmVisible',
  'showConfirm',
  'hideConfirm',
  'isEditWorkspaceVisible',
  'showEditWorkspace',
  'hideEditWorkspace',
  'isWorkspaceSwitcherVisible',
  'showWorkspaceSwitcher',
  'hideWorkspaceSwitcher',
  'isWelcomeVisible',
  'isWelcomeShowing',
  'showWelcome',
  'hideWelcome',
  'isEmbeddedImportVisible',
  'showChromeMenu',
  'hideChromeMenu',
  'isDocumentLocalShellAction',
  'postShellActionThroughBusHub',
  'dispatchShellAction',
  'savePanelMenuItems',
  'dispatchAddrbarOpen',
  'dispatchSidebarAddressMessage',
  'dispatchMergePaletteLifecycle',
  'sendSettingsPaletteMessage',
  'dispatchSettingsPaletteShow',
  'dispatchSettingsPaletteHide',
  'sendBookmarksViewMessage',
  'dispatchBookmarksViewShow',
  'dispatchBookmarksViewHide',
  'attachPaletteCloseListener',
  'attachPaletteEscListener',
  'attachOutsideClickDismissListener',
];

const CONSTANTS = [
  'MOTION_SLACK_MS',
  'MOTION_UNAVAILABLE_CEILING_MS',
  'motionWaits',
  'SETTINGS_TARGET_OPEN_PREFIX',
  'SETTINGS_TARGET_ID_PATTERN',
  'SETTINGS_OPEN_PREFIX',
  'SETTINGS_PRIVACY_OPEN_PREFIX',
  'PALETTE_OPEN_PREFIX',
  'PALETTE_CLOSE_PREFIX',
  'WORKSPACE_PALETTE_OPEN_PREFIX',
  'MERGE_PALETTE_OPEN_PREFIX',
  'MERGE_PALETTE_CLOSE_PREFIX',
  'BOOKMARKS_OPEN_PREFIX',
  'BOOKMARKS_CLOSE_PREFIX',
  'BOOKMARKS_VIEW_ATTR',
  'BOOKMARKS_TOOLBAR_ATTR',
  'SIDEBAR_PUSH_ATTR',
  'SIDEBAR_RAIL_ATTR',
  'BOOKMARK_POPUP_OPEN_PREFIX',
  'BOOKMARK_POPUP_CLOSE_PREFIX',
  'BOOKMARKED_TABS_PREFIX',
  'LIBRARY_KEY_STOCK_ATTR',
  'BOOKMARKS_VIEW_HIGHER_OVERLAYS',
  'OVERLAY_READY_PREFIX',
  'ADDON_ID',
  'BENTO_EMBEDDED_IMPORT_URL',
  'ADDRBAR_POPUP_WIDTH_PX',
  'ADDRBAR_POPUP_HEIGHT_PX',
  'ADDRBAR_FRAME_GUTTER_TOP_PX',
  'ADDRBAR_FRAME_GUTTER_INLINE_PX',
  'ADDRBAR_FRAME_GUTTER_BOTTOM_PX',
  'ADDRBAR_OPEN_RETRY_MS',
  'BOOKMARK_POPUP_REQUEST_MS',
  'ADDRBAR_OPEN_RETRY_LIMIT',
  'ADDRBAR_OPEN_FALLBACK_REVEAL_MS',
  'ADDRBAR_HOST_TRANSITION',
  'SIDEBAR_ADDRESS_RETRY_LIMIT',
  'menuOnSelectByContext',
];

const EXPORTED = [
  'overlays',
  'menuOnSelectByContext',
  'dispatchShellAction',
  'savePanelMenuItems',
  'MOTION_UNAVAILABLE_CEILING_MS',
  'BOOKMARK_POPUP_REQUEST_MS',
  'showPalette',
  'hidePalette',
  'hideWorkspacePalette',
  'hideEditWorkspace',
  'hideWelcome',
  'isWelcomeShowing',
  'togglePalette',
  'showWorkspacePalette',
  'showMergePalette',
  'hideMergePalette',
  'toggleMergePalette',
  'showSettingsPalette',
  'hideSettingsPalette',
  'handleSettingsTargetTitle',
  'showBookmarksView',
  'hideBookmarksView',
  'toggleBookmarksView',
  'retargetLibraryKeyToBookmarksView',
  'restoreLibraryKey',
  'applyChromeBookmarksEnabled',
  'attachBookmarksViewDialogListener',
  'attachBookmarkPopupListeners',
  'showBookmarkPopup',
  'hideBookmarkPopup',
  'isBookmarkPopupOpen',
  'requestBookmarkPopup',
  'patchBookmarkPageCommand',
  'openBookmarkPopupFromPanelHeader',
  'isBentoSavableUrlSpec',
  'drawPanelBookmarkButton',
  'updatePanelBookmarkButtonState',
  'handleBookmarkedTabsTitle',
  'refreshPanelHeaderBookmarkButtons',
  'readBookmarkPopupRequest',
  'attachPaletteCloseListener',
  'showAddrbar',
  'requestAddrbarOpen',
  'takeAddrbarOpenRequest',
  'handleAddrbarOpenAnswer',
  'handleSidebarAddressReadyTitle',
  'hideAddrbar',
  'revealPendingAddrbar',
  'showConfirm',
  'hideConfirm',
  'showEditWorkspace',
  'showWorkspaceSwitcher',
  'hideWorkspaceSwitcher',
  'showWelcome',
  'showChromeMenu',
  'hideChromeMenu',
  'attachPaletteEscListener',
  'attachOutsideClickDismissListener',
];

// ─── World ───────────────────────────────────────────────────────────────────

/**
 * A <browser> whose message manager records what chrome sends and which frame scripts it loads.
 * It also answers what the motion helpers read: a connected flag, an owner document whose view
 * gives a computed style, and transitionend listeners.
 */
class FakeElement {
  constructor(registry, tag, sent) {
    this.registry = registry;
    this.ownerDocument = registry.ownerDocument;
    this.isConnected = true;
    this.listeners = new Map();
    this.tag = tag;
    this.id = '';
    this.style = {};
    this.attrs = new Map();
    this.focusCount = 0;
    /** Whether it sits in a page's .browserSidebarContainer, where tab dialogs are drawn. */
    this.inPageContainer = false;
    /** The container it sits in when that is another element (a dialog overlay of a browser). */
    this.pageContainer = null;
    if (tag === 'browser') {
      this.messageManager = {
        loadFrameScript: () => {},
        sendAsyncMessage: (name, data) => sent.push({ name, data: plain(data), frame: this.id }),
      };
    }
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child) {
    if (child.id) this.registry.set(child.id, child);
    return child;
  }

  getBoundingClientRect() {
    return this.rect ?? { left: 0, top: 0, width: 100, height: 100 };
  }

  remove() {
    this.isConnected = false;
    this.registry.delete(this.id);
  }

  focus() {
    this.focusCount += 1;
    this.registry.focusLog.push(this.id);
  }

  closest(selector) {
    if (selector !== '.browserSidebarContainer') return null;
    return this.pageContainer ?? (this.inPageContainer ? this : null);
  }

  addEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(handler));
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  /** A browser event on this element, as the end of a CSS transition delivers it. */
  dispatch(type, init = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler({ type, target: this, ...init });
    }
  }
}

const HOSTS = {
  palette: { static: true },
  'merge-palette': { static: true },
  confirm: { static: true },
  menu: { static: true },
  addrbar: {},
  'workspace-palette': {},
  'settings-palette': {},
  bookmarks: {},
  'bookmarks-popup': {},
  'edit-workspace': {},
  welcome: {},
  'embedded-import': {},
  'workspace-switcher': {},
  'panel-navigator-tooltip': {},
};

/**
 * `windowId` is what chrome's window tracker answers: a number, or null when the lookup fails.
 * `fadeMs` is the opacity transition the stylesheet gives every overlay host (the Mux modal
 * role); 0 stands for reduced motion. An inline `transition: none` wins, as in CSS.
 */
function makeWorld({ windowId = 7, fadeMs = 180, privateWindow = false, presentationQuery } = {}) {
  let rowAnchorable = true;
  let clock = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const idle = [];
  const registry = new Map();
  /** The ids of the elements that took the focus, in order. */
  registry.focusLog = [];
  let currentFadeMs = fadeMs;
  registry.ownerDocument = {
    defaultView: {
      getComputedStyle(el) {
        const none = el.style.transition === 'none' || currentFadeMs === 0;
        return {
          transitionProperty: none ? 'none' : 'opacity',
          transitionDuration: none ? '0s' : `${currentFadeMs / 1000}s`,
          transitionDelay: '0s',
          animationName: 'none',
          animationDuration: '0s',
          animationDelay: '0s',
          animationIterationCount: '1',
        };
      },
    },
  };
  const sent = [];
  const hubPosts = [];
  const events = {
    navigations: [],
    scrim: new Set(),
    scrimShown: [],
    errors: [],
    presentation: [],
    noted: [],
    focusFallback: 0,
  };
  const listeners = [];

  function host(id, props) {
    const el = new FakeElement(registry, 'vbox', sent);
    el.id = `bento-${id}-host`;
    el.setAttribute('hidden', 'true');
    // The hosts start as ensureOverlayHost and the init pre-warm leave them.
    el.style.display = 'none';
    el.style.opacity = '0';
    if (id === 'workspace-switcher') {
      el.style.display = 'flex';
      el.style.pointerEvents = 'none';
    }
    if (id === 'menu') el.style.opacity = '';
    registry.set(el.id, el);
    if (props.static) {
      // The browser-box patch declares these frames inside their hosts.
      const frame = new FakeElement(registry, 'browser', sent);
      frame.id = `bento-${id}-frame`;
      el.appendChild(frame);
    }
  }
  for (const [id, props] of Object.entries(HOSTS)) host(id, props);
  const shellFrame = new FakeElement(registry, 'browser', sent);
  shellFrame.id = 'bento-shell-frame';
  registry.set(shellFrame.id, shellFrame);
  const sidebarHost = new FakeElement(registry, 'vbox', sent);
  sidebarHost.id = 'bento-shell-host';
  sidebarHost.style.display = 'flex';
  sidebarHost.classList = { contains: () => false };
  registry.set(sidebarHost.id, sidebarHost);
  const shellMessageManager = shellFrame.messageManager;

  const documentElement = new FakeElement(registry, 'html', sent);
  /** The panel header stars of the page, which the popup refreshes (see refreshPanelHeaderBookmarkButtons). */
  const headerStars = [];
  const document = {
    documentElement,
    body: new FakeElement(registry, 'body', sent),
    readyState: 'complete',
    activeElement: null,
    getElementById: (id) => registry.get(id) ?? null,
    createXULElement: (tag) => new FakeElement(registry, tag, sent),
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === '.bento-panel-header-button--bookmark' ? headerStars : [],
  };
  /** The tab and page `Cmd+D` is about. */
  const page = { tabId: 41, spec: 'https://example.com/a', title: 'Example' };
  /** What a Places bookmark lookup answers; a test swaps in a promise it settles itself. */
  let placesLookup = async () => [];
  const mutationObservers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }

    observe() {}

    disconnect() {
      this.disconnected = true;
    }
  }
  const firefoxBookmarkPage = [];
  const placesCommandHook = {
    bookmarkPage(...args) {
      firefoxBookmarkPage.push(args);
      return 'firefox';
    },
  };
  // The tab that is selected: opening a tab from a view selects another one.
  let selectedBrowser = new FakeElement(registry, 'browser', sent);
  selectedBrowser.id = 'selected-browser';
  selectedBrowser.inPageContainer = true;
  let splitBrowsers = null;

  function setTimeout(callback, ms = 0) {
    const id = nextTimer++;
    timers.set(id, { callback, due: clock + ms });
    return id;
  }
  const clearTimeout = (id) => timers.delete(id);

  const window = {
    performance: { now: () => clock },
    requestIdleCallback: (callback, options) => idle.push({ callback, options }),
    setTimeout,
    clearTimeout,
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    innerWidth: 1200,
    PlacesCommandHook: placesCommandHook,
    MutationObserver: FakeMutationObserver,
    gBrowser: {
      get selectedTab() {
        return { linkedPanel: 'selected-panel' };
      },
      get selectedBrowser() {
        return selectedBrowser;
      },
      // The browsers the window shows: the selected one, or those of a split view.
      get selectedBrowsers() {
        return splitBrowsers ?? [selectedBrowser];
      },
    },
  };

  const navigate = (name) => () => events.navigations.push(name);
  const sandbox = {
    document,
    window,
    setTimeout,
    clearTimeout,
    // The title payloads are base64 of UTF-8 JSON (decodeAddrbarPayload).
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    TextDecoder,
    Uint8Array,
    MutationObserver: FakeMutationObserver,
    console: {
      warn: () => {},
      error: (...args) => events.errors.push(args.map(String).join(' ')),
    },
    Date,
    Math,
    Map,
    Set,
    Object,
    bentoModePresenter: null,
    // What the overlay surfaces call that is not under test here.
    setBentoPaletteSrc: navigate('palette'),
    setBentoWorkspacePaletteSrc: navigate('workspace-palette'),
    setBentoMergePaletteSrc: navigate('merge-palette'),
    setBentoSettingsPaletteSrc: navigate('settings-palette'),
    setBentoBookmarksSrc: navigate('bookmarks'),
    setBentoAddrbarSrc: navigate('addrbar'),
    setBentoConfirmSrc: navigate('confirm'),
    setBentoEditWorkspaceSrc: navigate('edit-workspace'),
    setBentoWelcomeSrc: navigate('welcome'),
    setBentoWorkspaceSwitcherSrc: navigate('workspace-switcher'),
    setBentoMenuSrc: navigate('menu'),
    setBentoBookmarksPopupSrc: navigate('bookmarks-popup'),
    setBentoBookmarksToolbarSrc: navigate('bookmarks-toolbar'),
    setBentoPanelNavigatorTooltipSrc: navigate('panel-navigator-tooltip'),
    replayPanelNavigatorTooltipPayload: () => {},
    setOverlayPresentation: (frameId, presented, generation) => {
      events.presentation.push({ frameId, presented, generation });
      return presentationQuery ? presentationQuery(frameId, presented, generation) : true;
    },
    focusSelectedMainAfterPanelRemoval: () => { events.focusFallback += 1; },
    // The title listener checks that a frame shows a page of the bento-shell add-on.
    WebExtensionPolicy: { getByID: () => ({ mozExtensionHostname: 'bento-host' }) },
    // showMergePalette hides the rail merge card's tooltip; the tooltip is not under test here.
    hidePanelNavigatorTooltip: () => {},
    showOverlayToolbarScrim: (owner) => {
      events.scrim.add(owner);
      events.scrimShown.push(owner);
    },
    hideOverlayToolbarScrim: (owner) => events.scrim.delete(owner),
    sendImportSourcesToWelcome: async () => {},
    getChromeWindowId: () => windowId,
    // The selected tab and its page, which Firefox and the tab tracker answer.
    getSelectedWebExtensionTabId: () => page.tabId,
    activeMainBrowserSpec: () => page.spec,
    normalizeBookmarkUrlSpec: (url) => String(url || ''),
    getActiveMainBrowser: () => ({ contentTitle: page.title }),
    // Places, which the panel header star reads when the window does not use the Bento store.
    getPlacesUtils: () => ({}),
    getBookmarksForUrl: () => placesLookup(),
    getSavedPanelsFolderGuid: async () => null,
    isRealPanelUrl: (url) => !!url && url !== 'about:blank' && url !== 'about:newtab',
    bentoCompatNoteNative: (id, native) => events.noted.push({ id, native }),
    // A private window's tools-bound actions go to the BentoShellBus hub instead of
    // the frame script; the hub records what chrome posts to it.
    BentoPrivateBrowsingUtils: { isWindowPrivate: () => privateWindow },
    ChromeUtils: {
      importESModule: (url) => {
        assert.equal(url, 'resource:///actors/BentoShellBusParent.sys.mjs');
        return {
          BentoShellBusHub: {
            postFromChrome: (win, message) => {
              hubPosts.push({ win, message });
              return true;
            },
          },
        };
      },
    },
    // The placement itself is tested below; here an anchor just has to produce one.
    computeAddrbarAnchoredPlacement: (anchorRect) =>
      anchorRect ? { left: 1, top: 2, width: 3, height: 4, anchorWidth: 5, anchorHeight: 6 } : null,
    resolveClipboardUrlSuggestion: () => '',
    // Cmd+L asks the sidebar row over its address channel; the row is not under test here.
    canAnchorAddrbarToSidebarRow: () => rowAnchorable,
    getBentoSidebarAddressBridgeToken: () => 'token',
    // The frame scripts' URLs only name what loadFrameScript loads.
    SIDEBAR_ADDRESS_FRAME_SCRIPT_URL: 'sidebar-address',
    SHELL_ACTION_FRAME_SCRIPT_URL: 'shell-action',
    ADDRBAR_OPEN_FRAME_SCRIPT_URL: 'addrbar-open',
    MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT_URL: 'merge-lifecycle',
    SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_URL: 'settings-show',
    BOOKMARKS_VIEW_FRAME_SCRIPT_URL: 'bookmarks-view',
  };

  const script = `"use strict";
    ${CONSTANTS.map(extractConst).join('\n')}
    let mergePaletteOpenSeq = 0;
    let settingsLifecycleSeq = 0;
    let bookmarksLifecycleSeq = 0;
    let bookmarksViewReturnFocus = null;
    let bookmarksViewSelectedBrowser = null;
    let currentBookmarksEnabled = true;
    let addrbarOpenSeq = 0;
    let pendingAddrbarReveal = null;
    let pendingAddrbarOpenRequest = null;
    let addrbarOpenRequestSeq = 0;
    let addrbarOverSidebarRow = false;
    let addrbarOverSidebarRowSent = false;
    let addrbarOverSidebarRowRetry = null;
    let pendingMenuContextId = null;
    let currentAddrbarMode = 'current';
    let activeBookmarkPopupId = null;
    let bookmarkPopupIdSeq = 0;
    let bookmarkPopupReturnFocus = null;
    let bookmarkPopupSelectedBrowser = null;
    let pendingBookmarkPopupRequest = null;
    let bookmarkPopupRequestSeq = 0;
    let currentBookmarkedTabIds = new Set();
    let bookmarksToolbarObserver = null;
    ${extractOverlaysSection()}
    ${FUNCTIONS.map(extractFunction).join('\n')}
    ${extractOverlaysTable()}
    ({ ${EXPORTED.join(', ')}, getPendingAddrbarReveal: () => pendingAddrbarReveal });`;
  const api = vm.runInNewContext(script, sandbox, { filename: 'bento-shell-mount.js#surfaces' });

  const messages = (name) => sent.filter((message) => message.name === name);
  const world = {
    ...api,
    events,
    sent,
    registry,
    setNativeFocus: (frame) => { document.activeElement = frame; },
    get activeElement() { return document.activeElement; },
    documentElement,
    /** The tab the window shows: a view that opens a tab leaves another one selected. */
    selectBrowser: (browser) => { selectedBrowser = browser; },
    /** The browsers of a split view (the panels the window shows), or null outside one. */
    setSplitBrowsers: (browsers) => { splitBrowsers = browsers; },
    get selectedBrowser() { return selectedBrowser; },
    /** Firefox's Library key, as browser-sets.inc.xhtml declares it. */
    addLibraryKey: () => {
      const key = new FakeElement(registry, 'key', sent);
      key.id = 'manBookmarkKb';
      key.setAttribute('command', 'Browser:ShowAllBookmarks');
      registry.set(key.id, key);
      return key;
    },
    /**
     * A title written by the document in `frameId`, as the parent process reports it. The real
     * listener of attachPaletteCloseListener handles it (installed on first use).
     */
    titleChanged(frameId, title) {
      if (!listeners.some((entry) => entry.type === 'pagetitlechanged')) {
        api.attachPaletteCloseListener();
      }
      const frame = registry.get(frameId);
      frame.currentURI = { schemeIs: (scheme) => scheme === 'moz-extension', host: 'bento-host' };
      frame.contentTitle = title;
      const { handler } = listeners.findLast((entry) => entry.type === 'pagetitlechanged');
      handler({ target: frame });
    },
    timerCallback: (id) => timers.get(id)?.callback,
    /** What chrome sent the sidebar row over the address channel. */
    get sidebarMessages() {
      return messages('BentoSidebarAddress').map((message) => message.data);
    },
    /** Whether the sidebar's message manager exists yet (false: sends fail until it does). */
    setShellMessageManager: (available) => {
      shellFrame.messageManager = available ? shellMessageManager : null;
    },
    /** Whether chrome sees an expanded, settled sidebar (false: rail, hidden or mid-push). */
    setRowAnchorable: (value) => {
      rowAnchorable = value;
    },
    /** The overlay's document announces it (the BENTO_OVERLAY_READY title). */
    ready: (id) => api.overlays.markFrameReady(`bento-${id}-frame`),
    host: (id) => registry.get(`bento-${id}-host`),
    /** The overlay fade the stylesheet gives the hosts from now on (0 = reduced motion). */
    setFadeMs: (ms) => {
      currentFadeMs = ms;
    },
    frame: (id) => registry.get(`bento-${id}-frame`) ?? null,
    isShown: (id) => {
      const host = registry.get(`bento-${id}-host`);
      return host.style.display !== 'none' && !host.hasAttribute('hidden');
    },
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= target);
        if (due.length === 0) break;
        due.sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
        const [id, timer] = due[0];
        timers.delete(id);
        clock = Math.max(clock, timer.due);
        timer.callback();
      }
      clock = target;
    },
    /**
     * Esc as the chrome window sees it; returns whether Esc was consumed. `targetId` is the id of
     * the <browser> that has focus (the parent process reports a remote document's keys against it).
     */
    pressEscape(targetId) {
      api.attachPaletteEscListener();
      const { handler } = listeners.findLast((entry) => entry.type === 'keydown');
      const event = {
        key: 'Escape',
        target: targetId === undefined ? null : { id: targetId },
        consumed: false,
        preventDefault() {
          this.consumed = true;
        },
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      handler(event);
      return event.consumed;
    },
    /**
     * An event as Firefox dispatches it on the chrome window (a dialog event, TabSelect): the
     * listeners the mount attached (installed on first use) get `init`, with `type` added.
     */
    windowEvent(type, init) {
      if (!listeners.some((entry) => entry.type === type)) {
        api.attachBookmarksViewDialogListener();
        api.attachBookmarkPopupListeners();
      }
      for (const entry of listeners.filter((candidate) => candidate.type === type)) {
        entry.handler({ type, ...init });
      }
    },
    dialogEvent(type, init) {
      this.windowEvent(type, init);
    },
    /**
     * Firefox selects `browser`'s tab: the shown browser changes first, then TabSelect fires
     * (updateCurrentBrowser sets #selectedBrowser before it dispatches the event).
     */
    selectTab(browser) {
      selectedBrowser = browser;
      this.windowEvent('TabSelect', { target: browser });
    },
    /** Bento (or Firefox) activates a split view: its browsers are shown, then the event fires. */
    activateSplitView(browsers) {
      splitBrowsers = browsers;
      this.windowEvent('TabSplitViewActivate', { target: window });
    },
    /** A <browser> in its own page container, as a tab has; `dialogShowing`: it has a prompt open. */
    makeBrowser: (dialogShowing = false) => {
      const browser = new FakeElement(registry, 'browser', sent);
      browser.inPageContainer = true;
      if (dialogShowing) browser.setAttribute('tabDialogShowing', 'true');
      return browser;
    },
    /** The overlay a tab dialog of `browser` is drawn on, inside the browser's page container. */
    dialogOverlayOf: (browser) => {
      const overlay = new FakeElement(registry, 'vbox', sent);
      overlay.pageContainer = browser.closest('.browserSidebarContainer');
      return overlay;
    },
    /** The ids of the elements that took the focus, in order. */
    focusLog: () => [...registry.focusLog],
    /** The event types the mount listens for on the window. */
    windowListenerTypes: () => [...new Set(listeners.map((entry) => entry.type))],
    /** An element of the chrome document; `inPageContainer`: drawn inside a page's container. */
    makeElement: (inPageContainer) => {
      const element = new FakeElement(registry, 'vbox', sent);
      element.inPageContainer = inPageContainer;
      return element;
    },
    pointerDownOutside() {
      api.attachOutsideClickDismissListener();
      const { handler } = listeners.findLast((entry) => entry.type === 'pointerdown');
      handler({ composedPath: () => [] });
    },
    /** The messages chrome sent, as the frame scripts receive them. */
    addrbarOpens: () => messages('BentoAddrbarOpen').map((message) => message.data),
    mergeLifecycle: () => messages('BentoMergePaletteLifecycle').map((message) => message.data),
    mergeOpenNonces: () =>
      messages('BentoMergePaletteLifecycle')
        .map((message) => message.data)
        .filter((data) => data.type === 'open'),
    settingsShows: () => messages('BentoSettingsPaletteShow').map((message) => message.data),
    settingsHides: () => messages('BentoSettingsPaletteHide').map((message) => message.data),
    bookmarksShows: () => messages('BentoBookmarksViewShow'),
    bookmarksHides: () => messages('BentoBookmarksViewHide'),
    shellActions: () => messages('BentoShellAction').map((message) => message.data),
    /** The `ui/bookmarkPopup/open` actions chrome sent the shell bus, as the popup document gets them. */
    popupOpens: () =>
      messages('BentoShellAction')
        .map((message) => message.data)
        .filter((data) => data.type === 'ui/bookmarkPopup/open'),
    /** The selected tab and its page: `Cmd+D` is about these. */
    page,
    setPlacesLookup: (lookup) => {
      placesLookup = lookup;
    },
    /** What document.querySelector answers (the panel header star of the selected tab). */
    setQuery: (query) => {
      document.querySelector = query;
    },
    /** The chrome window itself, the target of its own resize events. */
    windowTarget: window,
    /** The panel header stars `refreshPanelHeaderBookmarkButtons` redraws. */
    headerStars,
    /** Firefox's own PlacesCommandHook, and what it was called with. */
    placesCommandHook,
    firefoxBookmarkPage,
    /** The mutation observers the mount made, and a change reported to all of them. */
    mutationObservers,
    mutate: () => mutationObservers.filter((o) => !o.disconnected).forEach((o) => o.callback([], o)),
    hubPosts: () => plain(hubPosts.map(({ message }) => message)),
    menuOpens: () =>
      messages('BentoShellAction')
        .map((message) => message.data)
        .filter((data) => data.type === 'menu/open'),
  };
  return world;
}

// A window that has been running for a few seconds: the eager overlays and the
// idle-prewarmed ones are created and have announced themselves.
function warmWorld(options) {
  const world = makeWorld(options);
  world.overlays.startEager();
  for (const id of ['addrbar', 'palette', 'menu']) world.overlays.ensure(id, 'idle');
  for (const id of [
    'confirm',
    'edit-workspace',
    'workspace-switcher',
    'addrbar',
    'palette',
    'menu',
  ]) {
    world.ready(id);
  }
  return world;
}

const MENU = { anchor: { left: 5, top: 6, width: 7, height: 8 }, items: [{ id: 'a' }] };
const STALL_MS = 5000;

// ─── Startup ─────────────────────────────────────────────────────────────────

test('nothing is created until startup, and startup creates only the eager overlays', () => {
  const world = makeWorld();
  for (const id of Object.keys(HOSTS)) {
    assert.equal(world.overlays.hasStarted(id), false, `${id} must not exist before startup`);
  }
  assert.deepEqual(world.events.navigations, []);

  world.overlays.startEager();

  assert.deepEqual(world.events.navigations, ['confirm', 'edit-workspace', 'workspace-switcher']);
  assert.ok(world.frame('edit-workspace'), 'the JS-created eager frames exist');
  assert.ok(world.frame('workspace-switcher'));
  assert.equal(world.frame('addrbar'), null, 'idle and on-demand frames do not exist yet');
});

// ─── Esc, toggle, and the other dismissal paths cancel a cold open ──────────

test('a cold palette open followed by Esc never appears', () => {
  const world = makeWorld();
  world.showPalette();
  assert.equal(world.overlays.hasPendingOpen('palette'), true);
  assert.equal(world.isShown('palette'), false, 'the host stays hidden while the document loads');

  assert.equal(world.pressEscape(), true, 'Esc is consumed by the pending open');
  assert.equal(world.overlays.hasPendingOpen('palette'), false);

  world.ready('palette');
  world.advance(10_000);
  assert.equal(world.isShown('palette'), false);
  assert.deepEqual(world.events.scrimShown, []);
});

test('a cold palette open followed by the toggle cancels it instead of queueing another', () => {
  const world = makeWorld();
  world.togglePalette();
  assert.equal(world.overlays.hasPendingOpen('palette'), true);

  world.togglePalette();
  assert.equal(world.overlays.hasPendingOpen('palette'), false);

  world.ready('palette');
  world.advance(10_000);
  assert.equal(world.isShown('palette'), false);
  assert.deepEqual(world.events.scrimShown, []);

  // Once the document is ready the toggle opens and closes it as before.
  world.togglePalette();
  assert.equal(world.isShown('palette'), true);
  world.togglePalette();
  world.advance(1000);
  assert.equal(world.isShown('palette'), false);
});

test('a cold merge palette open followed by the toggle or Esc never appears', () => {
  for (const dismiss of [(world) => world.toggleMergePalette(), (world) => world.pressEscape()]) {
    const world = makeWorld();
    world.toggleMergePalette();
    assert.equal(world.overlays.hasPendingOpen('merge-palette'), true);
    dismiss(world);
    world.ready('merge-palette');
    world.advance(10_000);
    assert.equal(world.isShown('merge-palette'), false);
    assert.deepEqual(world.mergeOpenNonces(), [], 'the open nonce is never sent');
  }
});

test('Esc cancels each cold open in turn, top of the stack first', () => {
  const world = makeWorld();
  world.showPalette();
  world.showConfirm();
  world.showEditWorkspace();

  assert.equal(world.pressEscape(), true);
  assert.equal(world.overlays.hasPendingOpen('edit-workspace'), true, 'confirm is above edit');
  assert.equal(world.overlays.hasPendingOpen('confirm'), false);

  world.pressEscape();
  assert.equal(world.overlays.hasPendingOpen('edit-workspace'), false);
  assert.equal(world.overlays.hasPendingOpen('palette'), true);

  world.pressEscape();
  assert.equal(world.overlays.hasPendingOpen('palette'), false);
  assert.equal(world.pressEscape(), false, 'nothing is open any more');

  for (const id of ['palette', 'confirm', 'edit-workspace']) world.ready(id);
  assert.deepEqual(world.events.scrimShown, []);
});

test('Esc is consumed but does not cancel the mandatory welcome overlay', () => {
  const world = makeWorld();
  world.showWelcome();
  assert.equal(world.pressEscape(), true);
  assert.equal(world.overlays.hasPendingOpen('welcome'), true);

  world.ready('welcome');
  assert.equal(world.isShown('welcome'), true);
  assert.equal(world.pressEscape(), true);
  assert.equal(world.isShown('welcome'), true);
});

test('the welcome is showing only while visible and not fading out, and again after a reopen', () => {
  const world = makeWorld();
  const host = world.host('welcome');
  assert.equal(world.isWelcomeShowing(host), false, 'hidden');

  world.ready('welcome');
  world.showWelcome();
  assert.equal(world.isWelcomeShowing(host), true);

  // Open Settings hides it: the host stays in the DOM while it fades, but a second Open Settings
  // (a double click) finds it no longer showing and opens no second Settings tab.
  world.hideWelcome();
  assert.equal(world.isShown('welcome'), true, 'still visible during the fade');
  assert.equal(world.isWelcomeShowing(host), false, 'fading out');
  world.advance(1000);
  assert.equal(world.isShown('welcome'), false);
  assert.equal(world.isWelcomeShowing(host), false);

  // Onboarding shown again in the same window (after Reset Bento settings) works with no state.
  world.showWelcome();
  assert.equal(world.isWelcomeShowing(host), true);
});

test('every hide function cancels a cold open', () => {
  const world = makeWorld();
  world.showConfirm();
  world.showMergePalette();
  world.showChromeMenu({ ...MENU });

  world.hideConfirm();
  world.hideMergePalette();
  world.hideChromeMenu();
  for (const id of ['confirm', 'merge-palette', 'menu']) {
    assert.equal(world.overlays.hasPendingOpen(id), false, id);
  }

  for (const id of ['confirm', 'merge-palette', 'menu']) world.ready(id);
  assert.equal(world.isShown('confirm'), false);
  assert.equal(world.isShown('merge-palette'), false);
  assert.equal(world.isShown('menu'), false);
  assert.deepEqual(world.menuOpens(), []);
  assert.deepEqual(world.mergeOpenNonces(), []);
});

// ─── Nothing is revealed or sent without the real announcement ──────────────

test('no overlay is revealed before its document announces, however long that takes', () => {
  const opens = {
    palette: (world) => world.showPalette(),
    'workspace-palette': (world) => world.showWorkspacePalette(),
    'merge-palette': (world) => world.showMergePalette(),
    confirm: (world) => world.showConfirm(),
    'edit-workspace': (world) => world.showEditWorkspace(),
    'workspace-switcher': (world) => world.showWorkspaceSwitcher(),
    welcome: (world) => world.showWelcome(),
    menu: (world) => world.showChromeMenu({ ...MENU }),
  };
  for (const [id, open] of Object.entries(opens)) {
    const world = makeWorld();
    open(world);
    world.advance(10 * 60_000);
    assert.equal(world.isShown(id), false, id);
    assert.equal(world.overlays.hasPendingOpen(id), true, `${id} stays pending`);
    assert.deepEqual(world.events.scrimShown, [], id);

    world.ready(id);
    assert.equal(world.isShown(id), true, `${id} opens on its announcement`);
    assert.equal(world.overlays.hasPendingOpen(id), false, id);
  }
});

test('a document that does not announce is reported once and its open stays cancellable', () => {
  const world = makeWorld();
  world.showPalette();

  world.advance(STALL_MS - 1);
  assert.deepEqual(world.events.errors, []);
  world.advance(1);
  assert.equal(world.events.errors.length, 1);
  assert.match(world.events.errors[0], /palette did not announce readiness/);

  assert.equal(world.isShown('palette'), false, 'it is not revealed');
  assert.equal(world.overlays.hasPendingOpen('palette'), true, 'the open is still pending');
  world.advance(60_000);
  assert.equal(world.events.errors.length, 1);

  // The user can still cancel it, and a late announcement then shows nothing.
  assert.equal(world.pressEscape(), true);
  world.ready('palette');
  assert.equal(world.isShown('palette'), false);
});

test('a late announcement shows the stalled open once, with its message', () => {
  const world = makeWorld();
  world.showMergePalette();
  world.advance(STALL_MS + 2000);
  assert.equal(world.isShown('merge-palette'), false);
  assert.deepEqual(world.mergeOpenNonces(), []);

  world.ready('merge-palette');
  assert.equal(world.isShown('merge-palette'), true);
  assert.equal(world.mergeOpenNonces().length, 1);
  world.ready('merge-palette');
  assert.equal(world.mergeOpenNonces().length, 1, 'a second announcement sends nothing again');
});

// ─── Menu ───────────────────────────────────────────────────────────────────

test('a menu opened before its document is ready is shown and sent once, on the announcement', () => {
  const world = makeWorld();
  world.showChromeMenu({ ...MENU });
  assert.deepEqual(world.menuOpens(), []);
  assert.equal(world.isShown('menu'), false);

  // No reveal at 5 s: the message has nowhere to go yet.
  world.advance(STALL_MS);
  assert.equal(world.isShown('menu'), false);
  assert.deepEqual(world.menuOpens(), []);

  // The listener mounts at 7 s.
  world.advance(2000);
  world.ready('menu');
  assert.equal(world.isShown('menu'), true);
  assert.equal(world.menuOpens().length, 1);
  assert.deepEqual(world.menuOpens()[0].anchor, { left: 5, top: 6, width: 7, height: 8 });

  world.ready('menu');
  assert.equal(world.menuOpens().length, 1, 'a second announcement does not send it again');
});

test('Esc and an outside click cancel a menu open that still waits for its document', () => {
  for (const dismiss of [(world) => world.pressEscape(), (world) => world.pointerDownOutside()]) {
    const world = makeWorld();
    world.showChromeMenu({ ...MENU });
    assert.equal(world.overlays.hasPendingOpen('menu'), true);

    dismiss(world);
    assert.equal(world.overlays.hasPendingOpen('menu'), false);
    world.advance(10_000);
    world.ready('menu');
    assert.deepEqual(world.menuOpens(), []);
    assert.equal(world.isShown('menu'), false);
  }
});

test('Esc is not consumed for a menu that was delivered: the menu page handles its own', () => {
  const world = warmWorld();
  world.showChromeMenu({ ...MENU });
  assert.equal(world.isShown('menu'), true);
  assert.equal(world.overlays.hasPendingOpen('menu'), false);
  assert.equal(world.pressEscape(), false);
  assert.equal(world.isShown('menu'), true);
});

test('the newest menu request is the one delivered, and a dropped request leaves no handler', () => {
  const world = makeWorld();
  world.showChromeMenu({ ...MENU, items: [{ id: 'first' }], onSelect: () => {} });
  world.showChromeMenu({ ...MENU, items: [{ id: 'second' }], onSelect: () => {} });
  assert.equal(world.menuOnSelectByContext.size, 1, 'the older handler can never be called');
  world.ready('menu');
  assert.equal(world.menuOpens().length, 1);
  assert.deepEqual(plain(world.menuOpens()[0].items), [{ id: 'second' }]);
  assert.equal(world.menuOnSelectByContext.size, 1, 'a delivered menu keeps its handler');

  const other = makeWorld();
  other.showChromeMenu({ ...MENU, onSelect: () => {} });
  other.pressEscape();
  assert.equal(other.menuOnSelectByContext.size, 0, 'a cancelled open drops its handler');
});

test('a ready menu opens synchronously, as before', () => {
  const world = warmWorld();
  world.showChromeMenu({ ...MENU });
  assert.equal(world.isShown('menu'), true);
  assert.equal(world.menuOpens().length, 1);
});

// ─── Address bar ────────────────────────────────────────────────────────────

test('a cold address bar open followed by Esc or an outside click sends nothing', () => {
  for (const dismiss of [(world) => world.pressEscape(), (world) => world.pointerDownOutside()]) {
    const world = makeWorld();
    world.showAddrbar('current');
    assert.equal(world.overlays.hasPendingOpen('addrbar'), true);
    assert.notEqual(world.getPendingAddrbarReveal(), null);

    dismiss(world);
    assert.equal(world.overlays.hasPendingOpen('addrbar'), false);
    assert.equal(world.getPendingAddrbarReveal(), null);

    world.ready('addrbar');
    world.advance(10_000);
    assert.deepEqual(world.addrbarOpens(), []);
    assert.equal(world.host('addrbar').style.opacity, '0');
  }
});

test('a cold address bar open is sent once the document announces, and not before', () => {
  const world = makeWorld();
  world.showAddrbar('newTab', 'query');
  world.advance(3000);
  assert.deepEqual(world.addrbarOpens(), [], 'nothing listens before the announcement');

  world.ready('addrbar');
  const [first] = world.addrbarOpens();
  assert.equal(first.mode, 'newTab');
  assert.equal(first.initialQuery, 'query');
});

test('readiness at 7 s still gives a filled address bar: the reveal timer starts at delivery', () => {
  const world = makeWorld();
  world.showAddrbar('current', 'typed');

  // 5 s stall report, then more than the 1.4 s reveal fallback: nothing may have
  // been revealed, and the open must still be waiting to be sent.
  world.advance(STALL_MS + 2000);
  assert.deepEqual(world.addrbarOpens(), []);
  assert.notEqual(world.getPendingAddrbarReveal(), null, 'the pending open is not dropped');
  assert.equal(world.host('addrbar').style.opacity, '0', 'the empty address bar is not revealed');
  assert.equal(world.host('addrbar').style.pointerEvents, 'none');

  world.ready('addrbar');
  const sentAt7s = world.addrbarOpens();
  assert.equal(sentAt7s.length, 1);
  assert.equal(sentAt7s[0].initialQuery, 'typed');
  assert.equal(world.host('addrbar').style.opacity, '0', 'it is not revealed by the delivery');

  // The reveal fallback counts from the delivery.
  world.advance(1399);
  assert.equal(world.host('addrbar').style.opacity, '0');
  world.advance(1);
  assert.equal(world.host('addrbar').style.opacity, '1');
  assert.equal(world.getPendingAddrbarReveal(), null);
});

test('the address bar document revealing itself ends the open, as it always did', () => {
  const world = warmWorld();
  world.showAddrbar('current');
  const [{ openId }] = world.addrbarOpens();
  world.revealPendingAddrbar(openId);
  assert.equal(world.host('addrbar').style.opacity, '1');
  world.advance(10_000);
  assert.equal(world.addrbarOpens().length >= 1, true);
  assert.equal(world.getPendingAddrbarReveal(), null);
});

test('the address bar does not take the focus from an overlay still waiting to open', () => {
  const world = warmWorld();
  world.showWorkspacePalette();
  world.showAddrbar('current');

  assert.equal(world.addrbarOpens().length, 1);
  assert.equal(world.addrbarOpens()[0].suppressFocus, true);
});

// ─── Cmd+L and Cmd+E ask the sidebar row to anchor the open ─────────────────

test('Cmd+L asks the row, and the row answer ends the wait without a second open', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('current');
  assert.equal(world.sidebarMessages.length, 1);
  const [request] = world.sidebarMessages;
  assert.equal(request.kind, 'open-request');
  assert.equal(request.mode, 'current');
  assert.equal(request.bridgeToken, 'token');
  assert.equal(request.windowId, 7);
  assert.equal(world.getPendingAddrbarReveal(), null, 'nothing opens before the row answers');

  assert.equal(world.takeAddrbarOpenRequest(request.requestId), true);
  assert.equal(world.takeAddrbarOpenRequest(request.requestId), false, 'one answer per request');
  world.advance(10_000);
  assert.deepEqual(world.addrbarOpens(), [], 'the answered request does not also open centered');
});

test('an unanswered Cmd+L opens the centered palette once, and a late answer is dropped', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('current');
  const [{ requestId }] = world.sidebarMessages;

  world.advance(119);
  assert.deepEqual(world.addrbarOpens(), []);
  world.advance(1);
  assert.equal(world.addrbarOpens().length, 1);
  assert.equal(world.addrbarOpens()[0].mode, 'current');
  assert.equal(world.addrbarOpens()[0].placement, null);

  assert.equal(world.takeAddrbarOpenRequest(requestId), false, 'a late anchored answer is dropped');
});

test('Cmd+T and a sidebar that is not expanded open the centered palette without asking the row', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('newTab');
  assert.equal(world.addrbarOpens().length, 1);
  assert.equal(world.addrbarOpens()[0].mode, 'newTab');

  world.setRowAnchorable(false);
  world.requestAddrbarOpen('current');
  assert.equal(world.addrbarOpens().length, 2);
  assert.deepEqual(world.sidebarMessages, []);
});

test('any other open, a hide or a newer request ends a pending Cmd+L request', () => {
  for (const interrupt of [
    (world) => world.showAddrbar('newTab'),
    (world) => world.hideAddrbar(),
    (world) => world.requestAddrbarOpen('current'),
  ]) {
    const world = warmWorld();
    world.requestAddrbarOpen('current');
    const [{ requestId }] = world.sidebarMessages;
    interrupt(world);
    assert.equal(world.takeAddrbarOpenRequest(requestId), false);
  }
});

const ROW_RECT = { left: 6, top: 66, width: 240, height: 32 };

function rowAnswer(world, overrides = {}) {
  const [{ requestId }] = world.sidebarMessages;
  return { requestId, mode: 'current', initialQuery: 'https://example.com/', anchorRect: ROW_RECT, ...overrides };
}

test('Esc or an outside click while Cmd+L waits for the row cancels the open', () => {
  for (const dismiss of [(world) => world.pressEscape(), (world) => world.pointerDownOutside()]) {
    const world = warmWorld();
    world.requestAddrbarOpen('current');
    const answer = rowAnswer(world);

    dismiss(world);
    world.handleAddrbarOpenAnswer(answer);
    world.advance(10_000);
    assert.deepEqual(world.addrbarOpens(), [], 'neither the late answer nor the timer opens it');
    assert.equal(world.getPendingAddrbarReveal(), null);
    assert.equal(world.host('addrbar').style.opacity, '0');
  }
});

test('Esc while Cmd+L waits for the row is consumed, as for any open that has not appeared', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('current');
  assert.equal(world.pressEscape(), true);
});

test('another overlay opening while Cmd+L waits for the row cancels the open', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('current');
  const answer = rowAnswer(world);
  world.showPalette();
  world.handleAddrbarOpenAnswer(answer);
  world.advance(10_000);
  assert.deepEqual(world.addrbarOpens(), []);
  assert.equal(world.isShown('palette'), true);
});

test('the row answer anchors the open while the sidebar is still expanded', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('current');
  world.handleAddrbarOpenAnswer(rowAnswer(world));
  const [open] = world.addrbarOpens();
  assert.equal(open.initialQuery, 'https://example.com/');
  assert.notEqual(open.placement, null);
  world.advance(10_000);
  assert.equal(new Set(world.addrbarOpens().map((o) => o.openId)).size, 1);
});

test('an answer that finds the sidebar collapsed or hiding opens centered, with the fallback query', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('current');
  const answer = rowAnswer(world);
  world.setRowAnchorable(false); // the sidebar started to collapse or hide before the answer
  world.handleAddrbarOpenAnswer(answer);
  const opens = world.addrbarOpens();
  assert.equal(opens.length, 1);
  assert.equal(opens[0].placement, null);
  assert.equal(opens[0].initialQuery, '');
  assert.equal(opens[0].mode, 'current');
  world.advance(10_000); // the retry resends the same open; the timer starts no second one
  assert.equal(new Set(world.addrbarOpens().map((o) => o.openId)).size, 1);
});

test('a click on the row still opens anchored, with no request involved', () => {
  const world = warmWorld();
  world.setRowAnchorable(false);
  world.handleAddrbarOpenAnswer({ mode: 'current', initialQuery: 'u', anchorRect: ROW_RECT });
  assert.notEqual(world.addrbarOpens()[0].placement, null);
});

// ─── The row's border fades out while the anchored palette is over it ───────

const overRowMessages = (world) =>
  world.sidebarMessages.filter((message) => message.kind === 'palette-over-row');

function revealAnchoredAddrbar(world) {
  world.showAddrbar('current', 'u', { anchorRect: ROW_RECT });
  const [{ openId }] = world.addrbarOpens();
  world.revealPendingAddrbar(openId);
}

test('the anchored palette tells the row once as it fades in and once as it starts to hide', () => {
  const world = warmWorld();
  world.showAddrbar('current', 'u', { anchorRect: ROW_RECT });
  assert.deepEqual(overRowMessages(world), [], 'nothing is sent before the palette is revealed');

  const [{ openId }] = world.addrbarOpens();
  world.revealPendingAddrbar(openId);
  world.advance(10_000); // the fallback reveal finds nothing pending
  const [shown] = overRowMessages(world);
  assert.equal(overRowMessages(world).length, 1);
  assert.equal(shown.open, true);
  assert.equal(shown.windowId, 7);
  assert.equal(shown.bridgeToken, 'token');

  world.hideAddrbar();
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, false],
  );
  assert.equal(world.host('addrbar').style.opacity, '0');

  world.hideAddrbar();
  world.advance(10_000);
  assert.equal(overRowMessages(world).length, 2, 'only changes are sent');
});

test('a centred open, and a hide that was never anchored, leave the row alone', () => {
  const world = warmWorld();
  world.requestAddrbarOpen('newTab');
  world.revealPendingAddrbar(world.addrbarOpens()[0].openId);
  world.hideAddrbar();
  world.setRowAnchorable(false);
  world.requestAddrbarOpen('current');
  world.advance(10_000);
  world.hideAddrbar();
  assert.deepEqual(overRowMessages(world), []);
});

test('a centred open over an anchored one gives the row its border back', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  world.showAddrbar('newTab');
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, false],
  );
});

test('an anchored open that is hidden before it is revealed never touches the row', () => {
  const world = warmWorld();
  world.showAddrbar('current', 'u', { anchorRect: ROW_RECT });
  world.hideAddrbar();
  world.advance(10_000);
  assert.deepEqual(overRowMessages(world), []);
});

test('an open that cannot reach the row never lands after the hide that followed it', () => {
  const world = warmWorld();
  world.setShellMessageManager(false);
  revealAnchoredAddrbar(world);
  world.advance(250); // the open's delivery is retrying
  world.hideAddrbar();
  world.setShellMessageManager(true);
  world.advance(10_000);
  assert.deepEqual(overRowMessages(world), [], 'the row was never told to hide its border');
});

test('an open that reaches the row late tells it once, while the palette is still open', () => {
  const world = warmWorld();
  world.setShellMessageManager(false);
  revealAnchoredAddrbar(world);
  world.advance(250);
  world.setShellMessageManager(true);
  world.advance(10_000);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true],
  );
});

test('a hide that cannot reach the row is retried until the border is back', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  world.setShellMessageManager(false);
  world.hideAddrbar();
  world.advance(250);
  world.setShellMessageManager(true);
  world.advance(10_000);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, false],
  );
});

test('a reopen while a hide is still retrying leaves the border hidden, with no stale hide', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  world.setShellMessageManager(false);
  world.hideAddrbar();
  world.advance(250);
  world.showAddrbar('current', 'u', { anchorRect: ROW_RECT });
  world.revealPendingAddrbar(world.addrbarOpens().at(-1).openId);
  world.setShellMessageManager(true);
  world.advance(10_000);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true],
  );
});

// A reloaded or re-created sidebar document starts with the row's border showing: it announces its
// address channel (BENTO_SIDEBAR_ADDRESS_READY), and chrome sends the wanted state again.

test('a new sidebar document is told the palette is over the row once it announces itself', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true],
  );

  // The document is recreated: it knows nothing yet, and chrome sends nothing until it listens.
  world.advance(10_000);
  assert.equal(overRowMessages(world).length, 1);
  world.handleSidebarAddressReadyTitle();
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, true],
  );

  world.hideAddrbar();
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, true, false],
  );
});

test('the next anchored reveal after a recreated document delivers, not skips', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  world.handleSidebarAddressReadyTitle();
  world.hideAddrbar();
  world.showAddrbar('current', 'u', { anchorRect: ROW_RECT });
  world.revealPendingAddrbar(world.addrbarOpens().at(-1).openId);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, true, false, true],
  );
});

test('a recreated document that finds the palette closed is sent nothing', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  world.hideAddrbar();
  world.handleSidebarAddressReadyTitle();
  world.advance(10_000);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, false],
  );
  world.handleSidebarAddressReadyTitle();
  assert.equal(overRowMessages(world).length, 2, 'a first load with the palette closed sends nothing');
});

test('a recreated document whose frame cannot be reached yet is told once it can', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  world.setShellMessageManager(false);
  world.handleSidebarAddressReadyTitle();
  world.advance(250);
  world.setShellMessageManager(true);
  world.advance(10_000);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true, true],
  );
});

test('the announcement does not bring back a hide that is still retrying', () => {
  const world = warmWorld();
  revealAnchoredAddrbar(world);
  world.setShellMessageManager(false);
  world.hideAddrbar();
  world.handleSidebarAddressReadyTitle();
  world.setShellMessageManager(true);
  world.advance(10_000);
  assert.deepEqual(
    overRowMessages(world).map((message) => message.open),
    [true],
    'the new document already shows the border, so the hide has nothing to undo',
  );
});

test('the shell announces the title the mount routes to the row resync', () => {
  const shell = fs.readFileSync(
    path.join(ROOT, 'extensions/bento-shell/src/bridge/useSidebarAddress.ts'),
    'utf8',
  );
  const shellPrefix = /SIDEBAR_ADDRESS_READY_PREFIX = '([A-Z_:]+)'/.exec(shell)?.[1];
  const mountPrefix = /const SIDEBAR_ADDRESS_READY_PREFIX = '([A-Z_:]+)'/.exec(MOUNT)?.[1];
  assert.ok(shellPrefix);
  assert.equal(mountPrefix, shellPrefix);
  assert.match(
    MOUNT,
    /title\.startsWith\(SIDEBAR_ADDRESS_READY_PREFIX\)\) \{\s*handleSidebarAddressReadyTitle\(\);/,
  );
});

// ─── The newest open wins, whichever document loads first ───────────────────

test('palette then merge palette: the merge palette wins in both readiness orders', () => {
  for (const order of [
    ['palette', 'merge-palette'],
    ['merge-palette', 'palette'],
  ]) {
    const world = makeWorld();
    world.showPalette();
    world.showMergePalette();
    assert.equal(world.overlays.hasPendingOpen('palette'), false, 'the older open is superseded');
    assert.equal(world.overlays.hasPendingOpen('merge-palette'), true);

    for (const id of order) world.ready(id);

    assert.equal(world.isShown('merge-palette'), true);
    assert.equal(world.isShown('palette'), false);
    assert.deepEqual([...world.events.scrim], ['merge-palette']);
    assert.equal(world.mergeOpenNonces().length, 1);
  }
});

test('merge palette then palette: the palette wins in both readiness orders', () => {
  for (const order of [
    ['palette', 'merge-palette'],
    ['merge-palette', 'palette'],
  ]) {
    const world = makeWorld();
    world.showMergePalette();
    world.showPalette();
    assert.equal(world.overlays.hasPendingOpen('merge-palette'), false);
    assert.equal(world.overlays.hasPendingOpen('palette'), true);

    for (const id of order) world.ready(id);

    assert.equal(world.isShown('palette'), true);
    assert.equal(world.isShown('merge-palette'), false);
    assert.deepEqual([...world.events.scrim], ['palette']);
    assert.deepEqual(world.mergeOpenNonces(), [], 'the superseded nonce is never sent');
  }
});

test('the workspace palette and the address bar also take over from a cold palette', () => {
  for (const open of [
    (world) => world.showWorkspacePalette(),
    (world) => world.showAddrbar('current'),
  ]) {
    const world = makeWorld();
    world.showPalette();
    open(world);
    assert.equal(world.overlays.hasPendingOpen('palette'), false);
    world.ready('palette');
    world.ready('workspace-palette');
    world.ready('addrbar');
    assert.equal(world.isShown('palette'), false);
  }
});

test('a shown palette closes when a cold merge palette is requested, not when it loads', () => {
  const world = warmWorld();
  world.showPalette();
  assert.equal(world.isShown('palette'), true);

  world.showMergePalette();
  world.advance(1000);
  assert.equal(world.isShown('palette'), false, 'closed at the request');
  assert.equal(world.isShown('merge-palette'), false, 'not shown until its document is ready');

  world.ready('merge-palette');
  assert.equal(world.isShown('merge-palette'), true);
});

test('a ready palette opens synchronously', () => {
  const world = warmWorld();
  world.showPalette();
  assert.equal(world.isShown('palette'), true);
  assert.deepEqual([...world.events.scrim], ['palette']);
});

// ─── Settings palette ────────────────────────────────────────────────────────

test('a cold Settings palette open waits for its document, then shows and sends the show once', () => {
  const world = makeWorld();
  world.showSettingsPalette('privacy:level');
  assert.equal(world.overlays.hasPendingOpen('settings-palette'), true);
  assert.equal(world.isShown('settings-palette'), false);
  assert.deepEqual(
    world.settingsShows(),
    [],
    'nothing is sent to a document that is not listening',
  );

  world.ready('settings-palette');
  assert.equal(world.isShown('settings-palette'), true);
  assert.deepEqual([...world.events.scrim], ['settings-palette']);
  assert.deepEqual(world.settingsShows(), [{ target: 'privacy:level', origin: null }]);
  assert.deepEqual(world.events.navigations, ['settings-palette']);

  // Shown again (a link while it is open) sends another show, so the document returns to its start.
  world.showSettingsPalette();
  assert.deepEqual(world.settingsShows(), [
    { target: 'privacy:level', origin: null },
    { target: null, origin: null },
  ]);
});

test('a command palette result opens the Settings palette at its row, and an odd id opens the first list', () => {
  const world = warmWorld();
  world.ready('settings-palette');
  world.handleSettingsTargetTitle('BENTO_OPEN_SETTING:setting:panelCornerRadiusPx:1792650000000');
  world.handleSettingsTargetTitle('BENTO_OPEN_SETTING:bad id with spaces:1792650000001');
  world.handleSettingsTargetTitle('BENTO_OPEN_SETTING:');
  // A result of the command palette opens Settings with that origin, so the document can offer a way back.
  assert.deepEqual(world.settingsShows(), [
    { target: 'setting:panelCornerRadiusPx', origin: 'palette' },
    { target: null, origin: 'palette' },
    { target: null, origin: 'palette' },
  ]);
});

test('only the command palette gives the Settings palette an origin', () => {
  const world = warmWorld();
  world.ready('settings-palette');
  world.showSettingsPalette();
  world.showSettingsPalette('privacy:level', 'palette');
  world.showSettingsPalette('privacy:level', 'something else');
  assert.deepEqual(world.settingsShows(), [
    { target: null, origin: null },
    { target: 'privacy:level', origin: 'palette' },
    { target: 'privacy:level', origin: null },
  ]);
});

test('Esc cancels a cold Settings palette open, and hides a shown one', () => {
  const world = makeWorld();
  world.showSettingsPalette();
  assert.equal(world.pressEscape(), true);
  world.ready('settings-palette');
  world.advance(10_000);
  assert.equal(world.isShown('settings-palette'), false);
  assert.deepEqual(world.settingsShows(), []);

  const warm = warmWorld();
  warm.ready('settings-palette');
  warm.showSettingsPalette();
  assert.equal(warm.isShown('settings-palette'), true);
  assert.equal(warm.pressEscape(), true);
  warm.advance(1000);
  assert.equal(warm.isShown('settings-palette'), false);
});

test('Esc in the Settings frame is left to the document, which steps back before it closes', () => {
  // The parent process sees the keys of a remote <browser> first. Consuming Esc there would close
  // Settings from every stage, so a shown Settings palette whose frame has focus keeps it.
  const world = warmWorld();
  world.ready('settings-palette');
  world.showSettingsPalette();
  assert.equal(world.pressEscape('bento-settings-palette-frame'), false);
  world.advance(1000);
  assert.equal(world.isShown('settings-palette'), true);
  assert.deepEqual(world.settingsHides(), []);

  // The stack below it stays shut too: the document alone answers that Esc.
  world.showPalette();
  world.showSettingsPalette();
  assert.equal(world.pressEscape('bento-settings-palette-frame'), false);

  // With focus somewhere else in the window, chrome closes it.
  assert.equal(world.pressEscape('bento-shell-frame'), true);
  world.advance(1000);
  assert.equal(world.isShown('settings-palette'), false);
});

test('Esc in the Settings frame still cancels an open that waits for the document', () => {
  const world = makeWorld();
  world.showSettingsPalette();
  assert.equal(world.pressEscape('bento-settings-palette-frame'), true);
  world.ready('settings-palette');
  world.advance(10_000);
  assert.equal(world.isShown('settings-palette'), false);
});

test('hiding the Settings palette tells its document, however it is dismissed', () => {
  // Esc, the document's own close and another overlay opening all end in hideSettingsPalette, and
  // each must stop a number edit's preview and timer in the document that stays loaded.
  const world = warmWorld();
  world.ready('settings-palette');
  world.hideSettingsPalette();
  assert.deepEqual(
    world.settingsHides(),
    [],
    'a document that was never shown has nothing to revert',
  );

  world.showSettingsPalette();
  assert.equal(world.pressEscape(), true);
  assert.equal(world.settingsHides().length, 1);

  world.showSettingsPalette();
  world.showPalette();
  world.advance(1000);
  assert.equal(world.isShown('settings-palette'), false);
  assert.equal(world.settingsHides().length, 2, 'opening the command palette hides it with a hide');
});

test('a Hide that waited for the frame does not land after the Show that came later', () => {
  const world = warmWorld();
  world.ready('settings-palette');
  world.showSettingsPalette();
  const mm = world.frame('settings-palette').messageManager;
  const send = mm.sendAsyncMessage;
  assert.equal(world.settingsHides().length, 0);

  // The frame cannot take a message for a moment: the Hide waits, and the next Show goes first.
  mm.sendAsyncMessage = undefined;
  world.hideSettingsPalette();
  mm.sendAsyncMessage = send;
  world.showSettingsPalette('privacy:level');
  world.advance(2000);
  assert.deepEqual(world.settingsHides(), [], 'the older Hide is dropped, not sent after the Show');
  assert.deepEqual(world.settingsShows().at(-1), { target: 'privacy:level', origin: null });
});

test('a Show that waited for the frame does not land after the Hide that came later', () => {
  const world = warmWorld();
  world.ready('settings-palette');
  world.showSettingsPalette();
  const mm = world.frame('settings-palette').messageManager;
  const send = mm.sendAsyncMessage;
  const shows = world.settingsShows().length;

  mm.sendAsyncMessage = undefined;
  world.showSettingsPalette('privacy:level');
  mm.sendAsyncMessage = send;
  world.hideSettingsPalette();
  world.advance(2000);
  assert.equal(world.settingsShows().length, shows, 'the older Show is dropped');
  assert.equal(world.settingsHides().length, 1);
});

test('a Hide before the first Show reached the frame still ends that Show', () => {
  const world = makeWorld();
  world.showSettingsPalette();
  const mm = world.frame('settings-palette').messageManager;
  const send = mm.sendAsyncMessage;
  mm.sendAsyncMessage = undefined;
  world.ready('settings-palette');
  world.hideSettingsPalette();
  mm.sendAsyncMessage = send;
  world.advance(2000);
  assert.deepEqual(world.settingsShows(), [], 'the Show that was still waiting is dropped');
  assert.deepEqual(world.settingsHides(), [], 'nothing was shown, so there is nothing to hide');
});

test('a retried Hide is still sent when no Show came after it', () => {
  const world = warmWorld();
  world.ready('settings-palette');
  world.showSettingsPalette();
  const mm = world.frame('settings-palette').messageManager;
  const send = mm.sendAsyncMessage;
  mm.sendAsyncMessage = undefined;
  world.hideSettingsPalette();
  mm.sendAsyncMessage = send;
  world.advance(500);
  assert.equal(world.settingsHides().length, 1);
});

test('the Settings frame script turns the hide message into the document event', () => {
  // The message listener names are the contract between the mount script and the document.
  const listeners = new Map();
  const events = [];
  vm.runInNewContext(SETTINGS_FRAME_SCRIPT_SRC, {
    addMessageListener: (name, handler) => listeners.set(name, handler),
    content: {
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      dispatchEvent: (event) => events.push({ type: event.type, detail: event.detail }),
    },
  });
  listeners.get('BentoSettingsPaletteShow')({ data: { target: 'privacy:level', origin: 'palette' } });
  listeners.get('BentoSettingsPaletteHide')({ data: {} });
  assert.deepEqual(events, [
    {
      type: 'bento-settings-show',
      detail: JSON.stringify({ target: 'privacy:level', origin: 'palette' }),
    },
    { type: 'bento-settings-hide', detail: undefined },
  ]);
});

test('the Settings palette and the other palettes dismiss each other when requested', () => {
  const others = [
    ['palette', (world) => world.showPalette()],
    ['workspace-palette', (world) => world.showWorkspacePalette()],
    ['merge-palette', (world) => world.showMergePalette()],
  ];
  for (const [id, openOther] of others) {
    const world = warmWorld();
    world.ready('settings-palette');
    world.ready(id);

    world.showSettingsPalette();
    assert.equal(world.isShown('settings-palette'), true);
    openOther(world);
    world.advance(1000);
    assert.equal(world.isShown('settings-palette'), false, `${id} closes the Settings palette`);
    assert.equal(world.isShown(id), true);

    world.showSettingsPalette();
    world.advance(1000);
    assert.equal(world.isShown(id), false, `the Settings palette closes ${id}`);
    assert.equal(world.isShown('settings-palette'), true);
  }
});

test('the address bar does not take the focus from a Settings palette waiting to open', () => {
  const world = warmWorld();
  world.showSettingsPalette();
  world.showAddrbar('current');

  assert.equal(world.addrbarOpens().length, 1);
  assert.equal(world.addrbarOpens()[0].suppressFocus, true);
});

// ─── Bookmarks view ─────────────────────────────────────────────────────────

const BOOKMARKS_ATTR = 'bento-bookmarks-view';
const hasBookmarksAttr = (world) => world.documentElement.hasAttribute(BOOKMARKS_ATTR);

/** A window with a Bookmarks view whose document has announced itself. */
function bookmarksWorld(options) {
  const world = warmWorld(options);
  world.ready('bookmarks');
  return world;
}

test('a cold Bookmarks view open waits for its document, then reveals, hides the chrome and sends the show once', () => {
  const world = makeWorld();
  world.showBookmarksView();
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), true);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false, 'the chrome stays until the view is revealed');
  assert.deepEqual(world.bookmarksShows(), [], 'nothing is sent to a document that is not listening');

  world.ready('bookmarks');
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(world.host('bookmarks').style.opacity, '1');
  assert.equal(world.documentElement.getAttribute(BOOKMARKS_ATTR), 'true');
  assert.equal(world.bookmarksShows().length, 1);
  assert.deepEqual(world.bookmarksShows()[0].data, { focus: true }, 'the document may take the focus');
  assert.deepEqual([...world.events.scrim], [], 'a view, not a modal: no toolbar scrim');
  assert.deepEqual(world.events.navigations, ['bookmarks']);
  world.advance(1);
  assert.equal(world.frame('bookmarks').focusCount, 1, 'the document gets the focus');
});

test('the Bookmarks view host is the lowest overlay, so the others open above it', () => {
  assert.match(MOUNT, /ensureOverlayHost\(\{\s*hostId: 'bento-bookmarks-host',\s*zIndex: 99000,/);
});

test('the sidebar and the command palette open the Bookmarks view by title, and its document closes it', () => {
  const world = bookmarksWorld();

  world.titleChanged('bento-shell-frame', 'BENTO_OPEN_BOOKMARKS_1792650000000');
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);

  world.titleChanged('bento-bookmarks-frame', 'BENTO_CLOSE_BOOKMARKS_1792650000001');
  assert.equal(hasBookmarksAttr(world), false, 'the chrome comes back at once, under the fade');
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), false);

  world.titleChanged('bento-palette-frame', 'BENTO_OPEN_BOOKMARKS_1792650000002');
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
});

test('only the sidebar, the command palette and the view itself speak for the Bookmarks view', () => {
  const world = bookmarksWorld();
  // The merge palette frame's handler knows its own close title only.
  world.titleChanged('bento-merge-palette-frame', 'BENTO_OPEN_BOOKMARKS_1');
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
});

test('a private window refuses the Bookmarks view and keeps the stock Library key', () => {
  const world = makeWorld({ privateWindow: true });
  const key = world.addLibraryKey();
  world.retargetLibraryKeyToBookmarksView();
  assert.equal(key.getAttribute('command'), 'Browser:ShowAllBookmarks');
  assert.equal(key.listenerCount(), 0);

  world.showBookmarksView();
  world.toggleBookmarksView();
  world.titleChanged('bento-shell-frame', 'BENTO_OPEN_BOOKMARKS_1');
  assert.equal(world.overlays.hasStarted('bookmarks'), false, 'no document is created');
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
  assert.deepEqual(world.events.navigations, []);
  assert.equal(hasBookmarksAttr(world), false);
});

test('opening the Bookmarks view dismisses the palettes, which still open above it afterwards', () => {
  const world = warmWorld();
  for (const id of ['bookmarks', 'workspace-palette', 'merge-palette', 'settings-palette']) {
    world.ready(id);
  }
  const palettes = [
    ['palette', (w) => w.showPalette()],
    ['workspace-palette', (w) => w.showWorkspacePalette()],
    ['merge-palette', (w) => w.showMergePalette()],
    ['settings-palette', (w) => w.showSettingsPalette()],
  ];
  for (const [id, open] of palettes) {
    open(world);
    assert.equal(world.isShown(id), true);
    world.showBookmarksView();
    world.advance(1000);
    assert.equal(world.isShown(id), false, `the view closes the ${id}`);
    assert.equal(world.isShown('bookmarks'), true);

    open(world);
    world.advance(1000);
    assert.equal(world.isShown(id), true, `the ${id} opens over the view`);
    assert.equal(world.isShown('bookmarks'), true, `and does not close it`);
    assert.equal(hasBookmarksAttr(world), true);
    world.hideBookmarksView();
    world.advance(1000);
  }
});

test('Esc in the Bookmarks frame is left to the document, which closes itself', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  assert.equal(world.pressEscape('bento-bookmarks-frame'), false, 'the document decides');
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
  assert.deepEqual(world.bookmarksHides(), []);

  // With the focus somewhere else in the window, chrome closes the view.
  assert.equal(world.pressEscape('bento-shell-frame'), true);
  assert.equal(hasBookmarksAttr(world), false);
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(world.pressEscape('bento-shell-frame'), false, 'nothing left to close');
});

test('Esc in a delivered menu above the Bookmarks view is left to the menu', () => {
  const world = bookmarksWorld();
  world.ready('menu');
  world.showBookmarksView();
  world.showChromeMenu({ ...MENU });
  assert.equal(world.isShown('menu'), true);

  assert.equal(world.pressEscape('bento-menu-frame'), false, 'the menu page handles its own Esc');
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
});

test('Esc still cancels a Bookmarks view open that waits for its document', () => {
  const world = makeWorld();
  world.showBookmarksView();
  assert.equal(world.pressEscape('bento-bookmarks-frame'), true);
  world.ready('bookmarks');
  world.advance(10_000);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
  assert.deepEqual(world.bookmarksShows(), []);
});

test('an overlay over the Bookmarks view takes Esc first, and the view stays', () => {
  const world = bookmarksWorld();
  world.ready('palette');
  world.showBookmarksView();
  world.showPalette();
  assert.equal(world.pressEscape('bento-palette-frame'), true);
  world.advance(1000);
  assert.equal(world.isShown('palette'), false);
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
});

test('closing the Bookmarks view tells its document and gives the focus back', () => {
  const world = bookmarksWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.advance(1);
  world.setNativeFocus(world.frame('bookmarks'));

  world.hideBookmarksView();
  assert.equal(hasBookmarksAttr(world), false);
  assert.equal(world.bookmarksHides().length, 1, 'the document drops an open editor or search');
  assert.equal(sidebar.focusCount, 1, 'the element that had the focus gets it back');
  assert.equal(world.selectedBrowser.focusCount, 0);

  // A second hide (the title after Esc) neither re-sends nor moves the focus again.
  world.hideBookmarksView();
  assert.equal(sidebar.focusCount, 1);
});

test('a view opened from the command palette returns to the page, not to the closed palette', () => {
  const world = bookmarksWorld();
  world.ready('palette');
  world.showPalette();
  world.setNativeFocus(world.frame('palette'));
  world.titleChanged('bento-palette-frame', 'BENTO_OPEN_BOOKMARKS_1');
  world.advance(1);
  world.setNativeFocus(world.frame('bookmarks'));
  const page = world.selectedBrowser;

  world.hideBookmarksView();
  assert.equal(world.frame('palette').focusCount, 0);
  assert.equal(page.focusCount, 1);
});

test('a second request while the view is open keeps the focus recorded by the first', () => {
  const world = bookmarksWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.setNativeFocus(world.frame('bookmarks'));
  world.showBookmarksView();
  world.hideBookmarksView();
  assert.equal(sidebar.focusCount, 1);
});

test('a reopen during the fade-out records the focus afresh', () => {
  const world = bookmarksWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.hideBookmarksView();
  assert.equal(sidebar.focusCount, 1);

  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.hideBookmarksView();
  assert.equal(sidebar.focusCount, 2, 'the second close returns to the sidebar, not the page');
  assert.equal(world.selectedBrowser.focusCount, 0);
});

test('opening a tab from the view leaves the focus on that tab', () => {
  const world = bookmarksWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  const openedTab = { focusCount: 0, isConnected: true, focus() { this.focusCount += 1; } };
  world.selectBrowser(openedTab);

  world.hideBookmarksView();
  assert.equal(openedTab.focusCount, 1);
  assert.equal(sidebar.focusCount, 0);
});

test('a cancelled open sends no hide, sets no attribute and moves no focus', () => {
  const world = makeWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.hideBookmarksView();
  world.ready('bookmarks');
  assert.deepEqual(world.bookmarksHides(), [], 'a document that was never shown has nothing to drop');
  assert.equal(hasBookmarksAttr(world), false);
  assert.equal(sidebar.focusCount, 0);
  assert.equal(world.selectedBrowser.focusCount, 0);
});

// ─── Focus against the overlays above the view ──────────────────────────────

test('a reveal that waited for the document leaves the focus with a palette opened meanwhile', () => {
  // The view was requested while its document loaded, and the palette (ready) opened before it.
  const world = warmWorld();
  world.showBookmarksView();
  world.showPalette();
  world.advance(1);
  world.setNativeFocus(world.frame('palette'));
  assert.deepEqual(world.focusLog(), ['bento-palette-frame']);

  world.ready('bookmarks');
  world.advance(1);
  assert.equal(world.isShown('bookmarks'), true, 'the view still opens, under the palette');
  assert.equal(hasBookmarksAttr(world), true);
  assert.deepEqual(world.focusLog(), ['bento-palette-frame'], 'and does not take the focus');
  assert.deepEqual(
    world.bookmarksShows().map((message) => message.data),
    [{ focus: false }],
    'the document is told, so its search field stays out of it too',
  );
});

test('a palette that waits for its document opens over the view and takes the focus last', () => {
  // The other readiness order: the view's document is ready first and reveals with the focus.
  const world = makeWorld();
  world.showBookmarksView();
  world.showPalette();
  world.ready('bookmarks');
  world.advance(1);
  assert.deepEqual(world.focusLog(), ['bento-bookmarks-frame']);
  assert.deepEqual(world.bookmarksShows().map((message) => message.data), [{ focus: true }]);

  world.ready('palette');
  world.advance(1);
  assert.deepEqual(world.focusLog(), ['bento-bookmarks-frame', 'bento-palette-frame']);
  assert.equal(world.isShown('palette'), true);
  assert.equal(world.isShown('bookmarks'), true);
});

test('every overlay above the view keeps the focus; a hidden or fading host does not', () => {
  const higher = [...MOUNT.matchAll(/overlayEntry\(\{\s*id: '([a-z-]+)'/g)]
    .map((match) => match[1])
    .filter((id) => id !== 'bookmarks' && id !== 'panel-navigator-tooltip');
  assert.deepEqual(
    higher.sort(),
    plain(
      vm.runInNewContext(
        extractConst('BOOKMARKS_VIEW_HIGHER_OVERLAYS').replace('const ', 'var ') +
          '\nBOOKMARKS_VIEW_HIGHER_OVERLAYS',
      ),
    ).sort(),
    'the list in the mount script is every overlay but the view and the tooltip',
  );

  for (const id of higher) {
    const world = bookmarksWorld();
    const sidebar = world.registry.get('bento-shell-frame');
    world.setNativeFocus(sidebar);
    world.showBookmarksView();
    // The overlay is on screen: shown and not fading out.
    world.host(id).style.display = 'flex';
    world.host(id).style.opacity = '1';
    world.hideBookmarksView();
    assert.equal(sidebar.focusCount, 0, `${id} keeps the focus on close`);
    assert.equal(world.selectedBrowser.focusCount, 0, `${id} keeps the focus on close`);
  }

  // The tooltip host is always laid out and shown; a host that is fading out is on its way.
  const world = bookmarksWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.host('panel-navigator-tooltip').style.display = 'flex';
  world.host('panel-navigator-tooltip').style.opacity = '1';
  world.host('palette').style.display = 'flex';
  world.host('palette').style.opacity = '0';
  world.hideBookmarksView();
  assert.equal(sidebar.focusCount, 1, 'neither the tooltip nor a fading palette holds the focus');
});

test('closing the view under a palette leaves the palette focused and forgets where to return', () => {
  const world = bookmarksWorld();
  world.ready('palette');
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.advance(1);
  world.showPalette();
  world.advance(1);
  world.setNativeFocus(world.frame('palette'));
  const log = world.focusLog();

  // Cmd+Shift+O with the palette on screen.
  world.toggleBookmarksView();
  world.advance(1);
  assert.equal(hasBookmarksAttr(world), false);
  assert.equal(world.bookmarksHides().length, 1);
  assert.deepEqual(world.focusLog(), log, 'nothing took the focus from the palette');
  assert.equal(sidebar.focusCount, 0);
  assert.equal(world.selectedBrowser.focusCount, 0);
  assert.equal(world.isShown('palette'), true);

  // The record is gone: a later close does not return to the old sidebar.
  world.hidePalette();
  world.advance(1000);
  world.setNativeFocus(null);
  world.showBookmarksView();
  world.hideBookmarksView();
  assert.equal(sidebar.focusCount, 0, 'the stale return target was forgotten');
  assert.equal(world.selectedBrowser.focusCount, 1);
});

// ─── Bookmark popup ─────────────────────────────────────────────────────────

const POPUP_OPEN = 'BENTO_BOOKMARK_POPUP_OPEN:';
const POPUP_CLOSE = 'BENTO_BOOKMARK_POPUP_CLOSE:';
const BOOKMARKED_TABS = 'BENTO_BOOKMARKED_TABS:';
const EDIT = {
  kind: 'edit',
  tabId: 41,
  url: 'https://example.com/a',
  title: 'Example',
  anchor: { left: 12, top: 30, width: 20, height: 20 },
};

/** A title as the shell writes it: PREFIX<ts>:<base64 of the UTF-8 JSON>. Chrome drops a repeated title, so each differs. */
let titleSeq = 0;
const titleOf = (prefix, payload) =>
  `${prefix}${1792650000000 + (titleSeq += 1)}:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;

/** A window whose popup document has announced itself, with the sidebar frame 10 px in and 40 px down. */
function popupWorld(options) {
  const world = warmWorld(options);
  world.ready('bookmarks-popup');
  world.registry.get('bento-shell-frame').rect = { left: 10, top: 40, width: 300, height: 800 };
  return world;
}

const lastAction = (world) => world.popupOpens().at(-1);

test('the popup is prewarmed, covers the window and is created only where it can show', () => {
  const row = /overlayEntry\(\{\s*id: 'bookmarks-popup',([\s\S]*?)\}\)/.exec(MOUNT);
  assert.ok(row, 'no bookmarks-popup row in the overlay table');
  assert.match(row[1], /prewarm: true/);
  assert.match(row[1], /created: true/);
  assert.match(MOUNT, /ensureOverlayHost\(\{\s*hostId: 'bento-bookmarks-popup-host',\s*zIndex: 99993,\s*parentId: null,\s*inlineFade: false,/);

  const regular = makeWorld();
  assert.ok(regular.overlays.ensure('bookmarks-popup', 'idle'), 'a regular window creates it');
  assert.deepEqual(regular.events.navigations, ['bookmarks-popup']);

  const priv = makeWorld({ privateWindow: true });
  assert.equal(priv.overlays.ensure('bookmarks-popup', 'idle'), null, 'a private window never does');
  assert.deepEqual(priv.events.navigations, []);

  const off = makeWorld();
  off.applyChromeBookmarksEnabled(false);
  assert.equal(off.overlays.ensure('bookmarks-popup', 'idle'), null, 'nor one with the manager off');
});

test('a star press opens the popup: the anchor moves from the sidebar frame to the host, and the document is sent one open', () => {
  const world = popupWorld();
  world.host('bookmarks-popup').rect = { left: 2, top: 5, width: 1200, height: 800 };
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);

  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));

  assert.equal(world.isShown('bookmarks-popup'), true);
  assert.equal(world.host('bookmarks-popup').style.opacity, '1');
  assert.equal(world.popupOpens().length, 1);
  const open = lastAction(world);
  assert.match(open.popupId, /^bp_/);
  assert.equal(open.__windowId, 7, 'the document filters by window');
  assert.deepEqual(open.request, {
    ...EDIT,
    // frame left 10 + anchor 12 - host 2; frame top 40 + anchor 30 - host 5
    anchor: { left: 20, top: 65, width: 20, height: 20 },
  });
  world.advance(1);
  assert.equal(world.frame('bookmarks-popup').focusCount, 1, 'the document gets the focus');
  assert.deepEqual([...world.events.scrim], [], 'a popover, not a modal: no toolbar scrim');
});

test('the popup also opens from the toolbar frame, and a toolbar title cannot open anything else', () => {
  const world = popupWorld();
  const toolbarFrame = world.makeElement(false);
  toolbarFrame.id = 'bento-bookmarks-toolbar-frame';
  toolbarFrame.rect = { left: 300, top: 24, width: 800, height: 30 };
  world.registry.set(toolbarFrame.id, toolbarFrame);

  world.titleChanged(
    toolbarFrame.id,
    titleOf(POPUP_OPEN, { kind: 'group', groupId: 'g1', anchor: { left: 4, top: 2, width: 60, height: 26 } }),
  );
  assert.deepEqual(plain(lastAction(world).request), {
    kind: 'group',
    groupId: 'g1',
    anchor: { left: 304, top: 26, width: 60, height: 26 },
  });

  world.titleChanged(toolbarFrame.id, 'BENTO_OPEN_BOOKMARKS_1');
  assert.equal(world.isShown('bookmarks'), false, 'only the popup frame speaks for the view');
});

test('only well-formed requests reach the document, and only the fields of their kind', () => {
  const world = makeWorld();
  const anchor = { left: 1, top: 2, width: 3, height: 4 };
  const read = (payload) => plain(world.readBookmarkPopupRequest(payload));

  assert.deepEqual(read({ ...EDIT, requestId: 'r1', extra: 'dropped' }), {
    request: { ...EDIT },
    requestId: 'r1',
  });
  assert.deepEqual(read({ kind: 'spaces', anchor, tabId: 9 }), {
    request: { kind: 'spaces', anchor },
    requestId: '',
  });
  assert.deepEqual(read({ kind: 'overflow', groupIds: ['a', 'b'], anchor }).request, {
    kind: 'overflow',
    groupIds: ['a', 'b'],
    anchor,
  });
  for (const bad of [
    null,
    'edit',
    { kind: 'edit', url: 'u', title: 't', anchor },
    { ...EDIT, tabId: '41' },
    { ...EDIT, anchor: { left: 1, top: 2, width: 3 } },
    { ...EDIT, anchor: { left: 1, top: NaN, width: 3, height: 4 } },
    { kind: 'group', groupId: '', anchor },
    { kind: 'overflow', groupIds: ['a', 3], anchor },
    { kind: 'teleport', anchor },
  ]) {
    assert.equal(read(bad), null, JSON.stringify(bad));
  }
});

test('a private window and a window with the manager off refuse the popup and keep Places', () => {
  const priv = popupWorld({ privateWindow: true });
  priv.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(priv.isShown('bookmarks-popup'), false);
  assert.deepEqual(priv.popupOpens(), []);

  const off = popupWorld();
  off.applyChromeBookmarksEnabled(false);
  off.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(off.isShown('bookmarks-popup'), false);
  assert.deepEqual(off.popupOpens(), []);
  assert.equal(off.isBookmarkPopupOpen(), false);
});

test('a cold popup open waits for its document, then shows and sends once', () => {
  const world = makeWorld();
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.overlays.hasPendingOpen('bookmarks-popup'), true);
  assert.equal(world.isShown('bookmarks-popup'), false);
  assert.deepEqual(world.popupOpens(), [], 'nothing is sent to a document that is not listening');

  world.ready('bookmarks-popup');
  assert.equal(world.isShown('bookmarks-popup'), true);
  assert.equal(world.popupOpens().length, 1);
  world.ready('bookmarks-popup');
  assert.equal(world.popupOpens().length, 1, 'a second announcement does not send it again');
});

test('Esc is the document\'s while its frame has focus; chrome takes it for a waiting open and for focus elsewhere', () => {
  const world = popupWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  world.advance(1);
  world.setNativeFocus(world.frame('bookmarks-popup'));

  assert.equal(world.pressEscape('bento-bookmarks-popup-frame'), false, 'the document decides');
  assert.equal(world.isShown('bookmarks-popup'), true);

  assert.equal(world.pressEscape('bento-shell-frame'), true);
  assert.equal(world.isShown('bookmarks-popup'), false);
  assert.equal(world.isBookmarkPopupOpen(), false);
  assert.equal(sidebar.focusCount, 1, 'the focus returns to where it was');
  assert.equal(world.pressEscape('bento-shell-frame'), false, 'nothing left to close');

  const cold = makeWorld();
  cold.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(cold.pressEscape('bento-bookmarks-popup-frame'), true, 'a waiting open is cancelled');
  cold.ready('bookmarks-popup');
  assert.equal(cold.isShown('bookmarks-popup'), false);
  assert.deepEqual(cold.popupOpens(), []);
});

test('the document closes its own popup by id, and a late close of an older one is dropped', () => {
  const world = popupWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  world.advance(1);
  world.setNativeFocus(world.frame('bookmarks-popup'));
  const first = lastAction(world).popupId;

  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, title: 'Renamed' }));
  const second = lastAction(world).popupId;
  assert.notEqual(first, second);
  assert.equal(world.popupOpens().length, 2, 'a second request replaces the content in place');

  world.titleChanged('bento-bookmarks-popup-frame', titleOf(POPUP_CLOSE, { popupId: first }));
  assert.equal(world.isShown('bookmarks-popup'), true, 'the older popup is not the open one');
  world.titleChanged('bento-bookmarks-popup-frame', titleOf(POPUP_CLOSE, { popupId: 7 }));
  assert.equal(world.isShown('bookmarks-popup'), true);

  world.titleChanged('bento-bookmarks-popup-frame', titleOf(POPUP_CLOSE, { popupId: second }));
  assert.equal(world.isShown('bookmarks-popup'), false);
  assert.equal(world.host('bookmarks-popup').style.opacity, '0');
  assert.deepEqual(
    world.events.presentation.filter((entry) => entry.frameId === 'bento-bookmarks-popup-frame').at(-1).presented,
    false,
    'the document is told it is no longer presented',
  );
  assert.equal(sidebar.focusCount, 1, 'the first request recorded the focus and the close gives it back');
});

test('a tab change, a prompt, a window resize, a sidebar change and another overlay close it, and none moves the focus', () => {
  const closers = {
    'a tab change': (world) => world.selectTab(world.makeBrowser()),
    'a tab prompt': (world) =>
      world.windowEvent('DOMWillOpenModalDialog', { target: world.selectedBrowser }),
    'a dialog': (world) => world.windowEvent('dialogopen', { target: world.selectedBrowser }),
    'a window resize': (world) => {
      // Only the chrome window's own resize counts (about: pages bubble theirs to it).
      world.windowEvent('resize', { target: 'an about: page' });
      assert.equal(world.isShown('bookmarks-popup'), true, 'a page resize leaves it');
      world.windowEvent('resize', { target: world.windowTarget });
    },
    'the sidebar': (world) => world.mutate(),
    'another overlay': (world) => world.showPalette(),
  };
  for (const [name, close] of Object.entries(closers)) {
    const world = popupWorld();
    world.ready('palette');
    world.attachBookmarkPopupListeners();
    const sidebar = world.registry.get('bento-shell-frame');
    world.setNativeFocus(sidebar);
    world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
    world.advance(1);
    assert.equal(world.isShown('bookmarks-popup'), true, name);

    close(world);
    assert.equal(world.isShown('bookmarks-popup'), false, name);
    assert.equal(world.isBookmarkPopupOpen(), false, name);
    assert.equal(sidebar.focusCount, 0, `${name}: the closer owns the focus`);
  }
});

test('Open in Bookmarks closes the popup, then opens the view; the view and a prompt keep the popup from opening', () => {
  const world = popupWorld();
  world.ready('bookmarks');
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  world.advance(1);

  world.titleChanged('bento-bookmarks-popup-frame', 'BENTO_OPEN_BOOKMARKS_1792650000001');
  assert.equal(world.isShown('bookmarks-popup'), false);
  assert.equal(world.isBookmarkPopupOpen(), false);
  assert.equal(world.isShown('bookmarks'), true);

  // Cmd+D and the stars do nothing under the view.
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.isShown('bookmarks-popup'), false);
  world.hideBookmarksView();
  world.advance(1000);

  // The page area holds a prompt: no popup over it.
  world.selectedBrowser.setAttribute('tabDialogShowing', 'true');
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.isShown('bookmarks-popup'), false);
  world.selectedBrowser.removeAttribute('tabDialogShowing');
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.isShown('bookmarks-popup'), true);

  // Opening the view closes the popup too, whoever asked.
  world.showBookmarksView();
  assert.equal(world.isShown('bookmarks-popup'), false);
});

test('the popup does not open under an overlay that stacks above it', () => {
  const world = popupWorld();
  world.ready('palette');
  world.showPalette();
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.isShown('bookmarks-popup'), false);
  assert.deepEqual(world.popupOpens(), []);
});

test('the shell action frame script leaves the focus alone for the popup, as for the menu', () => {
  const start = MOUNT.indexOf('const SHELL_ACTION_FRAME_SCRIPT_SRC =');
  const end = MOUNT.indexOf('const SHELL_ACTION_FRAME_SCRIPT_URL', start);
  assert.ok(start !== -1 && end !== -1);
  const src = vm.runInNewContext(MOUNT.slice(start, end).replace('const SHELL_ACTION_FRAME_SCRIPT_SRC =', ''));
  let listener;
  const posted = [];
  let focused = 0;
  vm.runInNewContext(src, {
    addMessageListener: (_name, fn) => (listener = fn),
    content: {
      focus: () => (focused += 1),
      BroadcastChannel: class {
        postMessage(message) {
          posted.push(message);
        }

        close() {}
      },
    },
  });
  listener({ data: { type: 'ui/bookmarkPopup/open', popupId: 'p' } });
  listener({ data: { type: 'menu/open' } });
  assert.equal(posted.length, 2);
  assert.equal(focused, 0, 'the popup frame takes the focus, not the sidebar');
  listener({ data: { type: 'ui/renameRequest' } });
  assert.equal(focused, 1, 'the other ui actions still focus the sidebar');
});

// ─── Cmd+D and the panel header star ────────────────────────────────────────

const askedForStar = (world) =>
  world.sidebarMessages.filter((message) => message.kind === 'bookmark-popup-request');

test('Cmd+D patches bookmarkPage once and asks the sidebar star; its answer opens the popup, once', () => {
  const world = popupWorld();
  const firefoxOriginal = world.placesCommandHook.bookmarkPage;
  world.patchBookmarkPageCommand();
  world.patchBookmarkPageCommand();
  assert.deepEqual(
    world.events.noted.map((entry) => [entry.id, entry.native === firefoxOriginal]),
    [['PlacesCommandHook.bookmarkPage', true]],
    'the original is recorded for the compat probe, and the patch applies once',
  );

  world.placesCommandHook.bookmarkPage();
  assert.deepEqual(world.firefoxBookmarkPage, [], 'Firefox is not asked');
  const [request] = askedForStar(world);
  assert.equal(askedForStar(world).length, 1);
  assert.equal(request.windowId, 7);
  assert.equal(request.bridgeToken, 'token');
  assert.ok(request.requestId && request.messageId);
  assert.equal(world.isShown('bookmarks-popup'), false, 'the star has not answered yet');

  const answer = titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId });
  world.titleChanged('bento-shell-frame', answer);
  assert.equal(world.popupOpens().length, 1);
  assert.deepEqual(lastAction(world).request.anchor, { left: 22, top: 70, width: 20, height: 20 });

  // The wait is over: the timer finds no request, and a repeated answer is dropped.
  world.advance(10_000);
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId, tabId: 99 }));
  assert.equal(world.popupOpens().length, 1);
});

test('an unanswered Cmd+D opens the popup from chrome for the selected tab, once', () => {
  const world = popupWorld();
  world.patchBookmarkPageCommand();
  world.placesCommandHook.bookmarkPage();
  const [request] = askedForStar(world);

  world.advance(world.BOOKMARK_POPUP_REQUEST_MS - 1);
  assert.equal(world.isShown('bookmarks-popup'), false);
  world.advance(1);
  assert.equal(world.popupOpens().length, 1);
  assert.deepEqual(plain(lastAction(world).request), {
    kind: 'edit',
    tabId: 41,
    url: 'https://example.com/a',
    title: 'Example',
    // No panel star or panel is laid out in the fake window: the top right of the window.
    anchor: { left: 1199, top: 0, width: 1, height: 1 },
  });

  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId }));
  assert.equal(world.popupOpens().length, 1, 'a late answer is dropped, not a second open');
});

test('the Cmd+D fallback anchors to the selected panel star, else its panel, and skips pages that cannot be saved', () => {
  const world = popupWorld();
  world.patchBookmarkPageCommand();
  world.setRowAnchorable(false); // rail, hidden or mid-push: no star to ask
  const star = { getBoundingClientRect: () => ({ left: 700, top: 50, width: 28, height: 28 }) };
  const wanted = '.bento-panel-header-button--bookmark[data-bento-panel-bookmark-tab-id="41"]';
  world.setQuery((selector) => (selector === wanted ? star : null));

  world.placesCommandHook.bookmarkPage();
  assert.deepEqual(askedForStar(world), [], 'no request when the row cannot be anchored to');
  assert.deepEqual(lastAction(world).request.anchor, { left: 700, top: 50, width: 28, height: 28 });

  world.hideBookmarkPopup();
  world.setQuery(() => null);
  const panel = world.makeElement(false);
  panel.id = 'selected-panel';
  panel.rect = { left: 300, top: 60, width: 500, height: 700, right: 800 };
  world.registry.set(panel.id, panel);
  world.placesCommandHook.bookmarkPage();
  assert.deepEqual(lastAction(world).request.anchor, { left: 799, top: 60, width: 1, height: 1 });

  world.hideBookmarkPopup();
  const opens = world.popupOpens().length;
  for (const spec of ['about:newtab', 'about:blank', '']) {
    world.page.spec = spec;
    world.placesCommandHook.bookmarkPage();
  }
  assert.equal(world.popupOpens().length, opens, 'nothing to save on those pages');
});

test('an answer that comes after the sidebar started to move anchors to the page instead', () => {
  const world = popupWorld();
  world.patchBookmarkPageCommand();
  world.placesCommandHook.bookmarkPage();
  const [request] = askedForStar(world);

  world.setRowAnchorable(false);
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId }));
  assert.deepEqual(lastAction(world).request.anchor, { left: 1199, top: 0, width: 1, height: 1 });
});

test('Cmd+D is Firefox\'s in a private window and with the manager off', () => {
  for (const setup of [
    () => makeWorld({ privateWindow: true }),
    () => {
      const world = makeWorld();
      world.applyChromeBookmarksEnabled(false);
      return world;
    },
  ]) {
    const world = setup();
    world.patchBookmarkPageCommand();
    assert.equal(world.placesCommandHook.bookmarkPage('arg'), 'firefox');
    assert.deepEqual(world.firefoxBookmarkPage, [['arg']]);
    assert.deepEqual(askedForStar(world), []);
    assert.equal(world.overlays.hasStarted('bookmarks-popup'), false);
  }

  // The setting is read at each call: turning the manager back on routes Cmd+D to the popup.
  const world = makeWorld();
  world.patchBookmarkPageCommand();
  world.applyChromeBookmarksEnabled(false);
  world.placesCommandHook.bookmarkPage();
  assert.equal(world.firefoxBookmarkPage.length, 1);
  world.applyChromeBookmarksEnabled(true);
  world.placesCommandHook.bookmarkPage();
  assert.equal(world.firefoxBookmarkPage.length, 1);
  assert.equal(askedForStar(world).length, 1);
});

test('a newer overlay or request ends a pending Cmd+D request', () => {
  for (const interrupt of [
    (world) => world.showPalette(),
    (world) => world.requestAddrbarOpen('newTab'),
    (world) => world.applyChromeBookmarksEnabled(false),
  ]) {
    const world = popupWorld();
    world.ready('palette');
    world.patchBookmarkPageCommand();
    world.placesCommandHook.bookmarkPage();
    assert.equal(askedForStar(world).length, 1);
    interrupt(world);
    world.advance(10_000);
    assert.deepEqual(world.popupOpens(), [], 'the timer finds nothing to open');
  }
});

test('Esc ends a Cmd+D still waiting for the sidebar star, and no popup follows', () => {
  const world = popupWorld();
  world.patchBookmarkPageCommand();
  world.placesCommandHook.bookmarkPage();
  const [request] = askedForStar(world);

  assert.equal(world.pressEscape('bento-shell-frame'), true, 'the waiting request is dismissed');
  assert.equal(world.pressEscape('bento-shell-frame'), false, 'and nothing is left to dismiss');
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId }));
  world.advance(10_000);
  assert.deepEqual(world.popupOpens(), [], 'neither a late answer nor the timeout opens it');
});

test('a tab change ends a pending Cmd+D: the timeout does not open the new tab and a late answer not the old one', () => {
  const world = popupWorld();
  world.attachBookmarkPopupListeners();
  world.patchBookmarkPageCommand();
  world.placesCommandHook.bookmarkPage();
  const [request] = askedForStar(world);
  assert.equal(world.isBookmarkPopupOpen(), false, 'no popup yet: nothing for the old hide to cancel');

  world.page.tabId = 42;
  world.page.spec = 'https://example.com/b';
  world.selectTab(world.makeBrowser());
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId }));
  world.advance(10_000);
  assert.deepEqual(world.popupOpens(), []);

  // A Cmd+D pressed after the switch is a new request for the new tab.
  world.placesCommandHook.bookmarkPage();
  world.advance(world.BOOKMARK_POPUP_REQUEST_MS);
  assert.deepEqual(plain(lastAction(world).request).tabId, 42);
});

test('an edit from a stale sidebar snapshot is dropped without ending the wait, and the timeout opens the current page', () => {
  const world = popupWorld();
  world.patchBookmarkPageCommand();
  // The selected tab changed and the sidebar has not caught up (no TabSelect reached it yet).
  world.page.tabId = 42;
  world.page.spec = 'https://example.com/b';
  world.page.title = 'B';
  world.placesCommandHook.bookmarkPage();
  const [request] = askedForStar(world);

  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId }));
  assert.deepEqual(world.popupOpens(), [], 'the old tab id and URL name another page');
  world.titleChanged(
    'bento-shell-frame',
    titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId, tabId: 42 }),
  );
  assert.deepEqual(world.popupOpens(), [], 'the right tab with the old URL is stale too');
  world.titleChanged(
    'bento-shell-frame',
    titleOf(POPUP_OPEN, { ...EDIT, requestId: request.requestId, url: 'https://example.com/b' }),
  );
  assert.deepEqual(world.popupOpens(), [], 'and so is the right URL with the old tab id');

  world.advance(world.BOOKMARK_POPUP_REQUEST_MS);
  assert.deepEqual(plain(lastAction(world).request).url, 'https://example.com/b');
  assert.equal(world.popupOpens().length, 1);

  // A star press (no request) from a stale row is dropped the same way.
  world.hideBookmarkPopup();
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.popupOpens().length, 1);
  world.titleChanged(
    'bento-shell-frame',
    titleOf(POPUP_OPEN, { ...EDIT, tabId: 42, url: 'https://example.com/b' }),
  );
  assert.equal(world.popupOpens().length, 2, 'the current page opens');
});

test('a popup whose page changed while its document loaded is dropped in the reveal', () => {
  const world = makeWorld();
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.overlays.hasPendingOpen('bookmarks-popup'), true);

  world.page.spec = 'https://example.com/elsewhere'; // navigated meanwhile
  world.ready('bookmarks-popup');
  assert.equal(world.isShown('bookmarks-popup'), false);
  assert.deepEqual(world.popupOpens(), []);
  assert.equal(world.isBookmarkPopupOpen(), false);
  world.advance(10_000);
  assert.deepEqual(world.focusLog(), [], 'the document never took the focus');
});

test('the popup is not admitted under an overlay still loading, and is dropped if one appears before its reveal', () => {
  // A palette whose document is still loading is not on screen, but it will be.
  const world = makeWorld();
  world.showPalette();
  assert.equal(world.overlays.hasPendingOpen('palette'), true);
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(world.isBookmarkPopupOpen(), false, 'refused at the request');
  assert.equal(world.overlays.hasPendingOpen('bookmarks-popup'), false);
  world.ready('palette');
  world.ready('bookmarks-popup');
  world.advance(10_000);
  assert.equal(world.isShown('palette'), true);
  assert.equal(world.isShown('bookmarks-popup'), false);
  assert.deepEqual(world.popupOpens(), []);
  assert.deepEqual(world.focusLog().filter((id) => id === 'bento-bookmarks-popup-frame'), []);

  // An overlay that shows without going through openOverlay (which would close the popup) while
  // the popup waits for its document: the reveal sees it and does not show, or take the focus.
  const late = makeWorld();
  late.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, EDIT));
  assert.equal(late.overlays.hasPendingOpen('bookmarks-popup'), true);
  late.host('palette').style.display = 'flex';
  late.host('palette').style.opacity = '1';
  late.ready('bookmarks-popup');
  late.advance(10_000);
  assert.equal(late.isShown('bookmarks-popup'), false);
  assert.deepEqual(late.popupOpens(), []);
  assert.deepEqual(late.focusLog(), []);

  // The same through a Cmd+D request, which asks nothing of the row in that case.
  const cmd = popupWorld();
  cmd.patchBookmarkPageCommand();
  cmd.showPalette();
  cmd.placesCommandHook.bookmarkPage();
  assert.deepEqual(askedForStar(cmd), []);
});

test('a Cmd+L pressed after a Cmd+D wins, whichever the sidebar answers first, and a Cmd+D after a Cmd+L wins too', () => {
  const world = popupWorld();
  world.patchBookmarkPageCommand();
  world.placesCommandHook.bookmarkPage();
  const [bookmarkRequest] = askedForStar(world);
  world.requestAddrbarOpen('current');
  const addrbarRequest = world.sidebarMessages.find((message) => message.kind === 'open-request');

  // The older request's reply comes first: it must not open, and must not cancel the Cmd+L.
  world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: bookmarkRequest.requestId }));
  assert.deepEqual(world.popupOpens(), []);
  assert.equal(world.takeAddrbarOpenRequest(addrbarRequest.requestId), true, 'the Cmd+L still waits');
  world.advance(10_000);
  assert.deepEqual(world.popupOpens(), [], 'and the Cmd+D timer is gone');

  const reverse = popupWorld();
  reverse.patchBookmarkPageCommand();
  reverse.requestAddrbarOpen('current');
  const older = reverse.sidebarMessages.find((message) => message.kind === 'open-request');
  reverse.placesCommandHook.bookmarkPage();
  const [newer] = askedForStar(reverse);
  assert.equal(reverse.takeAddrbarOpenRequest(older.requestId), false, 'the older Cmd+L is replaced');
  reverse.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, requestId: newer.requestId }));
  assert.equal(reverse.popupOpens().length, 1);

  // A Cmd+L also closes a popup that is open, at once.
  reverse.setNativeFocus(reverse.frame('bookmarks-popup'));
  reverse.requestAddrbarOpen('current');
  assert.equal(reverse.isBookmarkPopupOpen(), false);
  assert.equal(reverse.isShown('bookmarks-popup'), false);
});

test('a page the Bento store would not save opens nothing: Cmd+D, the sidebar answer and the panel star', () => {
  const unsavable = [
    'about:config',
    'about:blank',
    'data:text/html,hi',
    'moz-extension://abc/page.html',
    'view-source:https://example.com/',
    'blob:https://example.com/1',
    'chrome://browser/content/browser.xhtml',
    'javascript:void(0)',
  ];
  for (const spec of unsavable) {
    const world = popupWorld();
    assert.equal(world.isBentoSavableUrlSpec(spec), false, spec);
    world.patchBookmarkPageCommand();
    world.page.spec = spec;

    world.placesCommandHook.bookmarkPage();
    world.setRowAnchorable(false);
    world.placesCommandHook.bookmarkPage();
    world.advance(10_000);
    assert.deepEqual(askedForStar(world), [], `${spec}: the row is not asked`);
    assert.deepEqual(world.popupOpens(), [], `${spec}: no popup from Cmd+D`);
    assert.equal(world.isBookmarkPopupOpen(), false, spec);

    // A sidebar that sends an edit for that page anyway is refused by chrome.
    world.titleChanged('bento-shell-frame', titleOf(POPUP_OPEN, { ...EDIT, url: spec }));
    assert.deepEqual(world.popupOpens(), [], `${spec}: no popup from the sidebar star`);

    const button = { getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }) };
    const browser = { currentURI: { spec }, contentTitle: 't' };
    assert.equal(world.openBookmarkPopupFromPanelHeader(button, 55, browser), true, 'handled, not Places');
    assert.deepEqual(world.popupOpens(), [], `${spec}: no popup from the panel star`);
  }
  for (const spec of ['http://a.test/', 'https://a.test/', 'file:///tmp/a.html', 'ftp://a.test/f']) {
    assert.equal(makeWorld().isBentoSavableUrlSpec(spec), true, spec);
  }
});

test('the panel header star is drawn disabled on a page the store would not save, and Places never disables it', () => {
  const world = makeWorld();
  const star = () => {
    const attrs = new Map();
    const classes = new Set();
    return {
      attrs,
      classes,
      title: '',
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: (name) => attrs.delete(name),
      classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    };
  };
  const browserAt = (spec) => ({ currentURI: { spec } });
  world.titleChanged('bento-shell-frame', titleOf(BOOKMARKED_TABS, { tabIds: [55] }));

  const saved = star();
  world.drawPanelBookmarkButton(saved, 55, browserAt('https://example.com/p'));
  assert.equal(saved.attrs.has('disabled'), false);
  assert.equal(saved.classes.has('bento-panel-header-button--active'), true, 'filled from the Bento set');
  assert.equal(saved.title, 'Edit bookmark');

  const config = star();
  world.drawPanelBookmarkButton(config, 55, browserAt('about:config'));
  assert.equal(config.attrs.get('disabled'), 'true');
  assert.equal(config.classes.has('bento-panel-header-button--active'), false);
  world.drawPanelBookmarkButton(config, 55, browserAt('https://example.com/p'));
  assert.equal(config.attrs.has('disabled'), false, 'a navigation to a savable page enables it again');

  world.applyChromeBookmarksEnabled(false);
  const places = star();
  places.attrs.set('disabled', 'true');
  world.drawPanelBookmarkButton(places, 55, browserAt('about:config'));
  assert.equal(places.attrs.has('disabled'), false, "Firefox's star is not the store's to disable");
});

test('a Places lookup still running when the Bento store takes the star back cannot unfill it', async () => {
  const world = makeWorld();
  world.applyChromeBookmarksEnabled(false); // Places draws the star
  let settle;
  world.setPlacesLookup(() => new Promise((resolve) => (settle = resolve)));
  const classes = new Set();
  const star = {
    title: '',
    setAttribute() {},
    removeAttribute() {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
  };
  const browser = { currentURI: { spec: 'https://example.com/p' } };

  const lookup = world.updatePanelBookmarkButtonState(browser, star);
  world.applyChromeBookmarksEnabled(true); // the setting goes back on
  world.titleChanged('bento-shell-frame', titleOf(BOOKMARKED_TABS, { tabIds: [55] }));
  world.drawPanelBookmarkButton(star, 55, browser);
  assert.equal(classes.has('bento-panel-header-button--active'), true, 'filled from the Bento set');

  settle([]); // Places says: no bookmark
  await lookup;
  assert.equal(classes.has('bento-panel-header-button--active'), true, 'the stale answer is dropped');
  assert.equal(star.title, 'Edit bookmark');

  // In Places mode the answer still draws.
  world.applyChromeBookmarksEnabled(false);
  world.setPlacesLookup(async () => [{ guid: 'g', parentGuid: 'unfiled' }]);
  await world.updatePanelBookmarkButtonState(browser, star);
  assert.equal(classes.has('bento-panel-header-button--active'), true);
  assert.equal(star.title, 'Remove bookmark');
});

test('the panel header star opens the edit popup in chrome coordinates, and is Firefox\'s outside Bento mode', () => {
  const world = popupWorld();
  const button = {
    getBoundingClientRect: () => ({ left: 640, top: 52, width: 28, height: 28 }),
  };
  const browser = { currentURI: { spec: 'https://example.com/panel' }, contentTitle: 'Panel' };

  assert.equal(world.openBookmarkPopupFromPanelHeader(button, 55, browser), true);
  assert.deepEqual(plain(lastAction(world).request), {
    kind: 'edit',
    tabId: 55,
    url: 'https://example.com/panel',
    title: 'Panel',
    anchor: { left: 640, top: 52, width: 28, height: 28 },
  });

  world.hideBookmarkPopup();
  const opens = world.popupOpens().length;
  assert.equal(
    world.openBookmarkPopupFromPanelHeader(button, 55, { currentURI: { spec: 'about:blank' } }),
    true,
    'handled: Places must not bookmark a blank panel either',
  );
  assert.equal(world.popupOpens().length, opens);
  assert.equal(world.openBookmarkPopupFromPanelHeader(button, null, browser), false);

  world.applyChromeBookmarksEnabled(false);
  assert.equal(world.openBookmarkPopupFromPanelHeader(button, 55, browser), false);
  assert.equal(
    makeWorld({ privateWindow: true }).openBookmarkPopupFromPanelHeader(button, 55, browser),
    false,
  );
});

test('the bookmarked tab list redraws every panel header star, and so does the setting', () => {
  const world = makeWorld();
  let redraws = 0;
  world.headerStars.push({ _bentoRefreshBookmarkState: () => (redraws += 1) }, {});

  world.titleChanged('bento-shell-frame', titleOf(BOOKMARKED_TABS, { tabIds: [41, 'x', 7.5, 9] }));
  assert.equal(redraws, 1);
  world.titleChanged('bento-shell-frame', titleOf(BOOKMARKED_TABS, { tabIds: 'all' }));
  assert.equal(redraws, 1, 'a payload that is not a list is ignored');
  world.titleChanged('bento-shell-frame', titleOf(BOOKMARKED_TABS, { tabIds: [] }));
  assert.equal(redraws, 2);

  world.applyChromeBookmarksEnabled(false);
  assert.equal(redraws, 3, 'the stars go back to Places');
  world.applyChromeBookmarksEnabled(true);
  assert.equal(redraws, 4);
});

// ─── Bookmarks toolbar ──────────────────────────────────────────────────────

function toolbarWorld(options) {
  const world = makeWorld(options);
  const toolbar = world.makeElement(false);
  toolbar.id = 'PersonalToolbar';
  toolbar.collapsed = true;
  world.registry.set(toolbar.id, toolbar);
  return { world, toolbar };
}

const TOOLBAR_ATTR = 'bento-bookmarks-toolbar';

test('the toolbar attribute follows the first BENTO_PANELS that says the manager is on, and the frame waits for the toolbar to show', () => {
  const { world, toolbar } = toolbarWorld();
  // Until a payload arrives the window assumes the default but sets nothing.
  assert.equal(world.documentElement.hasAttribute(TOOLBAR_ATTR), false);

  world.applyChromeBookmarksEnabled(true); // the default value, still confirmed
  assert.equal(world.documentElement.getAttribute(TOOLBAR_ATTR), 'true');
  assert.equal(world.registry.has('bento-bookmarks-toolbar-host'), false, 'the toolbar is collapsed');
  assert.deepEqual(world.events.navigations, []);

  world.applyChromeBookmarksEnabled(true); // every later payload repeats it
  assert.equal(world.mutationObservers.length, 1, 'one watcher, not one per payload');

  toolbar.collapsed = false; // Cmd+Shift+B
  world.mutate();
  const host = world.registry.get('bento-bookmarks-toolbar-host');
  assert.ok(host, 'the host is created when the toolbar first shows');
  assert.equal(host.getAttribute('skipintoolbarset'), 'true');
  assert.equal(host.getAttribute('flex'), '1');
  assert.ok(world.registry.get('bento-bookmarks-toolbar-frame'), 'with the toolbar document in it');
  assert.deepEqual(world.events.navigations, ['bookmarks-toolbar']);

  world.applyChromeBookmarksEnabled(true);
  world.mutate();
  assert.deepEqual(world.events.navigations, ['bookmarks-toolbar'], 'created once');
});

test('a visible toolbar gets its frame at once, and the manager off takes both back', () => {
  const { world, toolbar } = toolbarWorld();
  toolbar.collapsed = false;
  world.applyChromeBookmarksEnabled(true);
  assert.ok(world.registry.get('bento-bookmarks-toolbar-host'));
  assert.deepEqual(world.events.navigations, ['bookmarks-toolbar']);

  world.applyChromeBookmarksEnabled(false);
  assert.equal(world.documentElement.hasAttribute(TOOLBAR_ATTR), false, "Firefox's toolbar is back");
  assert.equal(world.registry.has('bento-bookmarks-toolbar-host'), false);

  world.applyChromeBookmarksEnabled(true);
  assert.equal(world.documentElement.getAttribute(TOOLBAR_ATTR), 'true');
  assert.deepEqual(world.events.navigations, ['bookmarks-toolbar', 'bookmarks-toolbar']);
});

test('a manager turned off before the toolbar ever showed leaves no watcher behind', () => {
  const { world, toolbar } = toolbarWorld();
  world.applyChromeBookmarksEnabled(true);
  const [watcher] = world.mutationObservers;
  world.applyChromeBookmarksEnabled(false);
  assert.equal(watcher.disconnected, true);
  toolbar.collapsed = false;
  world.mutate();
  assert.equal(world.registry.has('bento-bookmarks-toolbar-host'), false);
});

test('a private window never gets the Bento toolbar', () => {
  const { world, toolbar } = toolbarWorld({ privateWindow: true });
  toolbar.collapsed = false;
  world.applyChromeBookmarksEnabled(true);
  assert.equal(world.documentElement.hasAttribute(TOOLBAR_ATTR), false);
  assert.equal(world.registry.has('bento-bookmarks-toolbar-host'), false);
  assert.deepEqual(world.events.navigations, []);
});

test('the stylesheet swaps the toolbar contents for the host only under the root attribute', () => {
  const css = fs.readFileSync(
    path.join(ROOT, 'src/browser/base/content/bento-shell-mount.css'),
    'utf8',
  );
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at !== -1, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('#bento-bookmarks-toolbar-host'), /display:\s*none/);
  assert.match(rule(':root[bento-bookmarks-toolbar] #bento-bookmarks-toolbar-host'), /display:\s*flex/);
  assert.match(
    rule(':root[bento-bookmarks-toolbar] #PersonalToolbar > :is(#personal-bookmarks, #personal-toolbar-empty, #import-button)'),
    /display:\s*none\s*!important/,
  );
});

test('the Bento toolbar is a floating rounded strip whose room the strip container reserves, in step with it', () => {
  const css = fs.readFileSync(
    path.join(ROOT, 'src/browser/base/content/bento-shell-mount.css'),
    'utf8',
  );
  /** The body of the first rule whose selector (whitespace squeezed) contains `selector`. */
  const body = (selector) => {
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (match[1].replace(/\s+/g, ' ').includes(selector)) return match[2];
    }
    assert.fail(`no rule for ${selector}`);
  };
  const strip = body(":root[bento-sidebar-addressbar='true'][bento-bookmarks-toolbar] #PersonalToolbar ");
  assert.match(strip, /position:\s*absolute\s*!important/, 'out of flow: the sidebar row never holds it');
  assert.match(strip, /border-radius:\s*var\(--bento-panel-corner-radius\)/, "the panels' radius");
  assert.match(strip, /margin-block:\s*var\(--bento-sidebar-top-inset\)/, "level with the sidebar's first row");

  const reserve = body('#PersonalToolbar:not([collapsed], [hidden])');
  assert.match(reserve, /margin-block-start:\s*var\(--bento-bookmarks-toolbar-reserve\)/);
  assert.ok(
    css.replace(/\s+/g, ' ').includes(':not([inFullscreen]):has( #PersonalToolbar:not([collapsed], [hidden]) ) #bento-strip-container'),
    'the room is reserved only while the toolbar shows and the window is not fullscreen',
  );

  // The geometry of the strip and of the room it takes share one pair, so the panels follow it.
  const pair = /var\(--muxui-semantic-motion-reveal-transition-spring-duration\)\s+var\(--muxui-semantic-motion-reveal-transition-spring-easing\)/;
  const toolbarMotion = body(':root[sessionrestored][bento-sidebar-addressbar=\'true\'][bento-bookmarks-toolbar] #PersonalToolbar ');
  const stripMotion = body(':root[sessionrestored][bento-sidebar-addressbar=\'true\'][bento-bookmarks-toolbar]:not([bento-bookmarks-view]) #bento-strip-container ');
  for (const property of ['height', 'margin-block-start']) {
    assert.match(toolbarMotion, new RegExp(`${property}\\s+${pair.source}`));
  }
  assert.match(stripMotion, new RegExp(`margin-block-start\\s+${pair.source}`));
  assert.doesNotMatch(toolbarMotion + stripMotion, /var\(--muxui-semantic-motion-(?!reveal-|state-)/);

  // Firefox's own toolbar keeps its slide pinned off; the Bento strip must not inherit that.
  assert.match(
    body(":root[bento-sidebar-addressbar='true']:not([bento-bookmarks-toolbar]) #PersonalToolbar "),
    /transition:\s*none\s*!important/,
  );
});

// ─── Tab dialogs under the view ─────────────────────────────────────────────

test('a before-unload prompt closes the view at once, with no fade and no focus move', () => {
  const world = bookmarksWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.advance(1);
  world.setNativeFocus(world.frame('bookmarks'));
  const log = world.focusLog();
  world.events.presentation.length = 0;

  // Leave/Stay of a tab close: the event names the prompting <browser> and carries tabPrompt.
  world.dialogEvent('DOMWillOpenModalDialog', {
    target: world.selectedBrowser,
    detail: { tabPrompt: true, inPermitUnload: true },
  });

  assert.equal(hasBookmarksAttr(world), false, 'the chrome is back for the prompt');
  assert.equal(world.isShown('bookmarks'), false, 'the host is gone now, not after a fade');
  assert.equal(world.host('bookmarks').style.opacity, '0');
  assert.equal(world.host('bookmarks').hasAttribute('hidden'), true);
  assert.equal(world.bookmarksHides().length, 1, 'the document drops an open editor or search');
  assert.deepEqual(world.focusLog(), log, 'the prompt takes the focus; the view does not move it');
  assert.deepEqual(
    world.events.presentation.map(({ frameId, presented }) => [frameId, presented]),
    [['bento-bookmarks-frame', false]],
    'the document is told it is no longer presented',
  );

  // Answering the prompt leaves a closed view that opens again as usual.
  world.advance(10_000);
  world.showBookmarksView();
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(world.host('bookmarks').style.opacity, '1');
  assert.equal(hasBookmarksAttr(world), true);
});

test('the view stays closed whether the Leave/Stay prompt is answered Leave or Stay', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  world.advance(1);
  world.dialogEvent('DOMWillOpenModalDialog', {
    target: world.selectedBrowser,
    detail: { tabPrompt: true, inPermitUnload: true },
  });
  // Nothing listens for the prompt closing, so no answer brings the view back.
  assert.equal(world.windowListenerTypes().includes('DOMModalDialogClosed'), false);
  const log = world.focusLog();

  // Stay: the page is still there. Leave: the tab closed and another one is selected.
  world.advance(10_000);
  assert.equal(world.isShown('bookmarks'), false);
  world.selectBrowser({ focusCount: 0, isConnected: true, focus() { this.focusCount += 1; } });
  world.advance(10_000);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
  assert.deepEqual(world.focusLog(), log, 'and the view moved no focus');
});

test('a prompt cancels a Bookmarks view open that still waits for its document', () => {
  const world = makeWorld();
  world.showBookmarksView();
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), true);

  world.dialogEvent('DOMWillOpenModalDialog', {
    target: world.selectedBrowser,
    detail: { tabPrompt: true, inPermitUnload: true },
  });
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);

  world.ready('bookmarks');
  world.advance(10_000);
  assert.equal(world.isShown('bookmarks'), false, 'the late announcement reveals nothing');
  assert.equal(hasBookmarksAttr(world), false);
  assert.deepEqual(world.bookmarksShows(), []);
  assert.deepEqual(world.focusLog(), []);
});

test('a prompt in this process names its window, which leads to the browser', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  world.dialogEvent('DOMWillOpenModalDialog', {
    target: { docShell: { chromeEventHandler: world.selectedBrowser } },
    detail: { tabPrompt: true, inPermitUnload: false },
  });
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
});

test('a tab dialog that opens without that event also closes the view', () => {
  // Print preview, share and screenshots use the tab dialog box without DOMWillOpenModalDialog.
  const world = bookmarksWorld();
  world.showBookmarksView();
  // The target is the dialog overlay, drawn in the container of the tab the window shows.
  world.dialogEvent('dialogopen', { target: world.dialogOverlayOf(world.selectedBrowser) });
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
});

test('a dialog outside the page area, or with no view open, leaves things alone', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  world.advance(1);
  // A window-level dialog (gDialogBox) and a prompt of an overlay frame are not under the view.
  world.dialogEvent('dialogopen', { target: world.makeElement(false) });
  world.dialogEvent('DOMWillOpenModalDialog', { target: world.registry.get('bento-palette-frame') });
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
  assert.deepEqual(world.bookmarksHides(), []);

  // With the view closed there is nothing to close and nothing is sent.
  world.hideBookmarksView();
  world.advance(1000);
  const hides = world.bookmarksHides().length;
  world.dialogEvent('DOMWillOpenModalDialog', { target: world.selectedBrowser });
  world.dialogEvent('dialogopen', { target: world.selectedBrowser });
  assert.equal(world.bookmarksHides().length, hides);
  assert.equal(world.events.errors.length, 0);
});

test('the Bookmarks view host takes no inline fade; the other created hosts keep theirs', () => {
  const made = [];
  const parent = { appendChild: (host) => made.push(host) };
  const ensure = vm.runInNewContext(
    `"use strict";${extractFunction('ensureOverlayHost')}\nensureOverlayHost`,
    {
      console,
      document: {
        documentElement: parent,
        getElementById: (id) => (id === 'browser' ? parent : null),
        createXULElement: () => ({ style: {}, setAttribute() {} }),
      },
    },
  );
  ensure({ hostId: 'bento-bookmarks-host', zIndex: 99000, inlineFade: false });
  ensure({ hostId: 'bento-settings-palette-host', zIndex: 99997 });
  const [bookmarks, settings] = made.map((host) => host.style.cssText);
  assert.doesNotMatch(bookmarks, /transition/, 'the stylesheet owns the fade (modal in, modal-dismiss out)');
  assert.match(settings, /transition: opacity var\(--muxui-semantic-motion-modal-transition\)/);
  assert.match(MOUNT, /hostId: 'bento-bookmarks-host',\s*zIndex: 99000,\s*inlineFade: false,/);
});

// ─── A dialog that is already showing ───────────────────────────────────────

const DIALOG_ATTR = 'tabDialogShowing';

test('the view refuses to open while the selected tab shows a prompt, and dismisses nothing', () => {
  const world = bookmarksWorld();
  world.ready('palette');
  world.showPalette();
  world.advance(1);
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  // The TabDialogBox of the selected tab has a Leave/Stay prompt open.
  world.selectedBrowser.setAttribute(DIALOG_ATTR, 'true');

  world.showBookmarksView();
  world.toggleBookmarksView();
  world.titleChanged('bento-palette-frame', 'BENTO_OPEN_BOOKMARKS_1');
  world.advance(1000);
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
  assert.equal(world.isShown('palette'), true, 'a refused open does not close the palette');
  assert.deepEqual(world.bookmarksShows(), []);

  // The prompt is answered: the same request opens the view, with the focus recorded afresh.
  world.selectedBrowser.removeAttribute(DIALOG_ATTR);
  world.hidePalette();
  world.advance(1000);
  world.showBookmarksView();
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
});

test('a prompt in any panel of the split view refuses the view, one in a background tab does not', () => {
  const world = bookmarksWorld();
  const second = world.makeElement(true);
  const background = world.makeElement(true);
  world.setSplitBrowsers([world.selectedBrowser, second]);

  background.setAttribute(DIALOG_ATTR, 'true');
  world.showBookmarksView();
  assert.equal(world.isShown('bookmarks'), true, 'nobody sees a background tab\'s dialog');
  world.hideBookmarksView();
  world.advance(1000);

  second.setAttribute(DIALOG_ATTR, 'true');
  world.showBookmarksView();
  assert.equal(world.isShown('bookmarks'), false, 'a visible panel\'s prompt would be covered');
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
});

test('an open that waited for its document is cancelled at the reveal if a dialog is showing then', () => {
  const world = makeWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), true);

  // A tab with an open prompt got selected while the document loaded; no dialog event came.
  world.selectedBrowser.setAttribute(DIALOG_ATTR, 'true');
  world.ready('bookmarks');
  world.advance(10_000);

  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(world.host('bookmarks').style.opacity, '0');
  assert.equal(hasBookmarksAttr(world), false);
  assert.deepEqual(world.bookmarksShows(), [], 'the document is never told to show');
  assert.deepEqual(world.focusLog(), [], 'and no focus moved');
  assert.equal(sidebar.focusCount, 0);
  assert.equal(
    world.events.presentation.at(-1)?.presented,
    false,
    'the presentation the open began is taken back',
  );

  // Once the prompt is gone the view opens again.
  world.selectedBrowser.removeAttribute(DIALOG_ATTR);
  world.showBookmarksView();
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
});

test('selecting a tab that already shows a prompt closes the view at once, with no focus move', () => {
  const world = bookmarksWorld();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  const quiet = world.makeBrowser();
  const prompting = world.makeBrowser(true);
  world.showBookmarksView();
  world.advance(1);
  world.setNativeFocus(world.frame('bookmarks'));
  const log = world.focusLog();

  // A tab without a prompt changes nothing.
  world.selectTab(quiet);
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);

  // Firefox focuses the dialog the tab already has and fires no dialog event, so TabSelect is the
  // only signal (the command palette selecting a tab behind a prompt, for one).
  world.selectTab(prompting);
  assert.equal(hasBookmarksAttr(world), false, 'the chrome is back for the prompt');
  assert.equal(world.isShown('bookmarks'), false, 'the host is gone now, not after a fade');
  assert.equal(world.bookmarksHides().length, 1, 'the document drops an open editor or search');
  assert.deepEqual(world.focusLog(), log, 'the prompt takes the focus; the view does not move it');
  assert.equal(sidebar.focusCount, 0);
  assert.equal(prompting.focusCount, 0);
});

test('selecting a tab that shows a prompt cancels a view that still waits for its document', () => {
  const world = makeWorld();
  world.showBookmarksView();
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), true);

  world.selectTab(world.makeBrowser(true));
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
  world.ready('bookmarks');
  world.advance(10_000);
  assert.equal(world.isShown('bookmarks'), false, 'the late announcement reveals nothing');
  assert.deepEqual(world.bookmarksShows(), []);
  assert.deepEqual(world.focusLog(), []);
});

test('a split view that brings a prompting tab into view closes the view, one without does not', () => {
  const world = bookmarksWorld();
  const quiet = world.makeBrowser();
  const prompting = world.makeBrowser(true);
  world.showBookmarksView();
  world.advance(1);

  world.activateSplitView([world.selectedBrowser, quiet]);
  world.advance(1);
  assert.equal(world.isShown('bookmarks'), true);

  world.activateSplitView([world.selectedBrowser, prompting]);
  world.advance(1);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
  assert.equal(world.bookmarksHides().length, 1);
});

test('a prompt in a background tab leaves the view open until that tab is shown', () => {
  const world = bookmarksWorld();
  const background = world.makeBrowser();
  world.showBookmarksView();
  world.advance(1);

  // An alert() of a tab nobody sees: tabbrowser does not select it (no focus-tab permission).
  world.dialogEvent('DOMWillOpenModalDialog', {
    target: background,
    detail: { tabPrompt: true, inPermitUnload: false },
  });
  background.setAttribute(DIALOG_ATTR, 'true');
  world.dialogEvent('dialogopen', { target: world.dialogOverlayOf(background) });
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), true, 'the dialog is not under the view');
  assert.equal(hasBookmarksAttr(world), true);
  assert.deepEqual(world.bookmarksHides(), []);

  // The user selects that tab: now the view would cover the prompt.
  world.selectTab(background);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
});

test('a background tab Leave/Stay prompt is caught once Firefox selects the tab, whichever event gets there first', () => {
  // The engine order for a beforeunload prompt of a background tab: PromptParent fires
  // DOMWillOpenModalDialog (the tab is not shown yet), tabbrowser's capture listener for it selects
  // the tab (TabSelect, and no dialog exists yet), TabDialogBox then sets tabDialogShowing as the
  // event returns, and dialogopen follows once the dialog has loaded.
  for (const caughtBy of ['the look after the event', 'dialogopen']) {
    const world = bookmarksWorld();
    const background = world.makeBrowser();
    world.showBookmarksView();
    world.advance(1);

    world.dialogEvent('DOMWillOpenModalDialog', {
      target: background,
      detail: { tabPrompt: true, inPermitUnload: true },
    });
    assert.equal(world.isShown('bookmarks'), true, `${caughtBy}: the tab is not shown yet`);
    world.selectTab(background);
    assert.equal(world.isShown('bookmarks'), true, `${caughtBy}: TabSelect is before the dialog`);

    background.setAttribute(DIALOG_ATTR, 'true');
    if (caughtBy === 'dialogopen') {
      world.dialogEvent('dialogopen', { target: world.dialogOverlayOf(background) });
    } else {
      world.advance(0);
    }
    assert.equal(world.isShown('bookmarks'), false, `${caughtBy} closes the view`);
    assert.equal(hasBookmarksAttr(world), false, caughtBy);
    assert.equal(world.bookmarksHides().length, 1, caughtBy);
  }
});

test('a prompt that is open before its tab is selected is caught by the selection', () => {
  // The other order: tabDialogShowing is set (the alert came while the tab was in the background),
  // and the tab is selected later with no dialog event at all.
  const world = bookmarksWorld();
  const background = world.makeBrowser();
  world.showBookmarksView();
  world.advance(1);
  background.setAttribute(DIALOG_ATTR, 'true');
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), true);

  world.selectTab(background);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
});

test('a Show that waited for the frame is checked against the overlays above the view when it goes out', () => {
  const world = bookmarksWorld();
  world.overlays.ensure('bookmarks', 'idle');
  const mm = world.frame('bookmarks').messageManager;
  const send = mm.sendAsyncMessage;

  // The frame has no message manager yet: the Show is retried every 100 ms.
  mm.sendAsyncMessage = undefined;
  world.showBookmarksView();
  assert.deepEqual(world.bookmarksShows(), []);

  // The command palette opens over the view meanwhile and takes the focus.
  world.host('palette').style.display = 'flex';
  world.host('palette').style.opacity = '1';
  mm.sendAsyncMessage = send;
  world.advance(100);
  assert.deepEqual(
    world.bookmarksShows().map((message) => message.data),
    [{ focus: false }],
    'the first attempt said focus: true; the delivery says what is true now',
  );
  assert.equal(world.frame('bookmarks').focusCount, 0, 'and the frame does not take it either');
});

test('a Show told not to take the focus is not promoted when its retry goes out', () => {
  const world = bookmarksWorld();
  world.overlays.ensure('bookmarks', 'idle');
  const mm = world.frame('bookmarks').messageManager;
  const send = mm.sendAsyncMessage;
  world.host('confirm').style.display = 'flex';
  world.host('confirm').style.opacity = '1';

  mm.sendAsyncMessage = undefined;
  world.showBookmarksView();
  // The overlay closes before the retry; the view still did not take the focus at the reveal.
  world.host('confirm').style.opacity = '0';
  mm.sendAsyncMessage = send;
  world.advance(100);
  assert.deepEqual(world.bookmarksShows().map((message) => message.data), [{ focus: false }]);
  assert.equal(world.frame('bookmarks').focusCount, 0);
});

test('the view does not take the focus on the next tick from an overlay that opened in between', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  // The reveal asked for the focus; before it lands, a menu is on screen.
  world.host('menu').style.display = 'flex';
  world.host('menu').style.opacity = '1';
  world.advance(1);
  assert.deepEqual(world.focusLog(), []);
  assert.equal(world.frame('bookmarks').focusCount, 0);
});

test('a Bookmarks view whose document reloads gives the chrome back and hides it again on the replay', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  assert.equal(hasBookmarksAttr(world), true);

  world.overlays.reset('bookmarks');
  assert.equal(hasBookmarksAttr(world), false, 'no hidden chrome while there is no view to see');
  assert.equal(world.isShown('bookmarks'), false);

  world.ready('bookmarks');
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
});

test('a Bookmarks view Hide that waited for the frame does not land after the Show that came later', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  const mm = world.frame('bookmarks').messageManager;
  const send = mm.sendAsyncMessage;

  mm.sendAsyncMessage = undefined;
  world.hideBookmarksView();
  mm.sendAsyncMessage = send;
  world.showBookmarksView();
  world.advance(2000);
  assert.deepEqual(world.bookmarksHides(), [], 'the older Hide is dropped, not sent after the Show');
  assert.equal(world.bookmarksShows().length, 2);
});

test('a Bookmarks view Show that waited for the frame does not land after the Hide that came later', () => {
  const world = bookmarksWorld();
  world.showBookmarksView();
  const mm = world.frame('bookmarks').messageManager;
  const send = mm.sendAsyncMessage;
  const shows = world.bookmarksShows().length;

  mm.sendAsyncMessage = undefined;
  world.showBookmarksView();
  mm.sendAsyncMessage = send;
  world.hideBookmarksView();
  world.advance(2000);
  assert.equal(world.bookmarksShows().length, shows, 'the older Show is dropped');
  assert.equal(world.bookmarksHides().length, 1);
});

test('the Bookmarks frame script turns the messages into the document events', () => {
  const listeners = new Map();
  const events = [];
  // Objects made through wrappedJSObject belong to the page's realm; here a marker stands for it.
  class PageObject {
    constructor() {
      this.realm = 'page';
    }
  }
  vm.runInNewContext(BOOKMARKS_FRAME_SCRIPT_SRC, {
    addMessageListener: (name, handler) => listeners.set(name, handler),
    content: {
      wrappedJSObject: { Object: PageObject },
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      dispatchEvent: (event) => events.push(event),
    },
  });
  listeners.get('BentoBookmarksViewShow')({ data: { focus: true } });
  listeners.get('BentoBookmarksViewShow')({ data: { focus: false } });
  listeners.get('BentoBookmarksViewHide')({ data: {} });
  assert.deepEqual(
    events.map((event) => event.type),
    ['bento-bookmarks-show', 'bento-bookmarks-show', 'bento-bookmarks-hide'],
  );
  assert.deepEqual(
    events.slice(0, 2).map((event) => [event.detail.realm, event.detail.focus]),
    [['page', true], ['page', false]],
    'the show detail is { focus } in the page realm, so the page can read it',
  );
  assert.equal(events[2].detail, undefined);
});

/** Runs the Bookmarks frame script in a scope like a frame script's; returns what it did. */
function runBookmarksFrameScript({ pageObject, dispatchEvent, scope }) {
  const listeners = new Map();
  const events = [];
  vm.runInNewContext(BOOKMARKS_FRAME_SCRIPT_SRC, {
    addMessageListener: (name, handler) => listeners.set(name, handler),
    content: {
      wrappedJSObject: { Object: pageObject },
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
      dispatchEvent: (event) => {
        dispatchEvent?.(event);
        events.push(event);
      },
    },
    ...scope,
  });
  return { listeners, events };
}

test('the Bookmarks frame script still shows the view when the detail cannot be built, and says so', () => {
  const warnings = [];
  const { listeners, events } = runBookmarksFrameScript({
    pageObject: class {
      constructor() {
        throw new Error('no page realm');
      }
    },
    scope: { console: { warn: (line) => warnings.push(line) } },
  });
  listeners.get('BentoBookmarksViewShow')({ data: { focus: false } });
  assert.deepEqual(events.map((event) => event.type), ['bento-bookmarks-show']);
  assert.equal(events[0].detail, undefined, 'the document gets the show without a detail');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bookmarks view show detail failed.*no page realm/);
});

test('the Bookmarks frame script logs through dump when the frame has no console, and never throws', () => {
  const dumped = [];
  const { listeners, events } = runBookmarksFrameScript({
    pageObject: class {
      constructor() {
        throw new Error('no page realm');
      }
    },
    dispatchEvent: () => {
      throw new Error('document gone');
    },
    // No console in the frame's scope: using it throws, which sends the line to dump.
    scope: { console: undefined, dump: (line) => dumped.push(line) },
  });
  listeners.get('BentoBookmarksViewShow')({ data: { focus: true } });
  listeners.get('BentoBookmarksViewHide')({ data: {} });
  assert.equal(events.length, 0, 'nothing could be delivered');
  assert.equal(dumped.length, 3, 'the detail failure, the show failure and the hide failure');
  assert.match(dumped[1], /show event failed.*document gone\n$/);
});

test('the Library key toggles the Bookmarks view, and the Library stays on its command', () => {
  const world = bookmarksWorld();
  const key = world.addLibraryKey();
  world.retargetLibraryKeyToBookmarksView();
  world.retargetLibraryKeyToBookmarksView();
  assert.equal(key.hasAttribute('command'), false, 'the key raises command on itself now');
  assert.equal(key.listenerCount(), 1, 'a second call adds nothing');

  key.dispatch('command');
  assert.equal(world.isShown('bookmarks'), true);
  key.dispatch('command');
  assert.equal(hasBookmarksAttr(world), false);
  // During the fade-out the host is still visible, but the view is closed: the key reopens it.
  key.dispatch('command');
  assert.equal(hasBookmarksAttr(world), true);
  key.dispatch('command');
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), false);

  // The menus and toolbar buttons keep Browser:ShowAllBookmarks; only the key is retargeted.
  assert.ok(!MOUNT.includes("'Browser:ShowAllBookmarks'"));
});

// ─── The Bookmarks manager setting ──────────────────────────────────────────

test('with the Bookmarks manager off, no path opens the view: call, toggle, title and key', () => {
  const world = bookmarksWorld();
  const key = world.addLibraryKey();
  world.retargetLibraryKeyToBookmarksView();
  world.applyChromeBookmarksEnabled(false);

  world.showBookmarksView();
  world.toggleBookmarksView();
  world.titleChanged('bento-shell-frame', 'BENTO_OPEN_BOOKMARKS_1');
  world.titleChanged('bento-palette-frame', 'BENTO_OPEN_BOOKMARKS_2');
  key.dispatch('command');
  world.advance(1000);

  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
  assert.deepEqual(world.bookmarksShows(), []);
  assert.equal(world.host('bookmarks').style.opacity, '0');
  assert.deepEqual(world.focusLog(), []);
});

test('a refused open leaves the palettes as they are', () => {
  const world = bookmarksWorld();
  world.ready('palette');
  world.applyChromeBookmarksEnabled(false);
  world.showPalette();
  world.showBookmarksView();
  world.advance(1000);
  assert.equal(world.isShown('palette'), true, 'the command palette is not dismissed');
  assert.equal(world.isShown('bookmarks'), false);
});

test('turning the Bookmarks manager off puts Firefox\'s command back on the Library key, exactly', () => {
  const world = bookmarksWorld();
  const key = world.addLibraryKey();
  const stock = key.getAttribute('command');
  assert.ok(stock, 'the key starts with its stock command');
  world.retargetLibraryKeyToBookmarksView();
  assert.equal(key.hasAttribute('command'), false);
  assert.equal(key.listenerCount(), 1);

  world.applyChromeBookmarksEnabled(false);
  assert.equal(key.getAttribute('command'), stock, 'the stock command, not a copy of its name');
  assert.equal(key.listenerCount(), 0, 'the key no longer toggles the view');
  assert.equal(key.hasAttribute('data-bento-library-command'), false, 'no trace is left');
  key.dispatch('command');
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
  assert.equal(world.isShown('bookmarks'), false);

  // The same state again changes nothing.
  world.applyChromeBookmarksEnabled(false);
  assert.equal(key.getAttribute('command'), stock);
});

test('turning the Bookmarks manager back on retargets the key once and the view opens again', () => {
  const world = bookmarksWorld();
  const key = world.addLibraryKey();
  const stock = key.getAttribute('command');
  world.retargetLibraryKeyToBookmarksView();
  world.applyChromeBookmarksEnabled(false);

  world.applyChromeBookmarksEnabled(true);
  world.applyChromeBookmarksEnabled(true);
  assert.equal(key.hasAttribute('command'), false, 'the key raises command on itself again');
  assert.equal(key.listenerCount(), 1, 'one listener, however often it is turned on');

  key.dispatch('command');
  assert.equal(world.isShown('bookmarks'), true);
  assert.equal(hasBookmarksAttr(world), true);
  world.titleChanged('bento-bookmarks-frame', 'BENTO_CLOSE_BOOKMARKS_1');
  world.advance(1000);

  // A second off-on round trip restores the very same stock command.
  world.applyChromeBookmarksEnabled(false);
  assert.equal(key.getAttribute('command'), stock);
  world.titleChanged('bento-shell-frame', 'BENTO_OPEN_BOOKMARKS_3');
  assert.equal(world.isShown('bookmarks'), false);
  world.applyChromeBookmarksEnabled(true);
  world.titleChanged('bento-shell-frame', 'BENTO_OPEN_BOOKMARKS_4');
  assert.equal(hasBookmarksAttr(world), true);
});

test('a key that is found only after the manager was turned off stays Firefox\'s', () => {
  const world = makeWorld();
  world.applyChromeBookmarksEnabled(false);
  const key = world.addLibraryKey();
  world.retargetLibraryKeyToBookmarksView();
  assert.equal(key.getAttribute('command'), 'Browser:ShowAllBookmarks');
  assert.equal(key.listenerCount(), 0);
  assert.equal(key.hasAttribute('data-bento-library-command'), false);

  world.applyChromeBookmarksEnabled(true);
  assert.equal(key.hasAttribute('command'), false, 'turning it on retargets the key that is there');
  assert.equal(key.listenerCount(), 1);
});

test('turning the Bookmarks manager off closes an open view like any close, and stays off', () => {
  const world = bookmarksWorld();
  world.addLibraryKey();
  world.retargetLibraryKeyToBookmarksView();
  const sidebar = world.registry.get('bento-shell-frame');
  world.setNativeFocus(sidebar);
  world.showBookmarksView();
  world.advance(1);
  world.setNativeFocus(world.frame('bookmarks'));
  assert.equal(hasBookmarksAttr(world), true);

  world.applyChromeBookmarksEnabled(false);
  assert.equal(hasBookmarksAttr(world), false, 'the chrome comes back under the fade-out');
  assert.equal(world.bookmarksHides().length, 1, 'the document drops an open editor or search');
  assert.equal(sidebar.focusCount, 1, 'the focus returns to where it was');
  assert.equal(world.host('bookmarks').style.opacity, '0');
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), false);

  world.showBookmarksView();
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
});

test('turning the Bookmarks manager off cancels an open that still waits for its document', () => {
  const world = makeWorld();
  world.showBookmarksView();
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), true);

  world.applyChromeBookmarksEnabled(false);
  assert.equal(world.overlays.hasPendingOpen('bookmarks'), false);
  world.ready('bookmarks');
  world.advance(1000);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(hasBookmarksAttr(world), false);
  assert.deepEqual(world.bookmarksShows(), []);
});

test('turning the manager off while Settings is open over the view closes the view and leaves Settings alone', () => {
  const world = bookmarksWorld();
  world.ready('settings-palette');
  world.showBookmarksView();
  world.advance(1);
  world.showSettingsPalette();
  world.advance(1000);
  world.setNativeFocus(world.frame('settings-palette'));
  const page = world.selectedBrowser;
  assert.equal(world.isShown('settings-palette'), true);
  assert.equal(hasBookmarksAttr(world), true);

  world.applyChromeBookmarksEnabled(false);
  world.advance(1000);
  assert.equal(hasBookmarksAttr(world), false);
  assert.equal(world.isShown('bookmarks'), false);
  assert.equal(world.isShown('settings-palette'), true, 'Settings stays open');
  assert.equal(page.focusCount, 0, 'the focus is not moved from the overlay above the view');
});

test('turning the Bookmarks manager off while the view is already closed does nothing else', () => {
  const world = bookmarksWorld();
  world.applyChromeBookmarksEnabled(false);
  assert.deepEqual(world.bookmarksHides(), [], 'no hide is sent to a view that was not shown');
  assert.deepEqual(world.focusLog(), []);
});

test('a private window keeps the stock Library key whatever the setting says', () => {
  const world = makeWorld({ privateWindow: true });
  const key = world.addLibraryKey();
  world.retargetLibraryKeyToBookmarksView();
  world.applyChromeBookmarksEnabled(false);
  world.applyChromeBookmarksEnabled(true);
  assert.equal(key.getAttribute('command'), 'Browser:ShowAllBookmarks');
  assert.equal(key.listenerCount(), 0);
  world.showBookmarksView();
  assert.equal(world.overlays.hasStarted('bookmarks'), false);
});

test('chrome reads the setting from the BENTO_PANELS payload, next to the other chrome-bound settings', () => {
  assert.match(
    MOUNT,
    /if \(typeof decoded\.bookmarksEnabled === 'boolean'\) \{\s*applyChromeBookmarksEnabled\(decoded\.bookmarksEnabled\);\s*\}/,
  );
});

test('a window without the Library key leaves Cmd+Shift+O alone and does not throw', () => {
  const world = makeWorld();
  world.retargetLibraryKeyToBookmarksView();
  assert.equal(world.overlays.hasStarted('bookmarks'), false);
});

test('Cmd+L does not anchor to the sidebar row while the Bookmarks view hides the sidebar', () => {
  const attrs = new Set();
  const canAnchor = vm.runInNewContext(
    `"use strict";${extractFunction('canAnchorAddrbarToSidebarRow')}\ncanAnchorAddrbarToSidebarRow`,
    {
      BOOKMARKS_VIEW_ATTR: BOOKMARKS_ATTR,
      document: {
        documentElement: { hasAttribute: (name) => attrs.has(name) },
        getElementById: () => ({}),
      },
      isSidebarCollapsedTarget: () => false,
      isSidebarHiddenTarget: () => false,
      isBentoSidebarPushing: () => false,
    },
  );
  assert.equal(canAnchor(), true);
  attrs.add(BOOKMARKS_ATTR);
  assert.equal(canAnchor(), false);
});

// Problems in the Bookmarks view rules of a stylesheet: what would hide, fade or move the toolbox,
// the nav bar or the window buttons (macOS drops the traffic lights when #navigator-toolbox,
// #nav-bar or the button box is hidden, or has opacity, a transform or a filter on it or on an
// ancestor; docs/technical/overlay-documents.md). The strip's controls may move only as children
// of #nav-bar-customization-target, a sibling of the button box.
function bookmarksViewRuleProblems(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const forbidden =
    /(^|;)\s*(visibility|display|opacity|transform|translate|scale|rotate|filter|-moz-subtree-hidden-only-visually)\s*:/;
  const effect =
    /(^|;)\s*(opacity|transform|translate|scale|rotate|filter|-moz-subtree-hidden-only-visually)\s*:/;
  const protectedSubject =
    /(^|[\s>+~])(#navigator-toolbox|#nav-bar|#TabsToolbar|\.titlebar-buttonbox-container|\.titlebar-buttonbox)\s*$|^(html|:root)(\[[^\]]*\])*$/;
  const touchesToolbox = /#nav-bar|#navigator-toolbox|#TabsToolbar|\.titlebar-buttonbox/;
  const universalSubject = /(^|[\s>+~])\*\s*$/;
  const underControls = /#nav-bar-customization-target\s*>/;
  const problems = [];
  let rules = 0;
  for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.includes(BOOKMARKS_ATTR)) continue;
    rules += 1;
    for (const raw of selectors.split(/,(?![^(]*\))/)) {
      const selector = raw.trim();
      if (forbidden.test(declarations) && protectedSubject.test(selector)) {
        problems.push(`${selector} must not take ${declarations.trim()}`);
      }
      if (
        effect.test(declarations) &&
        !underControls.test(selector) &&
        (touchesToolbox.test(selector) || universalSubject.test(selector))
      ) {
        problems.push(`${selector} may move or fade only children of #nav-bar-customization-target`);
      }
    }
  }
  if (rules < 3) problems.push('the Bookmarks view rules are missing from the stylesheet');
  return problems;
}

test('the stylesheet never hides, fades or transforms the toolbox, the nav bar or the window buttons', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/browser/base/content/bento-shell-mount.css'), 'utf8');
  assert.deepEqual(bookmarksViewRuleProblems(css), []);
  // The strip keeps only the button box: every other nav-bar child is hidden, that one is not.
  assert.match(css, /#nav-bar > :not\(\.titlebar-buttonbox-container\)/);
  // The top-bar slide and fade is on the controls, a sibling of the button box.
  assert.match(
    css,
    /:root\[bento-bookmarks-view\] #nav-bar-customization-target > \* \{\s*translate:[^;]+;\s*opacity: 0;/,
  );
});

test('the guard fails a rule that would move or fade the toolbox, the nav bar or the button box', () => {
  const bad = (selector, declaration) =>
    bookmarksViewRuleProblems(
      `:root[${BOOKMARKS_ATTR}] .a { color: red }\n:root[${BOOKMARKS_ATTR}] .b { color: red }\n` +
        `${selector} { ${declaration} }`,
    );
  const view = `:root[${BOOKMARKS_ATTR}]`;
  for (const [selector, declaration] of [
    [`${view} #nav-bar`, 'translate: 0 -10px'],
    [`${view} #navigator-toolbox`, 'transform: scale(0.9)'],
    [`${view} .titlebar-buttonbox-container`, 'opacity: 0'],
    [`${view} .titlebar-buttonbox`, 'filter: blur(1px)'],
    [`${view} #nav-bar > *`, 'opacity: 0'],
    [`${view} #nav-bar > :not(.titlebar-buttonbox-container)`, 'translate: 0 -10px'],
    [`${view} *`, 'opacity: 0'],
    [view, 'opacity: 0'],
  ]) {
    assert.notDeepEqual(bad(selector, declaration), [], `${selector} { ${declaration} }`);
  }
  assert.deepEqual(
    bad(`${view} #nav-bar > #nav-bar-customization-target > *`, 'translate: 0 -10px; opacity: 0'),
    [],
  );
});

// ─── Chrome stamps the window on what it sends ──────────────────────────────

test('the address bar open names the window it is for', () => {
  const world = warmWorld({ windowId: 7 });
  world.showAddrbar('current');
  assert.equal(world.addrbarOpens()[0].windowId, 7);
});

test('the merge palette open and close name the window they are for', () => {
  const world = warmWorld({ windowId: 7 });
  world.showMergePalette();
  world.ready('merge-palette');
  world.hideMergePalette();
  assert.deepEqual(
    world.mergeLifecycle().map((message) => [message.type, message.windowId]),
    [
      ['open', 7],
      ['close', 7],
    ],
  );
});

test('menu/open names the window it is for, in the envelope bento-tools routes by', () => {
  const world = warmWorld({ windowId: 7 });
  world.showChromeMenu({ ...MENU });
  assert.equal(world.menuOpens()[0].__windowId, 7);
});

test('a failed window lookup leaves the id out, so receivers accept the message', () => {
  const world = warmWorld({ windowId: null });
  world.showAddrbar('current');
  world.showChromeMenu({ ...MENU });
  assert.equal(world.addrbarOpens()[0].windowId, null);
  assert.equal('__windowId' in world.menuOpens()[0], false);
});

// ─── A private window cannot reach the shell background over BroadcastChannel ──

test('a private window posts tools-bound actions to the bus hub, not the frame script', () => {
  const world = warmWorld({ windowId: 7, privateWindow: true });

  assert.equal(
    world.dispatchShellAction({ type: 'tab/openUrl', url: 'https://example.com' }),
    true,
  );

  assert.deepEqual(world.hubPosts(), [
    {
      kind: 'action',
      action: { type: 'tab/openUrl', url: 'https://example.com' },
    },
  ]);
  assert.deepEqual(world.shellActions(), []);
});

test('a private window keeps menu/open and ui/* on the frame script, once', () => {
  const world = warmWorld({ windowId: 7, privateWindow: true });

  world.showChromeMenu({ ...MENU });
  world.dispatchShellAction({ type: 'ui/renameRequest', target: { kind: 'tab', id: 3 } });

  assert.deepEqual(
    world.shellActions().map((action) => action.type),
    ['menu/open', 'ui/renameRequest'],
  );
  assert.deepEqual(world.hubPosts(), []);
});

test('the panel options menu offers Save panel in a regular window, and not in a private one', () => {
  const regular = warmWorld({ windowId: 7 }).savePanelMenuItems();
  const privateItems = warmWorld({ windowId: 7, privateWindow: true }).savePanelMenuItems();

  assert.deepEqual(
    Array.from(regular, (item) => item.id),
    ['sep-save-panel', 'save-panel'],
  );
  assert.equal(privateItems.length, 0);
});

test('a regular window never uses the hub', () => {
  const world = warmWorld({ windowId: 7 });

  world.dispatchShellAction({ type: 'tab/openUrl', url: 'https://example.com' });

  assert.equal(world.shellActions().length, 1);
  assert.deepEqual(world.hubPosts(), []);
});

test("setFrameSrc marks a private window's frames with #bentoPrivate=1, and only those", () => {
  const navigations = [];
  const frame = { id: 'bento-palette-frame' };
  const run = (privateWindow) => {
    const sandbox = {
      document: { getElementById: () => frame },
      window: {},
      console: { warn: () => {} },
      setTimeout: () => {},
      URLSearchParams,
      URL,
      overlays: { idForFrame: () => 'palette', reset: () => {} },
      Object,
      String,
      moz: (path) => `moz-extension://host${path}`,
      getChromeWindowId: () => 7,
      navigateChromeFrame: (_frame, url) => navigations.push(url),
      BentoPrivateBrowsingUtils: { isWindowPrivate: () => privateWindow },
      SET_FRAME_SRC_MAX_RETRIES: 20,
      SET_FRAME_SRC_POLICY_RETRY_MIN_MS: 50,
      SET_FRAME_SRC_POLICY_RETRY_MAX_MS: 2000,
      SET_FRAME_SRC_POLICY_GIVE_UP_MS: 30000,
      ADDON_ID: 'bento-shell@bento.app',
    };
    vm.runInNewContext(
      `"use strict";${extractFunction('setFrameSrc')}\nsetFrameSrc('bento-palette-frame', '/dist/palette.html');`,
      sandbox,
      { filename: 'bento-shell-mount.js#setFrameSrc' },
    );
  };

  run(true);
  run(false);

  assert.deepEqual(navigations, [
    'moz-extension://host/dist/palette.html#bentoNativeMode=1&bentoWindowId=7&bentoPrivate=1&bentoHostedOverlay=1',
    'moz-extension://host/dist/palette.html#bentoNativeMode=1&bentoWindowId=7&bentoHostedOverlay=1',
  ]);
});

test('hosted hints preserve URL/hash data and never opt the sidebar into overlay presentation', () => {
  const navigations = [];
  const resets = [];
  const sandbox = {
    document: { getElementById: (id) => ({ id }) }, console: { warn() {} }, window: {},
    URL, URLSearchParams, Object, String,
    moz: (path) => `moz-extension://host${path}`,
    getChromeWindowId: () => 7,
    BentoPrivateBrowsingUtils: { isWindowPrivate: () => false },
    overlays: { idForFrame: (id) => id === 'bento-palette-frame' ? 'palette' : null,
      reset: (id) => resets.push(id) },
    navigateChromeFrame: (frame, url) => navigations.push({ id: frame.id, url: new URL(url) }),
    SET_FRAME_SRC_MAX_RETRIES: 20,
  };
  vm.runInNewContext(`${extractFunction('setFrameSrc')}
    setFrameSrc('bento-palette-frame', '/dist/palette.html?keep=query#old=value', 0, { extra: 'retained' });
    setFrameSrc('bento-shell-frame', '/dist/index.html#old=value');`, sandbox);
  assert.equal(navigations[0].url.search, '?keep=query');
  const overlayHash = new URLSearchParams(navigations[0].url.hash.slice(1));
  assert.equal(overlayHash.get('old'), 'value');
  assert.equal(overlayHash.get('extra'), 'retained');
  assert.equal(overlayHash.get('bentoHostedOverlay'), '1');
  assert.equal(new URLSearchParams(navigations[1].url.hash.slice(1)).has('bentoHostedOverlay'), false);
  assert.deepEqual(resets, ['palette']);
});

test('the native actor query validates its acknowledgement and cannot reveal a replacement document', async () => {
  let resolveQuery;
  const queried = [];
  const windowGlobal = { documentURI: { scheme: 'moz-extension' }, getActor: (name) => {
    assert.equal(name, 'BentoShellBus');
    return { sendQuery: (query, data) => {
      queried.push([query, data.presented, data.generation]);
      return new Promise((resolve) => { resolveQuery = resolve; });
    } };
  } };
  const frame = { browsingContext: { currentWindowGlobal: windowGlobal } };
  const sandbox = { document: { getElementById: () => frame }, bentoModePresenter: null };
  const apply = vm.runInNewContext(`${extractFunction('setOverlayPresentation')}\nsetOverlayPresentation`, sandbox);
  const pending = apply('frame', true, 7);
  frame.browsingContext.currentWindowGlobal = {};
  resolveQuery({ presented: true, generation: 7 });
  assert.equal(await pending, false);
  frame.browsingContext.currentWindowGlobal = windowGlobal;
  const current = apply('frame', true, 8);
  resolveQuery({ presented: true, generation: 8 });
  assert.equal(await current, true);
  assert.deepEqual(queried, [
    ['BentoShellBus:HostPresentation', true, 7], ['BentoShellBus:HostPresentation', true, 8],
  ]);
});

test('shared mode settlement precedes host-presentation ACK and navigation during that wait cannot reveal', async () => {
  let grant;
  const queries = [];
  const current = { documentURI: { scheme: 'moz-extension' }, getActor: () => ({
    sendQuery: async (_name, data) => { queries.push(data); return data; },
  }) };
  const frame = { browsingContext: { currentWindowGlobal: current } };
  const sandbox = {
    document: { getElementById: () => frame },
    bentoModePresenter: { prepareReveal: () => new Promise((resolve) => { grant = resolve; }) },
  };
  const apply = vm.runInNewContext(`${extractFunction('setOverlayPresentation')}\nsetOverlayPresentation`, sandbox);
  const stale = apply('frame', true, 1);
  assert.equal(queries.length, 0, 'mode writer has not submitted yet');
  frame.browsingContext.currentWindowGlobal = {};
  grant();
  assert.equal(await stale, false);
  assert.equal(queries.length, 0);
  frame.browsingContext.currentWindowGlobal = current;
  const shown = apply('frame', true, 2);
  grant();
  assert.equal(await shown, true);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].generation, 2);
});

test('tooltip payload waits for the shared presentation gate and null commits an immediate hide', () => {
  const sent = [];
  let reveal;
  const frame = { messageManager: { sendAsyncMessage: (...args) => sent.push(args) } };
  const host = { style: {}, removeAttribute() {} };
  const sandbox = {
    bentoModePresenter: null,
    panelNavigatorTooltipPayload: { label: 'latest' }, panelNavigatorTooltipTimer: null,
    document: { getElementById: (id) => id.endsWith('-host') ? host : frame },
    overlays: { hasPendingOpen: () => false,
      open: (_id, _reason, run) => { reveal = run; }, cancel() {},
      setPresented: (_id, value) => sent.push(['presentation', value]) },
  };
  vm.runInNewContext(`${extractFunction('replayPanelNavigatorTooltipPayload')}
    ${extractFunction('hidePanelNavigatorTooltip')}
    replayPanelNavigatorTooltipPayload(document.getElementById('frame'));`, sandbox);
  assert.deepEqual(sent, []);
  reveal();
  assert.equal(sent[0][0], 'BentoPanelNavigatorTooltip');
  vm.runInNewContext('hidePanelNavigatorTooltip();', sandbox);
  assert.deepEqual(sent.slice(1), [['BentoPanelNavigatorTooltip', null], ['presentation', false]]);
});

test("a private window's sidebar frame carries chrome's root font size; others do not", () => {
  const stamped = [];
  const run = ({ privateWindow, fontSize }) => {
    const sandbox = {
      document: {
        readyState: 'complete',
        getElementById: () => ({ setAttribute: () => {}, style: { setProperty: () => {} } }),
        querySelectorAll: () => [],
        documentElement: {},
      },
      getComputedStyle: () => ({ fontSize }),
      getBentoSidebarAddressBridgeToken: () => 'token',
      setFrameSrc: (_id, _path, _attempt, extra) => stamped.push(extra.bentoChromeRem),
      window: {},
      Array,
      Number,
      BentoPrivateBrowsingUtils: { isWindowPrivate: () => privateWindow },
    };
    vm.runInNewContext(
      `"use strict";${extractFunction('chromeRemPx')}\n${extractFunction('chromeSheetsApplied')}\n${extractFunction('setBentoShellSrc')}\nsetBentoShellSrc();`,
      sandbox,
      { filename: 'bento-shell-mount.js#setBentoShellSrc' },
    );
  };

  run({ privateWindow: true, fontSize: '11px' });
  run({ privateWindow: false, fontSize: '11px' });
  run({ privateWindow: true, fontSize: '' });

  // Absent for a regular window and for a root size that cannot be read.
  assert.deepEqual(stamped, [11, null, null]);
});

test('a private window whose chrome sheets are still loading stamps the font size only at load', () => {
  const stamped = [];
  const listeners = [];
  const link = { sheet: null };
  // A cold window reads 16px (the default) until global.css applies.
  let fontSize = '16px';
  const doc = {
    readyState: 'loading',
    getElementById: () => ({ setAttribute: () => {}, style: { setProperty: () => {} } }),
    querySelectorAll: () => [link],
    documentElement: {},
  };
  const sandbox = {
    document: doc,
    getComputedStyle: () => ({ fontSize }),
    getBentoSidebarAddressBridgeToken: () => 'token',
    setFrameSrc: (_id, _path, _attempt, extra) => stamped.push(extra.bentoChromeRem),
    window: { addEventListener: (type, fn) => listeners.push({ type, fn }) },
    Array,
    Number,
    BentoPrivateBrowsingUtils: { isWindowPrivate: () => true },
  };
  vm.runInNewContext(
    `"use strict";${extractFunction('chromeRemPx')}\n${extractFunction('chromeSheetsApplied')}\n${extractFunction('setBentoShellSrc')}\nthis.setBentoShellSrc = setBentoShellSrc; setBentoShellSrc();`,
    sandbox,
    { filename: 'bento-shell-mount.js#setBentoShellSrc' },
  );

  assert.deepEqual(stamped, []);
  assert.deepEqual(
    listeners.map((l) => l.type),
    ['load'],
  );

  // The load event: every sheet applied, the root font size is final.
  link.sheet = {};
  doc.readyState = 'complete';
  fontSize = '11px';
  listeners[0].fn();
  assert.deepEqual(stamped, [11]);
});

// ─── The hide waits for the fade the stylesheet configures ──────────────────

const isHidden = (world, id) => !world.isShown(id);

test('the address bar host fades on the modal role, with no raw duration', () => {
  assert.match(
    MOUNT,
    /^ {2}const ADDRBAR_HOST_TRANSITION = 'opacity var\(--muxui-semantic-motion-modal-transition\)';$/m,
  );
  const world = warmWorld();
  world.showAddrbar('current');
  assert.equal(
    world.host('addrbar').style.transition,
    'opacity var(--muxui-semantic-motion-modal-transition)',
  );
});

test('a hide takes its time from the computed fade, not from a constant', () => {
  for (const fadeMs of [120, 180, 400]) {
    const world = warmWorld({ fadeMs });
    world.showPalette();
    world.hidePalette();
    assert.equal(world.isShown('palette'), true, 'still fading');
    world.advance(fadeMs + 49);
    assert.equal(world.isShown('palette'), true, `${fadeMs} ms: not hidden before the fade ends`);
    world.advance(1);
    assert.equal(isHidden(world, 'palette'), true, `${fadeMs} ms: hidden after the fade`);
    assert.equal(world.host('palette').listenerCount(), 0);
  }
});

test('the end of the opacity transition hides at once, ahead of the timer', () => {
  const world = warmWorld();
  world.showPalette();
  world.hidePalette();
  const host = world.host('palette');

  host.dispatch('transitionend', { propertyName: 'transform' });
  assert.equal(world.isShown('palette'), true, 'another property ending is ignored');
  host.dispatch('transitionend', { propertyName: 'opacity', target: {} });
  assert.equal(world.isShown('palette'), true, 'an event from a descendant is ignored');

  host.dispatch('transitionend', { propertyName: 'opacity' });
  assert.equal(isHidden(world, 'palette'), true);
  assert.equal(host.listenerCount(), 0);
  world.advance(10_000);
});

test('native presentation stays true through exit opacity and commits false only after completion', () => {
  const world = warmWorld();
  world.showPalette();
  assert.equal(world.events.presentation.at(-1).presented, true);
  world.hidePalette();
  assert.equal(world.events.presentation.at(-1).presented, true);
  world.host('palette').dispatch('transitionend', { propertyName: 'opacity' });
  assert.equal(world.events.presentation.at(-1).presented, false);
  assert.equal(world.isShown('palette'), false);
});

test('an acknowledgement and stale exit cannot overtake a newer open', async () => {
  const queries = [];
  const world = makeWorld({ presentationQuery: (frameId, presented) =>
    new Promise((resolve) => queries.push({ frameId, presented, resolve })) });
  world.showPalette();
  world.ready('palette');
  assert.equal(world.isShown('palette'), false);
  queries[0].resolve(true);
  await Promise.resolve();
  assert.equal(world.isShown('palette'), true);
  world.hidePalette();
  world.showPalette();
  world.host('palette').dispatch('transitionend', { propertyName: 'opacity' });
  assert.equal(queries.some((query) => !query.presented), false);
  queries[1].resolve(true);
  await Promise.resolve();
  assert.equal(world.isShown('palette'), true);
});

test('a never-revealed host commits false immediately when dismissed during its presentation query', async () => {
  const queries = [];
  const world = makeWorld({ presentationQuery: (_frameId, presented) =>
    new Promise((resolve) => queries.push({ presented, resolve })) });
  world.showPalette();
  world.ready('palette');
  world.hidePalette();
  assert.deepEqual(queries.map((query) => query.presented), [true, false]);
  queries[0].resolve(true);
  await Promise.resolve();
  assert.equal(world.isShown('palette'), false);
});

test('the workspace switcher keeps layout and blocks input during exit, then commits hidden', () => {
  const world = warmWorld();
  world.showWorkspaceSwitcher();
  world.hideWorkspaceSwitcher();
  const host = world.host('workspace-switcher');
  assert.equal(host.style.pointerEvents, 'none');
  assert.equal(host.hasAttribute('hidden'), false);
  assert.equal(world.events.presentation.at(-1).presented, true);
  host.dispatch('transitionend', { propertyName: 'opacity' });
  assert.equal(host.style.display, 'flex');
  assert.equal(host.hasAttribute('hidden'), true);
  assert.equal(world.events.presentation.at(-1).presented, false);
});

test('workspace close returns owned focus immediately, ignores outside focus, and cancels old queued focus on reopen', () => {
  const world = warmWorld();
  world.showWorkspaceSwitcher();
  const frame = world.frame('workspace-switcher');
  world.setNativeFocus(frame);
  world.hideWorkspaceSwitcher();
  assert.equal(world.frame('shell').focusCount, 1);
  world.advance(0);
  assert.equal(frame.focusCount, 0, 'the queued focus from the closed open is stale');
  world.showWorkspaceSwitcher();
  world.advance(0);
  assert.equal(frame.focusCount, 1, 'the new open owns its focus callback');
  world.setNativeFocus({ id: 'outside-click-target' });
  world.hideWorkspaceSwitcher();
  assert.equal(world.frame('shell').focusCount, 1, 'an outside click retains its focus');

  const hiddenSidebar = warmWorld();
  hiddenSidebar.showWorkspaceSwitcher();
  hiddenSidebar.setNativeFocus(hiddenSidebar.frame('workspace-switcher'));
  hiddenSidebar.host('shell').classList.contains = (name) => name === 'bento-sidebar-hidden';
  hiddenSidebar.hideWorkspaceSwitcher();
  assert.equal(hiddenSidebar.events.focusFallback, 1);
  assert.equal(hiddenSidebar.frame('shell').focusCount, 0);
});

test('a shown address bar replays its pending reveal and open payload after navigation', () => {
  const world = warmWorld();
  world.showAddrbar('newTab', 'kept query');
  const oldOpenId = world.getPendingAddrbarReveal().openId;
  world.revealPendingAddrbar(oldOpenId);
  assert.equal(world.getPendingAddrbarReveal(), null);
  world.overlays.reset('addrbar');
  assert.equal(world.isShown('addrbar'), false);
  world.ready('addrbar');
  const pending = world.getPendingAddrbarReveal();
  assert.ok(pending);
  assert.notEqual(pending.openId, oldOpenId);
  assert.equal(world.addrbarOpens().at(-1).initialQuery, 'kept query');
  world.revealPendingAddrbar(oldOpenId);
  assert.equal(world.host('addrbar').style.opacity, '0', 'the old document cannot reveal the prepared host');
  assert.equal(world.getPendingAddrbarReveal().openId, pending.openId);
  world.revealPendingAddrbar(pending.openId);
  assert.equal(world.isShown('addrbar'), true);
});

test('address-bar reload before reveal replaces its old wait, id, and timers before preparing the new document', () => {
  const world = warmWorld();
  world.showAddrbar('newTab', 'still waiting');
  const oldPending = world.getPendingAddrbarReveal();
  const oldRetry = world.timerCallback(oldPending.retryTimer);
  const oldFallback = world.timerCallback(oldPending.fallbackTimer);
  assert.equal(typeof oldRetry, 'function');
  assert.equal(typeof oldFallback, 'function');

  world.overlays.reset('addrbar');
  assert.equal(world.getPendingAddrbarReveal(), null);
  assert.equal(world.timerCallback(oldPending.retryTimer), undefined);
  assert.equal(world.timerCallback(oldPending.fallbackTimer), undefined);
  assert.equal(world.host('addrbar').hasAttribute('hidden'), true);

  world.ready('addrbar');
  const pending = world.getPendingAddrbarReveal();
  assert.ok(pending);
  assert.notEqual(pending.openId, oldPending.openId);
  assert.equal(world.host('addrbar').hasAttribute('hidden'), false);
  assert.equal(world.host('addrbar').style.opacity, '0');
  const openCount = world.addrbarOpens().length;
  world.revealPendingAddrbar(oldPending.openId);
  oldRetry();
  oldFallback();
  assert.equal(world.addrbarOpens().length, openCount, 'old retries cannot target the new page');
  assert.equal(world.host('addrbar').style.opacity, '0', 'old reveal messages and timers are stale');
  assert.equal(world.getPendingAddrbarReveal().openId, pending.openId);
  assert.equal(world.addrbarOpens().at(-1).initialQuery, 'still waiting');

  world.revealPendingAddrbar(pending.openId);
  assert.equal(world.isShown('addrbar'), true);
  assert.equal(world.host('addrbar').style.opacity, '1');
});

test('with no fade (reduced motion) every hide completes at once', () => {
  const world = warmWorld({ fadeMs: 0 });
  for (const [id, show, hide] of [
    ['palette', () => world.showPalette(), () => world.hidePalette()],
    ['workspace-palette', () => world.showWorkspacePalette(), () => world.hideWorkspacePalette()],
    ['merge-palette', () => world.showMergePalette(), () => world.hideMergePalette()],
    ['settings-palette', () => world.showSettingsPalette(), () => world.hideSettingsPalette()],
    ['confirm', () => world.showConfirm(), () => world.hideConfirm()],
    ['edit-workspace', () => world.showEditWorkspace(), () => world.hideEditWorkspace()],
    ['welcome', () => world.showWelcome(), () => world.hideWelcome()],
  ]) {
    world.ready(id);
    show();
    assert.equal(world.isShown(id), true, `${id} shows`);
    hide();
    assert.equal(isHidden(world, id), true, `${id} hides without waiting`);
  }
  const addrbar = world.host('addrbar');
  world.showAddrbar('current');
  world.hideAddrbar();
  assert.equal(addrbar.style.display, 'none');
});

test('a host with no computed style falls back to the ceiling instead of hanging', () => {
  const world = warmWorld();
  world.showPalette();
  const host = world.host('palette');
  host.isConnected = false;
  world.hidePalette();
  world.advance(world.MOTION_UNAVAILABLE_CEILING_MS - 1);
  assert.equal(world.isShown('palette'), true);
  world.advance(1);
  assert.equal(isHidden(world, 'palette'), true);
});

test('showing again during the fade cancels the pending hide, and the next hide times itself', () => {
  const world = warmWorld();
  world.showPalette();
  const host = world.host('palette');

  world.hidePalette();
  world.advance(100);
  world.showPalette();
  assert.equal(host.listenerCount(), 0, 'the re-show dropped the first hide wait');

  world.advance(1000);
  assert.equal(world.isShown('palette'), true, 'the first hide never fires');

  // The second hide starts its own full fade rather than inheriting the first one's.
  world.hidePalette();
  world.advance(100);
  world.hidePalette();
  world.advance(179);
  assert.equal(world.isShown('palette'), true);
  world.advance(51);
  assert.equal(isHidden(world, 'palette'), true);
});

test('hiding twice replaces the pending hide instead of stacking waits', () => {
  const world = warmWorld();
  world.showConfirm();
  const host = world.host('confirm');
  world.hideConfirm();
  world.hideConfirm();
  assert.equal(host.listenerCount(), 2, 'one wait: its transitionend and animationend listeners');
  world.advance(10_000);
  assert.equal(isHidden(world, 'confirm'), true);
  assert.equal(host.listenerCount(), 0);
});

test('the address bar re-open during its fade keeps it shown', () => {
  const world = warmWorld();
  world.showAddrbar('current');
  const host = world.host('addrbar');
  world.hideAddrbar();
  world.advance(100);
  world.showAddrbar('current');
  world.advance(10_000);
  assert.equal(host.style.display, 'flex');
  assert.equal(host.hasAttribute('hidden'), false);
});

// ─── Anchored placement ─────────────────────────────────────────────────────

function placementWorld({ browser, shell }) {
  const sandbox = {
    Math,
    Number,
    document: {
      getElementById: (id) => ({
        getBoundingClientRect: () => (id === 'browser' ? browser : shell),
      }),
    },
  };
  const names = [
    'ADDRBAR_POPUP_WIDTH_PX',
    'ADDRBAR_POPUP_HEIGHT_PX',
    'ADDRBAR_ANCHORED_POPUP_WIDTH_PX',
    'ADDRBAR_ANCHORED_POPUP_HEIGHT_PX',
    'ADDRBAR_ANCHOR_MARGIN_PX',
  ];
  const script = `"use strict";
    ${names.map(extractConst).join('\n')}
    ${['readAddrbarAnchorNumber', 'roundAddrbarPx', 'computeAddrbarAnchoredPlacement']
      .map(extractFunction)
      .join('\n')}
    ({ computeAddrbarAnchoredPlacement });`;
  return vm.runInNewContext(script, sandbox, { filename: 'bento-shell-mount.js#placement' });
}

test('the anchored popup shares the row top-left corner and grows right and down', () => {
  const { computeAddrbarAnchoredPlacement } = placementWorld({
    browser: { left: 0, top: 80, width: 1400, height: 900 },
    shell: { left: 0, top: 80 },
  });
  // A row at x 6, y 40 in the shell: 240 x 32.
  const placement = plain(
    computeAddrbarAnchoredPlacement({ left: 6, top: 40, width: 240, height: 32 }),
  );
  assert.deepEqual(placement, {
    left: 6,
    top: 40,
    width: 512,
    height: 378,
    anchorWidth: 240,
    anchorHeight: 32,
  });
});

test("the popup's CSS margin at the window's right and bottom is chrome's placement margin", () => {
  const tokens = fs.readFileSync(
    path.join(ROOT, 'extensions/bento-shell/src/theme/bento-tokens.css'),
    'utf8',
  );
  const rem = /--bento-address-bar-anchor-margin:\s*([\d.]+)rem;/.exec(tokens)?.[1];
  assert.ok(rem, 'the token is missing');
  const { ADDRBAR_ANCHOR_MARGIN_PX } = vm.runInNewContext(
    `${extractConst('ADDRBAR_ANCHOR_MARGIN_PX')}\n({ ADDRBAR_ANCHOR_MARGIN_PX })`,
  );
  assert.equal(Number(rem) * 16, ADDRBAR_ANCHOR_MARGIN_PX);
});

test('the anchored popup keeps the row corner unless the row is outside the window', () => {
  const { computeAddrbarAnchoredPlacement } = placementWorld({
    browser: { left: 0, top: 0, width: 600, height: 500 },
    shell: { left: 0, top: 0 },
  });
  const near = plain(computeAddrbarAnchoredPlacement({ left: 4, top: 2, width: 240, height: 32 }));
  assert.equal(near.left, 4, 'a row inside the 12 px margin is not pushed in');
  assert.equal(near.top, 2);

  const outside = plain(
    computeAddrbarAnchoredPlacement({ left: -50, top: 700, width: 240, height: 32 }),
  );
  assert.equal(outside.left, 0);
  assert.equal(outside.top, 468);
  assert.equal(outside.height, 180, 'the popup keeps a usable minimum height');
});
