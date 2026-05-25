/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mounts two chrome <browser> elements that host bento-shell extension
// pages:
//   - bento-shell-frame   — the always-visible vertical sidebar (index.html)
//   - bento-palette-frame — the on-demand command palette overlay
//                           (palette.html), shown via Cmd/Ctrl+Alt+P
//
// extensions.webextensions.uuids is not honored for built-in addons, so we
// can't pin URLs at build time — WebExtensionPolicy.getByID resolves the
// per-profile UUID at runtime. Loaded via
//   <script src="chrome://browser/content/bento-shell-mount.js"/>
// from browser-box.inc.xhtml (external file because the chrome doc's meta
// CSP forbids inline scripts).

(function () {
  // Guard against double-initialization. Chrome scripts included from a
  // patched .inc.xhtml can sometimes execute more than once per window
  // (browser.xhtml include processing, addon-reload re-eval, etc.).
  // Attaching the keydown listener twice = each press toggles palette
  // open then immediately closed.
  if (window.__bentoShellMountInitialized) return;
  window.__bentoShellMountInitialized = true;

  const ADDON_ID = 'bento-shell@bento.app';

  // Mirror the synced/unsynced flag from BrowserWindowTracker.openWindow
  // (set on `window._bentoStartupSyncFlag` by patches/window-sync/01-...)
  // onto documentElement as a chrome-attribute so it's:
  //   1. Observable in the Browser Toolbox (Phase B verification step).
  //   2. Available to CSS for chrome differentiation if needed later.
  //   3. Read by Phase C's BentoWindowSync to decide whether to attach
  //      its event listeners to this window.
  // Default to "synced" when the flag is missing (e.g. the very first
  // window opened at startup before BrowserWindowTracker's openWindow has
  // run — Firefox itself creates that one) so the master pref's "synced
  // by default" stance still applies.
  (() => {
    const flag = window._bentoStartupSyncFlag === 'unsynced' ? 'unsynced' : 'synced';
    if (flag === 'synced') {
      document.documentElement.setAttribute('bento-synced-window', 'true');
    } else {
      document.documentElement.setAttribute('bento-unsynced-window', 'true');
    }
  })();

  // Cmd+Shift+Alt+N (macOS) / Ctrl+Shift+Alt+N (others) → open a new
  // UNSYNCED window. Bound via capture-phase listener on window so we
  // intercept the event BEFORE Firefox's XUL <key> element bindings get
  // a chance — XUL <key> matching is sometimes lax about extra
  // modifiers, so Cmd+Shift+Alt+N can accidentally trigger
  // key_privatebrowsing (Cmd+Shift+N) or even key_newNavigator (Cmd+N)
  // depending on the Firefox version's matching rules. preventDefault +
  // stopImmediatePropagation in the capture phase aborts the chain
  // before chrome <key>-derived handlers fire. The default Cmd+N path
  // continues to go through OpenBrowserWindow() with no explicit
  // bentoSyncedWindow option (→ synced via the openWindow default).
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || !e.shiftKey) return;
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.code !== 'KeyN') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      try {
        if (typeof window.OpenBrowserWindow === 'function') {
          window.OpenBrowserWindow({ bentoSyncedWindow: false });
        } else {
          console.warn(
            '[bento-shell-mount] OpenBrowserWindow not defined — cannot open unsynced window',
          );
        }
      } catch (err) {
        console.warn('[bento-shell-mount] cmd_bentoNewNavigatorUnsynced failed:', err);
      }
    },
    true /* capture */,
  );

  // Tale UI design tokens for chrome. The token CSS is generated from
  // tale-ui source by scripts/generate-chrome-tokens.mjs (runs as part
  // of `pnpm run import`) and registered in chrome via patches/chrome-
  // layout/01-bento-shell-mount.patch's jar.mn entry. Loading it as a
  // <link> stylesheet exposes Tale UI's variable cascade on the chrome
  // <window>'s :root, so chrome inline styles can use `var(--color-60)`,
  // `var(--neutral-90)`, `var(--radius-m)`, etc. — auto-themable via
  // future Scale-app-driven theme files, auto-flipping with the OS
  // color scheme via Tale UI's _color-modes.css cascade.
  //
  // We keep `var()` references (no manual hex constants) so any change
  // to Tale UI's primitives flows in on the next import without anyone
  // touching this file.
  function injectChromeTokens() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'chrome://browser/content/bento-chrome-tokens.css';
    document.documentElement.appendChild(link);
  }
  injectChromeTokens();

  // Map Firefox's chrome color variables (--toolbar-bgcolor,
  // --toolbar-field-background-color, --toolbox-textcolor, etc.) to
  // Tale UI tokens so the visible chrome (toolbar, URL bar, titlebar)
  // re-themes from the same source as the rest of Bento. Loaded AFTER
  // tokens so the var() references it makes resolve. See the file
  // header at chrome://browser/content/bento-chrome-theme.css for the
  // coverage list — visible chrome only; menus, popups, scrollbars,
  // devtools chrome stay on Firefox defaults until iterated.
  function injectChromeTheme() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'chrome://browser/content/bento-chrome-theme.css';
    document.documentElement.appendChild(link);
  }
  injectChromeTheme();

  function resolveChromeToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function syncArrowPanelTheme(panel) {
    if (!panel || panel.localName !== 'panel' || panel.getAttribute('type') !== 'arrow') return;

    const background = resolveChromeToken('--neutral-10');
    const color = resolveChromeToken('--neutral-90');
    const borderColor = resolveChromeToken('--neutral-20');
    const radius = resolveChromeToken('--radius-l');

    if (background) panel.style.setProperty('--panel-background', background, 'important');
    if (color) panel.style.setProperty('--panel-color', color, 'important');
    if (borderColor) panel.style.setProperty('--panel-border-color', borderColor, 'important');
    if (radius) panel.style.setProperty('--panel-border-radius', radius, 'important');
  }

  function syncArrowPanelsTheme() {
    for (const panel of document.querySelectorAll('panel[type="arrow"]')) {
      syncArrowPanelTheme(panel);
    }
  }

  document.addEventListener(
    'popupshowing',
    (event) => {
      syncArrowPanelTheme(event.target);
    },
    true,
  );
  requestAnimationFrame(syncArrowPanelsTheme);

  // Inject layout-shape CSS that depends on the tokens above. Kept in
  // a runtime-injected <style> rather than a static file because the
  // .browserContainer class only exists on per-tab elements created
  // dynamically by tabbrowser — a CSS rule applies forever, no need to
  // hook tab creation.
  function injectChromeStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* Consistent chrome gaps. The single source of truth for the
         spacing between a panel and the window edge / address bar /
         neighbour panel. All margins, padding, and splitter widths
         that contribute to chrome rhythm reference this:
           --space-2xs ≈ 6.4px at 62.5%-root rendering
         The chrome-tokens generator (scripts/generate-chrome-tokens.mjs)
         pulls Tale UI's spacing tokens into chrome, so --space-2xs is
         defined here just like it is in the bento-shell extension. */

      /* Inline sidebar: no padding around the frame, no rounded
         corners on the frame. Edges flush with the window so the
         sidebar reads as part of the chrome rather than a floating
         card. Position + z-index make the sidebar host the paint mask
         for panel-shadow overflow from the strip to its right; its
         background is the same chrome surface, so the mask is visually
         identical to chrome UI rather than a separate sidebar fill. */
      #bento-shell-host {
        padding: 0;
        position: relative;
        z-index: 2;
      }
      #bento-shell-host > #bento-shell-frame {
        border-radius: 0;
      }
      /* Sidebar splitter: zero NET layout width (so panel strip sits
         flush against the sidebar), but a wider invisible hit area
         centered on the boundary so users can still grab + drag to
         resize. Achieved with width:8px + margin-inline:-4px — the
         8px element box renders, but the negative margins cancel
         out its layout width to 0. Position: relative + z-index so
         the hit area paints above adjacent flex siblings (sidebar
         to the left, strip-container to the right) — without it,
         later-painted siblings would absorb the pointer events.
         !important needed for width + min-width because XUL chrome
         CSS sets defaults for <splitter> that win otherwise. */
      /* Remove the chrome-content separator line under the URL bar.
         Firefox's content-area.css applies
           #navigator-toolbox { border-bottom: 0.01px solid ... }
         which renders as a 1px hairline between the toolbar and the
         content area. Bento wants the panels flush against the URL
         bar (no separator); zero the border style here. */
      #navigator-toolbox {
        border-bottom-style: none !important;
      }
      #bento-shell-splitter {
        width: 8px !important;
        min-width: 0 !important;
        margin-inline: -4px;
        background-color: transparent;
        position: relative;
        z-index: 3;
      }

      /* Sidebar dimensions. The chrome patch ships inline
         'min-width: 200px; max-width: 600px' on #bento-shell-host
         (so the sidebar still renders sensibly if our stylesheet
         hasn't loaded yet); we override both via !important here
         from --bento-tab-strip-width-min/-max so the bounds become
         tunable from bento-tokens.css without a patch rebuild.
         Collapsed pins width/min/max to --bento-tab-strip-width-
         collapsed and hides the splitter — there's nothing to
         resize when the rail is at its minimum. The width
         transition makes the collapse/expand toggle feel animated
         rather than snapping. */
      #bento-shell-host {
        min-width: var(--bento-tab-strip-width-min) !important;
        max-width: var(--bento-tab-strip-width-max) !important;
        transition:
          width 200ms var(--bento-easing-standard, ease),
          min-width 200ms var(--bento-easing-standard, ease),
          max-width 200ms var(--bento-easing-standard, ease);
      }
      #bento-shell-host.bento-sidebar-collapsed {
        min-width: var(--bento-tab-strip-width-collapsed) !important;
        max-width: var(--bento-tab-strip-width-collapsed) !important;
        width: var(--bento-tab-strip-width-collapsed) !important;
      }
      #bento-shell-splitter.bento-sidebar-collapsed {
        /* visibility:hidden (NOT display:none) so the splitter still
           occupies its var(--space-2xs) width — that's what creates
           the visible gap between the sidebar and the main content
           slot. Without the reserved width, the gap collapses to 0
           and the rail looks pasted against the panel area. The
           hidden splitter remains non-interactive (can't be dragged
           — there's nothing to resize when the rail is at its
           minimum) which is the same behaviour display:none gave us
           on the interaction front. */
        visibility: hidden;
      }

      /* Bento panel rounded corners. overflow:clip so each remote
         <browser>'s rendered content (and the panel header sitting
         above it) are visually clipped to the rounded shape.
         - .browserContainer = the per-tab content area inside the main
           tab panel (one per browser tab in tabbrowser-tabbox).
         - [data-bento-panel-tab-id] = each side-panel vbox in the strip.
         - [data-bento-main-panel] = #tabbrowser-tabbox after we move
           it into the strip — gets the same rounded-corner / clip
           treatment so it visually matches the side panels.
         The strip itself uses overflow-x:auto for horizontal scrolling
         so we can't put overflow:clip on the strip. */
      .browserContainer,
      #bento-side-panel-host > [data-bento-panel-tab-id],
      #bento-side-panel-host > [data-bento-main-panel] {
        border-radius: var(--radius-m);
        overflow: clip;
      }

      /* Strip layout. Once unifyMainWithStrip() has moved
         #tabbrowser-tabbox in, the strip IS the entire content area
         right of the sidebar — main panel + side panels + Add-panel
         trailer in one horizontal scroll context. Symmetric padding
         on all four edges (the left edge is invisible because the
         sidebar-splitter sits there providing the same gap). The
         native horizontal scrollbar renders inside the bottom padding
         when overflow happens. */
      /* The strip is wrapped in a vbox container by setupPanelNavigator
         so we can place the navigator bar immediately below it. The
         strip itself is still horizontally scrollable but the native
         scrollbar is hidden — the navigator IS the visible scroll
         affordance (favicons + cycle buttons + active marker). */
      #bento-strip-container {
        display: flex;
        flex-direction: column;
        flex: 1 1 0%;
        min-width: 0;
        /* position: relative so per-panel .bento-panel-shadow proxy
           elements (children of this container — see syncPanelShadows)
           anchor to the strip-container's coordinate system. They
           live HERE, not inside #bento-side-panel-host, because the
           host has overflow-x:scroll which forces overflow-y:auto and
           clips shadow extension downward into the scrollbar / nav
           rows. The container has no overflow, so shadow can extend
           past the host into the lower area.
           Keep overflow visible so the first panel/main-slot shadow can
           bleed left into the chrome background beside the sidebar.
           The sidebar itself stays in normal layout flow, so the actual
           panel bodies still start at the strip edge; only the shadow
           proxy paint extends past it. */
        position: relative;
        z-index: 1;
        overflow: visible;
      }
      /* Workspace-switch fade. Applied as a class toggle to BOTH the
         split-view panel deck (#tabbrowser-tabpanels — Firefox-native,
         holds the main browser AND the side-panel browsers) AND the
         strip container (favicon navigator + custom scrollbar). They
         live in separate parts of the chrome tree so the only way to
         crossfade everything visible in one motion is to drive both
         with the same class. The visible transition is opacity-only;
         layout transitions on strip descendants are suppressed during
         the swap so reconcile writes land without visible motion.
         performWorkspaceSwitchFade also sets a swapping flag that
         suppresses in-reconcile animations (main-width transition,
         scroll-to-main smooth scroll, favicon nav enter/leave width
         transitions) so the user sees a STATIC fade — no panel
         sliding into place during fade-in. */
      #tabbrowser-tabpanels,
      #bento-strip-container {
        transition: opacity var(--bento-duration-fast, 140ms)
          var(--bento-easing-snappy, cubic-bezier(0.32, 0.72, 0, 1));
      }
      #tabbrowser-tabpanels.bento-workspace-switching,
      #bento-strip-container.bento-workspace-switching {
        opacity: 0;
      }
      /* Suppress layout transitions while the workspace strip is being
         swapped and while it fades back in. The opacity transition is
         our only workspace-switch animation; width/flex/transform
         transitions on panel containers or the favicon nav can restart
         when the fade class is removed, which reads as panels sliding
         behind the fade-in. Keep this scoped to Bento-owned strip
         structure rather than all descendants: broad animation
         suppression can break Firefox's internal browser painting. */
      #tabbrowser-tabpanels.bento-workspace-stabilizing > .split-view-panel-active,
      #tabbrowser-tabpanels.bento-workspace-stabilizing > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-workspace-stabilizing > [data-bento-panel-tab-id],
      #tabbrowser-tabpanels.bento-workspace-stabilizing > .split-view-splitter,
      #tabbrowser-tabpanels.bento-workspace-switching > .split-view-panel-active,
      #tabbrowser-tabpanels.bento-workspace-switching > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-workspace-switching > [data-bento-panel-tab-id],
      #tabbrowser-tabpanels.bento-workspace-switching > .split-view-splitter,
      #bento-strip-container.bento-workspace-stabilizing .bento-panel-nav__icon,
      #bento-strip-container.bento-workspace-stabilizing .bento-panel-nav__list,
      #bento-strip-container.bento-workspace-switching .bento-panel-nav__icon,
      #bento-strip-container.bento-workspace-switching .bento-panel-nav__list {
        transition: none !important;
      }
      @media (prefers-reduced-motion: reduce) {
        #tabbrowser-tabpanels,
        #bento-strip-container {
          transition: none;
        }
      }
      #bento-side-panel-host {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        overflow-x: scroll;
        overflow-y: hidden;
        border-radius: var(--radius-m);
        clip-path: inset(0 0 var(--space-2xs) 0 round var(--radius-m));
        padding-block-end: var(--space-2xs);
        padding-right: var(--space-2xs);
        gap: 0;
        flex: 1 1 auto;
        min-height: 0;
        /* position: relative so the absolute-positioned inter-panel
           splitters (children of this host — see syncInterPanelSplitters)
           anchor to the strip rather than scroll out of sync with some
           non-static ancestor. */
        position: relative;
        /* Native scrollbar hidden — replaced by the custom always-on
           scrollbar below. macOS auto-hides native scrollbars after a
           moment regardless of CSS, which conflicts with the user's
           "always visible" requirement. */
        scrollbar-width: none;
      }
      #bento-side-panel-host::-webkit-scrollbar {
        display: none;
      }
      #bento-strip-container.bento-no-side-panels > #bento-panel-nav,
      #bento-strip-container.bento-no-side-panels > #bento-strip-scrollbar {
        display: none !important;
      }
      #bento-strip-container.bento-no-side-panels > #bento-side-panel-host {
        overflow-x: hidden;
        padding-right: var(--space-2xs);
      }

      /* Custom always-visible horizontal scrollbar. Sits between the
         panel strip and the favicon navigator. Track + thumb both
         drawn from neutral tokens; thumb uses the workspace accent
         while being dragged so the user knows it's active. */
      #bento-strip-scrollbar {
        flex: 0 0 auto;
        height: var(--bento-scrollbar-thickness);
        margin: 0 var(--space-2xs) var(--space-3xs);
        position: relative;
        /* No track bg — the scrollbar sits in the row below the
           panels where .bento-panel-shadow proxies extend their
           drop shadow downward. An opaque track here would cover
           that shadow extension. The thumb has its own bg, so the
           scrollbar remains usable as a floating-thumb scrollbar. */
        border-radius: var(--bento-scrollbar-radius);
        cursor: pointer;
      }
      .bento-strip-scrollbar__thumb {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        min-width: var(--bento-scrollbar-thumb-min-width);
        background-color: var(--neutral-30);
        border-radius: var(--bento-scrollbar-radius);
        cursor: grab;
        transition: background-color var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-strip-scrollbar__thumb:hover {
        background-color: var(--neutral-50);
      }
      .bento-strip-scrollbar__thumb--dragging,
      .bento-strip-scrollbar__thumb--dragging:hover {
        background-color: var(--color-60);
        cursor: grabbing;
      }

      /* Panel navigator bar. Sits at the bottom of the strip area.
         [◀] [favicon] [favicon] [favicon] [▶]
         Active item (whichever panel is currently leftmost in the
         strip) gets the accent border + tinted background. */
      #bento-panel-nav {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-2xs);
        padding: var(--space-2xs);
        flex: 0 0 auto;
      }
      .bento-panel-nav__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--bento-control-size-sm);
        height: var(--bento-control-size-sm);
        padding: 0;
        background: transparent;
        border: none;
        border-radius: var(--radius-s);
        color: var(--neutral-70);
        cursor: pointer;
        flex: 0 0 auto;
        transition:
          background-color var(--bento-duration-fast) var(--bento-easing-standard),
          color var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-panel-nav__btn:hover {
        background-color: var(--neutral-16);
        color: var(--neutral-90);
      }
      .bento-panel-nav__btn > svg {
        width: var(--bento-icon-size-xs);
        height: var(--bento-icon-size-xs);
        pointer-events: none;
      }
      .bento-panel-nav__list {
        /* flex: 0 1 auto — only take as much width as the favicons
           need. The next button then sits immediately after the last
           favicon instead of being pushed to the right edge of the
           strip by a flex-grow on the list. With many panels the list
           shrinks to fit (min-width: 0) and scrolls internally. */
        flex: 0 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: var(--space-3xs);
        overflow-x: auto;
        scrollbar-width: none;
      }
      .bento-panel-nav__list::-webkit-scrollbar {
        display: none;
      }
      .bento-panel-nav__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--bento-control-size-sm);
        height: var(--bento-control-size-sm);
        padding: var(--space-3xs);
        background: transparent;
        border: var(--bento-border-hairline) solid transparent;
        border-radius: var(--radius-s);
        cursor: pointer;
        flex: 0 0 auto;
        position: relative;
        overflow: hidden;
        /* Active-marker transition uses --bento-duration-base (200ms)
           — visible fade as the user navigates, but quick enough not
           to feel laggy.
           width + padding + margin transitions drive the enter/leave
           animation when refreshPanelNav adds or removes favicons:
           a new icon starts at the --entering state (width 0) and
           transitions to its natural width on the next frame; a
           removed icon gets --leaving (width 0) and is yanked from
           the DOM after the transition. The flex parent's flex:0 0
           auto means its own width follows the sum of its children's
           transitioning widths — so the nav row grows / shrinks
           smoothly without needing its own width transition. */
        transition:
          width var(--bento-duration-base) var(--bento-easing-standard),
          padding var(--bento-duration-base) var(--bento-easing-standard),
          margin var(--bento-duration-base) var(--bento-easing-standard),
          opacity var(--bento-duration-base) var(--bento-easing-standard),
          background-color var(--bento-duration-base) var(--bento-easing-standard),
          border-color var(--bento-duration-base) var(--bento-easing-standard);
      }
      .bento-panel-nav__icon:hover {
        background-color: var(--neutral-16);
        border-color: var(--neutral-30);
        transform: translateY(-1px);
      }
      .bento-panel-nav__icon--active {
        border-color: var(--color-60);
        background-color: var(--color-3);
      }
      /* Enter / leave states. width:0 + 0 padding makes the favicon
         collapse to 0 layout space; transition above interpolates
         back to natural. opacity smooths the fade. !important so
         drag/hover state overrides during animation don't reopen the
         button mid-flight. */
      .bento-panel-nav__icon--entering,
      .bento-panel-nav__icon--leaving {
        width: 0 !important;
        padding-inline: 0 !important;
        margin-inline-start: calc(-1 * var(--space-3xs));
        opacity: 0;
      }
      .bento-panel-nav__icon > img {
        width: var(--bento-icon-size-sm);
        height: var(--bento-icon-size-sm);
        display: block;
        /* Make the favicon image pointer-transparent so pointerdown is
           always reported with the button as the target — keeps the
           drag-handler's setPointerCapture(btn) coherent regardless of
           whether the user pressed on the favicon or the button padding. */
        pointer-events: none;
      }
      .bento-panel-nav__icon--placeholder::before {
        content: '';
        position: absolute;
        inset: var(--space-3xs);
        border-radius: 50%;
        background-color: var(--neutral-30);
      }
      /* Drag-to-reorder states. Side-panel buttons (those with a tabId)
         show grab cursor on idle. While a drag is active the source
         button dims + scales down, the body cursor switches to grabbing
         (set on the list element so it covers the whole strip), and a
         drop indicator marks the prospective insertion point. */
      .bento-panel-nav__icon[data-bento-nav-draggable] {
        cursor: grab;
      }
      .bento-panel-nav__list--dragging {
        cursor: grabbing;
      }
      .bento-panel-nav__list--dragging .bento-panel-nav__icon[data-bento-nav-draggable] {
        cursor: grabbing;
      }
      .bento-panel-nav__icon--dragging {
        opacity: 0.45;
        transform: scale(0.92);
        transition:
          opacity var(--bento-duration-fast) var(--bento-easing-standard),
          transform var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-panel-nav__icon--dragging:hover {
        background-color: transparent;
        border-color: transparent;
        transform: scale(0.92);
      }
      /* Insertion indicator. Absolutely positioned overlay over the list
         (NOT a flex child) so painting it never reflows siblings — that
         would shift their bounding rects, which would feed back into the
         next pointermove's slot calculation and oscillate. Top/bottom
         pinned to span the full nav row height; X is set imperatively
         per pointermove. */
      .bento-panel-nav__list {
        position: relative;
      }
      .bento-panel-nav__drop-indicator {
        position: absolute;
        top: 0;
        bottom: 0;
        width: var(--bento-focus-ring-width);
        background-color: var(--color-60);
        border-radius: var(--bento-focus-ring-width);
        pointer-events: none;
        z-index: 1;
        animation: bento-nav-drop-fade-in var(--bento-duration-fast)
          var(--bento-easing-standard);
      }
      @keyframes bento-nav-drop-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      .bento-panel-nav-menu {
        position: fixed;
        z-index: 100000;
        min-width: 150px;
        padding: var(--space-3xs);
        background-color: var(--neutral-5);
        border: var(--bento-border-hairline) solid var(--neutral-20);
        border-radius: var(--radius-s);
        box-shadow: var(--shadow-lg);
      }
      .bento-panel-nav-menu__item {
        display: flex;
        align-items: center;
        width: 100%;
        min-height: var(--bento-control-size-sm);
        padding: 0 var(--space-2xs);
        background-color: var(--neutral-5);
        border: none;
        border-radius: var(--radius-s);
        color: var(--neutral-90);
        cursor: pointer;
        font: inherit;
        font-size: var(--font-s);
        text-align: left;
      }
      .bento-panel-nav-menu__item:hover {
        background-color: var(--neutral-10);
      }
      /* Hide the kebab 'more' button on the main panel — the menu's
         current contents (custom panel sizes) only apply to side
         panels, which use panel/setWidth. The main slot has its own
         shared-across-workspaces width (panel/setMainWidth) and gets
         resized via the main splitter instead.

         CRITICAL: scope via direct-child > to the panel header,
         because BOTH #tabbrowser-tabbox (the deck, marked by
         unifyMainWithStrip) AND the active-tab notificationbox carry
         data-bento-main-panel. A bare descendant selector matches
         the deck and hides the kebab on EVERY panel header,
         including side panels. The header is a direct child of its
         notificationbox; the deck has notificationboxes (not
         headers) as direct children, so '> .bento-panel-header'
         only matches when the marked element IS the main panel
         notificationbox. */
      [data-bento-main-panel] > .bento-panel-header .bento-panel-header-button--more {
        display: none;
      }

      /* The main panel (moved tabbrowser-tabbox). flex-grow:1 so it
         fills remaining space when no side panels exist; flex-basis:
         0 + min-width keeps it from collapsing under the panels.
         Inside, the existing tabbox renders the active tab's browser
         as before — moving the host element doesn't change its
         internal layout. */
      #bento-side-panel-host > [data-bento-main-panel] {
        display: flex;
        flex-direction: column;
        flex: 1 1 0%;
        min-width: var(--bento-main-panel-min-width);
      }

      /* Each side panel: column-flex of [header, browser]. flex stays
         at 0 0 auto so Firefox's native split-view splitter resize
         updates take effect against the sibling width. */
      #bento-side-panel-host > [data-bento-panel-tab-id] {
        display: flex;
        flex-direction: column;
        flex: 0 0 auto;
        min-width: var(--bento-panel-min-width);
        background-color: var(--neutral-5);
      }
      /* Close-panel fade-shrink animation. Width transitions
         smoothly so adjacent panels (and the per-pair splitters
         tracked via ResizeObserver) shift in real time as the
         panel collapses, instead of snapping to the new layout
         after the fade finishes. !important + min-width: 0
         overrides Firefox's split-view min-width that would
         otherwise refuse to let the panel shrink past its
         configured floor. */
      .bento-panel--removing {
        pointer-events: none;
        opacity: 0;
        transform: scale(0.95);
        min-width: 0 !important;
        max-width: 0 !important;
        width: 0 !important;
        flex: 0 0 0 !important;
        margin: 0 !important;
        transition:
          opacity 120ms var(--bento-easing-standard),
          transform 180ms var(--bento-easing-standard),
          min-width 180ms var(--bento-easing-standard),
          max-width 180ms var(--bento-easing-standard),
          width 180ms var(--bento-easing-standard),
          flex-basis 180ms var(--bento-easing-standard),
          margin 180ms var(--bento-easing-standard);
      }

      /* Panel containers are positioned for drag/focus bookkeeping, but
         do not paint their own frame. The splitters and optional shadow
         proxies provide separation without outlining every slot. */
      #bento-side-panel-host > [data-bento-main-panel],
      #bento-side-panel-host > [data-bento-panel-tab-id] {
        position: relative;
      }
      /* Suppress Firefox's default :focus outline on the panel
         containers. They have tabindex="-1" so they're focusable;
         when the user clicks into content the chrome focus path
         walks through the container and Firefox would otherwise
         paint a persistent default focus outline (rgb(251,251,254)
         3px, reads as a cool/cyan ring against dark backgrounds)
         that we don't own. !important is required because
         Firefox's chrome stylesheet sets the outline at high
         specificity. The cycle ring (.bento-panel--cycle-focused
         ::after below) is the only focus indicator we want. */
      [data-bento-main-panel],
      [data-bento-main-panel]:focus,
      [data-bento-main-panel]:focus-within,
      [data-bento-panel-tab-id],
      [data-bento-panel-tab-id]:focus,
      [data-bento-panel-tab-id]:focus-within {
        outline: none !important;
      }
      /* Firefox's content-area.css paints "outline: var(--focus-outline)"
         on the ".deck-selected > .browserContainer" of every split-view
         panel — that's where the cyan focus ring around the active tab's
         main slot was actually coming from (NOT the tabbrowser-tabbox
         itself, which we already neutralised above). Suppress it across
         all split-view panel browserContainers; the .bento-panel--cycle-
         focused ::after ring is the only focus indicator we want. */
      #tabbrowser-tabpanels[splitview] .browserContainer {
        outline: none !important;
      }
      #bento-side-panel-host > [data-bento-main-panel]::after,
      #bento-side-panel-host > [data-bento-panel-tab-id]::after {
        content: '';
        position: absolute;
        inset: 0;
        border: var(--bento-focus-ring-width) solid transparent;
        border-radius: var(--radius-m);
        pointer-events: none;
        z-index: 10;
        box-sizing: border-box;
        transition: border-color var(--bento-duration-slow) var(--bento-easing-standard);
      }
      #bento-side-panel-host > .bento-panel--focused::after,
      #bento-side-panel-host > .bento-panel--cycle-focused::after {
        border-color: var(--color-60);
      }
      #bento-side-panel-host > [data-bento-panel-tab-id] > browser {
        flex: 1 1 auto;
        min-height: 0;
      }

      /* Per-panel header: compact urlbar (back/fwd/reload, URL input,
         star). All sizing via Bento/Tale UI tokens — no raw values. */
      .bento-panel-header {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: var(--space-3xs);
        padding: var(--space-3xs) var(--space-2xs);
        background-color: var(--neutral-16);
        border-bottom: var(--bento-border-hairline) solid var(--neutral-16);
        flex: 0 0 auto;
        min-height: var(--bento-panel-header-height);
        box-sizing: border-box;
      }
      /* Header controls — drag handle (leftmost), back / forward /
         reload, then star / close / more on the right. All share the
         same 24×24 icon-button shape, default colour, hover, focus,
         and icon size; only the cursor and "engaged" state vary by
         role (grab/grabbing on the drag handle, filled-icon on the
         bookmark star). This shared rule is the single source of
         truth — per-element rules below override only the bits that
         genuinely differ. */
      .bento-panel-header-drag-handle,
      .bento-panel-header-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--bento-control-size-sm);
        height: var(--bento-control-size-sm);
        padding: 0;
        background-color: transparent;
        border: none;
        border-radius: var(--radius-s);
        color: var(--neutral-70);
        cursor: pointer;
        flex: 0 0 auto;
        transition:
          background-color var(--bento-duration-fast) var(--bento-easing-standard),
          color var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-panel-header-drag-handle > svg,
      .bento-panel-header-button > svg {
        width: var(--bento-icon-size-xs);
        height: var(--bento-icon-size-xs);
        pointer-events: none;
      }
      /* Dot-pattern icons (grip-vertical on the drag handle,
         more-vertical on the kebab) render each dot as the round
         cap of a zero-length stroke segment, so the dot diameter
         equals stroke-width. At stroke-width 2 in a 24-unit
         viewBox displayed at 14px, each dot is only ~1.17px —
         a fraction of the ink the continuous-stroke icons put
         on screen (chevrons, refresh, star, close), so the dot
         icons read as "disabled" even at the same currentColor.
         Bumping the stroke compensates so all header icons hit
         the same optical weight. */
      .bento-panel-header-drag-handle > svg,
      .bento-panel-header-button--more > svg {
        stroke-width: 3.5;
      }
      .bento-panel-header-drag-handle:hover,
      .bento-panel-header-button:hover:not([disabled]) {
        background-color: var(--neutral-16);
        color: var(--neutral-90);
      }
      .bento-panel-header-drag-handle:focus-visible,
      .bento-panel-header-button:focus-visible {
        outline: var(--bento-focus-ring-width) solid var(--color-60);
        outline-offset: -1px;
      }
      .bento-panel-header-button[disabled] {
        opacity: 0.4;
        cursor: default;
      }
      /* Drag handle: behaves as a button (role='button') but is
         operated by pointer drag, not click — override the default
         pointer cursor with grab / grabbing. */
      .bento-panel-header-drag-handle {
        cursor: grab;
        touch-action: none;
      }
      .bento-panel-header-drag-handle--dragging {
        cursor: grabbing;
        background-color: var(--neutral-16);
        color: var(--color-60);
      }
      /* Bookmark star: filled outline when the current URL is in
         the bookmarks DB. Fill uses currentColor so the icon picks
         up whatever default / hover colour the shared rule sets. */
      .bento-panel-header-button--active > svg {
        fill: currentColor;
      }
      /* Dragging state for the panel container — slight opacity
         dip + subtle shadow so the floating panel reads as
         'lifted off the strip'. */
      .bento-panel--dragging {
        opacity: 0.85;
      }
      .bento-panel-drop-indicator {
        background-color: var(--color-60);
        border-radius: 1.5px;
        pointer-events: none;
      }
      .bento-panel-header-url {
        flex: 1 1 auto;
        min-width: 0;
        height: var(--bento-control-size-sm);
        padding: 0 var(--space-2xs);
        background-color: var(--neutral-5);
        border: var(--bento-border-hairline) solid transparent;
        border-radius: var(--radius-s);
        color: var(--neutral-90);
        font-size: var(--font-s);
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
      }
      .bento-panel-header-url:focus {
        background-color: var(--neutral-5);
        border-color: var(--color-60);
      }
      .bento-panel-header-url::placeholder {
        color: var(--neutral-50);
      }

      /* ─── Native split-view panel layout ──────────────────────────────
         Activated when reconcilePanelsSplitView adds .bento-split-active
         to #tabbrowser-tabpanels and sets the [splitview] attribute via
         the BENTO_SPLIT_SENTINEL → setSplitViewActive() chain.

         Each active panel is a <hbox class="browserSidebarContainer
         split-view-panel split-view-panel-active">. By default that
         hbox lays out children horizontally — which makes our injected
         per-panel header sit to the LEFT of the <browser>, splitting
         the panel's width in half. Override flex-direction so children
         stack vertically: header on top, browser fills the rest. */
      /* When the combined min-width of all panels exceeds the viewport
         width (typical at 4+ panels on a narrow window), the deck must
         scroll horizontally instead of overflowing off-screen. flex-
         shrink: 0 on each panel keeps them at their min-width — without
         it, flex would shrink them past min-width and squash content
         until the panels are unusable. */
      #tabbrowser-tabpanels.bento-split-active {
        /* No background fill — chrome bg shows through directly so
           there's no surface discrepancy. Panels are cards lifted
           via box-shadow over that same chrome bg.
           display:flex + gap:var(--space-2xs) is the single source of
           truth for inter-panel spacing — Firefox's content-area.css
           sets margin-left: 5px on .split-view-panel-active children
           with higher specificity than our previous margin attempt,
           so flex gap (which the spec explicitly says doesn't
           collide with margin) is the cleaner override.
           No padding-inline-start: the first panel sits flush against
           the sidebar (sidebar-splitter is width:0). The padding was
           originally there to give panel box-shadow clearance, but
           shadows are now rendered by .bento-panel-shadow proxies in
           #bento-strip-container, so it's no longer needed. The right
           padding is still reserved for the Add-panel trailer's slot
           via padding-inline-end. */
        display: flex;
        flex-direction: row;
        align-items: stretch;
        gap: var(--space-2xs);
        overflow-x: scroll;
        overflow-y: hidden;
        /* Hide tabpanels' native horizontal scrollbar — the custom
           always-visible #bento-strip-scrollbar in the sidebar drives
           tabpanels.scrollLeft and is positioned next to the favicon
           nav. macOS's overlay scrollbar floats over panel content and
           auto-hides; the custom one stays put. */
        scrollbar-width: none;
      }
      #tabbrowser-tabpanels.bento-split-active::-webkit-scrollbar {
        display: none;
      }
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active {
        flex-direction: column;
        min-width: var(--bento-panel-min-width, 380px);
        flex-shrink: 0;
        /* Firefox's content-area.css applies margin: var(--space-xsmall)
           to active split-view panels — pushes the first panel away
           from the top URL bar and from the sidebar (and double-spaces
           against the inter-panel gap). Bento controls all spacing via
           tabpanels' gap + strip padding, so zero out the upstream
           margin. !important required because the upstream rule wins
           the specificity tie on source order otherwise. */
        margin: 0 !important;
      }
      /* Panels/main slot do not paint a border. The optional outer
         shadow comes from .bento-panel-shadow proxies (siblings of
         host inside strip-container — see below). Box-shadow on the
         panel itself is clipped by tabpanels' overflow box at the
         panel's bottom edge; the proxy escapes that clip. */
      #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] {
        border-radius: var(--radius-m);
        box-sizing: border-box;
        border: 0;
      }
      /* Outer shadow for each panel. Lives in #bento-strip-container
         (not inside the host) so the shadow can extend below the
         host into the scrollbar + favicon-nav area without being
         clipped by the host's overflow-x:scroll (which forces
         overflow-y:auto, clipping both axes). Inserted as the FIRST
         child of strip-container so document-order paint puts proxies
         BEFORE the host: host then paints over the proxy's interior,
         leaving only shadow extension visible past panel edges. The
         host's bg is transparent, as are tabpanels and the gap
         between panels — so shadow visible through to proxy beneath
         in inter-panel gaps. Below the host, scrollbar + nav are
         mostly transparent (scrollbar has narrow opaque track but
         margin around it lets shadow show through). Position +
         size synced from JS by syncPanelShadows() (called from
         syncInterPanelSplitters — same trigger conditions). */
      #bento-strip-container > .bento-panel-shadow {
        position: absolute;
        pointer-events: none;
        background-color: transparent;
        border-radius: var(--radius-m);
        box-shadow: var(--shadow-l);
      }
      #bento-strip-container > .bento-panel-shadow.bento-panel-shadow--strip-start {
        clip-path: inset(-64px round var(--radius-m));
      }
      #bento-strip-container.bento-panel-shadows-disabled > .bento-panel-shadow {
        display: none;
      }
      /* The browser fills whatever vertical space the header doesn't. */
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > browser,
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > .browserContainer,
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > .browserStack {
        flex: 1 1 auto;
        min-height: 0;
      }
      /* Side-panel content sits directly under the injected panel header.
         Keep the content's bottom corners rounded, but square off the
         top corners so it joins flush to the header's square bottom
         edge. The main content slot keeps all four rounded corners. */
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] > browser,
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] > .browserContainer,
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] > .browserStack {
        border-start-start-radius: 0 !important;
        border-start-end-radius: 0 !important;
      }
      /* Injected per-panel header — sits above the browser, takes its
         natural height, doesn't flex. */
      .bento-panel-header[data-bento-injected="1"] {
        flex: 0 0 auto;
      }

      /* ─── Add-panel trailer ────────────────────────────────────────
       * Slim flex item appended to the end of the split-view strip
       * (last child of #tabbrowser-tabpanels.bento-split-active).
       * The outer XUL host is only a layout/focus/cycle target; the
       * actual interactive controls are the "+" and saved-panel buttons
       * rendered inside the panel-trailer iframe. Inline order:999
       * keeps it visually after every panel regardless of the per-panel
       * order:N inline styles the reconciler stamps. */
      /* Trailer is a flex sibling of the panels inside tabpanels (NOT
         an absolute overlay) so it scrolls with the strip and the
         last panel's splitter sits between the last panel and the
         trailer naturally. Critical: needs .split-view-panel-active
         class to opt into Firefox's split-view paint pipeline —
         non-panel children of the deck render invisibly otherwise.
         The ID rule overrides the .split-view-panel-active rule's
         min-width (which would force 380px, way wider than we want
         for a slim trailer slot).
         Colours: --neutral-* tokens flip with Tale UI's color-mode
         cascade (data-color-mode on the chrome window), so the
         trailer adapts to light + dark mode automatically. SVG
         currentColor inherits from the trailer's color property so
         the icon tracks the same token. */
      /* Trailer width reserves a 3x3 button grid. If more than eight
         saved panels exist, React adds a native select underneath the
         grid and applyTrailerWidth() flips --bento-saved-panel-overflow
         to 1 so the host widens just enough for the select. */
      #bento-add-panel-trailer {
        flex: 0 0
          calc(
            (var(--space-l) * 3) +
              (var(--space-3xs) * 2) +
              (var(--space-xs) * 2) +
              (
                var(--bento-saved-panel-overflow, 0) *
                  (12rem - ((var(--space-l) * 3) + (var(--space-3xs) * 2)))
              )
          ) !important;
        min-width: calc((var(--space-l) * 3) + (var(--space-3xs) * 2) + (var(--space-xs) * 2)) !important;
        align-self: stretch !important;
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
        justify-content: stretch !important;
        order: 999 !important;
        box-sizing: border-box;
        margin-block: var(--space-2xs);
        padding: 0;
        background-color: transparent;
        border: 0;
        border-radius: var(--radius-m);
        color: var(--neutral-70);
        transition:
          flex-basis var(--bento-duration-base, 200ms) var(--bento-easing-standard);
      }
      /* Inner moz-extension <browser> iframe — fills the trailer host
         so the React PanelTrailer paints edge-to-edge. The iframe owns
         hover/active/focus styling for the actual buttons. */
      #bento-add-panel-trailer > #bento-panel-trailer-frame {
        flex: 1 1 auto;
        min-width: 0;
        background-color: transparent;
      }

      /* ─── Multi-panel column ordering ────────────────────────────────
         Firefox's split-view CSS only assigns explicit flex 'order' for
         column="0" and column="1" (designed for the 2-panel UI). With
         3+ panels, columns 2+ get default 'order: 0' and end up
         interleaved with column 0; column 1's 'order: 2' still pushes
         it after the splitter. Result with N panels: visual layout is
         [col 0, col 2, col 3, ..., splitter, col 1] instead of
         [col 0, col 1, col 2, ...]. The new mainTab (always col 0)
         appears in a non-deterministic visual slot depending on DOM
         insertion order, which the user perceives as "main slot
         moves to the second position when I press Cmd+T".
         The reconciler now sets inline style.order = 2*i on each
         panel and inserts a Bento splitter at order = 2*i + 1
         between adjacent pairs. The CSS rules below for column
         attributes 0–9 are kept as fallback for the brief moment
         before the reconciler stamps inline orders (they don't
         alternate with splitters but at least keep the visual
         ordering deterministic on first paint). Firefox's native
         splitter (Firefox order: 1, only between col 0 / col 1)
         is hidden — Bento's per-pair splitters take over. */
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="0"] { order: 0; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="1"] { order: 2; }
      /* Firefox's content-area.css gives subsequent .split-view-
         panel-active children a ~5px left margin and a separate
         col-1 margin. Both are zeroed because tabpanels.bento-
         split-active now uses flex gap (CSS spec: gap doesn't
         collide with item margins, so leftover Firefox margins
         would add to our flex gap producing double spacing). */
      #tabbrowser-tabpanels[splitview] > .split-view-panel-active,
      #tabbrowser-tabpanels[splitview] > .split-view-panel-active[column="1"] {
        margin-left: 0;
      }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="2"] { order: 4; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="3"] { order: 6; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="4"] { order: 8; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="5"] { order: 10; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="6"] { order: 12; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="7"] { order: 14; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="8"] { order: 16; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="9"] { order: 18; }
      #tabbrowser-tabpanels[splitview] > .split-view-splitter {
        order: 99;
        display: none;
      }

      /* Bento per-pair inter-panel splitter. Lives in
         #bento-side-panel-host (NOT inside tabpanels — XUL deck
         hit-testing blocks anything that isn't a selected panel,
         regardless of element type or position). Positioned
         absolutely at the right edge of each "left" panel via
         syncInterPanelSplitters in JS.
         Visual: a fixed-width accent line at the centre of a 14px grab
         zone, drawn via background linear-gradient (XUL splitter
         elements ignore ::before pseudo-elements, so element-side
         CSS is the only path). Hover/drag changes opacity only; the
         hit target and painted bar do not resize, so panel boundaries
         do not visually jump under the cursor. */
      #bento-side-panel-host > .bento-panel-splitter {
        cursor: col-resize;
        width: 14px !important;
        min-width: 14px !important;
        max-width: 14px !important;
        box-sizing: border-box;
        border: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        appearance: none;
        /* Invisible at rest and visible on hover/drag. The splitter is
           always the same 14px hit target with the same fixed-width
           painted bar; only opacity changes, so there is no apparent
           growth/shrink animation under the cursor. */
        background-image: linear-gradient(
          to right,
          transparent calc(50% - 2.5px),
          var(--color-60) calc(50% - 2.5px),
          var(--color-60) calc(50% + 2.5px),
          transparent calc(50% + 2.5px)
        );
        opacity: 0;
        transition: opacity var(--bento-duration-base) var(--bento-easing-standard);
      }
      #bento-side-panel-host > .bento-panel-splitter:hover,
      #bento-side-panel-host > .bento-panel-splitter--dragging {
        opacity: 1;
      }
      /* Hide every inter-panel splitter while a panel header is
         being dragged. Splitters are absolute-positioned overlays
         anchored to the layout positions of the panels they
         separate; the dragged panel transforms via translate
         (which doesn't fire the ResizeObserver, so syncInter-
         PanelSplitters won't re-run), which would otherwise leave
         splitters trailing the wrong panel boundaries. The drop
         indicator above takes over as the visual cue during the
         drag; splitters re-appear when endDrag re-syncs them
         against the settled post-drop layout. */
      #bento-side-panel-host.bento-side-panel-host--reordering > .bento-panel-splitter {
        visibility: hidden;
      }

      /* Split-view panel containers are positioned for drag/focus
         bookkeeping, but do not paint outline rings around the slots. */
      #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] {
        position: relative;
      }
      #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel]::after,
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id]::after {
        content: '';
        position: absolute;
        inset: 0;
        border: var(--bento-focus-ring-width) solid transparent;
        border-radius: var(--radius-m);
        pointer-events: none;
        z-index: 10;
        box-sizing: border-box;
        transition: border-color var(--bento-duration-slow) var(--bento-easing-standard);
      }
      #tabbrowser-tabpanels.bento-split-active > .bento-panel--focused::after,
      #tabbrowser-tabpanels.bento-split-active > .bento-panel--cycle-focused::after {
        border-color: var(--color-60);
      }

      /* Arrow-panel theming. macOS popup.css sets --panel-background:
         none on all panel elements so the native NSVisualEffectView
         renders the backdrop. Arrow panels disable native rendering
         (appearance: none) but still inherit --panel-background: none,
         leaving ::part(content) transparent. Override both the variable
         on the host element and the background on ::part(content)
         directly — the variable chain through @layer bento.chrome-theme
         does not reliably reach the XUL shadow part on macOS. */
      *|panel[type="arrow"] {
        --panel-background: var(--neutral-10) !important;
        --panel-color: var(--neutral-90) !important;
        --panel-border-color: var(--neutral-20) !important;
        --panel-border-radius: var(--radius-l) !important;
      }
      *|panel[type="arrow"]::part(content) {
        background: var(--neutral-10) !important;
        background-color: var(--neutral-10) !important;
        color: var(--neutral-90) !important;
        border-color: var(--neutral-20) !important;
      }
    `;
    document.documentElement.appendChild(style);
  }
  injectChromeStyles();

  function moz(path) {
    const policy = WebExtensionPolicy.getByID(ADDON_ID);
    if (!policy) return null;
    return 'moz-extension://' + policy.mozExtensionHostname + path;
  }

  // Resolve THIS chrome window's WebExtension windowId. We pass it
  // through to every shell document we host (sidebar, palette, confirm,
  // edit-workspace, etc.) as a `?bentoWindowId=<N>` query param so the
  // shell document can stamp it on its outgoing dispatches via the
  // WireAction `__windowId` envelope.
  //
  // Why not call browser.windows.getCurrent() from the shell document?
  // Bento's chrome-mounted <browser> frames (e.g. #bento-shell-frame)
  // are not regular tabs — they live directly in browser.xhtml, NOT in
  // tabbrowser-tabpanels. From the shell's content process, getCurrent()
  // typically resolves to the most-recently-focused chrome window, NOT
  // the one hosting this <browser>. That's wrong when window A's shell
  // is initializing while window B is focused — both windows then
  // believe they're window B.
  //
  // Chrome-side `windowTracker.getId(window)` reads from the same
  // BrowserWindowTracker the WebExtension API uses internally — same
  // ID space the shell document would otherwise be trying (and failing)
  // to resolve.
  //
  // Computed LAZILY at every setFrameSrc call (not once at module eval)
  // because this script can run before the chrome window has finished
  // registering with BrowserWindowTracker — early eval returns -1, the
  // lazy retry path catches it on the next call after registration.
  // Lazily importing on first call (and caching the result) is important:
  // bento-shell-mount.js evaluates very early during browser.xhtml parse,
  // which can be before `Extension.sys.mjs` has fully initialized the
  // Management.global namespace. Repeated lookups would also be expensive.
  // Sentinel `undefined` = "not yet attempted"; `null` = "attempted, gave up".
  let __bentoWindowTracker /* : object|null|undefined */ = undefined;
  function getChromeWindowId() {
    if (__bentoWindowTracker === undefined) {
      try {
        const mod = ChromeUtils.importESModule('resource://gre/modules/Extension.sys.mjs');
        __bentoWindowTracker = mod.Management?.global?.windowTracker || null;
      } catch (err) {
        console.warn('[bento-shell-mount] Extension.sys.mjs import failed:', err);
        __bentoWindowTracker = null;
      }
    }
    if (!__bentoWindowTracker) return null;
    try {
      const wid = __bentoWindowTracker.getId(window);
      return typeof wid === 'number' && wid >= 0 ? wid : null;
    } catch (err) {
      console.warn('[bento-shell-mount] windowTracker.getId failed:', err);
      return null;
    }
  }

  // Hard cap on setFrameSrc retries when windowId isn't resolving yet —
  // otherwise the spam can starve other startup work and the chrome
  // window's shell never paints (observed: blank chrome from infinite
  // retry loop). After this many failures, give up and load the URL
  // WITHOUT the windowId param. The shell document then dispatches with
  // __windowId=null and bento-tools falls back to legacy global semantics
  // — degraded but still functional (matches pre-A.1 behaviour).
  const SET_FRAME_SRC_MAX_RETRIES = 20; // ~1s @ 50ms

  function setFrameSrc(frameId, path, attempt) {
    const tries = typeof attempt === 'number' ? attempt : 0;
    const url = moz(path);
    if (!url) {
      // Extension hasn't loaded yet; try again on the next tick.
      setTimeout(() => setFrameSrc(frameId, path, tries + 1), 50);
      return;
    }
    const frame = document.getElementById(frameId);
    if (!frame) return;
    const windowId = getChromeWindowId();
    if (windowId === null && tries < SET_FRAME_SRC_MAX_RETRIES) {
      // Not yet — retry shortly. Capped via SET_FRAME_SRC_MAX_RETRIES so
      // a permanently-missing windowTracker doesn't loop forever.
      setTimeout(() => setFrameSrc(frameId, path, tries + 1), 50);
      return;
    }
    // Stamp the windowId as a URL HASH (not a query string). Hashes are
    // purely client-side fragments — they don't change the resource path
    // Firefox loads, don't change the document's origin, and crucially
    // don't trigger BrowsingContextGroup re-partitioning. Earlier we
    // tried `?bentoWindowId=N` as a query string and observed that
    // BroadcastChannel('bento-shell-bus') stopped delivering events from
    // the singleton bento-shell background to the per-window shell
    // documents — symptom: shells stuck on "connecting…" with skeleton
    // rendering, because the channel can't cross BCG boundaries even
    // within the same origin. The hash form sidesteps that entirely.
    const finalUrl = windowId !== null ? url + '#bentoWindowId=' + windowId : url;
    if (windowId === null) {
      console.warn(
        '[bento-shell-mount] setFrameSrc(' +
          frameId +
          '): giving up on windowId after ' +
          tries +
          ' retries; loading without hash (single-window fallback).',
      );
    }
    // setAttribute('src') works even before the <browser>'s webNavigation
    // is initialized; the loadURI APIs throw in that window. Stay with
    // setAttribute — the chrome process forwards the URL to the extension
    // content process when ready.
    frame.setAttribute('src', finalUrl);
  }

  function setBentoShellSrc() {
    const frame = document.getElementById('bento-shell-frame');
    if (frame) {
      frame.setAttribute('transparent', 'transparent');
      frame.style.backgroundColor = 'transparent';
      frame.style.setProperty('-moz-appearance', 'none');
    }
    setFrameSrc('bento-shell-frame', '/dist/index.html');
  }

  function setBentoPaletteSrc() {
    setFrameSrc('bento-palette-frame', '/dist/palette.html');
  }

  function setBentoConfirmSrc() {
    setFrameSrc('bento-confirm-frame', '/dist/confirm.html');
  }

  function setBentoEditWorkspaceSrc() {
    setFrameSrc('bento-edit-workspace-frame', '/dist/edit-workspace.html');
  }

  function setBentoWelcomeSrc() {
    setFrameSrc('bento-welcome-frame', '/dist/welcome.html');
  }

  function setBentoWorkspaceSwitcherSrc() {
    setFrameSrc('bento-workspace-switcher-frame', '/dist/workspace-switcher.html');
  }

  function setBentoMenuSrc() {
    setFrameSrc('bento-menu-frame', '/dist/menu.html');
  }

  // Trailer-frame source helper. Mirrors the other overlay-frame helpers
  // but the host is the existing #bento-add-panel-trailer XUL <vbox>
  // (not an ensureOverlayHost overlay) — see ensureAddPanelTrailer.
  function setBentoPanelTrailerSrc() {
    setFrameSrc('bento-panel-trailer-frame', '/dist/panel-trailer.html');
  }

  // Create overlay host elements dynamically rather than in the patch.
  // Why: browser.xhtml is preprocessed by mach at full-build time, so adding
  // a new <vbox> to browser-box.inc.xhtml requires `npm run build` to land
  // in the deployed app. JS-created elements bypass that — they go into the
  // live DOM at script-execution time, which `pnpm run dev` always picks
  // up via the bento-shell-mount.js symlink. Pattern: idempotent (guarded
  // by getElementById check) so the script can run multiple times without
  // duplicating hosts.
  //
  // Existing palette / confirm hosts stay in the patch because they were
  // created during a prior full build and changing them now would require
  // a rebuild anyway. New overlays added in dev should go through this
  // factory.
  function ensureOverlayHost(opts) {
    const { hostId, frameId, zIndex } = opts;
    if (document.getElementById(hostId)) return;
    const parent = document.getElementById('browser');
    if (!parent) {
      console.warn('[bento-shell-mount] ensureOverlayHost:', hostId, '— #browser missing');
      return;
    }
    const host = document.createXULElement('vbox');
    host.id = hostId;
    host.setAttribute('hidden', 'true');
    host.style.cssText =
      'position: absolute; top: 0; left: 0; width: 100%; height: 100%;' +
      ` z-index: ${zIndex}; background-color: transparent; pointer-events: auto;` +
      ' display: none; opacity: 0;' +
      ' transition: opacity 0.18s var(--bento-easing-standard, ease);';
    const frame = document.createXULElement('browser');
    frame.id = frameId;
    frame.setAttribute('type', 'content');
    frame.setAttribute('remote', 'true');
    frame.setAttribute('remoteType', 'extension');
    frame.setAttribute('primary', 'false');
    frame.setAttribute('flex', '1');
    frame.setAttribute('transparent', 'transparent');
    frame.style.cssText = 'background-color: transparent; -moz-appearance: none;';
    host.appendChild(frame);
    parent.appendChild(host);
  }

  // Edit-workspace overlay was added in dev — go through the JS factory
  // rather than waiting for a full build to inline its <vbox> into the
  // deployed browser.xhtml.
  ensureOverlayHost({
    hostId: 'bento-edit-workspace-host',
    frameId: 'bento-edit-workspace-frame',
    zIndex: 99997,
  });

  // Welcome overlay (first-run). Same dev-factory path. zIndex below
  // confirm/edit-workspace so a confirmation popup over a still-visible
  // welcome (theoretical) takes precedence; in practice welcome is the
  // very first overlay a user sees and there's nothing to stack against.
  ensureOverlayHost({
    hostId: 'bento-welcome-host',
    frameId: 'bento-welcome-frame',
    zIndex: 99996,
  });

  // Workspace-switcher overlay. The Tale UI Menu popover would otherwise
  // be clipped at the sidebar iframe boundary — useless when the rail is
  // collapsed to 4rem. Lifting the menu into a chrome-mounted <browser>
  // lets it render anywhere in the chrome window.
  // zIndex BELOW edit-workspace (99997) so an Edit dialog opened from a
  // menu item correctly overlays the menu while it's still fading out.
  // ABOVE the welcome (99996) since the menu can in principle open while
  // welcome is still mounted (welcome is dismissable but the menu would
  // be the user's natural next action).
  ensureOverlayHost({
    hostId: 'bento-workspace-switcher-host',
    frameId: 'bento-workspace-switcher-frame',
    zIndex: 99995,
  });
  // Pre-warm: keep the host laid out (display:flex) from chrome init so
  // window.screenLeft inside the overlay frame is accurate from the
  // start. Without this, the first menu open mis-positions: the overlay
  // React app receives the bus payload and re-renders BEFORE chrome's
  // 200ms title-poll fires showWorkspaceSwitcher(); inside a display:
  // none host, the iframe's content has no laid-out screen position
  // and window.screenLeft returns stale zeros, so the trigger-to-
  // overlay coord translation collapses and the menu ends up at the
  // chrome window's centre.
  // Invisibility + non-interactivity comes from opacity:0 +
  // pointer-events:none — the host stays in the layout tree but
  // intercepts no events and paints nothing visible.
  const wsSwitcherHostInit = document.getElementById('bento-workspace-switcher-host');
  if (wsSwitcherHostInit) {
    wsSwitcherHostInit.style.display = 'flex';
    wsSwitcherHostInit.style.pointerEvents = 'none';
    // opacity:0 and hidden=true already set by ensureOverlayHost defaults.
  }

  // ─── Palette overlay show/hide ──────────────────────────────────────────

  // Show/hide toggles the WRAPPER vbox, not the <browser> directly. XUL
  // <browser> ignores CSS sizing properties (width:100% / inset:0) — it
  // expects XUL flex inside a sized parent. The wrapper vbox carries the
  // position:absolute + 100% sizing; the browser inside uses flex="1".
  //
  // Reloading the palette frame on every show resets the React tree so the
  // Dialog re-mounts with isOpen=true. Without this, after a dismiss the
  // next open would show a closed Dialog (transparent overlay).

  function isPaletteVisible(host) {
    return host.style.display !== 'none';
  }

  // Show/hide drives opacity for a smooth fade. We do NOT reload the
  // palette frame on each show — reloading caused a perceptible empty-
  // content flash during the load roundtrip, and the `load` event
  // doesn't fire reliably for our remote=true moz-extension content
  // either. Instead the palette page renders Dialog with isOpen=true
  // permanently; visibility is purely a chrome concern via host
  // display + opacity. The Dialog stays mounted between opens, so
  // subsequent opens have zero React work and only the chrome-side
  // CSS transition runs.

  const PALETTE_TRANSITION_MS = 180; // matches inline transition duration

  function showPalette() {
    const host = document.getElementById('bento-palette-host');
    if (!host) {
      console.warn('[bento-shell-mount] showPalette: bento-palette-host missing');
      return;
    }
    host.style.display = 'flex';
    host.removeAttribute('hidden');
    // Force a layout pass so the browser registers display:flex BEFORE we
    // set opacity. Without this the opacity change wouldn't transition
    // (CSS doesn't transition from display:none to display:flex).
    void host.getBoundingClientRect();
    host.style.opacity = '1';
    const frame = document.getElementById('bento-palette-frame');
    setTimeout(() => frame?.focus(), 0);
  }

  function hidePalette() {
    const host = document.getElementById('bento-palette-host');
    if (!host) return;
    host.style.opacity = '0';
    setTimeout(() => {
      // Only commit display:none if still hidden — guards against a
      // re-show during the transition.
      if (host.style.opacity === '0') {
        host.style.display = 'none';
        host.setAttribute('hidden', 'true');
      }
    }, PALETTE_TRANSITION_MS);
  }

  function togglePalette() {
    const host = document.getElementById('bento-palette-host');
    if (!host) {
      console.warn('[bento-shell-mount] togglePalette: bento-palette-host missing — patch may not be applied');
      return;
    }
    if (isPaletteVisible(host)) hidePalette();
    else showPalette();
  }

  // ─── Confirm overlay (workspace delete, etc.) ──────────────────────────
  // Same chrome-overlay pattern as the palette: a transparent <browser>
  // sized to fill the window hosts the AlertDialog, so confirm modals are
  // not clipped to the sidebar's bounds. Visibility is driven by sidebar
  // title-IPC (BENTO_OPEN_CONFIRM_*) and confirm-content title-IPC
  // (BENTO_CLOSE_CONFIRM_*). The payload travels independently via the
  // 'bento-confirm-bus' BroadcastChannel.
  const CONFIRM_TRANSITION_MS = 180;

  function isConfirmVisible(host) {
    return host.style.display !== 'none';
  }

  function showConfirm() {
    const host = document.getElementById('bento-confirm-host');
    if (!host) {
      console.warn('[bento-shell-mount] showConfirm: bento-confirm-host missing');
      return;
    }
    host.style.display = 'flex';
    host.removeAttribute('hidden');
    void host.getBoundingClientRect();
    host.style.opacity = '1';
    const frame = document.getElementById('bento-confirm-frame');
    setTimeout(() => frame?.focus(), 0);
  }

  function hideConfirm() {
    const host = document.getElementById('bento-confirm-host');
    if (!host) return;
    host.style.opacity = '0';
    setTimeout(() => {
      if (host.style.opacity === '0') {
        host.style.display = 'none';
        host.setAttribute('hidden', 'true');
      }
    }, CONFIRM_TRANSITION_MS);
  }

  // ─── Edit-workspace overlay ────────────────────────────────────────────
  // Same chrome-overlay pattern as confirm/palette: a transparent
  // <browser> sized to fill the window hosts the form Dialog. Sidebar
  // never holds modal UI.
  const EDIT_WORKSPACE_TRANSITION_MS = 180;

  function isEditWorkspaceVisible(host) {
    return host.style.display !== 'none';
  }

  function showEditWorkspace() {
    const host = document.getElementById('bento-edit-workspace-host');
    if (!host) {
      console.warn('[bento-shell-mount] showEditWorkspace: host missing');
      return;
    }
    host.style.display = 'flex';
    host.removeAttribute('hidden');
    void host.getBoundingClientRect();
    host.style.opacity = '1';
    const frame = document.getElementById('bento-edit-workspace-frame');
    setTimeout(() => frame?.focus(), 0);
  }

  function hideEditWorkspace() {
    const host = document.getElementById('bento-edit-workspace-host');
    if (!host) return;
    host.style.opacity = '0';
    setTimeout(() => {
      if (host.style.opacity === '0') {
        host.style.display = 'none';
        host.setAttribute('hidden', 'true');
      }
    }, EDIT_WORKSPACE_TRANSITION_MS);
  }

  // ─── Workspace-switcher overlay ────────────────────────────────────────
  // The Tale UI Menu popover would otherwise be clipped at the sidebar
  // iframe boundary — useless when the rail is collapsed to 4rem and the
  // menu would render entirely outside the visible sidebar. Lifting it
  // into a chrome-mounted <browser> lets the menu render anywhere in the
  // chrome window. Sidebar's trigger button signals open via title-IPC;
  // the overlay subscribes to the bento-workspace-switcher-bus
  // BroadcastChannel for the trigger's anchor coords.
  //
  // Visibility is opacity-driven (NOT display) — see the prewarm note
  // at the host registration above. No transition timeout to track,
  // because we never flip display.

  function isWorkspaceSwitcherVisible(host) {
    // Visibility is opacity-driven (NOT display) for this overlay so the
    // frame stays laid out from chrome init — see the pre-warm comment
    // at the host registration above.
    return host.style.opacity === '1';
  }

  function showWorkspaceSwitcher() {
    const host = document.getElementById('bento-workspace-switcher-host');
    if (!host) {
      console.warn('[bento-shell-mount] showWorkspaceSwitcher: host missing');
      return;
    }
    // Display stays 'flex' from the init prewarm — only opacity +
    // pointer-events toggle here. Restoring display:flex would defeat
    // the prewarm's purpose (the frame has to stay laid out so its
    // window.screenLeft is accurate when the React app re-renders).
    host.style.pointerEvents = 'auto';
    host.removeAttribute('hidden');
    void host.getBoundingClientRect();
    host.style.opacity = '1';
    const frame = document.getElementById('bento-workspace-switcher-frame');
    setTimeout(() => frame?.focus(), 0);
  }

  function hideWorkspaceSwitcher() {
    const host = document.getElementById('bento-workspace-switcher-host');
    if (!host) return;
    host.style.opacity = '0';
    host.style.pointerEvents = 'none';
    host.setAttribute('hidden', 'true');
    // No display:none after the transition — see prewarm comment.
  }

  // ─── Welcome overlay (first-run) ───────────────────────────────────────
  // Same chrome-overlay pattern as confirm/palette/edit-workspace. Trigger
  // is one-shot per fresh profile: sidebar inspects settings.welcomeSeen
  // and signals BENTO_OPEN_WELCOME_<ts>; welcome content flips the flag
  // on dismiss so it never fires again.
  const WELCOME_TRANSITION_MS = 180;

  function isWelcomeVisible(host) {
    return host.style.display !== 'none';
  }

  function showWelcome() {
    const host = document.getElementById('bento-welcome-host');
    if (!host) {
      console.warn('[bento-shell-mount] showWelcome: host missing');
      return;
    }
    host.style.display = 'flex';
    host.removeAttribute('hidden');
    void host.getBoundingClientRect();
    host.style.opacity = '1';
    const frame = document.getElementById('bento-welcome-frame');
    setTimeout(() => frame?.focus(), 0);
  }

  function hideWelcome() {
    const host = document.getElementById('bento-welcome-host');
    if (!host) return;
    host.style.opacity = '0';
    setTimeout(() => {
      if (host.style.opacity === '0') {
        host.style.display = 'none';
        host.setAttribute('hidden', 'true');
      }
    }, WELCOME_TRANSITION_MS);
  }

  // ─── Generic chrome-menu overlay ───────────────────────────────────────
  // showChromeMenu({ anchor, items, onSelect }) opens a Tale UI Menu over
  // the entire chrome window, positioned next to `anchor` (a DOMRect-ish
  // {left, top, width, height} from the trigger element's
  // getBoundingClientRect). Each open generates a unique contextId so
  // overlapping opens (or rapid open→select sequences) route their
  // results back to the right handler. The map cleanup happens on the
  // first SELECT/CLOSE title-IPC we observe for that contextId.
  //
  // No fade transition (unlike palette/confirm) — menus should feel
  // instant. The React side stays mounted and updates state on
  // BroadcastChannel 'menu/open' actions; chrome just toggles host
  // display.
  const menuOnSelectByContext = new Map();

  function showChromeMenu({ anchor, items, onSelect }) {
    const host = document.getElementById('bento-menu-host');
    if (!host) {
      console.warn('[bento-shell-mount] showChromeMenu: bento-menu-host missing');
      return;
    }
    if (!anchor || !Array.isArray(items)) {
      console.warn('[bento-shell-mount] showChromeMenu: bad args', { anchor, items });
      return;
    }
    const contextId =
      'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    if (typeof onSelect === 'function') menuOnSelectByContext.set(contextId, onSelect);
    host.style.display = 'flex';
    host.removeAttribute('hidden');
    // Translate the trigger's chrome-document coords into menu-overlay
    // coords. The overlay frame fills #bento-menu-host (which lives
    // inside <hbox id="browser">, BELOW the chrome toolbar/tabstrip);
    // position:fixed inside the overlay is relative to the overlay's
    // own viewport, NOT the chrome document. Without this translation
    // the menu floats roughly one toolbar-height below the trigger.
    const hostRect = host.getBoundingClientRect();
    const adjustedAnchor = {
      left: anchor.left - hostRect.left,
      top: anchor.top - hostRect.top,
      width: anchor.width,
      height: anchor.height,
    };
    // Send the open payload over the shell bus. The menu page's React
    // listens for kind:'action' messages with action.type==='menu/open'.
    dispatchShellAction({
      type: 'menu/open',
      contextId,
      items,
      anchor: adjustedAnchor,
    });
    const frame = document.getElementById('bento-menu-frame');
    setTimeout(() => frame?.focus(), 0);
  }

  function hideChromeMenu() {
    const host = document.getElementById('bento-menu-host');
    if (!host) return;
    host.style.display = 'none';
    host.setAttribute('hidden', 'true');
  }

  // Cross-process IPC via document.title + DOMTitleChanged. Content in a
  // remote=true <browser> can't postMessage to the chrome process, but
  // title changes DO bubble cross-process to the chrome <browser>
  // element. Sidebar/palette content set document.title to a sentinel-
  // prefixed string with timestamp suffix; chrome reacts here. Timestamp
  // matters because DOMTitleChanged only fires when the title actually
  // changes — same value twice would be silent.
  const PALETTE_OPEN_PREFIX = 'BENTO_OPEN_PALETTE';
  const PALETTE_CLOSE_PREFIX = 'BENTO_CLOSE_PALETTE';
  // Same pattern for the confirm overlay (workspace deletion, etc.). The
  // confirm payload itself travels via BroadcastChannel('bento-confirm-bus')
  // — the title is just the visibility signal.
  const CONFIRM_OPEN_PREFIX = 'BENTO_OPEN_CONFIRM';
  const CONFIRM_CLOSE_PREFIX = 'BENTO_CLOSE_CONFIRM';
  // Same pattern for the edit-workspace overlay (rename/recolor/icon).
  // Payload travels via BroadcastChannel('bento-edit-workspace-bus').
  const EDIT_WORKSPACE_OPEN_PREFIX = 'BENTO_OPEN_EDIT_WORKSPACE';
  const EDIT_WORKSPACE_CLOSE_PREFIX = 'BENTO_CLOSE_EDIT_WORKSPACE';
  // Welcome overlay (first-run). No payload — sidebar's App.tsx reads
  // settings.welcomeSeen and signals BENTO_OPEN_WELCOME_<ts> the first
  // time it sees false; welcome content flips the flag + signals
  // BENTO_CLOSE_WELCOME_<ts> on dismiss.
  const WELCOME_OPEN_PREFIX = 'BENTO_OPEN_WELCOME';
  const WELCOME_CLOSE_PREFIX = 'BENTO_CLOSE_WELCOME';
  // Workspace-switcher menu overlay. Anchor coords travel via
  // BroadcastChannel('bento-workspace-switcher-bus') — title is just the
  // visibility signal.
  const WORKSPACE_SWITCHER_OPEN_PREFIX = 'BENTO_OPEN_WORKSPACE_SWITCHER';
  const WORKSPACE_SWITCHER_CLOSE_PREFIX = 'BENTO_CLOSE_WORKSPACE_SWITCHER';
  // Generic chrome-menu overlay. Items, anchor, and a routing contextId
  // travel from chrome into the menu page via a 'menu/open' shell-bus
  // action; the menu page reports back via these title prefixes which
  // include the contextId so chrome can find the right onSelect handler:
  //   BENTO_MENU_SELECT:<contextId>:<itemId>
  //   BENTO_MENU_CLOSE:<contextId>
  const MENU_SELECT_PREFIX = 'BENTO_MENU_SELECT:';
  const MENU_CLOSE_PREFIX = 'BENTO_MENU_CLOSE:';
  // Sidebar-driven scroll-to-main signal. Fires on every sidebar
  // tab-row click (including re-clicks on the active tab) so the
  // strip always returns to the main slot — see
  // handleScrollToMainTitle for the rationale.
  const SCROLL_TO_MAIN_PREFIX = 'BENTO_SCROLL_TO_MAIN_';
  // Sidebar-driven scroll-into-view + focus signal for a specific
  // panel. Fired by the PinnedPanels row click after the workspace
  // activation dispatches. Format: BENTO_FOCUS_PANEL:<ts>:<tabId>.
  // See handleFocusPanelTitle for the retry rationale (workspace
  // reconcile can run after the title write lands).
  const FOCUS_PANEL_PREFIX = 'BENTO_FOCUS_PANEL:';
  // Multi-panel reconciliation. Title format from sidebar:
  //   BENTO_PANELS:<ts>:<base64-of-json-array>
  // where the JSON array is [{tabId, url}, ...] for the active workspace.
  // Empty array hides the strip; non-empty rebuilds it via the
  // reconcilePanels() diff. Base64 because URLs can contain delimiter
  // chars; timestamp ensures repeated identical states still trigger
  // the title-change poll.
  const PANELS_PREFIX = 'BENTO_PANELS:';
  // Color-mode IPC. Title format: BENTO_COLOR_MODE:<ts>:<light|dark>
  // The shell sets this on settings/changed; the active BENTO_PANELS
  // payload also carries the same uiColorMode field as a self-correcting
  // backstop in case this dedicated message races with a panels/sync.
  const COLOR_MODE_PREFIX = 'BENTO_COLOR_MODE:';
  // Per-workspace theme IPC. Title format: BENTO_THEME:<ts>:<themeId>
  // The sidebar's useWorkspaceTheme hook (with pushChrome: true) writes
  // this on every active-workspace-theme change. We mirror it onto
  // documentElement[data-bento-theme] so the workspace theme presets in
  // bento-chrome-tokens.css (concatenated by generate-chrome-tokens.mjs
  // from extensions/bento-shell/src/theme/presets/*.css) scope their
  // overrides to the chrome window root. Boot race acknowledged in the
  // theme plan — until the first BENTO_THEME push lands, chrome paints
  // in the Default theme even when the workspace prefers another.
  const THEME_PREFIX = 'BENTO_THEME:';
  // Sidebar drag-to-reorder. Title format:
  //   BENTO_TAB_MOVE:<ts>:<srcTabId>:<anchorTabId>:<before|after>
  // Calls gBrowser.moveTabBefore / moveTabAfter so the dragged tab lands
  // immediately before/after the anchor. browser.tabs.move would route
  // through Firefox's moveTabTo which does `element = element.splitview`
  // and then throws on Bento's plain-object splitview marker — chrome's
  // moveTabBefore/After skip that transformation and preserve tab
  // identity, so dragging the currently-active (panel-marked) tab works.
  const TAB_MOVE_PREFIX = 'BENTO_TAB_MOVE:';

  // Drive Tale UI's color-mode cascade in chrome by setting
  // data-color-mode on the chrome window's <window> root.
  // _color-modes.css selectors are rewritten from `html` to `:root` by
  // scripts/generate-chrome-tokens.mjs, so the same cascade that flips
  // shell tokens flips chrome tokens. ColorModePref is now 'light' |
  // 'dark' only — the previous 'system' (clear attribute, fall through
  // to @media (prefers-color-scheme)) branch was removed in favour of
  // explicit user choice.
  function applyChromeColorMode(mode) {
    const root = document.documentElement;
    if (!root) return;
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-color-mode', mode);
    }
  }
  function handleThemeTitle(rawTitle) {
    // Format: BENTO_THEME:<ts>:<themeId>
    const tail = rawTitle.slice(THEME_PREFIX.length);
    const colonAfterTs = tail.indexOf(':');
    if (colonAfterTs < 0) return;
    const themeId = tail.slice(colonAfterTs + 1).trim();
    // Defensive: ignore empty / whitespace-only payloads. Anything else
    // is mirrored verbatim — the chrome stylesheet either has scoped
    // rules for that id (which apply) or doesn't (chrome stays on
    // defaults). Lenient by design so a typo'd new theme in the
    // registry doesn't break chrome.
    if (themeId.length === 0) return;
    document.documentElement.setAttribute('data-bento-theme', themeId);
  }
  function handleColorModeTitle(rawTitle) {
    const tail = rawTitle.slice(COLOR_MODE_PREFIX.length);
    const colonAfterTs = tail.indexOf(':');
    if (colonAfterTs < 0) return;
    const mode = tail.slice(colonAfterTs + 1);
    if (mode === 'light' || mode === 'dark') {
      applyChromeColorMode(mode);
    }
  }

  // ─── Side panel strip (multi-panel) ────────────────────────────────────
  //
  // The existing bento-side-panel-host (added by 02-bento-side-panel.patch
  // as a single-panel host) is repurposed as a horizontal STRIP that
  // holds N panel containers + an "Add panel" trailer. Reconciler rebuilds
  // children based on the panels/sync snapshot from bento-tools — adds
  // new panel hosts for new tabIds, removes hosts for gone tabIds,
  // navigates existing hosts whose URL changed.
  //
  // Each panel container is a vbox of [bento-panel-header, <browser>].
  // The header carries back/forward/reload buttons, an inline URL input,
  // and a star button (bookmarks). The header's URL input is the canonical
  // place to navigate the panel — the chrome's main URL bar always
  // reflects the active tab in the main content area.
  //
  // Splitters: one between each pair of adjacent panels. They use
  // `resizebefore="closest" resizeafter="none"` so dragging only resizes
  // the panel on the LEFT of the splitter — right-side panels just shift
  // along the horizontal scroll. The first splitter (between the main
  // content area and the strip) lives outside this code, in the
  // 02-bento-side-panel.patch — it resizes the strip / main as before.
  //
  // The "Add panel" trailer at the end creates a new tab via gBrowser
  // and stamps SessionStore extData "bentoAddAsPanel=1" on it, which
  // bento-tools' tabs.onCreated handler reads to add it to the active
  // workspace's panels list.
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Lucide icon paths — hand-copied from lucide-react (pinned in
  // extensions/bento-shell/package.json, currently ^0.460.0). This
  // file runs in Firefox's chrome JS context (browser.xhtml, parent
  // process) which has no npm module graph, so we can't import from
  // lucide-react directly the way the React-side extension code does.
  //
  // To verify or re-sync a path: open node_modules/lucide-react/dist/
  // esm/icons/<kebab-name>.js — each Lucide icon ships its path data
  // as static array exports. Key names below are camelCased versions
  // of the upstream kebab names (chevron-left → chevronLeft, etc.),
  // so the mapping is mechanical.
  //
  // Multi-segment icons concatenate sub-paths with 'M' moves so each
  // entry stays a single d-string (one <path> per icon — keeps
  // makeIcon trivial). gripVertical and moreVertical use Lucide's
  // degenerate-arc trick: zero-length segments rendered as filled
  // circles via stroke-linecap='round', dot diameter == stroke-width.
  const ICONS = {
    chevronLeft: 'm15 18-6-6 6-6',
    chevronRight: 'm9 18 6-6-6-6',
    rotate: 'M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.74 2.74L3 8 M3 3v5h5',
    star:
      'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
    plus: 'M12 5v14 M5 12h14',
    x: 'M18 6 6 18 M6 6l12 12',
    // grip-vertical: 2×3 dot grid — drag-to-reorder affordance.
    gripVertical:
      'M9 5a1 1 0 1 0 0 0 M9 12a1 1 0 1 0 0 0 M9 19a1 1 0 1 0 0 0 M15 5a1 1 0 1 0 0 0 M15 12a1 1 0 1 0 0 0 M15 19a1 1 0 1 0 0 0',
    // more-vertical: 1×3 dot column — canonical kebab "more" trigger.
    moreVertical: 'M12 5a1 1 0 1 0 0 0 M12 12a1 1 0 1 0 0 0 M12 19a1 1 0 1 0 0 0',
  };

  function makeIcon(d, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (size) {
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  function makeHeaderButton(title, iconD, onClick) {
    const btn = document.createElementNS(HTML_NS, 'button');
    btn.type = 'button';
    btn.className = 'bento-panel-header-button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.appendChild(makeIcon(iconD));
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Move the main tab content (#tabbrowser-tabbox) into the strip as
  // its first child. The strip becomes the entire content area right
  // of the sidebar — main + side panels + Add-panel button share one
  // horizontal scroll context, one bottom-padding gap, etc.
  //
  // Idempotent via the data-bento-strip-unified flag. Risk: tabbrowser
  // internals occasionally walk up the DOM looking for #tabbrowser-tabbox
  // at a specific parent location; if anything breaks (fullscreen,
  // PiP, sidebar splitter), revert by restoring the original parent.
  function unifyMainWithStrip() {
    const host = document.getElementById('bento-side-panel-host');
    const main = document.getElementById('tabbrowser-tabbox');
    if (!host || !main) return;
    if (host.dataset.bentoStripUnified === '1') return;

    host.dataset.bentoStripUnified = '1';

    main.dataset.bentoMainPanel = '1';
    // Same tabindex treatment as side panels so the cycle nav can
    // focus main without inserting it into the natural Tab order.
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    host.insertBefore(main, host.firstChild);
  }

  // Strip layout is fully driven by injected CSS (#bento-side-panel-host
  // rule). This function only needs to clear any lingering inline styles
  // from earlier code revisions.
  function configureSidePanelStrip() {
    const host = document.getElementById('bento-side-panel-host');
    if (!host) return;
    host.style.cssText = '';
  }

  // Type the value into the panel browser's URI fixup machinery and
  // navigate. Mirrors what the chrome URL bar does on Enter, but routed
  // to a specific <browser> rather than gBrowser.selectedBrowser.
  function loadInPanel(browserEl, value) {
    try {
      const flags =
        Services.uriFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
        Services.uriFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
      const info = Services.uriFixup.getFixupURIInfo(value, flags);
      const uri = info.preferredURI;
      if (!uri) return;
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      if (typeof browserEl.fixupAndLoadURIString === 'function') {
        browserEl.fixupAndLoadURIString(uri.spec, { triggeringPrincipal: principal });
      } else {
        browserEl.loadURI(uri, { triggeringPrincipal: principal });
      }
    } catch (err) {
      console.warn('[bento-shell-mount] panel header load failed:', err);
    }
  }

  // Insert a bookmark (silent — no dialog) at the unfiled "Other Bookmarks"
  // root and visually mark the star as filled. Already-bookmarked URLs
  // get inserted again (Firefox allows duplicate bookmarks); de-dupe is
  // a future enhancement.
  function bookmarkPanelPage(browserEl, starBtn) {
    let uri;
    try {
      uri = browserEl.currentURI;
    } catch {
      return;
    }
    if (!uri || !uri.spec) return;
    let title;
    try {
      title = browserEl.contentTitle || uri.spec;
    } catch {
      title = uri.spec;
    }
    try {
      const { PlacesUtils } = ChromeUtils.importESModule(
        'resource://gre/modules/PlacesUtils.sys.mjs',
      );
      PlacesUtils.bookmarks
        .insert({
          parentGuid: PlacesUtils.bookmarks.unfiledGuid,
          url: uri.spec,
          title,
        })
        .then(() => {
          if (starBtn) starBtn.classList.add('bento-panel-header-button--active');
        })
        .catch((err) => {
          console.warn('[bento-shell-mount] bookmark insert failed:', err);
        });
    } catch (err) {
      console.warn('[bento-shell-mount] bookmark module load failed:', err);
    }
  }

  // Build the header above each panel: back / forward / reload / URL
  // input / star. Wires a progress listener on the panel browser so the
  // URL stays in sync as the user navigates inside it.
  //
  // initialUrl pre-populates the URL input synchronously, so the user
  // sees the correct URL the moment the panel appears — the progress
  // listener doesn't need to fire first. about:blank is suppressed
  // (rendered as empty input) since it's the transient initial state
  // before the panel actually navigates.
  function createPanelHeader(browserEl, initialUrl, tabId) {
    const header = document.createXULElement('hbox');
    header.className = 'bento-panel-header';

    const backBtn = makeHeaderButton('Back', ICONS.chevronLeft, () => {
      try {
        if (browserEl.canGoBack) browserEl.goBack();
      } catch (e) {
        console.warn('[bento-shell-mount] panel goBack failed:', e);
      }
    });
    const forwardBtn = makeHeaderButton('Forward', ICONS.chevronRight, () => {
      try {
        if (browserEl.canGoForward) browserEl.goForward();
      } catch (e) {
        console.warn('[bento-shell-mount] panel goForward failed:', e);
      }
    });
    const reloadBtn = makeHeaderButton('Reload', ICONS.rotate, () => {
      try {
        browserEl.reload();
      } catch (e) {
        console.warn('[bento-shell-mount] panel reload failed:', e);
      }
    });

    const urlInput = document.createElementNS(HTML_NS, 'input');
    urlInput.type = 'text';
    urlInput.className = 'bento-panel-header-url';
    urlInput.placeholder = 'Enter URL';
    urlInput.spellcheck = false;
    // about:blank and about:newtab are transient/empty states — Firefox's
    // own URL bar renders them as empty too. Skip them so the user sees
    // an empty, focusable input ready for typing rather than a noisy
    // about: URL on a fresh panel.
    if (initialUrl && initialUrl !== 'about:blank' && initialUrl !== 'about:newtab') {
      urlInput.value = initialUrl;
    }
    urlInput.addEventListener('focus', () => {
      // Spotlight-style: select-all on focus so typing replaces the URL.
      setTimeout(() => urlInput.select(), 0);
    });
    // After Enter (navigate) or Escape (cancel), put DOM focus back on
    // the panel container so the Up/Down content-scroll handler and the
    // Left/Right cycle handler keep working. Without this, focus lands
    // on document body after blur, and arrow keys do nothing until the
    // user clicks back into the panel.
    function returnFocusToPanel() {
      const panelEl = urlInput.closest(
        '[data-bento-main-panel], [data-bento-panel-tab-id]',
      );
      if (!panelEl) return;
      try {
        panelEl.focus({ preventScroll: true });
      } catch {
        /* best-effort; setActiveByIndex relies on the same call working */
      }
    }
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = urlInput.value.trim();
        if (value) loadInPanel(browserEl, value);
        returnFocusToPanel();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Discard any in-progress edit by restoring the displayed URL
        // before handing focus back. Mirrors Firefox's #urlbar Esc
        // behaviour.
        const spec = browserEl?.currentURI?.spec;
        if (spec && spec !== 'about:blank' && spec !== 'about:newtab') {
          urlInput.value = spec;
        } else {
          urlInput.value = '';
        }
        returnFocusToPanel();
      }
    });

    const starBtn = makeHeaderButton('Bookmark page', ICONS.star, () =>
      bookmarkPanelPage(browserEl, starBtn),
    );

    // Close button: dispatches tab/close (NOT panel/remove). Closing a
    // side panel closes its underlying tab entirely — the tab does not
    // return to the sidebar list. bento-tools' tabs.onRemoved handler
    // (background.ts:201) automatically strips the tab from PanelStore
    // and emits panels/sync, which drives the reconciler to remove the
    // panel from the layout. Only wired when a tabId was passed
    // (defensive — the header can be constructed in test contexts
    // without one).
    let closeBtn = null;
    if (Number.isFinite(tabId)) {
      closeBtn = makeHeaderButton('Close panel', ICONS.x, () => removePanel(tabId));
    }

    // Kebab "more" button: opens a Tale UI Menu (via the generic
    // chrome-menu overlay) of panel-scoped options. First population
    // is the custom panel sizes from Bento Settings; future items
    // (e.g., move to workspace, duplicate panel) — including SUBMENUS —
    // join here by extending the items array. Hidden on the main
    // panel via CSS: the menu's current actions only apply to side
    // panels (panel/setWidth is per-tab; main uses the shared
    // panel/setMainWidth and gets resized via the splitter).
    let moreBtn = null;
    if (Number.isFinite(tabId)) {
      moreBtn = makeHeaderButton('Panel options', ICONS.moreVertical, () => {
        const panelEl = moreBtn.closest('[data-bento-panel-tab-id]');
        if (!panelEl) return;
        const sizeItems =
          currentCustomPanelSizes.length > 0
            ? currentCustomPanelSizes.map((px) => ({
                id: 'size:' + px,
                label: px + ' px',
              }))
            : [
                {
                  id: 'no-sizes',
                  label: 'No panel sizes set in Bento Settings',
                  isDisabled: true,
                },
              ];
        // Pin/Unpin item leads the menu. Label flips based on whether
        // THIS panel is currently in the active workspace's pin set —
        // BENTO_PANELS payload's `pinnedTabIdsInWorkspace` keeps
        // currentPinnedTabIdsInWorkspace in sync. Resolving the
        // workspaceId at click time (not menu-build time) is fine
        // here: both the menu open and the dispatch happen on the
        // chrome event loop, no async gap during which
        // currentWorkspaceId could shift.
        const isPinned = currentPinnedTabIdsInWorkspace.has(tabId);
        const pinItem = {
          id: isPinned ? 'unpin' : 'pin',
          label: isPinned ? 'Unpin this panel' : 'Pin this panel',
        };
        // Size presets nest under a "Custom panel widths" submenu so
        // the menu has room for new top-level actions — `items.items`
        // makes ChromeMenu.tsx render a SubmenuTrigger via
        // react-aria-components (no Tale UI Menu change needed).
        // "Save panel" sits as a sibling below a separator; clicking
        // dispatches `savedPanels/save` and bento-tools inserts the
        // bookmark into the "Saved panels" folder (de-dupes silently).
        const items = [
          pinItem,
          { id: 'custom-widths', label: 'Custom panel widths', items: sizeItems },
          { id: 'sep-save-panel', kind: 'separator' },
          { id: 'save-panel', label: 'Save panel' },
        ];
        showChromeMenu({
          anchor: moreBtn.getBoundingClientRect(),
          items,
          onSelect: (itemId) => {
            if (typeof itemId !== 'string') return;
            if (itemId === 'pin') {
              if (!currentWorkspaceId) return;
              dispatchShellAction({
                type: 'pinnedPanel/add',
                workspaceId: currentWorkspaceId,
                tabId,
              });
              return;
            }
            if (itemId === 'unpin') {
              if (!currentWorkspaceId) return;
              dispatchShellAction({
                type: 'pinnedPanel/remove',
                workspaceId: currentWorkspaceId,
                tabId,
              });
              return;
            }
            if (itemId === 'save-panel') {
              // Read the panel's current URL + title and dispatch to
              // bento-tools — SavedPanelsStore owns the find-or-create
              // folder + dedupe + insert path. Chrome avoids touching
              // PlacesUtils directly here (the star button at
              // bookmarkPanelPage still does, but that's a different
              // folder + a precedent we are NOT extending — bookmarks
              // mutated from chrome would bypass tools' list mirror
              // and the trailer iframe would lag until the next manual
              // refresh).
              const innerBrowser = panelEl.querySelector('browser');
              if (!innerBrowser) return;
              let uri;
              try {
                uri = innerBrowser.currentURI;
              } catch {
                return;
              }
              if (!uri || !uri.spec) return;
              let title;
              try {
                title = innerBrowser.contentTitle || uri.spec;
              } catch {
                title = uri.spec;
              }
              let favIconUrl = '';
              try {
                favIconUrl =
                  innerBrowser.mIconURL ||
                  innerBrowser.getAttribute?.('image') ||
                  innerBrowser.getAttribute?.('icon') ||
                  '';
              } catch {
                favIconUrl = '';
              }
              dispatchShellAction({
                type: 'savedPanels/save',
                url: uri.spec,
                title,
                favIconUrl,
              });
              return;
            }
            if (itemId.startsWith('size:')) {
              const px = Number(itemId.slice('size:'.length));
              applyPanelWidth(panelEl, px);
            }
          },
        });
      });
      moreBtn.classList.add('bento-panel-header-button--more');
    }

    // Drag handle for panel reordering. setupHeaderDrag binds
    // pointerdown to it and runs the drag loop. The handle is
    // styled small + leftmost so it reads as the obvious "grab
    // here to move this panel" affordance. Absent on the main
    // slot's header (the main panel is always col 0; reordering
    // it would break Bento's selected-tab-is-main model — see
    // setupHeaderDrag's early return).
    const dragHandle = document.createXULElement('hbox');
    dragHandle.className = 'bento-panel-header-drag-handle';
    dragHandle.setAttribute('role', 'button');
    dragHandle.setAttribute('aria-label', 'Drag to reorder panel');
    dragHandle.appendChild(makeIcon(ICONS.gripVertical));

    header.appendChild(dragHandle);
    header.appendChild(backBtn);
    header.appendChild(forwardBtn);
    header.appendChild(reloadBtn);
    header.appendChild(urlInput);
    header.appendChild(starBtn);
    if (closeBtn) header.appendChild(closeBtn);
    if (moreBtn) header.appendChild(moreBtn);

    // Refresh URL input + back/forward enabled state on navigation.
    // Initial pass after a short delay covers the case where the
    // browser hasn't started loading yet at construction time.
    //
    // Important: only overwrite urlInput.value when currentURI yields a
    // real URL. about:blank / empty are transient pre-load states; if
    // we wrote them into the input we'd wipe whatever initialUrl gave
    // us (which is the actual destination URL). The progress listener
    // calls this again on every onLocationChange, so the eventual real
    // URL still lands in the input.
    const refresh = () => {
      try {
        if (document.activeElement !== urlInput) {
          let spec = '';
          try {
            spec = browserEl.currentURI ? browserEl.currentURI.spec : '';
          } catch {
            spec = '';
          }
          if (spec && spec !== 'about:blank' && spec !== 'about:newtab') {
            urlInput.value = spec;
          } else if (spec === 'about:newtab') {
            // Clear when navigating to newtab (e.g. user typed nothing
            // and the address eventually resolves to about:newtab via
            // the redirect path).
            urlInput.value = '';
          }
        }
        if (browserEl.canGoBack) backBtn.removeAttribute('disabled');
        else backBtn.setAttribute('disabled', 'true');
        if (browserEl.canGoForward) forwardBtn.removeAttribute('disabled');
        else forwardBtn.setAttribute('disabled', 'true');
      } catch {
        // Browser not yet attached — refresh again on next tick.
      }
    };
    setTimeout(refresh, 50);

    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        'nsIWebProgressListener',
        'nsISupportsWeakReference',
      ]),
      onLocationChange() {
        refresh();
      },
      onStateChange() {},
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };
    try {
      if (typeof browserEl.addProgressListener === 'function') {
        browserEl.addProgressListener(
          listener,
          Ci.nsIWebProgress.NOTIFY_LOCATION | Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT,
        );
      }
    } catch (err) {
      console.warn('[bento-shell-mount] panel progress listener attach failed:', err);
    }

    return header;
  }

  // ─── Inter-panel splitter (drag to resize) ────────────────────────────
  //
  // Firefox's native split-view splitter only sits between col 0 and
  // col 1, has per-tab resize semantics (writes width to the col-0
  // notificationbox, which is the active tab's browser host), and
  // squeezes sibling panels instead of pushing them along the
  // strip's horizontal scroll. None of that fits Bento's N-panel
  // strip model, so we hide Firefox's splitter (see
  // injectChromeStyles) and inject our own at every adjacent panel
  // boundary.
  //
  // POINTER events with setPointerCapture survive the cursor
  // crossing into a remote=true content browser mid-drag — the same
  // reason the legacy reconciler used pointer events. mousedown +
  // window-level mousemove would lose drag the moment the cursor
  // entered a panel's webpage.
  //
  // Main panel width is a single window/profile layout choice. Each
  // tab has its own col-0 notificationbox; if we only wrote width to
  // that one element, switching tabs/workspaces would reveal stale
  // per-element sizing. Keep this chrome-side value as the immediate
  // source of truth; bento-tools persists the same value for next boot.
  let mainPanelWidth = null;

  // Cross-panel FLIP animation buffer. setupHeaderDrag's endDrag
  // populates this with each visible panel's pre-reorder rect
  // when a reorder commit is dispatched; runPendingPanelFlip
  // (called from the end of reconcilePanelsSplitView) reads
  // the new rects, applies an instant counter-transform, and
  // transitions back to translate(0) so the user sees the
  // OTHER panels (not just the dragged one) glide between
  // their old and new slots. Cleared at the start of every
  // run so a stale snapshot can never leak across reconciles.
  let __bentoPendingFlip = null;

  function createPanelSplitter() {
    // XUL <splitter> element — only XUL element type that XUL
    // <tabpanels>'s deck-style hit-testing routes pointer events
    // to. Tested:
    //   - HTML <div>: elementFromPoint at splitter center returns
    //     tabpanels, not the splitter (deck blocks non-selected).
    //   - XUL <hbox>: same.
    //   - XUL <hbox> with position:absolute z:999: still blocked.
    //   - XUL <splitter>: works (Firefox's own split-view-splitter
    //     uses this element).
    // resizebefore/resizeafter="none" disables Firefox's default
    // sibling-width-mutation behaviour — we want the splitter to
    // be a passive event sink whose drag is handled entirely by
    // our pointer handlers.
    const splitter = document.createXULElement('splitter');
    splitter.className = 'bento-panel-splitter';
    splitter.setAttribute('resizebefore', 'none');
    splitter.setAttribute('resizeafter', 'none');
    splitter.addEventListener('pointerdown', (e) => startPanelDrag(splitter, e));
    splitter.addEventListener('pointermove', (e) => onPanelDragMove(splitter, e));
    splitter.addEventListener('pointerup', (e) => endPanelDrag(splitter, e));
    splitter.addEventListener('pointercancel', (e) => endPanelDrag(splitter, e));
    splitter.addEventListener('lostpointercapture', () => endPanelDrag(splitter, null));
    splitter.addEventListener('contextmenu', (e) => showPanelSplitterContextMenu(splitter, e));
    return splitter;
  }

  function showPanelSplitterContextMenu(splitter, e) {
    const sourceTabId = getPanelSplitterSourceTabId(splitter);
    if (sourceTabId === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    showChromeMenu({
      anchor: {
        left: e.clientX,
        top: e.clientY,
        width: 1,
        height: 1,
      },
      items: [{ id: 'insert-panel-here', label: 'Insert panel here' }],
      onSelect: (itemId) => {
        if (itemId !== 'insert-panel-here') return;
        dispatchShellAction({
          type: 'panel/openAt',
          url: 'about:newtab',
          sourceTabId,
        });
      },
    });
  }

  function getPanelSplitterSourceTabId(splitter) {
    const leftPanelId = splitter?._bentoLeftPanelId;
    if (!leftPanelId) return undefined;
    const leftPanel = document.getElementById(leftPanelId);
    if (!leftPanel) return undefined;
    if (leftPanel.dataset.bentoMainPanel === '1') return null;
    const raw = leftPanel.dataset.bentoPanelTabId;
    const tabId = raw ? Number(raw) : NaN;
    return Number.isFinite(tabId) ? tabId : undefined;
  }

  function startPanelDrag(splitter, e) {
    if (e.button !== 0) return;
    const leftPanelId = splitter._bentoLeftPanelId;
    if (!leftPanelId) return;
    const leftPanel = document.getElementById(leftPanelId);
    if (!leftPanel) return;
    e.preventDefault();
    e.stopPropagation();

    splitter._panelDragState = {
      leftPanel,
      isMain: !!leftPanel.dataset.bentoMainPanel,
      startX: e.clientX,
      startWidth: leftPanel.getBoundingClientRect().width,
      pointerId: e.pointerId,
    };
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch (err) {
      console.warn('[bento-shell-mount] setPointerCapture failed:', err);
    }
    splitter.classList.add('bento-panel-splitter--dragging');
    document.documentElement.style.setProperty('cursor', 'col-resize', 'important');
    document.documentElement.style.setProperty('user-select', 'none', 'important');
  }

  function onPanelDragMove(splitter, e) {
    const drag = splitter._panelDragState;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const delta = e.clientX - drag.startX;
    const minWidth = drag.isMain ? 320 : 240;
    const next = Math.max(minWidth, drag.startWidth + delta);
    drag.leftPanel.style.width = next + 'px';
    drag.leftPanel.style.minWidth = next + 'px';
    drag.leftPanel.style.flex = '0 0 ' + next + 'px';
    if (drag.isMain) {
      mainPanelWidth = next;
    }
    // Re-position splitters so they track the live panel widths.
    // Without this the dragged splitter (and any splitters to its
    // right) stay at their pre-drag positions and detach visually
    // from the panel boundaries they own.
    syncInterPanelSplitters();
  }

  function endPanelDrag(splitter, e) {
    const drag = splitter._panelDragState;
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
    try {
      splitter.releasePointerCapture(drag.pointerId);
    } catch {
      /* already released */
    }
    const finalWidth = drag.leftPanel.getBoundingClientRect().width;
    const isMain = drag.isMain;
    const leftPanel = drag.leftPanel;
    splitter._panelDragState = null;
    splitter.classList.remove('bento-panel-splitter--dragging');
    document.documentElement.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('user-select');
    // After drag, re-position all splitters (the resized panel
    // shifts every splitter to its right).
    syncInterPanelSplitters();
    // Persist the new width. Main panel is per-workspace; side panels
    // are per-tabId. Both flow through bento-tools so the next launch
    // re-applies them on reconcile.
    if (isMain) {
      if (finalWidth > 0) {
        dispatchShellAction({
          type: 'panel/setMainWidth',
          widthPx: Math.round(finalWidth),
        });
      }
    } else {
      const tabIdAttr = leftPanel.dataset.bentoPanelTabId;
      const tabId = tabIdAttr ? Number(tabIdAttr) : NaN;
      if (Number.isFinite(tabId) && finalWidth > 0) {
        dispatchShellAction({
          type: 'panel/setWidth',
          id: tabId,
          widthPx: Math.round(finalWidth),
        });
      }
    }
  }

  function animatePanelEnter(panelEl, options = {}) {
    if (!panelEl) return;
    const finalWidth = panelEl.getBoundingClientRect().width;
    if (!Number.isFinite(finalWidth) || finalWidth <= 0) return;
    const clearSizingAfter = !!options.clearSizingAfter;
    panelEl.style.transition = 'none';
    panelEl.style.opacity = '0';
    panelEl.style.transform = 'scale(0.98)';
    panelEl.style.minWidth = '0';
    panelEl.style.width = '0';
    panelEl.style.flex = '0 0 0';
    panelEl.getBoundingClientRect();
    requestAnimationFrame(() => {
      panelEl.style.transition =
        'opacity 140ms var(--bento-easing-standard), ' +
        'transform 180ms var(--bento-easing-standard), ' +
        'width 180ms var(--bento-easing-standard), ' +
        'min-width 180ms var(--bento-easing-standard), ' +
        'flex-basis 180ms var(--bento-easing-standard)';
      panelEl.style.opacity = '1';
      panelEl.style.transform = 'scale(1)';
      panelEl.style.width = finalWidth + 'px';
      panelEl.style.minWidth = finalWidth + 'px';
      panelEl.style.flex = '0 0 ' + finalWidth + 'px';
      let onTransitionEnd = null;
      const cleanup = () => {
        panelEl.style.removeProperty('transition');
        panelEl.style.removeProperty('opacity');
        panelEl.style.removeProperty('transform');
        if (clearSizingAfter) {
          panelEl.style.removeProperty('width');
          panelEl.style.removeProperty('min-width');
          panelEl.style.removeProperty('flex');
        }
        if (onTransitionEnd) panelEl.removeEventListener('transitionend', onTransitionEnd);
      };
      onTransitionEnd = (event) => {
        if (event.target !== panelEl) return;
        if (event.propertyName !== 'width' && event.propertyName !== 'flex-basis') return;
        cleanup();
      };
      panelEl.addEventListener('transitionend', onTransitionEnd);
      setTimeout(cleanup, 260);
    });
  }

  // ResizeObserver shared across all panels — re-syncs inter-panel
  // splitter positions whenever any observed panel's width changes.
  // Robust against the layout race that previously caused
  // misalignment at boot (reconciler reads bounding rects before
  // Firefox's split-view flex layout commits) and close-animation
  // flicker (panels reflow but splitters stay at stale positions).
  // The observer has a single callback that re-runs the full sync;
  // we (re-)observe the current panel set on every reconcile.
  const __bentoSplitterRO =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          try {
            syncInterPanelSplitters();
          } catch (err) {
            console.warn('[bento-shell-mount] splitter RO sync failed:', err);
          }
        })
      : null;

  // Sync inter-panel splitter elements in #bento-side-panel-host so
  // there's exactly one between each adjacent pair of panels in
  // tabpanels.splitViewPanels, positioned absolutely at the right
  // edge of each "left" panel. Idempotent; called from
  // reconcilePanelsSplitView, the resize-repaint poke (window
  // resize), the strip scroll listener, after each drag commit,
  // and from the per-panel ResizeObserver. Pass the desired panel
  // ordering explicitly to avoid races where tabpanels.splitView-
  // Panels hasn't updated yet; if omitted, reads from current
  // splitViewPanels.
  // FLIP runner for cross-panel reorder animation. Called from
  // the end of reconcilePanelsSplitView. Reads __bentoPendingFlip
  // (a Map<tabId, oldRect> populated by setupHeaderDrag's
  // endDrag), computes each visible panel's new rect, applies
  // an instant counter-transform (translateX(oldLeft - newLeft))
  // so each panel visually starts at where it was before the
  // reorder, then on the next frame transitions back to
  // translate(0) — they glide smoothly to their new slots.
  //
  // The dragged panel is included here too. endDrag stashes its
  // current PAINTED rect (which includes the live drag transform,
  // i.e. the cursor position) as that panel's "old position".
  // The FLIP then animates it from cursor X to its new slot,
  // bypassing the bug where clearing the transform in endDrag
  // would briefly snap the panel back to its OLD slot before
  // the reconciler updated the layout.
  function runPendingPanelFlip() {
    if (!__bentoPendingFlip) return;
    const snapshot = __bentoPendingFlip;
    __bentoPendingFlip = null;
    const moved = [];
    for (const panelEl of getOrderedPanels()) {
      const tabIdAttr = panelEl.dataset.bentoPanelTabId;
      if (!tabIdAttr) continue;
      const tabId = Number(tabIdAttr);
      if (!Number.isFinite(tabId)) continue;
      const oldRect = snapshot.get(tabId);
      if (!oldRect) continue;
      // Reset any leftover transform on the dragged panel so its
      // newRect reflects pure layout coords. Without this, the
      // dragged panel still has its cursor-following transform
      // and getBoundingClientRect would include it, making
      // dx ≈ 0.
      const isDragged = tabId === snapshot.__draggedTabId;
      if (isDragged) {
        panelEl.style.transition = 'none';
        panelEl.style.transform = '';
      }
      const newRect = panelEl.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      if (Math.abs(dx) < 1) continue;
      moved.push({ panelEl, dx, isDragged });
    }
    if (moved.length === 0) return;
    // Instant counter-transform — panels visually stay where
    // they were before the reorder (or for the dragged panel,
    // where the cursor released).
    for (const { panelEl, dx } of moved) {
      panelEl.style.transition = 'none';
      panelEl.style.willChange = 'transform';
      panelEl.style.transform = 'translateX(' + dx + 'px)';
    }
    // Force a layout flush so the browser sees the transformed
    // start state before the transition class is applied.
    void window.gBrowser?.tabpanels?.offsetWidth;
    // On the next frame, enable the transition and clear the
    // transform — panels glide to their settled slots.
    requestAnimationFrame(() => {
      for (const { panelEl, isDragged } of moved) {
        panelEl.style.transition =
          'transform var(--bento-duration-base) var(--bento-easing-standard)';
        panelEl.style.transform = '';
        const cleanup = (e) => {
          if (e && e.propertyName !== 'transform') return;
          panelEl.style.transition = '';
          panelEl.style.willChange = '';
          if (isDragged) panelEl.style.zIndex = '';
          panelEl.removeEventListener('transitionend', cleanup);
        };
        panelEl.addEventListener('transitionend', cleanup);
        // Belt-and-suspenders: if transitionend somehow misses,
        // wipe styles after the transition would have completed.
        setTimeout(() => cleanup({ propertyName: 'transform' }), 400);
      }
    });
  }

  // Shadow proxies — sibling-of-tabpanels divs that mirror each
  // panel's bounding rect and render the actual outer box-shadow.
  // Lives outside tabpanels so the shadow extent isn't clipped by
  // tabpanels' overflow context (overflow-x:scroll → CSS spec
  // promotes overflow-y to auto regardless of what we set, which
  // clips outer shadows top + bottom).
  // Visibility gate: only updates shadows for panels that intersect
  // (or are within a one-panel-width margin of) tabpanels' viewport.
  // Offscreen shadow updates are skipped to keep the per-frame cost
  // bounded even with many panels — only the 3-5 visible panels at
  // any moment get their shadow position synced.
  function removePanelShadows(container) {
    for (const sh of container.querySelectorAll(':scope > .bento-panel-shadow')) sh.remove();
  }

  function ensurePanelShadowCount(container, desired) {
    const existing = Array.from(container.querySelectorAll(':scope > .bento-panel-shadow'));
    for (let i = existing.length; i > desired; i--) existing[i - 1].remove();
    for (let i = existing.length; i < desired; i++) {
      const sh = document.createElementNS(HTML_NS, 'div');
      sh.className = 'bento-panel-shadow';
      // Insert as FIRST child so document-order paint puts the
      // proxy BEFORE the host (and the scrollbar / nav). Host then
      // paints over the proxy's interior; shadow extension past
      // panel edges remains visible through host's transparent gap
      // areas and below the host into the scrollbar / nav rows.
      container.insertBefore(sh, container.firstChild);
      existing.unshift(sh);
    }
    return existing;
  }

  function syncMainOnlyPanelShadow(container) {
    const main = document.getElementById('tabbrowser-tabbox');
    if (!main) {
      removePanelShadows(container);
      return;
    }
    const shadows = ensurePanelShadowCount(container, 1);
    const sh = shadows[0];
    sh.classList.add('bento-panel-shadow--strip-start');
    const containerRect = container.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    if (!mainRect.width || !mainRect.height) {
      removePanelShadows(container);
      return;
    }
    sh.style.top = mainRect.top - containerRect.top + 'px';
    sh.style.left = mainRect.left - containerRect.left + 'px';
    sh.style.width = mainRect.width + 'px';
    sh.style.height = mainRect.height + 'px';
  }

  function syncPanelShadows(panelIds) {
    const container = document.getElementById('bento-strip-container');
    const host = document.getElementById('bento-side-panel-host');
    if (!container || !host || !window.gBrowser?.tabpanels) return;
    const tabpanels = window.gBrowser.tabpanels;
    if (!currentPanelShadowsEnabled) {
      removePanelShadows(container);
      return;
    }
    if (container.classList.contains('bento-no-side-panels')) {
      syncMainOnlyPanelShadow(container);
      return;
    }
    // Tear-down: split-view inactive → remove all shadows.
    if (!tabpanels.classList.contains('bento-split-active') || !panelIds.length) {
      removePanelShadows(container);
      return;
    }
    const desired = panelIds.length;
    const existing = ensurePanelShadowCount(container, desired);
    const containerRect = container.getBoundingClientRect();
    // Visibility cull: skip shadow updates for panels whose rect
    // doesn't overlap the visible container area (with one-panel-
    // width margin so shadows are ready when scrolled into view).
    const cullMargin = 800;
    const visLeft = containerRect.left - cullMargin;
    const visRight = containerRect.right + cullMargin;
    for (let i = 0; i < desired; i++) {
      const sh = existing[i];
      const panelEl = document.getElementById(panelIds[i]);
      if (!panelEl) {
        sh.classList.remove('bento-panel-shadow--strip-start');
        continue;
      }
      sh.classList.toggle('bento-panel-shadow--strip-start', panelEl.id === 'tabbrowser-tabbox');
      const pr = panelEl.getBoundingClientRect();
      if (pr.right < visLeft || pr.left > visRight) continue;
      sh.style.top = pr.top - containerRect.top + 'px';
      sh.style.left = pr.left - containerRect.left + 'px';
      sh.style.width = pr.width + 'px';
      sh.style.height = pr.height + 'px';
    }
  }

  function syncInterPanelSplitters(tabsToRender) {
    const host = document.getElementById('bento-side-panel-host');
    if (!host || !window.gBrowser?.tabpanels) return;
    const tabpanels = window.gBrowser.tabpanels;
    let panelIds;
    if (tabsToRender) {
      panelIds = tabsToRender.map((t) => t.linkedPanel).filter((id) => !!id);
    } else {
      panelIds = (tabpanels.splitViewPanels || []).slice();
    }

    // Sync the per-panel shadow proxies. Same trigger conditions as
    // splitters (reconcile, drag, scroll, resize) — the proxies need
    // to track panel rects in lockstep, so piggy-back here rather
    // than re-installing the same listeners.
    syncPanelShadows(panelIds);

    // Splitter count: N-1 between adjacent panel pairs, plus 1 more
    // between the last panel and the Add-panel trailer (when the
    // trailer exists). The extra splitter resizes the LAST panel —
    // without it, the last panel has no drag handle on its right
    // and is only resizable by manipulating other panels.
    const trailer = document.getElementById('bento-add-panel-trailer');
    const baseDesired = Math.max(0, panelIds.length - 1);
    const desired = baseDesired + (trailer && panelIds.length > 0 ? 1 : 0);
    const existing = Array.from(host.querySelectorAll(':scope > .bento-panel-splitter'));

    for (let i = existing.length; i > desired; i--) {
      existing[i - 1].remove();
    }
    for (let i = existing.length; i < desired; i++) {
      const sp = createPanelSplitter();
      host.appendChild(sp);
      existing.push(sp);
    }

    // (Re-)observe the current panel set with the shared
    // ResizeObserver so any width change (drag, close-animation,
    // workspace switch, layout-commit-after-reconcile) re-runs
    // this sync without us having to find every code path that
    // mutates panel widths. Disconnect first so panels removed
    // from the set don't keep firing the callback.
    if (__bentoSplitterRO) {
      __bentoSplitterRO.disconnect();
    }

    if (desired === 0) {
      // No splitters to position; observer is already disconnected.
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const SPLITTER_WIDTH = 14;
    for (let i = 0; i < desired; i++) {
      const sp = existing[i];
      const leftPanelEl = document.getElementById(panelIds[i]);
      if (!leftPanelEl) continue;
      const lr = leftPanelEl.getBoundingClientRect();
      // The right "neighbour" is either the next panel (for inter-
      // panel splitters) or the trailer (for the last splitter).
      // Both code paths centre on the gap between the two elements
      // so the painted bar visually aligns regardless of which
      // splitter type it is. Since the trailer now lives inside
      // tabpanels (scrolling with the strip), the last splitter
      // tracks the last panel naturally — no clamp needed.
      const isLastSplitter = i === panelIds.length - 1;
      let gapCentre;
      if (isLastSplitter) {
        if (!trailer) continue;
        const tr = trailer.getBoundingClientRect();
        gapCentre = (lr.right + tr.left) / 2;
      } else {
        const rightPanelEl = document.getElementById(panelIds[i + 1]);
        if (!rightPanelEl) continue;
        const rr = rightPanelEl.getBoundingClientRect();
        gapCentre = (lr.right + rr.left) / 2;
      }
      sp._bentoLeftPanelId = panelIds[i];
      sp.style.position = 'absolute';
      sp.style.top = lr.top - hostRect.top + 'px';
      sp.style.height = lr.height + 'px';
      sp.style.left = gapCentre - hostRect.left - SPLITTER_WIDTH / 2 + 'px';
      sp.style.width = SPLITTER_WIDTH + 'px';
      sp.style.minWidth = SPLITTER_WIDTH + 'px';
      sp.style.maxWidth = SPLITTER_WIDTH + 'px';
      sp.style.zIndex = '5';
    }
    // Re-observe after positioning so the next layout commit
    // triggers a re-sync. Observe both the left AND right panel
    // of every boundary plus the right edge of the last panel,
    // so any width change in any panel re-fires.
    if (__bentoSplitterRO) {
      for (const id of panelIds) {
        const el = document.getElementById(id);
        if (el) __bentoSplitterRO.observe(el);
      }
    }
  }

  // ─── Arrow-key panel navigation ────────────────────────────────────────
  // Left / Right arrow keys cycle through panels — main + each side
  // panel, then the Add-panel trailer when present. The "current" item
  // advances from the user's explicit selection; pressing Right scrolls
  // the next item into view, Left scrolls the previous one. Stops at the
  // ends (no wraparound).
  //
  // Suppressed when focus is inside any input / textarea / contenteditable
  // (URL bars, form fields, etc.) so the keys still move the text caret.
  // Arrow keys pressed inside a remote content browser don't bubble to
  // chrome — the content process consumes them — so webpages keep
  // their arrow-key behaviour for free.
  function getOrderedPanels() {
    // Panels live as notificationbox children of gBrowser.tabpanels,
    // in tabpanels.splitViewPanels order. The reconciler stamps
    // data-bento-main-panel / data-bento-panel-tab-id on each panel
    // container so downstream code (drag-reorder, arrow-key cycling,
    // Esc-to-blur) reads tabIds. When tabpanels isn't yet in split-
    // active mode (boot, or no panels in the active workspace), the
    // ordered list is empty.
    if (!window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) {
      return [];
    }
    const out = [];
    const ids = window.gBrowser.tabpanels.splitViewPanels || [];
    for (const panelId of ids) {
      const el = document.getElementById(panelId);
      if (el) out.push(el);
    }
    return out;
  }

  function getPanelCycleTargets() {
    // Cycle targets = ordered panels + the Add-panel trailer (when
    // present). The trailer is a focusable XUL vbox sibling of the
    // panel containers inside tabpanels; including it as the final
    // cycle slot lets Right-arrow past the last panel land on it, and
    // its Enter/Space keydown handler then triggers addNewPanel.
    // applyActiveMarker is naturally a no-op for this index because
    // the favicon strip only renders entries for real panels.
    const targets = getOrderedPanels();
    if (targets.length === 0) return targets;
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (trailer) targets.push(trailer);
    return targets;
  }

  function shouldHandlePanelArrowKey(target) {
    // Bail when arrow keys belong to a text widget or chrome navigation
    // surface that has its own meaning for ←/→. Without these guards the
    // panel cycler steals letter-by-letter cursor movement in the
    // Firefox URL bar / search bar / panel header URL input, and menu
    // navigation in <menupopup>/<menubar>.
    //
    // We check both the event target AND document.activeElement because
    // some chrome widgets dispatch keydown on a wrapper while the focused
    // sub-element (the actual editable) is reported by activeElement.
    const candidates = [target, document.activeElement];
    for (const node of candidates) {
      if (!node) continue;
      // browser.xhtml is XHTML (XML mode), so tagName preserves case for
      // HTML-namespace elements created via createElementNS(HTML_NS, …) —
      // the panel header URL input reports tagName 'input' (lowercase),
      // not 'INPUT'. localName is consistently lowercase across both
      // XUL and HTML namespaces, so use that.
      const tag = node.localName;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
      if (node.isContentEditable) return false;
      // closest() walks up the flattened tree; bail on any chrome
      // editable / navigable container. #urlbar and #searchbar cover the
      // Firefox awesomebar + search field; <menupopup>/<menubar>/<menu>
      // own arrow-key navigation; [role=…] catches custom widgets that
      // self-identify as text/list nav surfaces.
      if (typeof node.closest === 'function') {
        if (
          node.closest(
            '#urlbar, #searchbar, menupopup, menubar, menu, menulist,' +
              ' [role="textbox"], [role="searchbox"], [role="combobox"],' +
              ' [role="menu"], [role="menubar"], [role="listbox"]',
          )
        )
          return false;
      }
    }
    return true;
  }

  function navigatePanels(delta) {
    // Scroll the active host (tabpanels in split-view mode, legacy
    // panel-host otherwise) so the next cycle target is brought into
    // view alongside the favicon-strip marker advance. Without this,
    // panels off-screen of the strip stay off-screen even though the
    // favicon strip indicator advances.
    const host = getStripScrollTarget();
    if (!host) return false;
    const targets = getPanelCycleTargets();
    if (targets.length === 0) return false;

    // Index advances from the user's CURRENT selection — not from
    // wherever the strip happens to be scrolled to. Decoupling these
    // means: (a) repeated cycle clicks always advance one panel even
    // when the strip can't physically scroll further (end of list),
    // (b) the bottom marker stays in sync with what the user just
    // selected, (c) manual scroll (mouse wheel) doesn't change the
    // selection.
    //
    // Endpoint behaviour: clamp by default; wrap when the user has
    // opted into wraparound via Settings. Modulo handles both ends
    // (Left from index 0 wraps to the trailer, Right from the trailer
    // wraps to the main panel).
    let nextIdx;
    if (currentPanelCycleWraparound) {
      const n = targets.length;
      nextIdx = (((currentActiveIdx + delta) % n) + n) % n;
    } else {
      nextIdx = Math.max(0, Math.min(targets.length - 1, currentActiveIdx + delta));
    }
    if (nextIdx === currentActiveIdx) return false;

    const targetPanel = targets[nextIdx];
    const stripLeft = host.getBoundingClientRect().left;
    const panelLeft = targetPanel.getBoundingClientRect().left;
    const targetScrollLeft = host.scrollLeft + (panelLeft - stripLeft);
    host.scrollTo({
      left: Math.max(0, targetScrollLeft),
      behavior: 'smooth',
    });
    setActiveByIndex(nextIdx);
    return true;
  }

  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!shouldHandlePanelArrowKey(e.target)) return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // When focus lives inside a content <browser>, the BentoKey
      // child actor owns Left/Right: it forwards to chrome only when
      // the inner content target is non-editable, so a Wikipedia
      // search input (or any in-page text field) keeps caret motion.
      // shouldHandlePanelArrowKey can't see across the process
      // boundary — document.activeElement reports the <browser>
      // element, not the inner input — so bail here unconditionally
      // when content has focus.
      if (document.activeElement?.localName === 'browser') return;
      e.preventDefault();
      navigatePanels(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    // Up/Down on a cycle-focused panel container scroll the panel's
    // content vertically. Without this, arrow keys produce no scroll
    // because the panel container (a notificationbox) isn't a scroll
    // surface and keyboard focus is on chrome, not content.
    //
    // We can't simply move keyboard focus to the panel's <browser>
    // element to let the content's natural arrow-key handling take
    // over: with focus in content (a remote process), the chrome
    // keydown listener on `window` no longer sees Left/Right key
    // events, breaking cycling. Instead, use the chrome command
    // dispatcher's cmd_scrollLine{Up,Down} which routes scroll
    // commands across the multi-process boundary to whichever
    // browser is currently focused. Brief focus shuffle: focus the
    // browser to direct the command at it, dispatch, then restore
    // focus to the container so Left/Right cycling keeps working.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const target = e.target;
      const isPanelContainer = !!(
        target &&
        target.dataset &&
        (target.dataset.bentoMainPanel || target.dataset.bentoPanelTabId)
      );
      if (!isPanelContainer) return;
      const browser = target.querySelector('browser');
      if (!browser) return;
      e.preventDefault();
      try {
        browser.focus({ preventScroll: true });
        const cmd = e.key === 'ArrowDown' ? 'cmd_scrollLineDown' : 'cmd_scrollLineUp';
        const controller = document.commandDispatcher.getControllerForCommand(cmd);
        controller?.doCommand?.(cmd);
      } catch (err) {
        console.warn('[bento-shell-mount] panel scroll failed:', err);
      } finally {
        try {
          target.focus({ preventScroll: true });
        } catch {
          /* best-effort restore */
        }
      }
    }
  });

  // Scroll the focused panel's content via a frame script. With panel
  // CONTAINER focused (cycle mode), neither contentWindow.scrollBy
  // (returns null for remote=true browsers — frameLoader.docShell is
  // null on the chrome side) nor goDoCommand (vbox has no controllers
  // in its focus chain) reaches the right browser. The reliable
  // cross-process path is to load a tiny frame script into the panel
  // browser, then sendAsyncMessage from chrome — frame script runs in
  // the content process and has direct access to `content.scrollBy`.
  //
  // For the MAIN panel, the underlying browser is the active tab's
  // <browser> (gBrowser.selectedBrowser). We load the frame script
  // into that browser too, on demand.
  const PANEL_SCROLL_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoPanelScroll", function(msg) {' +
    '  try {' +
    '    if (content && typeof content.scrollBy === "function") {' +
    '      content.scrollBy({ left: 0, top: msg.data.dy, behavior: "smooth" });' +
    '    }' +
    '  } catch (e) {}' +
    '});';
  const PANEL_SCROLL_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(PANEL_SCROLL_FRAME_SCRIPT_SRC);

  function ensurePanelScrollFrameScript(browserEl) {
    if (!browserEl || browserEl._bentoScrollScriptLoaded) return;
    try {
      const mm = browserEl.messageManager;
      if (mm && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(PANEL_SCROLL_FRAME_SCRIPT_URL, true);
        browserEl._bentoScrollScriptLoaded = true;
      }
    } catch (err) {
      console.warn('[bento-shell-mount] loadFrameScript failed:', err);
    }
  }

  function getPanelScrollBrowser(panelEl) {
    // For the main panel container (#tabbrowser-tabbox), the actual
    // content lives in the active tab's browser. For side panels,
    // the panel container has its own dedicated <browser> child.
    if (panelEl.dataset && panelEl.dataset.bentoMainPanel) {
      return window.gBrowser ? window.gBrowser.selectedBrowser : null;
    }
    return panelEl.querySelector('browser');
  }

  function scrollPanelContent(panelEl, dy) {
    const browser = getPanelScrollBrowser(panelEl);
    if (!browser) return false;
    ensurePanelScrollFrameScript(browser);
    try {
      const mm = browser.messageManager;
      if (mm && typeof mm.sendAsyncMessage === 'function') {
        mm.sendAsyncMessage('BentoPanelScroll', { dy });
        return true;
      }
    } catch (err) {
      console.warn('[bento-shell-mount] sendAsyncMessage failed:', err);
    }
    return false;
  }

  // Keyboard scroll within the focused panel. Active only when focus
  // is on a panel container (data-bento-main-panel /
  // data-bento-panel-tab-id) — i.e. the user is in cycle mode. The
  // panel header buttons / URL input pass through (they're inside the
  // panel but not the container itself, so default behaviour wins).
  // Once focus is inside a content browser, content handles these keys
  // natively in the content process, so this listener doesn't even
  // see them.
  const SCROLL_LINE_PX = 40;
  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const isUp = e.key === 'ArrowUp';
    const isDown = e.key === 'ArrowDown';
    const isSpace = e.key === ' ' || e.code === 'Space';
    if (!isUp && !isDown && !isSpace) return;
    const active = document.activeElement;
    if (!active || !active.dataset) return;
    if (!active.dataset.bentoMainPanel && !active.dataset.bentoPanelTabId) return;
    const panelBrowser = getPanelScrollBrowser(active);
    const panelHeight = panelBrowser?.clientHeight || 600;
    const pageStep = Math.max(SCROLL_LINE_PX, panelHeight - SCROLL_LINE_PX);
    let dy = 0;
    if (isUp) dy = -SCROLL_LINE_PX;
    else if (isDown) dy = SCROLL_LINE_PX;
    else if (isSpace) dy = e.shiftKey ? -pageStep : pageStep;
    if (dy === 0) return;
    e.preventDefault();
    e.stopPropagation();
    scrollPanelContent(active, dy);
  });

  // ESC inside a panel returns focus to the panel container itself,
  // letting the user resume arrow-key cycling. Skipped while any of
  // the chrome overlays (palette / confirm / edit-workspace) is open
  // — those have their own ESC dismiss handlers (see
  // attachPaletteEscListener) which run earlier in capture phase
  // and stopPropagation, so we only see ESC when no overlay is
  // intercepting. Skipped for keystrokes inside a remote content
  // browser too — those don't bubble into chrome (different process).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const active = document.activeElement;
    if (!active) return;
    const panels = getOrderedPanels();
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      // Already on the panel container itself — nothing to escape from.
      if (active === panel) continue;
      if (panel.contains(active)) {
        e.preventDefault();
        e.stopPropagation();
        // Blur whatever input/button currently has focus, then focus
        // the panel container. Re-applies the cycle indicator so the
        // user has a visual cue they're back in panel-cycle mode.
        try {
          if (typeof active.blur === 'function') active.blur();
        } catch {
          /* best-effort */
        }
        setActiveByIndex(i);
        return;
      }
    }
  });

  // ─── Panel navigator (favicon strip + cycle buttons) ──────────────────
  // Sits below the strip in a column-flex wrapper. Replaces the native
  // horizontal scrollbar. Buttons cycle panels (same as ←/→ keys).
  // Favicons map to panels in DOM order: main + each side panel. Click
  // a favicon → scroll that panel to the leftmost position.

  function getMainTabFavicon() {
    try {
      return window.gBrowser?.selectedTab?.image || '';
    } catch {
      return '';
    }
  }

  function scrollPanelToLeftmost(panelEl) {
    if (!panelEl) return;
    // Use getStripScrollTarget() — in split-view mode the actual
    // scroll context is #tabbrowser-tabpanels (Firefox's native deck),
    // NOT #bento-side-panel-host. Hardcoding the host meant favicon
    // clicks scrolled the wrong container in split-view, which both
    // failed to bring the panel into view AND visually misaligned the
    // inter-panel splitters (their absolute positions are computed
    // relative to the active scroll container — scrolling the wrong
    // one leaves splitters anchored to the live tabpanels offsets but
    // visually painted at the host's offsets). The cycle handler at
    // ~line 2015 already uses this helper for the same reason. */
    const host = getStripScrollTarget();
    if (!host) return;
    const stripLeft = host.getBoundingClientRect().left;
    const panelLeft = panelEl.getBoundingClientRect().left;
    const targetScrollLeft = host.scrollLeft + (panelLeft - stripLeft);
    host.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
  }

  // Minimal-scroll variant for "newly-added panel" auto-scroll. If the
  // panel is already fully on screen, no-op. If it sits past the right
  // edge (the common case — new panels append rightward, after either
  // the source panel for openAt or at the end for plain add), nudge
  // just far enough that the panel's right edge meets the viewport's
  // right edge — keeping the previously-visible panels (including the
  // source) in view to the left. If the panel sits past the left edge,
  // align its left edge instead. Wider-than-viewport panels can't be
  // fully shown; fall back to leftmost alignment so the header is at
  // least visible.
  function scrollPanelIntoViewFromRight(panelEl) {
    if (!panelEl) return;
    const host = getStripScrollTarget();
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const fullyVisible =
      panelRect.left >= hostRect.left - 1 && panelRect.right <= hostRect.right + 1;
    if (fullyVisible) return;
    if (panelRect.width > hostRect.width) {
      scrollPanelToLeftmost(panelEl);
      return;
    }
    let delta = 0;
    if (panelRect.right > hostRect.right) {
      delta = panelRect.right - hostRect.right;
    } else if (panelRect.left < hostRect.left) {
      delta = panelRect.left - hostRect.left;
    }
    const targetScrollLeft = host.scrollLeft + delta;
    host.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
  }

  function isPanelFullyVisible(panelEl) {
    if (!panelEl) return false;
    const host = getStripScrollTarget();
    if (!host) return false;
    const hostRect = host.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    return panelRect.left >= hostRect.left - 1 && panelRect.right <= hostRect.right + 1;
  }

  function scrollPanelFullyIntoView(panelEl) {
    if (!panelEl) return;
    const host = getStripScrollTarget();
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    if (isPanelFullyVisible(panelEl)) return;
    // Explicit open targets should land as complete panels. Aligning
    // the left edge is more reliable than a minimal right-edge nudge
    // while the trailer width, panel width, and smooth scroll settle.
    const targetScrollLeft = host.scrollLeft + (panelRect.left - hostRect.left);
    host.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
  }

  function scheduleScrollPanelTabIntoView(tabId, options = {}) {
    if (!Number.isInteger(tabId)) return;
    const DEADLINE_MS = 2000;
    const POLL_MS = 50;
    const started = Date.now();
    const tryScroll = () => {
      const panelEl = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
      if (panelEl) {
        if (options.reveal === 'full') {
          scrollPanelFullyIntoView(panelEl);
          if (!isPanelFullyVisible(panelEl) && Date.now() - started <= DEADLINE_MS) {
            setTimeout(tryScroll, 120);
          }
        } else {
          scrollPanelIntoViewFromRight(panelEl);
        }
        return;
      }
      if (Date.now() - started > DEADLINE_MS) return;
      setTimeout(tryScroll, POLL_MS);
    };
    setTimeout(tryScroll, 0);
  }

  // The active panel is the user's current cycle selection. Source of
  // truth for both the bottom favicon marker and the cycle-focus
  // indicator on the panel itself. NOT recomputed from scroll position
  // — that would lose track when the selected panel can't physically
  // scroll to leftmost (end of strip), and would also confuse the
  // "press next again to advance further" semantic.
  let currentActiveIdx = 0;
  let panelFocusTimer = null;
  let panelNavContextMenu = null;
  const PANEL_REMOVE_ANIMATION_MS = 190;

  const SHELL_ACTION_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoShellAction", function(msg) {' +
    '  try {' +
    '    var channel = new content.BroadcastChannel("bento-shell-bus");' +
    '    channel.postMessage({ kind: "action", action: msg.data });' +
    '    channel.close();' +
    '  } catch (e) {}' +
    '});';
  const SHELL_ACTION_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' + encodeURIComponent(SHELL_ACTION_FRAME_SCRIPT_SRC);

  const PANEL_TRAILER_FOCUS_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoPanelTrailerCycleFocus", function(msg) {' +
    '  try {' +
    '    var root = content.document && content.document.documentElement;' +
    '    if (!root) return;' +
    '    if (msg.data && msg.data.focused) {' +
    '      root.setAttribute("data-bento-cycle-focus-add", "1");' +
    '    } else {' +
    '      root.removeAttribute("data-bento-cycle-focus-add");' +
    '    }' +
    '  } catch (e) {}' +
    '});';
  const PANEL_TRAILER_FOCUS_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(PANEL_TRAILER_FOCUS_FRAME_SCRIPT_SRC);

  function dispatchShellAction(action) {
    const shellFrame = document.getElementById('bento-shell-frame');
    if (!shellFrame) return false;
    try {
      const mm = shellFrame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') return false;
      if (!shellFrame._bentoShellActionScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(SHELL_ACTION_FRAME_SCRIPT_URL, true);
        shellFrame._bentoShellActionScriptLoaded = true;
      }
      // Stamp this chrome window's WebExtension windowId on the wire
      // envelope so bento-tools' per-window state lookups
      // (getActiveId(sourceWindowId), browser.tabs.create({windowId, …}))
      // resolve to THIS window's active workspace — not the global
      // fallback. Without this stamp, panel/openAt from a chrome menu
      // item routes to whatever workspace getActiveId(null) returns
      // (lastGlobalActiveId), so in multi-window setups the panel can
      // get registered against a workspace that isn't this window's
      // current one: the new tab is created in this window (focused),
      // gets assigned this window's workspaceId via tabs.onCreated, but
      // the panels list update lands on the wrong workspace. Result:
      // tab appears in the sidebar (wrong workspace's panel filter
      // doesn't exclude it) and never renders as a panel here.
      // The React-side dispatch() in useToolsPort.ts does the same
      // stamping — see the WireAction __windowId envelope notes.
      const windowId = getChromeWindowId();
      const wireAction =
        typeof windowId === 'number' && windowId >= 0
          ? Object.assign({}, action, { __windowId: windowId })
          : action;
      mm.sendAsyncMessage('BentoShellAction', wireAction);
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] shell action dispatch failed:', err);
      return false;
    }
  }

  function setPanelTrailerAddFocus(focused) {
    const frame = document.getElementById('bento-panel-trailer-frame');
    if (!frame) return;
    try {
      const mm = frame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') return;
      if (!frame._bentoPanelTrailerFocusScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(PANEL_TRAILER_FOCUS_FRAME_SCRIPT_URL, true);
        frame._bentoPanelTrailerFocusScriptLoaded = true;
      }
      mm.sendAsyncMessage('BentoPanelTrailerCycleFocus', { focused: !!focused });
    } catch (err) {
      console.warn('[bento-shell-mount] panel trailer focus sync failed:', err);
    }
  }

  function removePanel(tabId) {
    if (!Number.isFinite(tabId)) return;
    hidePanelNavContextMenu();
    const panel = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
    if (!panel) {
      dispatchShellAction({ type: 'tab/close', id: tabId });
      return;
    }
    if (panel._bentoPanelRemoving) return;
    panel._bentoPanelRemoving = true;

    panel.classList.add('bento-panel--removing');

    setTimeout(() => {
      dispatchShellAction({ type: 'tab/close', id: tabId });
    }, PANEL_REMOVE_ANIMATION_MS);
  }

  // Cmd/Ctrl+W in a side panel closes THAT panel, not the active tab.
  // Without this, key_close → cmd_close → BrowserCommands.closeTabOrWindow
  // → gBrowser.removeCurrentTab always closes the main slot's tab, even
  // when focus is in a side panel — out of step with the user's mental
  // model ("close the thing in front of me").
  //
  // Capture phase + the key's reserved="true" flag means we see the
  // keydown on the chrome window even while content has focus, and
  // stopImmediatePropagation aborts before the XUL <key> binding fires.
  // Main panel (data-bento-main-panel) intentionally falls through:
  // closing the main panel IS closing the active tab, which is what
  // stock Cmd+W already does. Shift/Alt skipped so Cmd+Shift+W (close
  // window) and other compound shortcuts keep their meaning.
  window.addEventListener(
    'keydown',
    (e) => {
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.altKey || e.shiftKey) return;
      if (e.code !== 'KeyW') return;
      const active = document.activeElement;
      if (!active || typeof active.closest !== 'function') return;
      const panel = active.closest('[data-bento-panel-tab-id]');
      if (!panel) return;
      const tabId = Number(panel.dataset.bentoPanelTabId);
      if (!Number.isFinite(tabId)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      removePanel(tabId);
    },
    true /* capture */,
  );

  // Cmd/Ctrl+S toggles the sidebar collapsed state. Firefox's stock
  // key_savePage is patched to reserved="true" (patches/core-ui/
  // 07-key-savepage-reserved.patch) so chrome's capture-phase listener
  // sees the keydown even when content has focus, and content can no
  // longer intercept it. We stopImmediatePropagation to abort the
  // Browser:SavePage command — File → Save Page As stays available via
  // the menu for users who still need to save.
  //
  // Current collapsed state is read from #bento-shell-host's class
  // (set by applyChromeSidebarCollapsed on each panels/sync). Dispatch
  // settings/update with the toggled value; tools persists + broadcasts
  // back via BENTO_PANELS, and applyChromeSidebarCollapsed re-applies
  // the class so the next press toggles the other way.
  window.addEventListener(
    'keydown',
    (e) => {
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.altKey || e.shiftKey) return;
      if (e.code !== 'KeyS') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const host = document.getElementById('bento-shell-host');
      const currentlyCollapsed = !!host?.classList.contains('bento-sidebar-collapsed');
      dispatchShellAction({
        type: 'settings/update',
        changes: { sidebarCollapsed: !currentlyCollapsed },
      });
    },
    true /* capture */,
  );

  function hidePanelNavContextMenu() {
    if (!panelNavContextMenu) return;
    panelNavContextMenu.remove();
    panelNavContextMenu = null;
  }

  function showPanelNavContextMenu(tabId, x, y) {
    hidePanelNavContextMenu();
    const menu = document.createElementNS(HTML_NS, 'div');
    menu.className = 'bento-panel-nav-menu';
    menu.setAttribute('role', 'menu');

    const removeBtn = document.createElementNS(HTML_NS, 'button');
    removeBtn.type = 'button';
    removeBtn.className = 'bento-panel-nav-menu__item';
    removeBtn.setAttribute('role', 'menuitem');
    removeBtn.textContent = 'Remove panel';
    removeBtn.addEventListener('click', () => removePanel(tabId));
    menu.appendChild(removeBtn);

    document.documentElement.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    panelNavContextMenu = menu;

    setTimeout(() => {
      removeBtn.focus();
    }, 0);
  }

  // Apply a preset width to a single side panel. Mirrors the inline
  // style writes that endPanelDrag produces during a drag so the
  // resize is instant — bento-tools intentionally does NOT broadcast
  // panels/sync after panel/setWidth (see protocol-handler.ts) to
  // avoid clobbering live drag layouts, so the persisted value only
  // re-applies on a future unrelated reconcile. Without the inline
  // write the panel would visually stay at its old width until then.
  // The shared ResizeObserver re-syncs inter-panel splitters on the
  // next layout commit.
  function applyPanelWidth(panelEl, widthPx) {
    if (!panelEl) return;
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const tabIdAttr = panelEl.dataset.bentoPanelTabId;
    const tabId = tabIdAttr ? Number(tabIdAttr) : NaN;
    if (!Number.isFinite(tabId)) return;
    const px = Math.round(widthPx);
    // One-shot transition for menu-driven (non-drag) resizes. Drag uses
    // pointermove which writes inline width every frame — a transition
    // there lags the cursor. Menu-driven resizes have no follow-along
    // pointer, so snapping reads as jarring; ease the change instead.
    // Same shape as the workspace-switch main-panel transition (see
    // reconcilePanels). Snappy curve matches the workspace-switch tab-
    // list slide so simultaneous transitions feel like one motion.
    // Inline `transition` is cleared after 250ms so subsequent drags
    // revert to instant.
    const snappy = 'var(--bento-easing-snappy, cubic-bezier(0.32, 0.72, 0, 1))';
    panelEl.style.transition =
      'width var(--bento-duration-base, 200ms) ' + snappy +
      ', min-width var(--bento-duration-base, 200ms) ' + snappy +
      ', flex-basis var(--bento-duration-base, 200ms) ' + snappy;
    window.setTimeout(() => {
      panelEl.style.removeProperty('transition');
    }, 250);
    panelEl.style.width = px + 'px';
    panelEl.style.minWidth = px + 'px';
    panelEl.style.flex = '0 0 ' + px + 'px';
    dispatchShellAction({ type: 'panel/setWidth', id: tabId, widthPx: px });
  }

  function applyActiveMarker(idx) {
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list) return;
    for (let i = 0; i < list.children.length; i++) {
      list.children[i].classList.toggle('bento-panel-nav__icon--active', i === idx);
    }
  }

  // Panel-itself focus indicator (inset ring). Auto-removed 1.5s after
  // the last nav action so it doesn't linger when the user stops
  // cycling. Each setActiveByIndex call resets the timer, so cycling
  // through several panels in quick succession keeps the ring visible.
  function applyPanelFocusIndicator(idx) {
    const targets = getPanelCycleTargets();
    for (const target of targets) target.classList.remove('bento-panel--cycle-focused');
    setPanelTrailerAddFocus(false);
    if (idx < 0 || idx >= targets.length) return;
    const target = targets[idx];
    target.classList.add('bento-panel--cycle-focused');
    const isTrailer = target.id === 'bento-add-panel-trailer';
    if (isTrailer) setPanelTrailerAddFocus(true);
    if (panelFocusTimer) clearTimeout(panelFocusTimer);
    panelFocusTimer = setTimeout(() => {
      target.classList.remove('bento-panel--cycle-focused');
      if (isTrailer) setPanelTrailerAddFocus(false);
    }, 1500);
  }

  function applyFocusedPanelIndicator(panelEl) {
    const targets = getPanelCycleTargets();
    for (const target of targets) {
      target.classList.toggle('bento-panel--focused', target === panelEl);
    }
  }

  function setActiveByIndex(idx) {
    currentActiveIdx = idx;
    applyActiveMarker(idx);
    applyPanelFocusIndicator(idx);
    const targets = getPanelCycleTargets();
    if (idx < 0 || idx >= targets.length) return;
    const target = targets[idx];
    // Panel target → focus the panel's <browser> content so the
    // page receives keys natively. Page-bound keyboard extensions
    // (Vimium j/k, Surfingkeys, etc.) only work when their content
    // document has DOM focus; before the BentoKey content actor
    // landed we focused the chrome notificationbox here instead,
    // which made Left/Right cycling work but blocked all other
    // page-bound keys. Now Left/Right is forwarded back to chrome
    // via the actor (see attachContentKeyBridgeListener), so we
    // can keep content-focused as the default.
    //
    // Add-trailer target → focus the outer vbox (NOT its inner
    // panel-trailer-frame iframe). The trailer hosts a moz-extension
    // iframe child since the saved-panels feature; if we focused that
    // iframe, the chrome-side keydown handler on the vbox wouldn't see
    // Enter and the cycle-Enter "create blank panel" UX would break.
    // Mouse hover/click on the iframe's React buttons still works
    // normally — those don't go through this focus path.
    try {
      const isTrailer = target.id === 'bento-add-panel-trailer';
      const browserEl = isTrailer ? null : target.querySelector?.('browser');
      if (browserEl) {
        browserEl.focus({ preventScroll: true });
      } else {
        target.focus({ preventScroll: true });
      }
    } catch {
      /* focus best-effort; some browser elements may reject */
    }
  }

  function buildNavIcon(favIconUrl, title, onClick, tabId) {
    const btn = document.createElementNS(HTML_NS, 'button');
    btn.type = 'button';
    btn.className = 'bento-panel-nav__icon';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    if (favIconUrl) {
      const img = document.createElementNS(HTML_NS, 'img');
      img.src = favIconUrl;
      img.alt = '';
      // If the favicon URL fails to load, fall back to the placeholder
      // dot so the user still sees a uniform-shaped marker for the
      // panel rather than an empty / broken-image button.
      img.addEventListener('error', () => {
        img.remove();
        btn.classList.add('bento-panel-nav__icon--placeholder');
      });
      btn.appendChild(img);
    } else {
      btn.classList.add('bento-panel-nav__icon--placeholder');
    }
    btn.addEventListener('click', (e) => {
      // Drag end synthesises a click on pointerup at the same target —
      // suppress it when a drag actually happened so we don't also
      // scroll-into-view + activate the panel under the released cursor.
      if (btn._bentoSuppressClick) {
        btn._bentoSuppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClick(e);
    });
    // Prevent left-click from moving DOM focus to the button. Without
    // this, the click sequence is: focus → button (mousedown), then
    // focus → panel content browser (setActiveByIndex). Two focus
    // transitions back-to-back cancel the in-progress smooth scroll
    // we kicked off via scrollPanelToLeftmost. Arrow-key cycling
    // doesn't hit this because focus was already in chrome — there's
    // only one focus shift (chrome → panel browser). preventDefault
    // on left mousedown keeps focus stable through the click; the
    // 'click' event still fires (preventDefault on mousedown only
    // suppresses the default focus-on-mousedown behaviour, not the
    // subsequent click event itself). */
    btn.addEventListener('mousedown', (e) => {
      if (e.button === 0) e.preventDefault();
    });
    if (Number.isFinite(tabId)) {
      btn.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
      });
      btn.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        removePanel(tabId);
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showPanelNavContextMenu(tabId, e.clientX, e.clientY);
      });
      setupNavDrag(btn, tabId);
    }
    return btn;
  }

  // ─── Navigator drag-to-reorder ───────────────────────────────────────
  // Side-panel favicon buttons can be dragged horizontally to reorder the
  // panel strip. The user said: "panels should reorder as soon as I let
  // go of the button for performance reasons" — so during the drag we
  // only paint visual state (source dim + drop indicator), and the actual
  // panel/reorder action fires once on pointerup. The reorder snaps in
  // when chrome receives the next panels/sync from tools.
  //
  // Pointer events + setPointerCapture so the drag survives the cursor
  // crossing into a panel's remote=true content browser (same constraint
  // splitter dragging already deals with).
  const NAV_DRAG_THRESHOLD_PX = 4;

  function setupNavDrag(btn, tabId) {
    btn.dataset.bentoNavDraggable = '1';

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let pointerId = null;
    let indicator = null;

    function getList() {
      return document.querySelector('.bento-panel-nav__list');
    }
    // Side-panel buttons in DOM order, excluding the main panel (always
    // index 0) and the drop indicator overlay.
    function getSidePanelButtons(list) {
      const out = [];
      for (let i = 1; i < list.children.length; i++) {
        const child = list.children[i];
        if (child === indicator) continue;
        if (child.classList && child.classList.contains('bento-panel-nav__icon')) {
          out.push(child);
        }
      }
      return out;
    }
    // targetSlot = number of non-source siblings whose midpoint X is to
    // the left of the cursor. Maps to splice index in the new ordering.
    function computeTargetSlot(list, clientX) {
      const siblings = getSidePanelButtons(list).filter((el) => el !== btn);
      let slot = 0;
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect();
        if (clientX > r.left + r.width / 2) slot++;
        else break;
      }
      return slot;
    }
    // Position the indicator at the visual gap for `slot`. Computed in
    // list-local coords (offsetLeft chain) so horizontal scroll inside
    // the list is naturally accounted for. Indicator is absolutely
    // positioned so its presence doesn't reflow the strip.
    function placeIndicator(list, slot) {
      if (!indicator) {
        indicator = document.createElementNS(HTML_NS, 'div');
        indicator.className = 'bento-panel-nav__drop-indicator';
        list.appendChild(indicator);
      } else if (indicator.parentNode !== list) {
        list.appendChild(indicator);
      }
      const siblings = getSidePanelButtons(list).filter((el) => el !== btn);
      const listRect = list.getBoundingClientRect();
      let x;
      if (siblings.length === 0) {
        // Only the source panel exists — indicator at its current spot.
        const r = btn.getBoundingClientRect();
        x = r.left - listRect.left + list.scrollLeft;
      } else if (slot >= siblings.length) {
        const r = siblings[siblings.length - 1].getBoundingClientRect();
        x = r.right - listRect.left + list.scrollLeft;
      } else {
        const r = siblings[slot].getBoundingClientRect();
        x = r.left - listRect.left + list.scrollLeft;
      }
      // Center the 2px bar on the gap.
      const indicatorWidth = indicator.offsetWidth || 2;
      indicator.style.left = (x - indicatorWidth / 2) + 'px';
    }
    function clearIndicator() {
      if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      indicator = null;
    }

    function startDrag(list) {
      if (dragging) return;
      dragging = true;
      btn.classList.add('bento-panel-nav__icon--dragging');
      list.classList.add('bento-panel-nav__list--dragging');
      // Suppress the synthesised click on release so the drop doesn't
      // also scroll-and-activate the (unchanged) panel.
      btn._bentoSuppressClick = true;
      // Drag pre-empts the right-click menu / cycle marker for this btn.
      hidePanelNavContextMenu();
    }
    function endDrag(commit, finalClientX) {
      const list = getList();
      if (dragging && commit && list) {
        const slot = computeTargetSlot(list, finalClientX);
        const panels = getOrderedPanels();
        const currentIds = panels
          .map((p) => Number(p.dataset.bentoPanelTabId))
          .filter((n) => Number.isFinite(n));
        const filtered = currentIds.filter((id) => id !== tabId);
        const clampedSlot = Math.max(0, Math.min(slot, filtered.length));
        filtered.splice(clampedSlot, 0, tabId);
        const changed =
          filtered.length !== currentIds.length ||
          filtered.some((id, i) => currentIds[i] !== id);
        if (changed) dispatchShellAction({ type: 'panel/reorder', tabIds: filtered });
      }
      if (list) list.classList.remove('bento-panel-nav__list--dragging');
      btn.classList.remove('bento-panel-nav__icon--dragging');
      clearIndicator();
      dragging = false;
      pointerId = null;
    }

    btn.addEventListener('pointerdown', (e) => {
      // Left button only; right-click / middle-click already have other
      // handlers (context menu / close).
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw on some pointer types — drag will
           still work, just won't survive cursor crossing remote content. */
      }
    });

    btn.addEventListener('pointermove', (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      if (!dragging) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (dx * dx + dy * dy < NAV_DRAG_THRESHOLD_PX * NAV_DRAG_THRESHOLD_PX) return;
        const list = getList();
        if (!list) return;
        startDrag(list);
      }
      const list = getList();
      if (!list) return;
      placeIndicator(list, computeTargetSlot(list, e.clientX));
    });

    function release(e, commit) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      endDrag(commit, e.clientX);
    }
    btn.addEventListener('pointerup', (e) => release(e, true));
    btn.addEventListener('pointercancel', (e) => release(e, false));
    btn.addEventListener('lostpointercapture', (e) => release(e, dragging));
  }

  // Drag-to-reorder via a dedicated grip handle on the per-panel
  // header. The handle (createPanelHeader's leftmost child) is
  // the only pointerdown target that initiates a drag — the rest
  // of the header still routes to its native controls. Skips
  // the main slot (main stays col 0).
  //
  // During drag the panel container follows the cursor via
  // transform: translateX so the user gets immediate physical
  // feedback. On release the panel CSS-transitions back to its
  // settled spot (transform: 0); if the slot changed, the
  // panel/reorder dispatch updates layout in the same frame.
  function setupHeaderDrag(header, panelEl, tabId) {
    if (!Number.isFinite(tabId) || !panelEl) return;
    if (panelEl.dataset.bentoMainPanel === '1') return;
    const handle = header.querySelector('.bento-panel-header-drag-handle');
    if (!handle) return;

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let pointerId = null;
    let indicator = null;

    function getStripContainer() {
      return document.getElementById('bento-side-panel-host');
    }
    // All split-view panels in visual order including main.
    function getPanels() {
      return getOrderedPanels();
    }
    // Side panels (excluding main) in visual order. Excludes the
    // dragged source so target-slot math is straightforward.
    function getDropTargets() {
      return getPanels()
        .filter((p) => p.dataset.bentoPanelTabId)
        .filter((p) => p !== panelEl);
    }
    // targetSlot = number of non-source side panels whose midpoint
    // is to the left of the cursor. Maps to splice index in the
    // post-reorder side-panel array.
    function computeTargetSlot(clientX) {
      const targets = getDropTargets();
      let slot = 0;
      for (const t of targets) {
        const r = t.getBoundingClientRect();
        if (clientX > r.left + r.width / 2) slot++;
        else break;
      }
      return slot;
    }
    // Position a vertical bar at the boundary the panel will land
    // at. Hosted in #bento-side-panel-host with absolute positioning,
    // matching the inter-panel splitter pattern.
    function placeIndicator(slot) {
      const host = getStripContainer();
      if (!host) return;
      if (!indicator) {
        indicator = document.createElementNS(HTML_NS, 'div');
        indicator.className = 'bento-panel-drop-indicator';
        host.appendChild(indicator);
      }
      const targets = getDropTargets();
      const main = getPanels().find((p) => p.dataset.bentoMainPanel === '1');
      const hostRect = host.getBoundingClientRect();
      let x;
      if (targets.length === 0 && main) {
        // Only main + dragged source — drop spot is just after main.
        const r = main.getBoundingClientRect();
        x = r.right - hostRect.left;
      } else if (slot >= targets.length) {
        const r = targets[targets.length - 1].getBoundingClientRect();
        x = r.right - hostRect.left;
      } else if (slot === 0) {
        // Drop before the first side panel — between main and it.
        const r = targets[0].getBoundingClientRect();
        x = r.left - hostRect.left;
      } else {
        const r = targets[slot].getBoundingClientRect();
        x = r.left - hostRect.left;
      }
      const indicatorWidth = 3;
      indicator.style.position = 'absolute';
      indicator.style.top = '0';
      indicator.style.bottom = '0';
      indicator.style.left = x - indicatorWidth / 2 + 'px';
      indicator.style.width = indicatorWidth + 'px';
      indicator.style.zIndex = '6';
    }
    function clearIndicator() {
      if (indicator?.parentNode) indicator.parentNode.removeChild(indicator);
      indicator = null;
    }

    function startDrag() {
      if (dragging) return;
      dragging = true;
      handle.classList.add('bento-panel-header-drag-handle--dragging');
      panelEl.classList.add('bento-panel--dragging');
      // Hide all inter-panel splitters for the duration of the
      // drag. Their absolute-positioned overlays are anchored to
      // panel rects via syncInterPanelSplitters, but during the
      // drag the panel transforms (translate) without firing the
      // ResizeObserver — splitters end up partially out of sync
      // and visually trail. Cleanest is to skip them entirely;
      // they re-sync (and re-appear) when the reconciler settles
      // the post-drop layout.
      const host = document.getElementById('bento-side-panel-host');
      if (host) host.classList.add('bento-side-panel-host--reordering');
      // No transition while the user is actively dragging — the
      // transform should stick to the cursor 1:1. The release
      // handler re-enables it before resetting transform so the
      // snap-back / settle is animated.
      panelEl.style.transition = 'none';
      panelEl.style.willChange = 'transform';
      panelEl.style.zIndex = '10';
      hidePanelNavContextMenu();
      document.documentElement.style.setProperty('cursor', 'grabbing', 'important');
      document.documentElement.style.setProperty('user-select', 'none', 'important');
    }
    function followCursor(clientX) {
      const dx = clientX - startX;
      panelEl.style.transform = 'translateX(' + dx + 'px)';
    }
    function endDrag(commit, finalClientX) {
      let dispatched = false;
      if (dragging && commit) {
        const slot = computeTargetSlot(finalClientX);
        const sidePanelEls = getPanels().filter((p) => p.dataset.bentoPanelTabId);
        const currentIds = sidePanelEls
          .map((p) => Number(p.dataset.bentoPanelTabId))
          .filter((n) => Number.isFinite(n));
        const filtered = currentIds.filter((id) => id !== tabId);
        const clampedSlot = Math.max(0, Math.min(slot, filtered.length));
        filtered.splice(clampedSlot, 0, tabId);
        const changed =
          filtered.length !== currentIds.length ||
          filtered.some((id, i) => currentIds[i] !== id);
        if (changed) {
          // Snapshot every visible side panel's pre-reorder rect.
          // The reconciler that runs after panels/sync arrives will
          // read this via runPendingPanelFlip and animate every
          // panel (including the dragged one) from its old screen
          // position to its new slot.
          //
          // For the DRAGGED panel we record the cursor's release
          // X instead of the layout left edge: the panel is
          // currently displayed at cursorX (transform follows
          // cursor), so the FLIP needs to use that as its
          // "old position" anchor. Without this the dragged panel
          // visually snaps back to its source slot for one frame
          // before re-appearing at its destination.
          const snap = new Map();
          for (const p of sidePanelEls) {
            const id = Number(p.dataset.bentoPanelTabId);
            if (!Number.isFinite(id)) continue;
            if (id === tabId) {
              // Use the dragged panel's CURRENT painted rect —
              // includes the live drag transform — so the FLIP
              // can compute newRect.left - paintedLeft to
              // counter-translate.
              snap.set(id, p.getBoundingClientRect());
            } else {
              // Non-dragged panels are at their layout positions.
              snap.set(id, p.getBoundingClientRect());
            }
          }
          snap.__draggedTabId = tabId;
          __bentoPendingFlip = snap;
          dispatchShellAction({ type: 'panel/reorder', tabIds: filtered });
          dispatched = true;
          // Don't clear the dragged panel's transform yet — the
          // FLIP runner will replace it with a counter-transform
          // matching the post-reorder layout, then transition
          // to translate(0). Clearing it now would animate the
          // panel back to its OLD slot for the brief window
          // before the reconciler runs, which is the bug we're
          // fixing.
        }
      }
      // Snap-back path: no commit OR no actual reorder. Animate
      // the dragged panel back to its original slot.
      if (dragging && !dispatched) {
        panelEl.style.transition =
          'transform var(--bento-duration-base) var(--bento-easing-standard)';
        panelEl.style.transform = '';
        const cleanup = () => {
          panelEl.style.transition = '';
          panelEl.style.willChange = '';
          panelEl.style.zIndex = '';
          panelEl.removeEventListener('transitionend', cleanup);
        };
        panelEl.addEventListener('transitionend', cleanup);
        setTimeout(cleanup, 400);
      }
      handle.classList.remove('bento-panel-header-drag-handle--dragging');
      panelEl.classList.remove('bento-panel--dragging');
      const host = document.getElementById('bento-side-panel-host');
      if (host) host.classList.remove('bento-side-panel-host--reordering');
      // Splitters were hidden during the drag; immediately re-sync
      // their positions so they re-appear at the post-drop layout
      // boundaries without waiting for the ResizeObserver tick.
      try {
        syncInterPanelSplitters();
      } catch (err) {
        console.warn('[bento-shell-mount] post-drop splitter sync failed:', err);
      }
      clearIndicator();
      document.documentElement.style.removeProperty('cursor');
      document.documentElement.style.removeProperty('user-select');
      dragging = false;
      pointerId = null;
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort capture */
      }
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener('pointermove', (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      if (!dragging) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (dx * dx + dy * dy < NAV_DRAG_THRESHOLD_PX * NAV_DRAG_THRESHOLD_PX) return;
        startDrag();
      }
      followCursor(e.clientX);
      placeIndicator(computeTargetSlot(e.clientX));
    });

    function release(e, commit) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      endDrag(commit, e.clientX);
    }
    handle.addEventListener('pointerup', (e) => release(e, true));
    handle.addEventListener('pointercancel', (e) => release(e, false));
    handle.addEventListener('lostpointercapture', (e) => release(e, dragging));
  }

  function refreshPanelNavMain() {
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list || list.children.length === 0) return;
    const mainBtn = list.children[0];
    const fav = getMainTabFavicon();
    while (mainBtn.firstChild) mainBtn.removeChild(mainBtn.firstChild);
    if (fav) {
      mainBtn.classList.remove('bento-panel-nav__icon--placeholder');
      const img = document.createElementNS(HTML_NS, 'img');
      img.src = fav;
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        mainBtn.classList.add('bento-panel-nav__icon--placeholder');
      });
      mainBtn.appendChild(img);
    } else {
      mainBtn.classList.add('bento-panel-nav__icon--placeholder');
    }
  }

  // Called from reconcilePanels with the current desired panel list.
  // Diff-based update so favicon buttons that survive a reconcile
  // (same tabId still present) are reused — that preserves their
  // pointer-capture / drag state and lets the enter/leave width
  // transition only fire for icons that are actually new or going
  // away. The full innerHTML='' rebuild used previously made every
  // reconcile look like every favicon was new (no animation possible)
  // and tore down drag listeners between reconciles.
  function refreshPanelNav(panels) {
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list) return;
    hidePanelNavContextMenu();

    // Index existing children by their bento nav key. Skip ones already
    // mid-leave so they're not accidentally reused.
    const existing = new Map();
    for (const child of Array.from(list.children)) {
      if (child.dataset.bentoNavLeaving === '1') continue;
      const key = child.dataset.bentoNavKey;
      if (key) existing.set(key, child);
    }

    // Desired keys in order: 'main' first, then each panel tabId.
    const desiredKeys = ['main'];
    for (const panel of panels) desiredKeys.push(String(panel.tabId));

    // Build / reuse each desired icon in order, collecting which ones
    // are new (need enter animation).
    const desiredEls = [];
    const newEls = [];
    for (let i = 0; i < desiredKeys.length; i++) {
      const key = desiredKeys[i];
      let btn = existing.get(key);
      if (btn) {
        existing.delete(key);
      } else {
        // New icon — construct via buildNavIcon with the right handler.
        if (key === 'main') {
          btn = buildNavIcon(getMainTabFavicon(), 'Main panel', () => {
            const ordered = getOrderedPanels();
            const main = ordered[0] || document.getElementById('tabbrowser-tabbox');
            scrollPanelToLeftmost(main);
            setActiveByIndex(0);
          });
        } else {
          const tabId = Number(key);
          btn = buildNavIcon(
            panels[i - 1].favIconUrl || '',
            'Panel',
            () => {
              const el = document.querySelector(
                '[data-bento-panel-tab-id="' + tabId + '"]',
              );
              if (el) scrollPanelToLeftmost(el);
              // Re-compute the icon's CURRENT index in the live nav
              // list (skipping any leaving siblings) — the closure
              // index captured at build time goes stale as other
              // panels add/remove around this one.
              const targets = getPanelCycleTargets();
              const idx = targets.findIndex(
                (t) => t.dataset.bentoPanelTabId === String(tabId),
              );
              setActiveByIndex(idx >= 0 ? idx : 0);
            },
            tabId,
          );
        }
        btn.dataset.bentoNavKey = key;
        btn.classList.add('bento-panel-nav__icon--entering');
        newEls.push(btn);
      }
      desiredEls.push(btn);
    }

    // Re-order: appendChild moves existing children to the end, so
    // iterating in desired order yields the final order.
    for (const el of desiredEls) list.appendChild(el);

    // Departing icons — animate out then remove.
    for (const [, el] of existing) {
      el.dataset.bentoNavLeaving = '1';
      el.classList.add('bento-panel-nav__icon--leaving');
      setTimeout(
        () => {
          el.remove();
        },
        // Match the transition duration in CSS; small buffer for
        // sub-frame scheduling. --bento-duration-base is 200ms.
        260,
      );
    }

    // Trigger enter animation on next frame so the browser commits
    // the initial 'entering' (width:0) state before we remove the
    // class. Without the rAF, browsers may collapse both states into
    // one paint and skip the transition.
    if (newEls.length > 0) {
      requestAnimationFrame(() => {
        for (const el of newEls) {
          el.classList.remove('bento-panel-nav__icon--entering');
        }
      });
    }

    // Keep the main favicon up to date (selectedTab can change without
    // refreshPanelNav being called for tab favicons, but when it IS
    // called we want the freshest favicon).
    const mainBtn = desiredEls[0];
    if (mainBtn) refreshNavIconImage(mainBtn, getMainTabFavicon());

    // Clamp active index to current cycle target count and re-paint
    // the marker (panel count may have decreased since the last
    // selection). The Add-panel trailer is part of keyboard cycling
    // but has no favicon marker, so applyActiveMarker naturally
    // leaves all favicons unmarked when it is selected.
    const total = getPanelCycleTargets().length;
    if (currentActiveIdx >= total) currentActiveIdx = 0;
    applyActiveMarker(currentActiveIdx);
  }

  // Update a nav-icon button's <img> src without rebuilding the button
  // (preserves drag state). Mirrors the placeholder fallback from
  // buildNavIcon.
  function refreshNavIconImage(btn, favIconUrl) {
    let img = btn.querySelector('img');
    if (favIconUrl) {
      btn.classList.remove('bento-panel-nav__icon--placeholder');
      if (img) {
        if (img.src !== favIconUrl) img.src = favIconUrl;
      } else {
        img = document.createElementNS(HTML_NS, 'img');
        img.src = favIconUrl;
        img.alt = '';
        img.addEventListener('error', () => {
          img.remove();
          btn.classList.add('bento-panel-nav__icon--placeholder');
        });
        btn.appendChild(img);
      }
    } else {
      if (img) img.remove();
      btn.classList.add('bento-panel-nav__icon--placeholder');
    }
  }

  // ─── Custom always-on horizontal scrollbar ────────────────────────────
  // macOS auto-hides native scrollbars regardless of CSS. We hide the
  // native one and draw our own that stays put: a track + a draggable
  // thumb, sized proportionally to (visible / total) panel-strip width.
  // setPointerCapture on the thumb so drags continue when the cursor
  // crosses over a remote content browser (same reason inter-panel
  // splitters use it).
  // Returns the element whose horizontal scroll the custom scrollbar
  // should track. In split-view mode, the actual scroll context is
  // #tabbrowser-tabpanels (Firefox's native deck — content-area.css and
  // our injected overflow-x: auto make it scrollable when N panels
  // exceed viewport width). In the legacy parallel-browser path, it's
  // #bento-side-panel-host. Single helper so updateStripScrollbar +
  // pointer drag handlers + track-click all stay aligned.
  function getStripScrollTarget() {
    // Once the reconciler has activated split-view mode, the deck
    // (#tabbrowser-tabpanels) IS the scroll context for the panel
    // strip. Before then (boot, or no panels in this workspace), the
    // unified host vbox is the strip and tabpanels is just main.
    if (window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) {
      return window.gBrowser.tabpanels;
    }
    return document.getElementById('bento-side-panel-host');
  }

  function updateStripScrollbar() {
    const host = getStripScrollTarget();
    const bar = document.getElementById('bento-strip-scrollbar');
    if (!host || !bar) return;
    // Show ONLY when there's actually overflow. +1 tolerance for
    // sub-pixel rounding so the scrollbar doesn't flicker on a
    // borderline content size. When visible it stays visible (no
    // auto-hide); only the overflow check toggles it.
    const hasOverflow = host.scrollWidth > host.clientWidth + 1;
    bar.style.display = hasOverflow ? '' : 'none';
    if (!hasOverflow) return;

    const thumb = bar.querySelector('.bento-strip-scrollbar__thumb');
    if (!thumb) return;
    const trackWidth = bar.clientWidth;
    if (trackWidth <= 0) return;
    // Thumb width proportional to visible/total ratio. 30px min via CSS
    // so it stays grabbable even with very wide overflow.
    const ratio = host.clientWidth / host.scrollWidth;
    const thumbWidth = Math.max(30, trackWidth * ratio);
    const scrollableWidth = host.scrollWidth - host.clientWidth;
    const scrollRatio = scrollableWidth > 0 ? host.scrollLeft / scrollableWidth : 0;
    const thumbLeft = (trackWidth - thumbWidth) * scrollRatio;
    thumb.style.width = thumbWidth + 'px';
    thumb.style.transform = 'translateX(' + thumbLeft + 'px)';
  }

  function buildStripScrollbar() {
    const bar = document.createElementNS(HTML_NS, 'div');
    bar.id = 'bento-strip-scrollbar';
    const thumb = document.createElementNS(HTML_NS, 'div');
    thumb.className = 'bento-strip-scrollbar__thumb';
    bar.appendChild(thumb);

    let dragState = null; // { startX, startScrollLeft, pointerId }

    thumb.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const host = getStripScrollTarget();
      if (!host) return;
      dragState = {
        startX: e.clientX,
        startScrollLeft: host.scrollLeft,
        pointerId: e.pointerId,
      };
      thumb.classList.add('bento-strip-scrollbar__thumb--dragging');
      try {
        thumb.setPointerCapture(e.pointerId);
      } catch (err) {
        console.warn('[bento-shell-mount] scrollbar setPointerCapture failed:', err);
      }
    });

    thumb.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const host = getStripScrollTarget();
      if (!host) return;
      const trackWidth = bar.clientWidth - thumb.clientWidth;
      const scrollableWidth = host.scrollWidth - host.clientWidth;
      if (trackWidth <= 0 || scrollableWidth <= 0) return;
      const pixelDelta = e.clientX - dragState.startX;
      const ratio = scrollableWidth / trackWidth;
      host.scrollLeft = Math.max(
        0,
        Math.min(scrollableWidth, dragState.startScrollLeft + pixelDelta * ratio),
      );
    });

    function endDrag(e) {
      if (!dragState) return;
      if (e && e.pointerId !== undefined && e.pointerId !== dragState.pointerId) return;
      try {
        thumb.releasePointerCapture(dragState.pointerId);
      } catch {
        /* already released */
      }
      dragState = null;
      thumb.classList.remove('bento-strip-scrollbar__thumb--dragging');
    }
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);
    thumb.addEventListener('lostpointercapture', () => endDrag(null));

    // Click on the empty track jumps the scroll to that position.
    bar.addEventListener('pointerdown', (e) => {
      if (e.target !== bar) return; // ignore clicks on the thumb
      if (e.button !== 0) return;
      const host = getStripScrollTarget();
      if (!host) return;
      const rect = bar.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const scrollableWidth = host.scrollWidth - host.clientWidth;
      host.scrollTo({
        left: Math.max(0, Math.min(scrollableWidth, ratio * host.scrollWidth - host.clientWidth / 2)),
        behavior: 'smooth',
      });
    });

    return bar;
  }

  // SHIFT + wheel should feel like panel cycling, not like pixel-wise
  // horizontal strip scrolling. Trackpads emit many tiny wheel events;
  // mouse wheels emit fewer, larger line/page events. Normalize both and
  // advance one panel per threshold crossed, reusing navigatePanels so
  // the active marker, focus ring, and edge behavior match arrow keys.
  // A short gesture lock also captures momentum tail events whose
  // shiftKey can drop before the wheel burst has fully ended.
  const PANEL_WHEEL_STEP_PX = 32;
  const PANEL_WHEEL_GESTURE_LOCK_MS = 220;
  let panelWheelRemainder = 0;
  let panelWheelGestureUntil = 0;

  function normalizeWheelDeltaPx(e) {
    const linePx = SCROLL_LINE_PX;
    const pagePx = Math.max(linePx, window.innerWidth || 800);
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? linePx
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? pagePx
          : 1;
    const dominantDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    return dominantDelta * unit;
  }

  // Horizontal scroll anywhere on chrome (sidebar, panel headers, gaps
  // between panels) routes to the panel strip. Gives the user a reliable
  // place to rest the cursor and scroll the strip without panels'
  // horizontally-overflowing web content stealing the scroll. Skips
  // events targeting web content (<browser>) so pages keep handling
  // their own horizontal scroll. Skips modifier gestures so it doesn't
  // collide with Shift+wheel (panel cycling) or Ctrl/Cmd+wheel (zoom).
  function onChromeHorizontalWheel(e) {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target;
    if (target?.localName === 'browser') return;
    if (typeof target?.closest === 'function' && target.closest('browser')) return;
    // Only act on horizontal-dominant deltas. A tie (deltaX === deltaY)
    // is ambiguous; defer to native handling.
    const ax = Math.abs(e.deltaX);
    const ay = Math.abs(e.deltaY);
    if (ax === 0 || ax <= ay) return;
    const stripTarget = getStripScrollTarget();
    if (!stripTarget) return;
    const linePx = SCROLL_LINE_PX;
    const pagePx = Math.max(linePx, window.innerWidth || 800);
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? linePx
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? pagePx
          : 1;
    e.preventDefault();
    stripTarget.scrollLeft += e.deltaX * unit;
  }

  function onPanelStripWheel(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!shouldHandlePanelArrowKey(e.target)) return;
    const isPanelWheelGesture = e.shiftKey || Date.now() < panelWheelGestureUntil;
    if (!isPanelWheelGesture) return;

    const delta = normalizeWheelDeltaPx(e);
    if (!delta) return;

    e.preventDefault();
    e.stopPropagation();
    panelWheelGestureUntil = Date.now() + PANEL_WHEEL_GESTURE_LOCK_MS;
    panelWheelRemainder += delta;

    let steps = 0;
    while (Math.abs(panelWheelRemainder) >= PANEL_WHEEL_STEP_PX) {
      steps += panelWheelRemainder > 0 ? 1 : -1;
      panelWheelRemainder +=
        panelWheelRemainder > 0 ? -PANEL_WHEEL_STEP_PX : PANEL_WHEEL_STEP_PX;
    }

    if (steps === 0) return;
    const direction = steps > 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(steps); i++) {
      if (!navigatePanels(direction)) {
        panelWheelRemainder = 0;
        break;
      }
    }
  }

  function setupPanelNavigator() {
    const host = document.getElementById('bento-side-panel-host');
    if (!host) return;
    if (document.getElementById('bento-strip-container')) return; // already wrapped

    const wrap = document.createXULElement('vbox');
    wrap.id = 'bento-strip-container';
    wrap.setAttribute('flex', '1');
    host.parentNode.insertBefore(wrap, host);
    wrap.appendChild(host);

    // Custom scrollbar between strip and navigator.
    const scrollbar = buildStripScrollbar();
    wrap.appendChild(scrollbar);

    const nav = document.createElementNS(HTML_NS, 'div');
    nav.id = 'bento-panel-nav';

    const prevBtn = document.createElementNS(HTML_NS, 'button');
    prevBtn.type = 'button';
    prevBtn.className = 'bento-panel-nav__btn';
    prevBtn.title = 'Previous panel';
    prevBtn.setAttribute('aria-label', 'Previous panel');
    prevBtn.appendChild(makeIcon(ICONS.chevronLeft));
    prevBtn.addEventListener('click', () => navigatePanels(-1));

    const list = document.createElementNS(HTML_NS, 'div');
    list.className = 'bento-panel-nav__list';

    const addBtn = document.createElementNS(HTML_NS, 'button');
    addBtn.type = 'button';
    addBtn.className = 'bento-panel-nav__btn';
    addBtn.title = 'Add panel';
    addBtn.setAttribute('aria-label', 'Add panel');
    addBtn.appendChild(makeIcon(ICONS.plus));
    addBtn.addEventListener('click', addNewPanel);

    const nextBtn = document.createElementNS(HTML_NS, 'button');
    nextBtn.type = 'button';
    nextBtn.className = 'bento-panel-nav__btn';
    nextBtn.title = 'Next panel';
    nextBtn.setAttribute('aria-label', 'Next panel');
    nextBtn.appendChild(makeIcon(ICONS.chevronRight));
    nextBtn.addEventListener('click', () => navigatePanels(1));

    nav.appendChild(prevBtn);
    nav.appendChild(list);
    nav.appendChild(addBtn);
    nav.appendChild(nextBtn);
    wrap.appendChild(nav);

    // Live updates: tab switches and tab attribute changes (icon, title)
    // refresh the main panel's favicon. We deliberately do NOT update
    // the active marker on scroll — currentActiveIdx is set only by
    // explicit nav (click / button / key), so manual scroll doesn't
    // override the user's selection. The custom scrollbar's thumb
    // position DOES update on scroll though.
    host.addEventListener('scroll', updateStripScrollbar, { passive: true });
    // Shift+wheel panel cycling is attached to the strip CONTAINER, not
    // just the panel host — so the gesture also works when the cursor
    // is over the custom scrollbar (#bento-strip-scrollbar) or the
    // favicon navigator (#bento-panel-nav) underneath the panels.
    // Those are siblings of the host inside #bento-strip-container, so
    // a listener on the host alone never sees their wheel events.
    wrap.addEventListener('wheel', onPanelStripWheel, { capture: true, passive: false });
    // Chrome-wide horizontal-wheel intercept: any side-scroll over the
    // chrome (sidebar, panel headers, between-panel gaps) scrolls the
    // panel strip, so the user always has a reliable surface to rest
    // the cursor on. Capture-phase so it sees the event before any
    // chrome scroll container's native handling; preventDefault on
    // matched events prevents double-scroll. Web content (<browser>)
    // is excluded inside the handler so pages keep their own
    // horizontal scrolling. Once-per-window; setupPanelNavigator runs
    // exactly once at chrome boot.
    window.addEventListener('wheel', onChromeHorizontalWheel, {
      capture: true,
      passive: false,
    });
    // Splitters live in bento-side-panel-host (not tabpanels) because
    // tabpanels' XUL deck refuses to paint non-panel children, so
    // they don't follow tabpanels' horizontal scroll automatically.
    // Re-sync them on every scroll tick of the active strip target so
    // they track the panel boundaries the user actually sees. */
    const stripTarget = getStripScrollTarget();
    if (stripTarget && stripTarget !== host) {
      stripTarget.addEventListener(
        'scroll',
        () => {
          syncInterPanelSplitters();
        },
        { passive: true },
      );
    }
    window.addEventListener('mousedown', (e) => {
      if (panelNavContextMenu && !panelNavContextMenu.contains(e.target)) {
        hidePanelNavContextMenu();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePanelNavContextMenu();
    });
    window.addEventListener('blur', hidePanelNavContextMenu);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(updateStripScrollbar);
      ro.observe(host);
    }
    if (window.gBrowser?.tabContainer) {
      window.gBrowser.tabContainer.addEventListener('TabSelect', refreshPanelNavMain);
      window.gBrowser.tabContainer.addEventListener('TabAttrModified', refreshPanelNavMain);
    }
    // Initial paint on next tick (give layout a beat to settle).
    setTimeout(updateStripScrollbar, 0);
  }

  // The "Add panel" trailer at the end of the strip. Click creates a new
  // tab via gBrowser.addTab and stamps SessionStore extData
  // "bentoAddAsPanel=1" on it. bento-tools' tabs.onCreated handler reads
  // that marker (via browser.sessions.getTabValue) and adds the tab to
  // the active workspace's panels list, then emits panels/sync — which
  // round-trips back to chrome and the next reconcilePanels pass renders
  // the new panel.

  // URL-marker IPC: chrome creates the tab at a sentinel URL; bento-tools'
  // tabs.onCreated handler reads tab.url, redirects to the real new-tab
  // page, and adds the tab to the active workspace's panels. We tried
  // SessionStore.setTabValue first but the SessionStore module's exported
  // shape is not stable across Firefox versions in chrome scripts loaded
  // via jar.mn from inc.xhtml — `mod.SessionStore.setTabValue` is
  // sometimes undefined even after a successful import. URL markers go
  // through the WebExtension API and are visible to bento-tools without
  // any chrome-side privilege juggling.
  const ADD_AS_PANEL_MARKER = 'bento_add_as_panel=1';

  function addNewPanel() {
    if (!window.gBrowser || typeof window.gBrowser.addTab !== 'function') {
      console.warn('[bento-shell-mount] addNewPanel: gBrowser unavailable');
      return;
    }
    // about:blank with the marker query string. bento-tools sees the URL,
    // adds the tab to the active workspace's panel list. Adding a
    // timestamp to the URL keeps consecutive Add-panel clicks distinct
    // (otherwise tabs.onUpdated may collapse them as the same URL).
    const markerUrl = 'about:blank?' + ADD_AS_PANEL_MARKER + '&ts=' + Date.now();
    let newTab;
    try {
      newTab = window.gBrowser.addTab(markerUrl, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        skipAnimation: true,
        inBackground: true,
      });
    } catch (err) {
      console.warn('[bento-shell-mount] addNewPanel: addTab failed:', err);
      return;
    }
    if (!newTab) return;
    // The newly-created tab needs to navigate away from the marker
    // URL so the tab title and main URL bar (when this tab becomes
    // active) show a clean state. Chrome's loadURI bypasses any
    // WebExtension API restrictions on about:newtab navigation. The
    // 250ms delay gives bento-tools' tabs.onCreated listener time to
    // fire with the marker URL and add the tab to the panel list
    // before we navigate away.
    setTimeout(() => {
      try {
        const principal = Services.scriptSecurityManager.getSystemPrincipal();
        const browserEl = newTab.linkedBrowser;
        if (browserEl && typeof browserEl.fixupAndLoadURIString === 'function') {
          browserEl.fixupAndLoadURIString('about:newtab', { triggeringPrincipal: principal });
        } else if (browserEl && typeof browserEl.loadURI === 'function') {
          browserEl.loadURI(Services.io.newURI('about:newtab'), {
            triggeringPrincipal: principal,
          });
        }
      } catch (err) {
        console.warn('[bento-shell-mount] addNewPanel: post-create navigate failed:', err);
      }
    }, 250);
  }

  // Add-panel trailer at the end of the strip. Idempotent — created on
  // first call, just re-appended to keep it visually after every panel.
  // Lives inside #tabbrowser-tabpanels.bento-split-active as a flex
  // child sibling of the panel containers; does NOT register in
  // splitViewPanels (Firefox's split-view APIs would treat it as a
  // panel and try to wrap a <browser> around it). The order:999 inline
  // CSS keeps it at the visual end regardless of where Firefox's
  // append puts it in DOM order.
  //
  // The visible "+" button and the per-saved-bookmark favicon buttons
  // are rendered by a React app inside a moz-extension <browser>
  // iframe (panel-trailer.html). The XUL <vbox> here is purely the
  // host: it owns the paint-pipeline class, focus-ring CSS,
  // splitter/cycle-target identity, and the keyboard Enter handler
  // that survives for cycle-Enter UX (since chrome captures the key
  // before the iframe's React app sees it).
  function ensureAddPanelTrailer(tabpanels) {
    let trailer = document.getElementById('bento-add-panel-trailer');
    if (!trailer) {
      // XUL <vbox> (NOT HTML <button>) because tabpanels is a XUL
      // <tabpanels>/deck element, and HTML children inside it lay out
      // (getBoundingClientRect returns a sensible rect) but don't
      // paint or receive hit-testing — elementsFromPoint at the
      // trailer's centre showed tabpanels itself rather than the
      // trailer, confirming the HTML element wasn't reaching the
      // compositor. Other tabpanels children are XUL notificationboxes
      // for the same reason. The XUL <browser> child paints fine
      // inside this <vbox> — same constraint that makes every real
      // panel's <browser> work.
      trailer = document.createXULElement('vbox');
      trailer.id = 'bento-add-panel-trailer';
      // .split-view-panel-active opts the trailer into Firefox's
      // split-view paint pipeline. Without it the deck silently
      // suppresses non-panel children even with display:flex +
      // visibility:visible !important. Our #id rule overrides the
      // 380px min-width that the .split-view-panel-active class
      // selector applies to real panels.
      trailer.classList.add('split-view-panel-active');
      // tabindex + keydown survive so keyboard cycling Right past the
      // last panel lands on the trailer; Enter still creates a blank
      // panel via the existing addNewPanel marker URL path. The
      // visible "+" inside the iframe also dispatches panel/openAt
      // when mouse-clicked — both end states are equivalent (a new
      // panel appended to the strip).
      trailer.setAttribute('tabindex', '0');
      trailer.setAttribute('aria-label', 'Add panel');
      // Removed (vs. pre-iframe trailer):
      //   - role="button": the vbox is now a CONTAINER; the iframe
      //     child renders the actual button widgets.
      //   - inline `title`: replaced by the iframe's Tale UI Tooltip.
      //   - click handler: the iframe captures mouse clicks before
      //     they reach the vbox. The keydown handler stays because
      //     keyboard cycle-Enter focuses the vbox (see
      //     setActiveByIndex's trailer special-case) and the keydown
      //     fires there directly.
      trailer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          addNewPanel();
        }
      });
      // Inner moz-extension iframe — same attribute set as
      // ensureOverlayHost frames. Renders /dist/panel-trailer.html
      // which mounts the React PanelTrailer app. Mouse clicks on the
      // iframe's "+" / favicon buttons dispatch panel/openAt with
      // position 'end'; the existing panels/sync round-trip surfaces
      // the new panel in chrome's strip.
      const frame = document.createXULElement('browser');
      frame.id = 'bento-panel-trailer-frame';
      frame.setAttribute('type', 'content');
      frame.setAttribute('remote', 'true');
      frame.setAttribute('remoteType', 'extension');
      frame.setAttribute('primary', 'false');
      frame.setAttribute('flex', '1');
      frame.setAttribute('transparent', 'transparent');
      frame.style.cssText = 'background-color: transparent; -moz-appearance: none;';
      trailer.appendChild(frame);
      // NOTE: setBentoPanelTrailerSrc() is called AFTER the trailer is
      // appended to tabpanels below — setFrameSrc resolves the frame
      // via document.getElementById, which silently returns null when
      // the element is still detached from the document.
    }
    // Append to tabpanels as the LAST child every reconcile. order:999
    // (in CSS) keeps it visually trailing regardless of DOM order.
    const wasDetached = trailer.parentNode !== tabpanels;
    if (wasDetached || tabpanels.lastElementChild !== trailer) {
      tabpanels.appendChild(trailer);
    }
    // First-mount-only: now that the trailer + its inner <browser> are
    // in the document, kick off the moz-extension URL load. Subsequent
    // reconciles re-append the same node but the iframe's `src`
    // (already set on first mount) survives the DOM move.
    if (wasDetached) {
      const frame = document.getElementById('bento-panel-trailer-frame');
      if (frame && !frame.getAttribute('src')) {
        setBentoPanelTrailerSrc();
      }
    }
  }

  // Update the trailer's flex-basis so it grows only when the saved-panel
  // overflow select is present. The first eight saved panels fit into the
  // 3x3 grid around the centre "new tab" button.
  function applyTrailerWidth(count) {
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (!trailer) return;
    const safe = Number.isFinite(count) && count >= 0 ? Math.round(count) : 0;
    trailer.style.setProperty('--bento-saved-panel-overflow', safe > 8 ? '1' : '0');
  }

  function removeAddPanelTrailer() {
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (trailer) trailer.remove();
  }

  function setNoSidePanelsMode(enabled) {
    const container = document.getElementById('bento-strip-container');
    const host = document.getElementById('bento-side-panel-host');
    const tabpanels = window.gBrowser?.tabpanels;
    if (container) {
      container.classList.toggle('bento-no-side-panels', enabled);
    }
    if (enabled) {
      if (host) host.scrollLeft = 0;
      if (tabpanels) tabpanels.scrollLeft = 0;
    }
  }

  function forceMainOnlyChromeState(gBrowser, tabpanels) {
    setNoSidePanelsMode(true);
    syncInterPanelSplitters([]);
    removeAddPanelTrailer();

    if (tabpanels) {
      try {
        const previous = tabpanels.splitViewPanels || [];
        const previousTabs = previous
          .map((id) => gBrowser?.tabs?.find((t) => t.linkedPanel === id))
          .filter((t) => !!t);
        if (previousTabs.length && typeof tabpanels.removeTabsFromSplitview === 'function') {
          tabpanels.removeTabsFromSplitview(previousTabs);
        } else {
          tabpanels.splitViewPanels = [];
        }
      } catch (err) {
        console.warn('[bento-shell-mount] force main-only teardown failed:', err);
        try {
          tabpanels.splitViewPanels = [];
        } catch {
          /* best-effort fallback */
        }
      }
      tabpanels.classList.remove('bento-split-active');
      tabpanels.removeAttribute('splitview');
    }

    if (gBrowser?.tabs) {
      for (const tab of gBrowser.tabs) {
        if (tab.splitview && tab.splitview.kind === BENTO_SPLIT_KIND) {
          delete tab.splitview;
        }
        const panelEl = document.getElementById(tab.linkedPanel);
        if (!panelEl) continue;
        delete panelEl.dataset.bentoMainPanel;
        delete panelEl.dataset.bentoPanelTabId;
        panelEl.style.removeProperty('order');
        panelEl.style.removeProperty('width');
        panelEl.style.removeProperty('min-width');
        panelEl.style.removeProperty('flex');
        panelEl.classList.remove(
          'split-view-panel',
          'split-view-panel-active',
          'bento-panel--focused',
          'bento-panel--cycle-focused',
        );
        panelEl.removeAttribute('column');
        if (panelEl.getAttribute('tabindex') === '-1') {
          panelEl.removeAttribute('tabindex');
        }
      }
    }

    if (__lastSplitViewMarker) {
      try {
        window.dispatchEvent(
          new CustomEvent('TabSplitViewDeactivate', {
            bubbles: true,
            detail: {
              tabs: __lastSplitViewMarker.tabs,
              splitview: __lastSplitViewMarker,
            },
          }),
        );
      } catch (err) {
        console.warn('[bento-shell-mount] force teardown deactivate failed:', err);
      }
      __lastSplitViewMarker = null;
    }

    refreshPanelNav([]);
    currentActiveIdx = 0;
    __lastPanelsPayload = [];
    __reconciledForWorkspace = currentWorkspaceId;
    __lastMainPanelId = window.gBrowser?.selectedTab?.linkedPanel ?? null;
    updateStripScrollbar();
    syncPanelShadows([]);
  }

  // ─── Native split-view panel rendering ──────────────────────────────
  //
  // Panel rendering is driven through Firefox 150's
  // `tabpanels.splitViewPanels = [...]` setter — each panel is a real
  // Firefox tab whose `linkedBrowser` stays in tabpanels for its
  // lifetime. Extension content scripts attach correctly because
  // nothing about a tab's identity changes.
  //
  // Plan: plans/bento-spaces-split-view-panels.md.

  // The most recent panels payload, stashed so the TabSelect listener
  // can re-reconcile when only the active main tab changes (the panel
  // set is unchanged but the first slot of splitViewPanels follows
  // gBrowser.selectedTab).
  let __lastPanelsPayload = [];
  // The linkedPanel id of the most recent main tab. Compared on each
  // reconcile to detect "selected tab actually changed" (vs. reconcile
  // for an unrelated reason like panel width refresh) so we know when
  // to auto-scroll the strip back to the main slot — sidebar-tab
  // clicks should bring main back into view even if the user was
  // looking at a side panel.
  let __lastMainPanelId = null;
  // Workspace ID we've successfully reconciled at least once. Compared
  // against currentWorkspaceId to detect "this is the initial hydration
  // for this workspace" (boot OR workspace switch) versus "user mutated
  // the panel set within the same workspace". The previousTabIds diff
  // alone can't distinguish these: a workspace that previously had zero
  // panels has previousTabIds empty whether we're hydrating it for the
  // first time or the user just added the first panel via the link
  // context menu. Updated in both the empty-panels early-return path
  // AND the main return path so it stays accurate across teardowns.
  let __reconciledForWorkspace = null;

  // The most recent split-view marker dispatched via TabSplitViewActivate.
  // We need to dispatch a matching TabSplitViewDeactivate (with === identity)
  // before activating the next marker so gBrowser.#activeSplitView is cleared
  // properly. Null when no split is currently active.
  let __lastSplitViewMarker = null;

  // Marker assigned to `tab.splitview` for tabs Bento puts into the
  // split. Firefox's setSplitViewActive() in tabbox.js gates the
  // [splitview] attribute on tabpanels by `selectedTab.splitview &&
  // updatedValue` (a boolean check), so the marker must be truthy.
  //
  // It also has to expose `.tabs` (the array of tabs in the split) and
  // `.activeTab` because Firefox's tabbrowser.js progress listener does
  // `this.mTab.splitview.tabs.indexOf(this.mTab)` on every onLocation-
  // Change for split-view tabs (browser/components/tabbrowser/content/
  // tabbrowser.js:9594). Without `.tabs` the read throws Uncaught
  // TypeError, which aborts Firefox's progress-listener bookkeeping and
  // leaves panel docShells in a half-broken state (this surfaced as
  // "panels go blank when focus leaves them" during smoke testing).
  //
  // Each reconcile creates a fresh marker bound to the current
  // tabsToRender array; the same marker object is shared by every tab
  // in the split, so `tab.splitview.tabs.indexOf(tab)` always finds the
  // tab and returns its slot index.
  const BENTO_SPLIT_KIND = 'bento-split';
  function makeSplitViewMarker(tabs) {
    return {
      kind: BENTO_SPLIT_KIND,
      get tabs() {
        return tabs;
      },
      get activeTab() {
        return tabs[0];
      },
      // tabbrowser.js:_insertTabAtIndex (line ~4867) treats `tab.splitview`
      // as a MozTabSplitViewWrapper DOM element — when the opener tab is
      // the first in the split, it does `itemAfter = splitview` then
      // `node.before(newTab)`. Without these shims our plain-object marker
      // throws "node.before is not a function" on right-click→Open in New
      // Tab and on Cmd+Shift+T panel restore. Delegating to the first /
      // last tab in the split places the new tab adjacent to ours in the
      // (hidden) tab strip, matching Firefox's intent.
      before(newNode) {
        tabs[0]?.before(newNode);
      },
      get nextElementSibling() {
        return tabs[tabs.length - 1]?.nextElementSibling || null;
      },
    };
  }

  // Reconciles the split-view layout to match the current panels payload
  // (bento-tools' side-panel set) plus gBrowser.selectedTab (the active
  // sidebar tab — always slot 0 of splitViewPanels). This is the single
  // entry point for layout updates, called from both runtime panels/sync
  // messages and from window-level selection signals (TabSelect /
  // TabOpen / tp.select).
  //
  // ── The N-panel split-view fix architecture ────────────────────────
  // Firefox's split-view machinery (toolkit/content/widgets/tabbox.js +
  // browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs) is built for
  // a 2-panel UI driven by MozTabSplitViewWrapper. Bento drives N
  // simultaneous panels directly via tabpanels.splitViewPanels = [...]
  // and dispatches the same TabSplitViewActivate event the wrapper
  // emits, which feeds gBrowser.#activeSplitView and makes
  // splitViewBrowsers / shouldDeactivateDocShell respect our panels.
  //
  // Several pieces of Firefox's per-tab activation lifecycle don't
  // hold up under this usage. The fix is four coordinated mechanisms;
  // removing any one re-introduces a specific failure mode:
  //
  // 1. tab.splitview marker (set via Object.defineProperty per-tab,
  //    BEFORE the cleanup loop). Required so setSplitViewActive's
  //    `gBrowser.selectedTab.splitview && updatedValue` gate keeps
  //    [splitview] = true throughout the cleanup. Without it, cleanup
  //    transiently removes [splitview] and the AsyncTabSwitcher
  //    queues docShell deactivations that race with the rebuild.
  //    The marker also exposes `.tabs`, which Firefox's onLocationChange
  //    needs (tabbrowser.js:9594 reads `.splitview.tabs.indexOf(tab)`).
  //
  // 2. preserveLayers(true) before docShellIsActive=false on departing
  //    tabs (cleanup loop). Without it, Firefox destroys the browser's
  //    compositor layer when deactivated; on re-entry the slot stays
  //    blank for one paint cycle even though all activation invariants
  //    hold. preserveLayers caches the layer so re-entry paints
  //    immediately.
  //
  // 3. setSplitViewPanelActive(false, panelId) before
  //    removeTabsFromSplitview on departing tabs (cleanup loop).
  //    Firefox's removeTabsFromSplitview only strips .split-view-panel,
  //    NOT .split-view-panel-active — and the xul.css rule
  //    `tabpanels > .split-view-panel-active { visibility: inherit }`
  //    keeps the stale class visible. Combined with (2)'s preserved
  //    layer, the departing tab renders as a ghost overlay on top of
  //    the new mainTab. Stripping the class puts it back to default
  //    visibility: hidden.
  //
  // 4. gBrowser.warmupTab(tab) for every tab in tabsToRender (after
  //    showSplitViewPanels). The AsyncTabSwitcher (gBrowser._switcher)
  //    is created lazily and DESTROYS itself after every successful
  //    tab switch (AsyncTabSwitcher.sys.mjs:343 finish() calls
  //    destroy() which sets tabbrowser._switcher = null). When the
  //    switcher is null, gBrowser.on_visibilitychange takes the
  //    `!this._switcher` fallback (tabbrowser.js:8158) which iterates
  //    selectedBrowsers and forces docShellIsActive = !document.hidden
  //    — silently deactivating panels on every visibility transition
  //    with no path back. Calling the public warmupTab API recreates
  //    the switcher so the fallback never runs. Belt-and-suspenders:
  //    we also override on_visibilitychange to no-op while in
  //    split-view mode (see attachTabSelectListener) for the windows
  //    where the switcher gets destroyed between reconciles.
  //
  // The combined effect: panels stay painted across sidebar tab
  // switches, Cmd+T, window minimise/restore, and DevTools toggling.
  function reconcilePanelsSplitView(panels, options = {}) {
    if (!window.gBrowser) {
      console.warn('[bento-shell-mount] reconcilePanelsSplitView: gBrowser unavailable');
      return;
    }
    const gBrowser = window.gBrowser;
    const tabpanels = gBrowser.tabpanels;
    if (!tabpanels) {
      console.warn('[bento-shell-mount] reconcilePanelsSplitView: tabpanels unavailable');
      return;
    }
    // Capture the previous panel-set for "did a new panel just get
    // added?" detection at the end of this function — so we can
    // auto-scroll the strip to bring the freshly-added panel into
    // view. Snapshot BEFORE overwriting __lastPanelsPayload below;
    // otherwise the comparison would always show zero deltas.
    const previousTabIds = new Set(__lastPanelsPayload.map((p) => p.tabId));
    __lastPanelsPayload = panels.slice();

    // No panels in the workspace → tear down split-view entirely
    // instead of wrapping the lone selected tab in a 1-element "split".
    // The previous behaviour added .split-view-panel-active to the tab's
    // notificationbox, which applies the .split-view-panel-active margin
    // from content-area.css:170 — visible as a small inset around an
    // otherwise-normal full-width tab. Also avoids dispatching repeated
    // TabSplitViewActivate cycles on every TabSelect when there are no
    // panels (which TabSelect fires for whether a workspace has panels
    // or not).
    if (!panels || panels.length === 0) {
      setNoSidePanelsMode(true);
      const previous = tabpanels.splitViewPanels || [];
      const splitActive = tabpanels.classList.contains('bento-split-active');
      if (!previous.length && !__lastSplitViewMarker && !splitActive) {
        // Already torn down — record the workspace so a subsequent
        // first-panel-add within it is detected as mid-session.
        __reconciledForWorkspace = currentWorkspaceId;
        return;
      }

      // Walk every tab in the window and strip the artifacts the
      // reconciler stamps on panel containers. Two reasons we need to
      // do this comprehensively here (not just for `previous`):
      //   1. The TabSelect-triggered reconcile that fires WHEN bento-
      //      tools activates the new workspace's tab runs BEFORE the
      //      panels/sync arrives, so the new mainTab's container gets
      //      stamped with data-bento-main-panel + style.order even
      //      though the "real" reconcile (this one) is about to tear
      //      everything down.
      //   2. Firefox's tabpanels.splitViewPanels = [] setter only
      //      adds .split-view-panel to NEW entries — it doesn't strip
      //      from departing ones (asymmetric API). Without removing,
      //      ex-panels keep `flex: 1; width: 49.4%` from
      //      content-area.css:160 even after they've left the split,
      //      causing the new selectedTab to render at fractional
      //      width with blank flex slots beside it (the user-reported
      //      "first tab in new workspace doesn't extend to full
      //      window viewport" symptom).
      //
      // Includes all tabs (not just `previous`) to catch any artifacts
      // left over from the transient TabSelect reconcile above.
      for (const tab of gBrowser.tabs) {
        if (tab.splitview && tab.splitview.kind === BENTO_SPLIT_KIND) {
          delete tab.splitview;
        }
        const panelEl = document.getElementById(tab.linkedPanel);
        if (!panelEl) continue;
        delete panelEl.dataset.bentoMainPanel;
        delete panelEl.dataset.bentoPanelTabId;
        panelEl.style.removeProperty('order');
        panelEl.style.removeProperty('width');
        panelEl.style.removeProperty('min-width');
        panelEl.style.removeProperty('flex');
        if (panelEl.getAttribute('tabindex') === '-1') {
          panelEl.removeAttribute('tabindex');
        }
        panelEl.classList.remove('split-view-panel-active');
      }
      // Remove inter-panel splitters — they live in the strip
      // host, NOT in tabpanels (XUL deck blocks hit-testing of
      // non-panel children). syncInterPanelSplitters with no args
      // walks the now-empty splitViewPanels and clears all.
      syncInterPanelSplitters([]);

      // Use Firefox's removeTabsFromSplitview to strip .split-view-
      // panel + [column] from each previous panel container in one
      // go. Then clear the deck's split state.
      const previousTabs = previous
        .map((id) => gBrowser.tabs.find((t) => t.linkedPanel === id))
        .filter((t) => !!t);
      if (previousTabs.length) {
        try {
          tabpanels.removeTabsFromSplitview(previousTabs);
        } catch (err) {
          console.warn('[bento-shell-mount] tear-down: removeTabsFromSplitview failed:', err);
        }
      } else {
        try {
          tabpanels.splitViewPanels = [];
        } catch (err) {
          console.warn('[bento-shell-mount] tear-down: clear splitViewPanels failed:', err);
        }
      }

      // Strip the Bento class from tabpanels so our overrides
      // (overflow-x, scrollbar-width, etc.) stop applying — the deck
      // returns to default Firefox rendering where the .deck-selected
      // notificationbox uses position: absolute (from
      // .browserSidebarContainer) to fill the viewport.
      tabpanels.classList.remove('bento-split-active');

      // Drop the Add-panel trailer too — its dashed-border styling
      // would float in the empty deck without any panels around it.
      removeAddPanelTrailer();

      // Notify Firefox so #activeSplitView clears and
      // shouldActivateDocShell stops returning true for ex-panel
      // browsers.
      if (__lastSplitViewMarker) {
        try {
          window.dispatchEvent(
            new CustomEvent('TabSplitViewDeactivate', {
              bubbles: true,
              detail: {
                tabs: __lastSplitViewMarker.tabs,
                splitview: __lastSplitViewMarker,
              },
            }),
          );
        } catch (err) {
          console.warn('[bento-shell-mount] tear-down: deactivate dispatch failed:', err);
        }
        __lastSplitViewMarker = null;
      }

      // Refresh nav strip (no panels → empty)
      refreshPanelNav([]);
      // Record that we've completed a reconcile for this workspace —
      // the next reconcile within the same workspace is mid-session
      // (e.g. user adding the first panel via "Open in new panel"),
      // not hydration.
      __reconciledForWorkspace = currentWorkspaceId;
      return;
    }

    // Resolve panel tabIds (WebExtension IDs from bento-tools' panels/sync
    // payload) to gBrowser tab elements via the same TabTracker path the
    // Cmd+1..9 handler uses.
    const tabTracker = (() => {
      try {
        const mod = ChromeUtils.importESModule(
          'resource://gre/modules/ExtensionParent.sys.mjs',
        );
        return mod.ExtensionParent?.apiManager?.global?.tabTracker || null;
      } catch (err) {
        console.warn('[bento-shell-mount] tabTracker import failed:', err);
        return null;
      }
    })();

    const resolved = [];
    if (tabTracker) {
      for (const p of panels) {
        try {
          const t = tabTracker.getTab(p.tabId);
          // Skip tabs that are being closed. Two flags are checked:
          //   - tab.closing: Firefox's own flag, set in _beginRemoveTab
          //     at line 5863 — but only AFTER _blurTab at line 5796 has
          //     already fired TabSelect on the successor tab. So during
          //     the FIRST reconcile triggered by _blurTab's TabSelect,
          //     `tab.closing` is still false.
          //   - tab.bentoClosing: our flag set in the _beginRemoveTab
          //     wrapper above, BEFORE Firefox's own logic runs. This is
          //     what catches the close-the-main-slot-panel case where
          //     the closing tab would otherwise be re-rendered as a
          //     strip panel for one frame (the "ghost panel" symptom).
          // Both flags are checked because the wrapper might miss an
          // edge-case path that bypasses _beginRemoveTab.
          if (t && !t.closing && !t.bentoClosing) {
            resolved.push({ tab: t, payload: p });
          }
        } catch {
          // Tab might be gone (race with tab/close); skip
        }
      }
    }

    // Materialize + load lazy/pending panel tabs. SessionStore restores
    // tabs with `pending="true"`, no linkedPanel, and no actual content
    // loaded (Firefox's restore_on_demand default — content loads when
    // the user clicks the tab). Two problems for panels:
    //   1. The reconciler below filters tabs without linkedPanel, so a
    //      pending tab is silently dropped — sessions reopen with panel
    //      favicons in the navigator but no panel strip.
    //   2. Even after _insertBrowser materializes the docshell (which
    //      sets linkedPanel), no content is loaded — the panel renders
    //      blank until clicked.
    // Fix: _insertBrowser to materialize (same path gBrowser.selectTab
    // uses for a lazy click, minus the selection change), then
    // linkedBrowser.reload() to actually fetch the URL.
    for (const { tab } of resolved) {
      if (tab.linkedPanel && !tab.hasAttribute('pending')) continue;
      if (!tab.linkedPanel) {
        try {
          window.gBrowser._insertBrowser(tab);
        } catch (err) {
          console.warn(
            '[bento-shell-mount] _insertBrowser failed for tabId',
            tab.id || '?',
            err,
          );
          continue;
        }
      }
      if (tab.hasAttribute('pending')) {
        try {
          tab.linkedBrowser?.reload();
        } catch (err) {
          console.warn(
            '[bento-shell-mount] reload() failed for tabId',
            tab.id || '?',
            err,
          );
        }
      }
    }
    if (resolved.length === 0) {
      forceMainOnlyChromeState(gBrowser, tabpanels);
      return;
    }
    setNoSidePanelsMode(false);

    // NOTE: we do NOT call gBrowser.hideTab(tab) on panel tabs.
    //
    // The plan called for it (so panels stay out of native visibleTabs
    // iterations), but the smoke test showed Firefox's split-view
    // rendering produces a black/empty content slot for any tab that's
    // hidden — the deck-selected attribute is set, the panel container
    // sizes correctly, but the browser inside doesn't paint.
    //
    // Bento hides #TabsToolbar entirely (patches/core-ui/02-hide-native-
    // tabs.patch) so panel tabs are already invisible to the user via
    // the native strip. The sidebar's tab list filters panels via
    // PanelStore membership in bento-tools (see useWorkspaceTabIds).
    // Skipping tab.hidden costs us nothing visually and lets the
    // split-view paint content for every panel.
    //
    // Side effect to watch in Phase 4: visibleTabs iterations from
    // home.js / multi-account-containers / sessionstore will include
    // panel tabs. If any of those misbehave, revisit (likely with a
    // more surgical attribute or a tab-flag that's separate from
    // hidden=true).

    // Build the ordered list of tabs to render in the split. Active
    // main tab (gBrowser.selectedTab) is the FIRST slot; panel tabs
    // follow in bento-tools' order. Dedupe on linkedPanel so a tab
    // that's both selected and a panel doesn't appear twice.
    const mainTab = gBrowser.selectedTab;
    const tabsToRender = [];
    const seenPanelIds = new Set();
    if (mainTab?.linkedPanel) {
      tabsToRender.push(mainTab);
      seenPanelIds.add(mainTab.linkedPanel);
    }
    for (const { tab } of resolved) {
      if (!tab.linkedPanel || seenPanelIds.has(tab.linkedPanel)) continue;
      tabsToRender.push(tab);
      seenPanelIds.add(tab.linkedPanel);
    }
    // Closing the last side panel can briefly leave that tab selected
    // as the main slot while it still appears in the stale panels
    // payload. After dedupe, that means there is only main to render:
    // tear the split down instead of leaving a main-only strip.
    if (tabsToRender.length <= 1) {
      forceMainOnlyChromeState(gBrowser, tabpanels);
      return;
    }

    // Tabs that USED to be in the split but no longer are: clear their
    // per-panel split-view-active attribute, clear our split sentinel,
    // ORDER MATTERS:
    //   1. Set markers on every tab in tabsToRender FIRST.
    //   2. Then run the cleanup loop (removeTabsFromSplitview).
    //
    // Why: removeTabsFromSplitview internally calls setSplitViewActive
    // (toolkit/content/widgets/tabbox.js:536), which gates the
    // [splitview] attribute on `gBrowser.selectedTab.splitview &&
    // updatedValue` (line 546). If we run cleanup before setting the
    // marker on the new mainTab, selectedTab.splitview is undefined →
    // setSplitViewActive removes [splitview] → split deactivates
    // briefly. The AsyncTabSwitcher (gBrowser._switcher) sees
    // splitViewBrowsers shrink, queues docShell deactivations for the
    // ex-split browsers, and those land before our subsequent
    // showSplitViewPanels can re-assert docShellIsActive=true. Net
    // result: blank content in the new main slot when toggling between
    // two sidebar tabs (the bug surfaced in late Phase 2 testing).
    //
    // tab.splitview is a GETTER (browser/components/tabbrowser/content/
    // tab.js:399) that returns parentElement only when parentElement is
    // a <tab-split-view-wrapper>; no setter, so a plain assignment is
    // silently shadowed. Use Object.defineProperty to add an own-
    // property that takes precedence over the prototype getter.
    const splitViewMarker = makeSplitViewMarker(tabsToRender);
    for (const tab of tabsToRender) {
      try {
        Object.defineProperty(tab, 'splitview', {
          value: splitViewMarker,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      } catch (err) {
        console.warn('[bento-shell-mount] tab.splitview defineProperty failed:', err);
      }
    }

    // Now teardown. Each departing tab is one that was in the previous
    // splitViewPanels but isn't in the new tabsToRender. Firefox's
    // removeTabsFromSplitview (toolkit/content/widgets/tabbox.js:516)
    // handles the full per-panel teardown:
    //   - .split-view-panel class removed (otherwise the base CSS at
    //     content-area.css:160 keeps width: 49.4%, flex: 1 on the
    //     leftover panel — it's invisible because it lacks
    //     .split-view-panel-active and .deck-selected, but it still
    //     consumes flex space, pushing the new main into visual
    //     position 2. This was the original "main moves between
    //     first and second positions" symptom.)
    //   - [column] attribute removed.
    //   - Auto-select click/focus listeners detached.
    //   - panelId spliced from tabpanels.#splitViewPanels.
    // Because we set the new marker first (above), the internal
    // setSplitViewActive call here sees mainTab.splitview = truthy and
    // keeps [splitview] = true throughout — no transient deactivation.
    const previous = tabpanels.splitViewPanels || [];
    const departingTabs = [];
    for (const panelId of previous) {
      if (seenPanelIds.has(panelId)) continue;
      const t = gBrowser.tabs.find((tab) => tab.linkedPanel === panelId);
      if (!t) continue;
      departingTabs.push(t);
      if (t.splitview && t.splitview.kind === BENTO_SPLIT_KIND) {
        delete t.splitview;
      }
      if (t !== mainTab && t.linkedBrowser) {
        // preserveLayers(true) BEFORE docShellIsActive=false. Without
        // this, Firefox destroys the browser's compositor layers when
        // deactivated; on reactivation the docShell processes again
        // but the layers need re-rendering, leaving a blank frame
        // until the next paint cycle. Empirically: even though all
        // diagnostic invariants (docShellIsActive=true, frameLoader
        // present, classes correct, panel rect non-zero, visibility
        // visible) hold after re-entry, the slot stays blank because
        // the cached layer is gone. Mirrors the order in
        // tabbrowser.js:8161 on_visibilitychange.
        t.linkedBrowser.preserveLayers(true);
        t.linkedBrowser.docShellIsActive = false;
      }
      // Explicitly remove .split-view-panel-active. Firefox's
      // removeTabsFromSplitview (tabbox.js:516) removes
      // .split-view-panel but NOT .split-view-panel-active. The
      // stale class keeps the departing panel visible via the
      // xul.css rule:
      //
      //   tabpanels > .split-view-panel-active { visibility: inherit; }
      //
      // Combined with our preserveLayers(true) above (which keeps the
      // browser's compositor layer alive), the result is a ghost
      // panel rendered on top of the new mainTab's slot — observed
      // as "I can see the first tab beneath the new tab". Strip the
      // class explicitly to make the panel invisible the instant it
      // leaves the split.
      try {
        tabpanels.setSplitViewPanelActive(false, panelId);
      } catch (err) {
        console.warn('[bento-shell-mount] setSplitViewPanelActive(false) failed:', err);
      }
    }
    if (departingTabs.length) {
      try {
        tabpanels.removeTabsFromSplitview(departingTabs);
      } catch (err) {
        console.warn('[bento-shell-mount] removeTabsFromSplitview failed:', err);
      }
    }

    // Register the marker as gBrowser's activeSplitView via the same
    // event MozTabSplitViewWrapper dispatches. tabbrowser.js listens
    // for TabSplitViewActivate at window level (line 218) and stores
    // event.detail.splitview in #activeSplitView. The splitViewBrowsers
    // getter then iterates `#activeSplitView.tabs` (our marker exposes
    // .tabs), and shouldActivateDocShell() returns true for any browser
    // in that list (line 7949). That's how Firefox keeps every panel's
    // docShell active even when only one is `selectedBrowser`.
    //
    // Without this, AsyncTabSwitcher (gBrowser._switcher) deactivates
    // every browser except selectedBrowser as soon as it processes the
    // next tick — exactly matching the reported "panels go blank
    // moments after creation" symptom.
    //
    // Deactivate the previous marker first so the === identity check in
    // on_TabSplitViewDeactivate (tabbrowser.js:8225) matches and the
    // private field actually clears before we set the new one.
    if (__lastSplitViewMarker) {
      try {
        window.dispatchEvent(
          new CustomEvent('TabSplitViewDeactivate', {
            bubbles: true,
            detail: {
              tabs: __lastSplitViewMarker.tabs,
              splitview: __lastSplitViewMarker,
            },
          }),
        );
      } catch (err) {
        console.warn('[bento-shell-mount] TabSplitViewDeactivate dispatch failed:', err);
      }
    }
    try {
      window.dispatchEvent(
        new CustomEvent('TabSplitViewActivate', {
          bubbles: true,
          detail: { tabs: tabsToRender, splitview: splitViewMarker },
        }),
      );
      __lastSplitViewMarker = splitViewMarker;
    } catch (err) {
      console.warn('[bento-shell-mount] TabSplitViewActivate dispatch failed:', err);
    }

    // Use Firefox's high-level showSplitViewPanels API. It calls
    // _insertBrowser, sets linkedBrowser.docShellIsActive=true, fires
    // setIsSplitViewActive(true, tabs) (which calls
    // setSplitViewPanelActive(true, panelId) per-panel AND, now that
    // selectedTab.splitview is truthy, toggles the [splitview]
    // attribute on tabpanels), then sets tabpanels.splitViewPanels.
    try {
      gBrowser.showSplitViewPanels(tabsToRender);
    } catch (err) {
      console.error('[bento-shell-mount] showSplitViewPanels failed:', err);
      return;
    }

    // The splitViewPanels setter (toolkit/content/widgets/tabbox.js:498)
    // attaches `click` and `focus` listeners on each panel's
    // `.browserContainer` / `<browser>`. The handler (line 346-350)
    // does `tabstrip.selectedItem = tab` — i.e. clicking into a panel
    // makes that panel's tab the global gBrowser.selectedTab. That's
    // correct for Firefox's 2-tab split UI but wrong for Bento, where
    // panels are subordinate to a main tab: clicking a side panel
    // should focus its content WITHOUT changing which sidebar tab is
    // "main". Without this strip, our reconciler runs on every panel
    // click, treats the just-clicked panel as mainTab, and shuffles
    // splitViewPanels[0] to that panel — which causes the reported
    // "main content disappears when focus leaves a panel" and
    // "panels reorder when I click around" symptoms.
    //
    // Listeners are added with `this` (the tabpanels element itself)
    // as the listener; removeEventListener with the same reference
    // detaches them. Idempotent: safe to run after every reconcile.
    // Mouseover/mouseout are left alone — they manage the per-panel
    // link-preview StatusPanel, which is desirable behaviour.
    for (const tab of tabsToRender) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      const browserContainer = panelEl.querySelector('.browserContainer');
      const browserEl = panelEl.querySelector('browser');
      browserContainer?.removeEventListener('click', tabpanels);
      browserEl?.removeEventListener('focus', tabpanels);
    }

    // Set inline `order` per panel so flex layout renders them in
    // splitViewPanels index order regardless of count. The static
    // CSS rules in injectChromeStyles only enumerate columns 0..9
    // (Firefox's split-view CSS only ships 0 and 1; we extended to
    // 9). Beyond column 9, columns get default `order: 0` and end
    // up in the same flex group as the main panel (also order: 0),
    // rendering interleaved or before main. Empirically observed at
    // ~10 panels: new panels start appearing adjacent to the right
    // of main rather than at the strip's tail; older panels can land
    // visually to the LEFT of main. Inline style.order overrides any
    // CSS rule and scales to N panels.
    //
    // Also stamp the data-bento-main-panel / data-bento-panel-tab-id
    // attributes the legacy parallel-browser renderer used to set —
    // downstream code (getOrderedPanels, navigatePanels arrow-cycle,
    // setupNavDrag drag-reorder, the Esc-to-blur handler) reads these
    // to identify panels and recover tabIds. Without them, drag-
    // reorder dispatches a bogus single-element panels list (which
    // PanelStore.reorder rejects on length mismatch) and arrow-key
    // cycling has no targets to walk through.
    // Panels at even orders (0, 2, 4, ...) so splitters can slot in
    // at odd orders (1, 3, 5, ...) between them. The splitter has
    // `_bentoLeftPanelId` set to the panel it resizes (the one to
    // its left in visual order), used by startPanelDrag.
    // Build per-tabId width lookup from the BENTO_PANELS payload so we
    // can re-apply persisted widths during reconcile. Without this, a
    // panel restored at boot or reordered during a workspace switch
    // would render at its default flex width and lose whatever the
    // user previously dragged it to.
    const widthByTabId = new Map();
    for (const p of panels) {
      if (typeof p.widthPx === 'number' && p.widthPx > 0) {
        widthByTabId.set(p.tabId, p.widthPx);
      }
    }
    const isInitialReconcileForWorkspace =
      __reconciledForWorkspace !== currentWorkspaceId;
    const newTabIds = panels.map((p) => p.tabId).filter((id) => !previousTabIds.has(id));
    const shouldAnimateNewPanels = newTabIds.length > 0 && !isInitialReconcileForWorkspace;
    for (const [i, tab] of tabsToRender.entries()) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      panelEl.style.order = String(i * 2);
      // tabindex="-1" makes the notificationbox programmatically
      // focusable. Without it, setActiveByIndex's targets[idx].focus()
      // call is a silent no-op (HBOX/notificationbox isn't focusable
      // by default), DOM focus stays wherever the user last clicked,
      // and the Up/Down panel-content scroll handler routes the
      // command to the wrong panel.
      if (!panelEl.hasAttribute('tabindex')) {
        panelEl.setAttribute('tabindex', '-1');
      }
      if (i === 0) {
        panelEl.dataset.bentoMainPanel = '1';
        delete panelEl.dataset.bentoPanelTabId;
        // Apply the universal main-panel width every reconcile so
        // every tab's col-0 notificationbox shows the user's chosen
        // main width, not its own per-tab default. Only paints when
        // the user has actually dragged the main splitter once.
        if (mainPanelWidth !== null) {
          // On workspace-switch reconciles, give the panel a one-shot
          // CSS transition so the width change animates from the old
          // to the new value instead of snapping ~200ms after the
          // tab content swap. Drag-driven reconciles bypass this
          // (the flag is only set when handlePanelsTitle observes a
          // workspace-id change in the payload).
          if (__mainWidthTransitionForNextReconcile) {
            // Snappy easing matches the workspace-switch tab-list slide
            // (TabList.css) so the simultaneous main-panel resize and
            // sidebar tab swap feel like one motion.
            const snappy = 'var(--bento-easing-snappy, cubic-bezier(0.32, 0.72, 0, 1))';
            panelEl.style.transition =
              'width var(--bento-duration-base, 200ms) ' + snappy +
              ', min-width var(--bento-duration-base, 200ms) ' + snappy +
              ', flex-basis var(--bento-duration-base, 200ms) ' + snappy;
            // Clear the inline transition after it would have completed
            // so subsequent inline width writes (e.g. drag pointermove)
            // are instant.
            window.setTimeout(() => {
              panelEl.style.removeProperty('transition');
            }, 250);
            __mainWidthTransitionForNextReconcile = false;
          }
          panelEl.style.width = mainPanelWidth + 'px';
          panelEl.style.minWidth = mainPanelWidth + 'px';
          panelEl.style.flex = '0 0 ' + mainPanelWidth + 'px';
        } else {
          // A tab panel can carry stale inline sizing from a previous
          // workspace, split-view activation, or pre-sync reconcile.
          // When the profile has no persisted main width yet, let the
          // CSS flex rule make the main slot fill available space
          // instead of preserving an old narrow per-workspace width.
          panelEl.style.removeProperty('width');
          panelEl.style.removeProperty('min-width');
          panelEl.style.removeProperty('flex');
        }
      } else {
        delete panelEl.dataset.bentoMainPanel;
        let tabId = null;
        if (tabTracker) {
          try {
            tabId = tabTracker.getId(tab);
            if (tabId) panelEl.dataset.bentoPanelTabId = String(tabId);
          } catch {
            /* tabTracker can throw for transient/uninitialised tabs */
          }
        }
        // Apply persisted width if we have one. Don't paint a default
        // width when none is persisted — the panel keeps whatever it
        // had (in-flight drag width, or Firefox's flex default).
        if (tabId !== null) {
          const w = widthByTabId.get(tabId);
          if (typeof w === 'number') {
            // Skip if a drag is currently in flight on this panel —
            // we'd otherwise stomp the user's live mutation with
            // the persisted value (which is one drag-end behind).
            const dragInFlight = panelEl.style.width &&
              panelEl.classList.contains('bento-panel-resizing');
            if (!dragInFlight) {
              panelEl.style.width = w + 'px';
              panelEl.style.minWidth = w + 'px';
              panelEl.style.flex = '0 0 ' + w + 'px';
            }
          }
          if (shouldAnimateNewPanels && newTabIds.includes(tabId)) {
            animatePanelEnter(panelEl, { clearSizingAfter: typeof w !== 'number' });
          }
        }
      }
    }

    // Inter-panel splitters: one between each adjacent pair. They
    // CANNOT live inside tabpanels — XUL <tabpanels> is a deck and
    // its hit-testing routes events only to panels with the
    // .split-view-panel-active class, ignoring all sibling
    // elements regardless of element type, position, z-index, etc.
    // Tested with HTML <div>, XUL <hbox>, XUL <splitter>, all with
    // and without position:absolute z:999 — all blocked.
    //
    // Workaround: park splitters in #bento-side-panel-host (the
    // strip parent of tabbox), positioned absolutely at the right
    // edge of each "left" panel. They float above tabpanels'
    // boundary regions. Repositioned on every reconcile and on
    // window resize so panel-width changes shift the splitter.
    syncInterPanelSplitters(tabsToRender);

    // Strip stale inline order + data attrs from departing tabs so
    // they don't leak into a future split (e.g. tab returns to the
    // layout via a workspace switch with a different position) or
    // make getOrderedPanels mistakenly include them.
    for (const tab of departingTabs) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      panelEl.style.removeProperty('order');
      panelEl.style.removeProperty('width');
      panelEl.style.removeProperty('min-width');
      panelEl.style.removeProperty('flex');
      delete panelEl.dataset.bentoMainPanel;
      delete panelEl.dataset.bentoPanelTabId;
    }

    // Force the AsyncTabSwitcher to exist by calling the public
    // gBrowser.warmupTab API (which internally calls _getSwitcher() in
    // multi-process mode). This is critical: without the switcher,
    // gBrowser.on_visibilitychange (tabbrowser.js:8158) takes the
    // `!this._switcher` fallback that iterates selectedBrowsers and
    // sets docShellIsActive = !document.hidden — silently
    // DEACTIVATING every panel browser whenever the OS/DevTools
    // toggles window visibility, with no path to reactivate them.
    // Empirically observed via docShellIsActive setter trace:
    // 4 panels all set to false from on_visibilitychange line 8162,
    // matching the user-reported "blank panels after a sidebar tab
    // toggle" symptom.
    //
    // With the switcher created, on_visibilitychange's `if
    // (!this._switcher)` branch never runs, and the switcher's own
    // shouldDeactivateDocShell (AsyncTabSwitcher.sys.mjs:937) respects
    // splitViewBrowsers — so panels stay active across visibility
    // transitions.
    //
    // warmupTab is also idempotent + advances tabs in STATE_UNLOADED
    // back to STATE_LOADING, so tabs that were previously unloaded
    // get repainted on re-entry into the split.
    for (const tab of tabsToRender) {
      try {
        gBrowser.warmupTab(tab);
      } catch (err) {
        console.warn('[bento-shell-mount] warmupTab failed:', err);
      }
    }

    // showSplitViewPanels sets each tab.linkedBrowser.docShellIsActive
    // = true BEFORE calling setIsSplitViewActive, which internally
    // does `this.selectedPanel = selectedPanel`. Setting selectedPanel
    // on a MozDeck triggers the deck's mutation observer / activation
    // logic which DEACTIVATES docShells of non-selected children. So
    // by the time showSplitViewPanels returns, every panel except the
    // currently-deck-selected one has docShellIsActive=false again,
    // and only the selected panel paints content (the others render
    // their .split-view-panel-active container + our injected header
    // but the browser inside stays blank).
    //
    // Re-force docShellIsActive=true on every panel's browser AFTER
    // showSplitViewPanels has done its dance. The deck won't toggle
    // them off again until the next setSelectedPanel — which we
    // re-run on TabSelect, where this same path fires.
    for (const tab of tabsToRender) {
      if (tab.linkedBrowser && !tab.linkedBrowser.docShellIsActive) {
        tab.linkedBrowser.docShellIsActive = true;
      }
    }

    // Per-panel header injection. Each linkedPanel is a notificationbox;
    // we inject Bento's header (URL bar, back/forward/reload, X close,
    // bookmark) as the FIRST child so the visual order is
    // [header, notificationstack, browser]. Idempotent — re-running
    // skips panels that already have a header.
    for (const { tab, payload } of resolved) {
      injectPanelHeaderIntoLinkedPanel(tab, payload.url || '');
    }

    // Mark tabpanels with a class so CSS can switch into Bento's
    // split-view layout (flex row + horizontal scroll). Idempotent.
    tabpanels.classList.add('bento-split-active');

    // Ensure the Add-panel trailer is the LAST child of tabpanels.
    // Idempotent — created once, re-appended on every reconcile so
    // newly-inserted panel containers don't end up after it visually.
    ensureAddPanelTrailer(tabpanels);

    // Refresh favicon nav strip (lives outside tabpanels; reads from
    // panels/sync payload — same data the legacy reconciler consumes).
    refreshPanelNav(panels);

    // Resize/reposition the custom always-visible scrollbar thumb to
    // match the new panel count. Layout settles after this tick, so
    // queue for the next frame.
    setTimeout(updateStripScrollbar, 0);

    // FLIP-animate any cross-panel reorder that endDrag (header
    // drag) has staged. No-op when no snapshot is pending.
    runPendingPanelFlip();

    // Auto-scroll to bring any freshly-added panel into view. Trigger
    // whenever a new panel id appears AND we've already reconciled
    // this workspace at least once (so this is a mid-session mutation,
    // not the initial hydration of a boot/switch). Scrolls to the
    // LAST new tab id (rightmost in DOM, which is where panel/add
    // appends and the right-click-on-side-panel insert lands; for
    // panel/openAt-from-main with sourceTabId=null, the new panel is
    // at position 0 and is the only new id, so "last new" still
    // resolves correctly).
    //
    // Workspace match handles three cases that the previous
    // previousTabIds-only guard conflated:
    //   - Boot hydration (__reconciledForWorkspace null → mismatch → skip)
    //   - Workspace switch (__reconciledForWorkspace = prior → mismatch → skip)
    //   - First-panel-add to a previously-empty workspace
    //     (__reconciledForWorkspace was set by the empty-panels early-
    //     return path → match → scroll)
    //
    // setTimeout 0 lets tabpanels' layout commit the new panel's
    // width before scrollPanelIntoViewFromRight reads its bounding
    // rect. Uses the minimal-scroll variant rather than leftmost so
    // the source panel (the one the user right-clicked, or the
    // currently-focused panel for plain panel/add) stays in view to
    // the left of the new one — the new panel just nudges into view
    // from the right, instead of jumping the strip to the new panel.
    let scrolledToNewPanel = false;
    const explicitScrollId =
      Number.isInteger(options.scrollToPanelTabId) ? options.scrollToPanelTabId : null;
    if (explicitScrollId !== null) {
      scrolledToNewPanel = true;
      scheduleScrollPanelTabIntoView(explicitScrollId, { reveal: 'full' });
    } else if (newTabIds.length > 0 && !isInitialReconcileForWorkspace) {
      const newId = newTabIds[newTabIds.length - 1];
      scrolledToNewPanel = true;
      scheduleScrollPanelTabIntoView(newId);
    }
    __reconciledForWorkspace = currentWorkspaceId;

    // Auto-scroll to the MAIN panel when the selected tab changes
    // (sidebar tab click, Cmd+T new tab, Cmd+Shift+T undo-close, ...).
    // The main slot follows gBrowser.selectedTab; if the user was
    // looking at a side panel and clicked a sidebar tab, the new
    // main is offscreen-left until we scroll to it.
    // Skipped when:
    //   - we just scrolled to a new side panel (above) — that's the
    //     more specific user intent, don't immediately yank back
    //   - selected tab didn't actually change (reconcile fired for
    //     an unrelated reason like a width refresh)
    //   - the workspace has no side panels (main fills the strip,
    //     no scroll needed)
    const currentMainPanelId = window.gBrowser?.selectedTab?.linkedPanel ?? null;
    const mainChanged = currentMainPanelId !== __lastMainPanelId;
    __lastMainPanelId = currentMainPanelId;
    if (
      !scrolledToNewPanel &&
      mainChanged &&
      panels.length > 0 &&
      currentMainPanelId &&
      !__workspaceSwitchSwapping
    ) {
      setTimeout(() => {
        const mainEl = getOrderedPanels()[0];
        if (mainEl) scrollPanelToLeftmost(mainEl);
      }, 0);
    }
  }

  // Sidebar-driven scroll-to-main signal. Sidebar sets
  // document.title = BENTO_SCROLL_TO_MAIN_<ts> on every tab-row click,
  // INCLUDING clicks on the already-active tab. Without this, clicking
  // the active tab fires no TabSelect (Firefox doesn't re-emit when
  // the same tab is reselected) → no reconcile → no scroll. The
  // dedicated sentinel covers that case so EVERY sidebar tab click
  // brings main back into view.
  function handleScrollToMainTitle() {
    const mainEl = getOrderedPanels()[0];
    if (mainEl) scrollPanelToLeftmost(mainEl);
  }

  // Sidebar-driven panel focus signal. Fired by the PinnedPanels row
  // click in the React shell — workspace switch goes through the
  // tools port, but the workspace's panels are only materialized
  // after the next reconcile, so the target [data-bento-panel-tab-id]
  // element may not exist when this title write lands. Retry briefly
  // (covers the fade + reconcile window), then give up — the user
  // can still click the panel themselves.
  function handleFocusPanelTitle(rawTitle) {
    // Format: BENTO_FOCUS_PANEL:<ts>:<tabId>
    const tail = rawTitle.slice(FOCUS_PANEL_PREFIX.length);
    const colon = tail.indexOf(':');
    if (colon < 0) return;
    const tabId = Number.parseInt(tail.slice(colon + 1), 10);
    if (!Number.isInteger(tabId)) return;
    const DEADLINE_MS = 2000;
    const POLL_MS = 50;
    const started = Date.now();
    const tryFocus = () => {
      const panel = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
      if (panel) {
        // Scroll the strip so the panel lands at the leftmost visible
        // slot, matching the favicon-navigator-click affordance. Focus
        // the inner <browser> so the page receives keys natively
        // (mirrors setActiveByIndex's panel-target branch).
        try {
          scrollPanelToLeftmost(panel);
        } catch (err) {
          console.warn('[bento-shell-mount] FOCUS_PANEL scroll failed:', err);
        }
        try {
          const browserEl = panel.querySelector && panel.querySelector('browser');
          if (browserEl) browserEl.focus({ preventScroll: true });
          else panel.focus({ preventScroll: true });
        } catch (err) {
          console.warn('[bento-shell-mount] FOCUS_PANEL focus failed:', err);
        }
        return;
      }
      if (Date.now() - started > DEADLINE_MS) return;
      setTimeout(tryFocus, POLL_MS);
    };
    tryFocus();
  }

  // Sidebar drag-to-reorder. Resolves srcTabId + anchorTabId (WebExtension
  // ids from bento-tools' TabRegistry) to <tab> DOM elements via the same
  // tabTracker the panel reconciler uses, then calls
  // gBrowser.moveTabBefore / moveTabAfter. Those APIs operate on element
  // references (no `element.splitview` transformation), so the
  // currently-active tab — which has Bento's plain-object .splitview
  // marker — moves correctly. Firefox's tab-moved event fires from
  // gBrowser; bento-tools' TabRegistry.#onMoved catches it and emits the
  // `updated` delta that refreshes the sidebar mirror, so the visual
  // reorder rides the same pipeline as any other tab-index change.
  function handleTabMoveTitle(rawTitle) {
    // Format: BENTO_TAB_MOVE:<ts>:<srcId>:<anchorId>:<before|after>
    const tail = rawTitle.slice(TAB_MOVE_PREFIX.length);
    const parts = tail.split(':');
    if (parts.length !== 4) return;
    const srcId = Number.parseInt(parts[1], 10);
    const anchorId = Number.parseInt(parts[2], 10);
    const side = parts[3];
    if (!Number.isInteger(srcId) || !Number.isInteger(anchorId)) return;
    if (side !== 'before' && side !== 'after') return;
    let tabTracker;
    try {
      const mod = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      tabTracker = mod.ExtensionParent?.apiManager?.global?.tabTracker;
    } catch (err) {
      console.warn('[bento-shell-mount] BENTO_TAB_MOVE: tabTracker import failed:', err);
      return;
    }
    if (!tabTracker) return;
    let srcTab;
    let anchorTab;
    try {
      srcTab = tabTracker.getTab(srcId);
      anchorTab = tabTracker.getTab(anchorId);
    } catch {
      // One of the tabs was closed between the drop and now — drop the
      // reorder silently. The sidebar will reflect the gone tab via its
      // own removed-delta path.
      return;
    }
    if (!srcTab || !anchorTab || srcTab === anchorTab) return;
    try {
      if (side === 'before') {
        window.gBrowser.moveTabBefore(srcTab, anchorTab);
      } else {
        window.gBrowser.moveTabAfter(srcTab, anchorTab);
      }
    } catch (err) {
      console.warn('[bento-shell-mount] BENTO_TAB_MOVE: gBrowser.moveTab* failed:', err);
    }
  }

  // Click-into-partial-panel auto-scroll. When the user clicks inside
  // a panel's <browser> content, Firefox's focus engine routes chrome
  // focus to that <browser> element — focusin fires on chrome's
  // document with the browser as the target. We listen here so that
  // if the focused panel is only partially in view (the user clicked
  // an edge that was peeking past the strip's visible area), the
  // strip nudges just enough to bring the full panel into view —
  // preserving the neighbouring panels' context rather than jumping
  // the clicked panel to the leftmost slot. Programmatic focus from
  // setActiveByIndex / reconcile also fires focusin, but
  // scrollPanelIntoViewFromRight's fully-visible early-return makes
  // those a no-op when the panel is already on screen.
  function attachPanelClickAutoScroll() {
    window.addEventListener(
      'focusin',
      (e) => {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        // Add-panel trailer focus must bypass this listener: the trailer
        // has neither data-bento-* attr, so closest() walks past it up
        // to the outer #tabbrowser-tabbox (which DOES carry data-bento-
        // main-panel) and the fallback below incorrectly resets
        // currentActiveIdx to 0 — turning the next Right-arrow press
        // from the trailer into a wrap-to-first-side-panel jump.
        if (target.closest('#bento-add-panel-trailer')) {
          applyFocusedPanelIndicator(null);
          return;
        }
        // Browser elements live inside the panel containers (notif-
        // boxes) tagged with data-bento-{main-panel,panel-tab-id};
        // closest() walks up to find the right one regardless of any
        // wrapper depth Firefox introduces between <browser> and the
        // panel container.
        const panelEl = target.closest('[data-bento-panel-tab-id], [data-bento-main-panel]');
        if (!panelEl) {
          applyFocusedPanelIndicator(null);
          return;
        }
        // Only scroll if the panel is inside the active strip. If
        // tabpanels isn't in split-view mode, no strip to scroll.
        if (!window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) {
          applyFocusedPanelIndicator(null);
          return;
        }
        scrollPanelIntoViewFromRight(panelEl);
        // Sync the navigator's active marker to match the panel that
        // just received focus. Without this, clicking into a panel
        // scrolls the strip but leaves the favicon highlight stuck on
        // wherever the last keyboard cycle put it. Update state +
        // marker directly rather than calling setActiveByIndex —
        // that helper also focuses the panel's <browser>, which
        // would re-fire this same focusin handler.
        //
        // Index resolution has a subtlety: closest() with the
        // [data-bento-main-panel] selector can match EITHER the inner
        // split-view main panel (the one in getPanelCycleTargets) OR
        // the outer #tabbrowser-tabbox (which also carries the attr,
        // see line 1488 + 4228). When closest returns the outer
        // tabbox, indexOf returns -1 because targets only holds the
        // inner panels — we'd silently skip the update. Resolve by
        // mapping the outer tabbox to targets[0] (the inner main
        // panel always sits at index 0 in splitViewPanels).
        const targets = getPanelCycleTargets();
        let idx = targets.indexOf(panelEl);
        if (idx < 0 && panelEl.id === 'tabbrowser-tabbox' && targets.length > 0) {
          idx = 0;
        }
        if (idx >= 0) {
          currentActiveIdx = idx;
          applyActiveMarker(idx);
          applyFocusedPanelIndicator(targets[idx]);
        }
      },
      true,
    );
  }
  attachPanelClickAutoScroll();

  // ─── "Open in new panel" link context-menu item ────────────────────────
  // Adds a menuitem to Firefox's contentAreaContextMenu that appears when
  // the user right-clicks a link inside any Bento panel (main or side).
  // Clicking the item dispatches panel/openAt with the link's URL plus
  // the source panel's identity — bento-tools then creates the tab and
  // inserts it as a panel immediately to the right of the source.
  function installOpenInNewPanelMenuItem() {
    const menu = document.getElementById('contentAreaContextMenu');
    if (!menu) {
      console.warn('[bento-shell-mount] contentAreaContextMenu missing');
      return;
    }
    if (document.getElementById('bento-context-open-in-panel')) return;

    const item = document.createXULElement('menuitem');
    item.id = 'bento-context-open-in-panel';
    item.setAttribute('label', 'Open in new panel');
    item.hidden = true;
    // Sit next to the existing "Open Link in New Tab" / "Open Link in
    // New Window" items if they exist; fall back to first child.
    const anchor =
      document.getElementById('context-openlinkincurrent') ||
      document.getElementById('context-openlink') ||
      menu.firstChild;
    menu.insertBefore(item, anchor);

    // Resolve the source panel container from gContextMenu.browser.
    // closest() walks up — when split-view is active, the inner main
    // panel and inner side panels carry data-bento-* attrs (set by
    // reconcilePanelsSplitView). When NO side panels exist yet, the
    // OUTER #tabbrowser-tabbox is the only element tagged data-bento-
    // main-panel (set by unifyMainWithStrip at boot). Accept that
    // case too: the outer tabbox has no data-bento-panel-tab-id, so
    // the command handler reads sourceTabId as null → handler inserts
    // at position 0 (first side panel), seeding split-view from a
    // right-click in a plain tab.
    function findSourcePanel() {
      const browser = typeof gContextMenu !== 'undefined' ? gContextMenu?.browser : null;
      if (!browser) return null;
      return browser.closest('[data-bento-panel-tab-id], [data-bento-main-panel]');
    }

    // Defer popupshowing-listener registration until DOMContentLoaded.
    // Firefox initializes gContextMenu inside a DOMContentLoaded callback in
    // browser-context.js — that callback is registered before this script
    // runs (browser-context.inc is parsed before browser-box.inc.xhtml), so
    // it fires first and Firefox's popupshowing listener attaches first. If
    // we attach during parsing, our listener registers earlier and runs
    // first on every popup — seeing gContextMenu from the PREVIOUS open
    // (or undefined initially) and bailing on !onLink before Firefox
    // reassigns it. Deferring to DOMContentLoaded guarantees Firefox's
    // listener registers first.
    const attachPopupShowingListener = () => {
      menu.addEventListener('popupshowing', () => {
        try {
          if (typeof gContextMenu === 'undefined' || !gContextMenu?.onLink) {
            item.hidden = true;
            return;
          }
          if (!gContextMenu.linkURL) {
            item.hidden = true;
            return;
          }
          if (!findSourcePanel()) {
            item.hidden = true;
            return;
          }
          item.hidden = false;
        } catch (err) {
          console.warn('[bento-shell-mount] open-in-panel popupshowing failed:', err);
          item.hidden = true;
        }
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachPopupShowingListener, { once: true });
    } else {
      attachPopupShowingListener();
    }

    item.addEventListener('command', () => {
      try {
        const url = gContextMenu?.linkURL;
        if (!url) return;
        const source = findSourcePanel();
        if (!source) return;
        const sourceTabId = source.dataset.bentoPanelTabId
          ? Number(source.dataset.bentoPanelTabId)
          : null;
        dispatchShellAction({ type: 'panel/openAt', url, sourceTabId });
      } catch (err) {
        console.warn('[bento-shell-mount] open-in-panel command failed:', err);
      }
    });
  }
  installOpenInNewPanelMenuItem();

  // ─── "Open in new panel" places context-menu item ──────────────────────
  // Mirrors installOpenInNewPanelMenuItem but for the bookmark / history /
  // sidebar Places menu (#placesContext). Right-click a bookmark on the
  // toolbar, in the bookmarks menu, or in the sidebar → "Open in New Panel"
  // dispatches panel/openAt with sourceTabId=null, which the handler treats
  // as "insert as first side panel" — same path the main-panel link
  // right-click already uses, so the behaviour is consistent across the
  // two surfaces.
  function installOpenInNewPanelBookmarkMenuItem() {
    const menu = document.getElementById('placesContext');
    if (!menu) return;
    if (document.getElementById('bento-places-context-open-in-panel')) return;

    const item = document.createXULElement('menuitem');
    item.id = 'bento-places-context-open-in-panel';
    item.setAttribute('label', 'Open in New Panel');
    item.hidden = true;
    // Sit immediately after "Open in New Tab" so the open-in-* items stay
    // visually grouped. Fall back through the rest of the family if the
    // preferred anchor is missing (private-browsing / container disabled).
    const anchor =
      document.getElementById('placesContext_open:newcontainertab') ||
      document.getElementById('placesContext_openContainer:tabs') ||
      document.getElementById('placesContext_openLinks:tabs') ||
      document.getElementById('placesContext_open:newwindow') ||
      document.getElementById('placesContext_openSeparator') ||
      null;
    if (anchor) menu.insertBefore(item, anchor);
    else menu.appendChild(item);

    // Read the single-selection URL. Firefox's own popupshowing listener
    // (PlacesUIUtils.placesContextShowing) runs first — it stashes the
    // resolved view on menu._view and the trigger element on
    // PlacesUIUtils.lastContextMenuTriggerNode. Managed (enterprise-policy)
    // bookmarks live in a separate DOM tree under #managed-bookmarks and
    // carry the URL directly on the trigger as .link instead of going
    // through a Places view.
    //
    // place: URIs are Firefox-internal query strings (history smart
    // folders, tag queries, etc.) — they don't render meaningfully in a
    // tab let alone a panel, so we hide the item for those.
    function getBookmarkUrl(callsite) {
      try {
        const trigger =
          typeof PlacesUIUtils !== 'undefined' ? PlacesUIUtils.lastContextMenuTriggerNode : null;
        if (trigger?.closest?.('#managed-bookmarks')) {
          const link = typeof trigger.link === 'string' ? trigger.link : null;
          const result = link && !link.startsWith('place:') ? link : null;
          return result;
        }
        const view = menu._view;
        const selected = view?.selectedNode;
        if (!selected) {
          return null;
        }
        const uri = typeof selected.uri === 'string' ? selected.uri : null;
        if (!uri || uri.startsWith('place:')) {
          return null;
        }
        return uri;
      } catch (err) {
        console.warn(
          '[bento-shell-mount] places open-in-panel:',
          callsite,
          '— getBookmarkUrl threw:',
          err,
        );
        return null;
      }
    }

    // Same registration-order rationale as installOpenInNewPanelMenuItem:
    // Firefox attaches its popupshowing handler inside DOMContentLoaded
    // (placesContextMenu.js), so we defer ours to the same event to
    // guarantee menu._view is populated by the time we run.
    const attachPopupShowing = () => {
      menu.addEventListener('popupshowing', () => {
        try {
          const url = getBookmarkUrl('popupshowing');
          item.hidden = !url;
        } catch (err) {
          console.warn('[bento-shell-mount] places open-in-panel popupshowing failed:', err);
          item.hidden = true;
        }
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachPopupShowing, { once: true });
    } else {
      attachPopupShowing();
    }

    item.addEventListener('command', () => {
      try {
        const url = getBookmarkUrl('command');
        if (!url) {
          console.warn(
            '[bento-shell-mount] places open-in-panel: command fired but no url — view was probably cleared by popuphiding before command ran',
          );
          return;
        }
        const sent = dispatchShellAction({ type: 'panel/openAt', url, sourceTabId: null });
        void sent;
      } catch (err) {
        console.warn('[bento-shell-mount] places open-in-panel command failed:', err);
      }
    });
  }
  installOpenInNewPanelBookmarkMenuItem();

  function injectPanelHeaderIntoLinkedPanel(tab, url) {
    const panelEl = document.getElementById(tab.linkedPanel);
    if (!panelEl) return;
    if (panelEl.querySelector(':scope > .bento-panel-header[data-bento-injected="1"]')) {
      return; // already injected
    }
    if (!tab.linkedBrowser) return;
    const tabId = (() => {
      try {
        const mod = ChromeUtils.importESModule(
          'resource://gre/modules/ExtensionParent.sys.mjs',
        );
        return mod.ExtensionParent?.apiManager?.global?.tabTracker?.getId(tab) ?? null;
      } catch {
        return null;
      }
    })();
    const header = createPanelHeader(tab.linkedBrowser, url, tabId);
    header.dataset.bentoInjected = '1';
    // notificationbox children typically are [notificationstack, browser];
    // insert header as the first child so it visually sits above content.
    panelEl.insertBefore(header, panelEl.firstChild);
    setupHeaderDrag(header, panelEl, tabId);
  }

  // Re-reconcile the split view when the active main tab changes —
  // splitViewPanels[0] needs to follow gBrowser.selectedTab. Cheap:
  // computes the same desired array minus an unchanged panel set.
  // No-op when the pref is off.
  //
  // Listen on multiple targets to make sure we catch the event no matter
  // how it's dispatched: tabContainer (where Mozilla's own listeners
  // live), gBrowser itself (some flows fire here), and the window
  // (TabSelect bubbles). Use a single dedup'd callback so we don't
  // run the reconciler multiple times per actual selection change.
  function attachTabSelectListener() {
    // The IIFE that hosts this script runs synchronously during window
    // construction, before gBrowser, gBrowser.tabContainer, and
    // gBrowser.tabpanels are wired up. If we early-returned without
    // attaching, none of the selection signals would ever fire and
    // new-tab creation would silently bypass the reconciler — that's
    // exactly the bug we hit when the listeners stayed silent for
    // Cmd+T despite TabOpen demonstrably being dispatched. Defer until
    // the window is fully loaded.
    if (!window.gBrowser?.tabContainer || !window.gBrowser?.tabpanels) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, attachTabSelectListener, { once: true });
      }
      return;
    }
    // Override gBrowser.on_visibilitychange so it doesn't deactivate
    // split-view panels when the AsyncTabSwitcher isn't around.
    //
    // Background: tabbrowser.js:8158's on_visibilitychange runs the
    // `!this._switcher` fallback that iterates selectedBrowsers and
    // sets docShellIsActive = !document.hidden on each. With the
    // AsyncTabSwitcher, this branch is skipped (the switcher handles
    // visibility itself, respecting splitViewBrowsers). But the
    // switcher destroys itself after every successful tab switch
    // (AsyncTabSwitcher.sys.mjs:343 finish() → destroy() →
    // tabbrowser._switcher = null), so by the time a visibility event
    // fires, _switcher is null again, the fallback runs, and our
    // panels get deactivated. Empirically observed: pre-warmup logs
    // showed "switcher exists: false" at the start of every reconcile
    // even though warmupTab created it inside the previous one.
    //
    // Our override is a no-op when in split-view mode. Panels stay
    // active regardless of window visibility — small additional CPU
    // cost when the window is minimised, but no blank-panel race.
    // Out of split-view mode, falls through to the original handler
    // so non-Bento behaviour is preserved.
    if (
      window.gBrowser &&
      typeof window.gBrowser.on_visibilitychange === 'function' &&
      !window.gBrowser.__bentoVisOverride
    ) {
      const original = window.gBrowser.on_visibilitychange.bind(
        window.gBrowser,
      );
      window.gBrowser.on_visibilitychange = function () {
        if (this.tabpanels?.hasAttribute('splitview')) {
          return;
        }
        return original();
      };
      window.gBrowser.__bentoVisOverride = true;
    }

    // Mark tabs as "bento-closing" at the START of _beginRemoveTab — before
    // _blurTab fires TabSelect on a different tab. Firefox's _beginRemoveTab
    // (tabbrowser.js:5730) sets aTab.closing=true at line 5863, but only
    // AFTER it has already called _blurTab(aTab) at line 5796. _blurTab
    // synchronously assigns selectedTab and dispatches TabSelect — which
    // wakes the reconciler. So by the time the reconciler runs, the panels
    // payload still contains the to-be-closed tab AND that tab's `.closing`
    // is still false. The in-reconciler `!t.closing` filter is therefore
    // a no-op for that specific reconcile.
    //
    // We can't safely reorder Firefox's own statements, but setting our
    // own `t.bentoClosing` flag in a pre-call wrapper IS safe — the flag
    // exists from the very first instruction of _beginRemoveTab and the
    // reconciler checks it alongside `.closing`. Net effect: the closing
    // tab is filtered out of `resolved` on the very first reconcile
    // triggered by _blurTab, so no ghost strip-panel is rendered.
    if (
      window.gBrowser &&
      typeof window.gBrowser._beginRemoveTab === 'function' &&
      !window.gBrowser.__bentoBeginRemoveOverride
    ) {
      const originalBeginRemove = window.gBrowser._beginRemoveTab.bind(window.gBrowser);
      window.gBrowser._beginRemoveTab = function (aTab, ...args) {
        if (aTab) aTab.bentoClosing = true;
        const ok = originalBeginRemove(aTab, ...args);
        // _beginRemoveTab returns false when the close is rejected: tab
        // already closing, window already closing, or beforeunload denied
        // permitUnload. In the beforeunload-denied case the tab survives
        // and must not stay filtered, otherwise it'd be excluded from
        // every future reconcile.
        if (!ok && aTab) aTab.bentoClosing = false;
        return ok;
      };
      window.gBrowser.__bentoBeginRemoveOverride = true;
    }

    // Scope tab-close succession to the current workspace's sidebar tabs.
    // Firefox's _findTabToBlurTo (tabbrowser.js:6231) picks "the next
    // visible tab" when the selected tab is closed. In Bento, the global
    // tab list is shared across workspaces, so Firefox's default
    // succession can land on:
    //   (a) a strip panel — promotes it to main, shifts every other
    //       strip slot to fill the gap. Symptom: "strip shifts as if
    //       the main slot itself is closing."
    //   (b) a tab in another workspace (or unassigned) — the new
    //       active is "foreign" and doesn't appear in the current
    //       workspace's sidebar list. Symptom: "the tab that becomes
    //       active is sometimes not one of the tabs in the workspace."
    //
    // Exclude both classes from succession. Firefox's existing fallback
    // chain (successor → owner → next visible → collapsed-group) runs
    // against the filtered set, landing on a current-workspace sidebar
    // tab whenever one exists. If none remain (degenerate case: every
    // other tab is a panel or foreign), fall back to the unfiltered
    // original so we don't strand selectedTab at null.
    //
    // The bentoClosing pre-mark above is the orthogonal half of this
    // fix: it filters the closing tab itself out of the reconciler's
    // `resolved` list so it isn't re-rendered as a strip panel for one
    // frame during the _blurTab-triggered reconcile.
    if (
      window.gBrowser &&
      typeof window.gBrowser._findTabToBlurTo === 'function' &&
      !window.gBrowser.__bentoFindTabOverride
    ) {
      const original = window.gBrowser._findTabToBlurTo.bind(window.gBrowser);
      window.gBrowser._findTabToBlurTo = function (aTab, aExcludeTabs = []) {
        const tabTracker = getTabTracker();
        const SessionStore = getSessionStore();
        const haveWorkspaceContext = currentWorkspaceId && SessionStore;
        const havePanelContext = currentPanelTabIds.size > 0 && tabTracker;
        if (haveWorkspaceContext || havePanelContext) {
          const panelExtras = [];
          const foreignExtras = [];
          for (const tab of this.tabs) {
            if (tab === aTab) continue;
            if (havePanelContext) {
              let webExtId = null;
              try {
                webExtId = tabTracker.getId(tab);
              } catch {
                /* tabTracker may transiently not know about a tab */
              }
              if (webExtId !== null && currentPanelTabIds.has(webExtId)) {
                panelExtras.push(tab);
                continue;
              }
            }
            if (haveWorkspaceContext) {
              let wsValue = null;
              try {
                const raw = SessionStore.getCustomTabValue(tab, WORKSPACE_SESSION_KEY);
                if (raw) wsValue = JSON.parse(raw);
              } catch {
                /* tab without value, treat as null (foreign) */
              }
              if (wsValue !== currentWorkspaceId) {
                foreignExtras.push(tab);
              }
            }
          }
          // Preference order:
          //   1. Current-workspace sidebar tab (excludes both panels
          //      and foreign/unassigned). Matches what the user sees
          //      in the sidebar — the natural "next" tab.
          //   2. Any non-panel tab (excludes panels only). Avoids the
          //      strip-shift symptom; tolerates landing on a foreign
          //      tab if no current-workspace sidebar tab exists.
          //   3. Unfiltered original. Last-resort so selectedTab isn't
          //      stranded at null when every other tab is a panel.
          if (panelExtras.length > 0 || foreignExtras.length > 0) {
            const tier1 = original(aTab, aExcludeTabs.concat(panelExtras, foreignExtras));
            if (tier1) return tier1;
          }
          if (panelExtras.length > 0) {
            const tier2 = original(aTab, aExcludeTabs.concat(panelExtras));
            if (tier2) return tier2;
          }
        }
        return original(aTab, aExcludeTabs);
      };
      window.gBrowser.__bentoFindTabOverride = true;
    }

    let lastReconciledFor = null;
    const reconcile = (_source) => {
      const sel = window.gBrowser.selectedTab;
      if (sel === lastReconciledFor) return;
      lastReconciledFor = sel;
      if (shouldDeferReconcileForWorkspaceSwitch(sel)) {
        armWorkspaceSwitchFade();
        return;
      }
      reconcilePanelsSplitView(__lastPanelsPayload);
    };

    // Signal 1: TabSelect on the tabContainer / gBrowser / window. This is
    // the canonical Mozilla event but in practice doesn't always reach our
    // listener for new-tab-creation flows (Cmd+T, sidebar +) — observed
    // empirically: the reconciler never fires even though selectedTab
    // demonstrably changes. Keep the listener registered as a fast path
    // for the cases it does fire (sidebar tab clicks).
    const onTabSelect = () => reconcile('TabSelect');
    window.gBrowser.tabContainer?.addEventListener('TabSelect', onTabSelect);
    window.gBrowser.addEventListener?.('TabSelect', onTabSelect);
    window.addEventListener('TabSelect', onTabSelect, true);

    // Signal 2: TabOpen. Catches new-tab creation regardless of whether
    // the new tab becomes selected synchronously. The reconciler reads
    // gBrowser.selectedTab when it runs, so if the new tab IS now the
    // selected one (the typical case for Cmd+T), this picks it up.
    // If TabOpen fires before selection settles, the dedup on
    // lastReconciledFor turns the second pass into a no-op.
    const onTabOpen = () => reconcile('TabOpen');
    window.gBrowser.tabContainer?.addEventListener('TabOpen', onTabOpen);

    // Signal 3: 'select' event on tabpanels. MozDeck's selectedIndex
    // setter dispatches this event whenever the selected panel changes
    // (toolkit/content/widgets/tabbox.js:237-239). It's the canonical
    // signal for "the visible content area changed" and catches every
    // selection mechanism — including ones where TabSelect/TabOpen
    // don't reach our handler. The class the deck toggles is
    // `.deck-selected` (line 218), not the `[selected]` attribute, so
    // the earlier MutationObserver attempt with attributeFilter:
    // ['selected'] never fired.
    window.gBrowser.tabpanels?.addEventListener('select', () =>
      reconcile('tp.select'),
    );

    // Wire the custom always-visible scrollbar (#bento-strip-scrollbar
    // in the sidebar) to track tabpanels' horizontal scroll. The
    // scrollbar's drag/click handlers already resolve their target via
    // getStripScrollTarget(), but they only react to user interaction
    // — the thumb position needs separate scroll + resize listeners
    // to update when panels are added, scrollLeft changes via wheel,
    // or the window resizes. Same pattern as the legacy host wiring
    // (see setupPanelNavigator). One-time setup.
    const tp = window.gBrowser.tabpanels;
    if (tp && !tp.__bentoStripScrollWired) {
      const onStripChange = () => {
        updateStripScrollbar();
        // Re-position inter-panel splitters — scroll shifts the
        // panel boundaries in viewport space, so the absolute-
        // positioned splitters need to follow. Cheap (just style
        // writes against bounding rects).
        try {
          syncInterPanelSplitters();
        } catch (err) {
          console.warn('[bento-shell-mount] strip scroll splitter sync failed:', err);
        }
        // Persist the user's scroll position for the active workspace.
        // Skip programmatic writes (workspace-switch restore) so we
        // don't echo restored values back to tools. Skip when we
        // don't know our workspace yet (boot before first panels/sync)
        // — the next genuine scroll after boot will capture it.
        if (__suppressStripScrollDispatch) return;
        if (!currentWorkspaceId) return;
        const left = tp.scrollLeft;
        // Capture workspaceId at scroll time, not dispatch time. The
        // debounce can outlive a workspace switch; binding the id
        // here ensures the dispatched value targets the workspace
        // the user was scrolling, not whatever's active when the
        // setTimeout fires.
        const capturedWorkspaceId = currentWorkspaceId;
        // Update the local mirror eagerly so a workspace-switch round-
        // trip (leave + return quickly) picks up the latest position
        // even if the title-IPC echo from tools hasn't landed yet.
        stripScrollByWorkspace.set(capturedWorkspaceId, left);
        if (__stripScrollDispatchTimer) clearTimeout(__stripScrollDispatchTimer);
        __stripScrollDispatchTimer = setTimeout(() => {
          __stripScrollDispatchTimer = null;
          dispatchShellAction({
            type: 'panel/setStripScroll',
            workspaceId: capturedWorkspaceId,
            scrollLeft: left,
          });
        }, STRIP_SCROLL_DEBOUNCE_MS);
      };
      tp.addEventListener('scroll', onStripChange, { passive: true });
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(onStripChange);
        ro.observe(tp);
      }
      tp.__bentoStripScrollWired = true;
    }
  }

  function reconcilePanels(panels, options = {}) {
    reconcilePanelsSplitView(panels, options);
  }

  function handlePanelsTitle(rawTitle) {
    // Format: BENTO_PANELS:<ts>:<base64-of-json-array>
    // Skip the prefix and the timestamp segment.
    const tail = rawTitle.slice(PANELS_PREFIX.length);
    const colonAfterTs = tail.indexOf(':');
    if (colonAfterTs < 0) return;
    const b64 = tail.slice(colonAfterTs + 1);
    let decoded;
    try {
      // Counterpart of the sidebar's btoa(unescape(encodeURIComponent(json))).
      decoded = JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) {
      console.warn('[bento-shell-mount] failed to decode BENTO_PANELS payload:', e);
      return;
    }
    // Payload shape: { workspaceId, panels, windowId?, ... }.
    // workspaceId is the currently-active Bento workspace for THIS WINDOW
    // (phase A.4 — per-window active workspace); chrome stores it so the
    // Cmd+1..9 handler can scope tab activation. The panels array drives
    // the side-panel strip reconcile. windowId is informational — each
    // chrome window reads its own document.title intrinsically, but the
    // shell stamps the originating window for cross-window debugging /
    // future validation. We don't strictly need to act on windowId (the
    // per-window-ness is already implicit in document.title scope) but
    // we log it so a mismatched payload would be visible.
    let panels;
    // Hoisted to outer scope so the fade-routing branch BELOW the
    // if/else can read it. A `const` inside the else-if would be
    // out-of-scope at the read site and throw ReferenceError on every
    // payload, silently aborting the reconcile.
    let isWorkspaceTransition = false;
    let scrollToPanelTabId = null;
    if (Array.isArray(decoded)) {
      panels = decoded;
    } else if (decoded && Array.isArray(decoded.panels)) {
      panels = decoded.panels;
      const incomingWorkspaceId =
        typeof decoded.workspaceId === 'string' ? decoded.workspaceId : null;
      if (typeof decoded.windowId === 'number') {
        // No window-ID validation against gBrowser here yet — chrome
        // can't trivially resolve "my own WebExtension windowId" without
        // a hop through ExtensionParent.windowTracker. Phase F's
        // workspace mirroring will revisit this when per-window
        // routing becomes load-bearing. For now, the per-window
        // selector in useToolsPort already ensures each shell only
        // writes its own window's title.
         
        decoded.windowId; // documented presence; informational only
      }
      // Workspace just changed — flag the next reconcile so the main
      // panel gets a one-shot CSS width transition. Without this the
      // sequence is: TabSelect fires immediately (new tab content swaps
      // in), then up to 200ms later the title-IPC poll picks up the new
      // mainWidthPx and the panel snaps to the new width. The snap
      // reads as two-stage. The transition makes it feel synchronized
      // even though the underlying messages aren't.
      const wsChanged =
        currentWorkspaceId !== null &&
        incomingWorkspaceId !== null &&
        currentWorkspaceId !== incomingWorkspaceId;
      // Broader transition test (boot included) — used below to decide
      // both panel-strip scroll restore AND the workspace-switch fade.
      // Computed BEFORE the currentWorkspaceId mutation so the
      // comparison actually sees the previous value. Assigned (not
      // re-declared) so the outer-scope `let` from the top of
      // handlePanelsTitle is the binding the fade router below reads.
      isWorkspaceTransition =
        incomingWorkspaceId !== null && currentWorkspaceId !== incomingWorkspaceId;
      currentWorkspaceId = incomingWorkspaceId;
      currentPanelTabIds = new Set(panels.map((p) => p.tabId));
      // Update mainPanelWidth from persisted tools state when present.
      // Missing mainWidthPx is not authoritative: workspace-switch
      // payloads can arrive before tools has echoed the just-written
      // value, and the main slot width is intentionally shared across
      // workspaces for this window/profile.
      if (typeof decoded.mainWidthPx === 'number' && decoded.mainWidthPx > 0) {
        mainPanelWidth = decoded.mainWidthPx;
      }
      __mainWidthTransitionForNextReconcile = wsChanged;
      // Self-correcting backstop for the dedicated BENTO_COLOR_MODE
      // path: if a panels/sync raced with a color-mode change and
      // overwrote the title before chrome polled it, the next reconcile
      // re-applies. Idempotent — applyChromeColorMode short-circuits
      // when the attribute already matches.
      if (decoded.uiColorMode === 'light' || decoded.uiColorMode === 'dark') {
        applyChromeColorMode(decoded.uiColorMode);
      }
      if (typeof decoded.themeId === 'string' && decoded.themeId.trim().length > 0) {
        const themeId = decoded.themeId.trim();
        document.documentElement.setAttribute('data-bento-theme', themeId);
      }
      // Sidebar collapsed state — toggle a class on the chrome host so
      // CSS narrows the sidebar to a rail showing only favicons and the
      // workspace avatar.
      if (typeof decoded.sidebarCollapsed === 'boolean') {
        applyChromeSidebarCollapsed(decoded.sidebarCollapsed);
      }
      // Custom panel sizes (kebab menu presets). Filter to finite
      // positive integers up front so the menu doesn't have to defend
      // against malformed entries on every open. Missing key leaves
      // the list untouched — earlier payloads might have carried it.
      if (Array.isArray(decoded.customPanelSizes)) {
        currentCustomPanelSizes = decoded.customPanelSizes
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0)
          .map((n) => Math.round(n));
      }
      if (typeof decoded.panelCycleWraparound === 'boolean') {
        currentPanelCycleWraparound = decoded.panelCycleWraparound;
      }
      if (typeof decoded.panelShadowsEnabled === 'boolean') {
        applyChromePanelShadowsEnabled(decoded.panelShadowsEnabled);
      }
      if (
        typeof decoded.scrollToPanelTabId === 'number' &&
        Number.isInteger(decoded.scrollToPanelTabId)
      ) {
        scrollToPanelTabId = decoded.scrollToPanelTabId;
      }
      // Pinned-panel tabIds for the incoming workspace. Workspace-
      // filtered upstream so a Set.has(tabId) is enough to pick the
      // Pin/Unpin label in the kebab menu. Missing key means the
      // workspace has no pins (tools omits the field when the array
      // is empty); reset the local mirror accordingly so a workspace
      // switch from a pinned workspace into an unpinned one doesn't
      // carry stale state forward.
      if (Array.isArray(decoded.pinnedTabIdsInWorkspace)) {
        currentPinnedTabIdsInWorkspace = new Set(
          decoded.pinnedTabIdsInWorkspace
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n)),
        );
      } else {
        currentPinnedTabIdsInWorkspace = new Set();
      }
      // Saved-panel count drives the Add-panel trailer's flex-basis
      // so the inline favicon row has room to render. Global (not
      // workspace-scoped) but rides on this payload because chrome
      // already polls BENTO_PANELS — see SavedPanelsStore in
      // bento-tools. Missing key resets to 0 (legacy tools builds
      // that haven't been rebuilt with the bookmarks permission).
      if (typeof decoded.savedPanelCount === 'number' && decoded.savedPanelCount >= 0) {
        currentSavedPanelCount = Math.round(decoded.savedPanelCount);
      } else {
        currentSavedPanelCount = 0;
      }
      applyTrailerWidth(currentSavedPanelCount);
      // Per-workspace panel-strip scroll position. Capture into the
      // module-level map keyed by workspaceId so:
      //   - Same-workspace reconciles (panel add/remove, width change)
      //     don't clobber a fresh in-flight user scroll.
      //   - Workspace-switch reconciles can look up the destination
      //     workspace's stored scrollLeft and apply it after the
      //     reconcile has finished laying out the new panel set.
      // Missing field on the payload leaves the current map entry
      // untouched (older tools, or no scroll recorded yet).
      if (typeof decoded.stripScrollLeft === 'number' && decoded.stripScrollLeft >= 0) {
        stripScrollByWorkspace.set(incomingWorkspaceId, decoded.stripScrollLeft);
      }
      // Workspace transition: apply the destination workspace's
      // stored scroll AFTER the reconcile commits layout. Without
      // this the chrome strip always lands at scrollLeft=0 (rebuilding
      // the tabpanels children resets scroll), so the user always
      // sees the main slot regardless of where the strip was before.
      //
      // Triggers on BOTH boot (null → X) AND inter-workspace switches
      // (X → Y) — see isWorkspaceTransition computation above.
      if (isWorkspaceTransition) {
        const targetScroll = stripScrollByWorkspace.get(incomingWorkspaceId);
        __pendingStripScrollRestore = typeof targetScroll === 'number' ? targetScroll : null;
      }
    } else {
      return;
    }
    // OS-level reduced-motion: skip the fade (and the 140ms
    // pre-reconcile delay it implies) so the swap is instant for
    // users who've opted out of animation. Matches the React
    // sidebar's TabList.css behaviour.
    const reduceMotion = prefersReducedWorkspaceMotion();
    if (isWorkspaceTransition && !reduceMotion) {
      // Crossfade-then-swap: fade the visible workspace contents out,
      // perform the reconcile DOM swap behind the opacity-0 curtain,
      // then fade back in. Without this, the panel strip / favicon
      // navigator / main content all swap instantly while only the
      // React sidebar slides — the asymmetric motion reads as a
      // visual glitch even though each individual swap is correct.
      performWorkspaceSwitchFade(panels);
    } else {
      reconcilePanels(panels, { scrollToPanelTabId });
      applyPendingStripScrollRestore();
    }
  }

  // Apply any pending strip-scroll restore after the reconciler has
  // committed the new panel DOM. Two rAFs because the first commits
  // the layout style writes and the second is the first frame where
  // scrollWidth reflects the final panel widths — applying earlier
  // gets clamped to the (pre-reconcile) scrollWidth and lands short.
  // NOT used during the fade path — that branch applies scroll
  // restore synchronously, under the opacity-0 curtain, so the user
  // never sees the scroll position settle.
  function applyPendingStripScrollRestore() {
    if (__pendingStripScrollRestore === null) return;
    const target = __pendingStripScrollRestore;
    __pendingStripScrollRestore = null;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const host = getStripScrollTarget();
        if (!host) return;
        // Suppress the dispatch the scroll listener would otherwise
        // fire: this is a programmatic restore, not a user gesture,
        // and dispatching here would write the restored value back
        // to tools as if it were a fresh user action (harmless but
        // noisy in the log + persistence layer).
        __suppressStripScrollDispatch = true;
        try {
          host.scrollLeft = Math.max(0, target);
        } finally {
          // Clear the suppression on the next frame so any user
          // scroll that lands AFTER the programmatic write is
          // captured normally.
          requestAnimationFrame(() => {
            __suppressStripScrollDispatch = false;
          });
        }
      });
    });
  }

  // Workspace-switch fade coordinator. Adds the fade-out class
  // immediately, defers the reconcile until the fade-out CSS
  // transition has visually completed, then queues a single rAF to
  // remove the class and let the CSS transition handle fade-in.
  //
  // Key invariant: NOTHING moves during the fade. The reconcile runs
  // at opacity 0, with main-width transition suppressed and the
  // auto-scroll-to-main path gated off; scroll restore happens
  // synchronously under the curtain. By the time the fade class is
  // removed, all layout is at its final destination — the user sees
  // a STATIC fade-in, no sliding.
  //
  // Belt-and-suspenders cleanup: each fragile step has its own
  // try/catch, the rAF that removes the class lives in `finally`
  // (always runs), and a watchdog timer force-clears the class if
  // it's still present after WORKSPACE_FADE_WATCHDOG_MS. Without
  // these guards a single failed reconcile would strand opacity at
  // 0 — chrome would go blank until process restart.
  let __workspaceSwitchTimer = null;
  let __workspaceFadeWatchdog = null;
  let __workspaceFadeCleanupTimer = null;
  const WORKSPACE_FADE_WATCHDOG_MS = 1500;
  const WORKSPACE_FADE_MS = 140;
  const WORKSPACE_STABILIZE_MS = 260;
  function clearWorkspaceFadeClasses() {
    const sc = document.getElementById('bento-strip-container');
    const tp = window.gBrowser?.tabpanels;
    if (sc) sc.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    if (tp) tp.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    if (__workspaceFadeCleanupTimer) {
      clearTimeout(__workspaceFadeCleanupTimer);
      __workspaceFadeCleanupTimer = null;
    }
  }
  function setWorkspaceFadeClasses(enabled) {
    const stripContainer = document.getElementById('bento-strip-container');
    const tp = window.gBrowser?.tabpanels;
    for (const el of [stripContainer, tp]) {
      if (!el) continue;
      el.classList.toggle('bento-workspace-switching', enabled);
      el.classList.toggle('bento-workspace-stabilizing', enabled);
    }
  }
  function cancelStripScrollMotion() {
    const host = getStripScrollTarget();
    if (!host) return;
    // Assigning the current value cancels an in-flight native smooth
    // scroll without changing the final position.
    host.scrollLeft = host.scrollLeft;
  }
  function armWorkspaceSwitchFade() {
    cancelStripScrollMotion();
    setWorkspaceFadeClasses(true);
  }
  function selectedTabWorkspaceId(tab) {
    if (!tab) return null;
    const SessionStore = getSessionStore();
    if (!SessionStore) return null;
    try {
      const raw = SessionStore.getCustomTabValue(tab, WORKSPACE_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function shouldDeferReconcileForWorkspaceSwitch(tab) {
    if (prefersReducedWorkspaceMotion()) return false;
    if (!currentWorkspaceId) return false;
    const tabWorkspaceId = selectedTabWorkspaceId(tab);
    return tabWorkspaceId !== null && tabWorkspaceId !== currentWorkspaceId;
  }
  function prefersReducedWorkspaceMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }
  function performWorkspaceSwitchFade(panels) {
    const stripContainer = document.getElementById('bento-strip-container');
    const tp = window.gBrowser?.tabpanels;
    if (__workspaceSwitchTimer) clearTimeout(__workspaceSwitchTimer);
    if (__workspaceFadeWatchdog) clearTimeout(__workspaceFadeWatchdog);
    if (__workspaceFadeCleanupTimer) {
      clearTimeout(__workspaceFadeCleanupTimer);
      __workspaceFadeCleanupTimer = null;
    }
    // Watchdog armed BEFORE we add the class so any throw between
    // here and the cleanup rAF still gets a chance to clear the
    // class and restore visibility.
    __workspaceFadeWatchdog = setTimeout(() => {
      __workspaceFadeWatchdog = null;
      if (
        (stripContainer && stripContainer.classList.contains('bento-workspace-switching')) ||
        (tp && tp.classList.contains('bento-workspace-switching'))
      ) {
        console.warn(
          '[bento-shell-mount] workspace-switch watchdog fired — fade class lingered, force-clearing',
        );
        clearWorkspaceFadeClasses();
      }
    }, WORKSPACE_FADE_WATCHDOG_MS);
    armWorkspaceSwitchFade();
    __workspaceSwitchTimer = setTimeout(() => {
      __workspaceSwitchTimer = null;
      // Suppress every in-reconcile animation. The fade IS our
      // transition; any layout animation here would tail past the
      // fade-in and the user would see panels sliding into place.
      //  - Clear __mainWidthTransitionForNextReconcile (set above on
      //    wsChanged) so reconcile snaps the main-panel width
      //    instead of running a 200ms width transition.
      //  - Set __workspaceSwitchSwapping so reconcilePanelsSplitView
      //    skips its smooth scrollPanelToLeftmost auto-scroll-to-main.
      __mainWidthTransitionForNextReconcile = false;
      __workspaceSwitchSwapping = true;
      try {
        try {
          reconcilePanels(panels);
          cancelStripScrollMotion();
        } catch (err) {
          console.warn('[bento-shell-mount] workspace-switch reconcile threw:', err);
        }
        // Apply scroll restore SYNCHRONOUSLY, not via
        // applyPendingStripScrollRestore's double-rAF (which would
        // defer past fade-in). Setting scrollLeft directly is
        // instant — no smooth animation — so the user can't see
        // the strip moving. Happens under the opacity-0 curtain
        // because the class-removal rAF hasn't fired yet.
        if (__pendingStripScrollRestore !== null) {
          try {
            const target = __pendingStripScrollRestore;
            __pendingStripScrollRestore = null;
            const host = getStripScrollTarget();
            if (host) {
              __suppressStripScrollDispatch = true;
              try {
                host.scrollLeft = Math.max(0, target);
              } finally {
                requestAnimationFrame(() => {
                  __suppressStripScrollDispatch = false;
                });
              }
            }
          } catch (err) {
            console.warn(
              '[bento-shell-mount] workspace-switch scroll restore threw:',
              err,
            );
          }
        }
      } finally {
        __workspaceSwitchSwapping = false;
        // Class removal MUST run even if reconcile/scroll-restore
        // threw — otherwise the chrome stays at opacity 0 forever.
        // The watchdog above is the belt; this `finally` is the
        // suspenders.
        requestAnimationFrame(() => {
          if (stripContainer) stripContainer.classList.remove('bento-workspace-switching');
          if (tp) tp.classList.remove('bento-workspace-switching');
          // Keep layout-transition suppression through the fade-in. If
          // we remove it in the same frame as the opacity class, pending
          // width/flex changes can begin animating under the fade-in and
          // look like the strip is sliding to the destination workspace.
          __workspaceFadeCleanupTimer = setTimeout(() => {
            __workspaceFadeCleanupTimer = null;
            if (stripContainer) {
              stripContainer.classList.remove('bento-workspace-stabilizing');
            }
            if (tp) tp.classList.remove('bento-workspace-stabilizing');
          }, WORKSPACE_STABILIZE_MS);
          if (__workspaceFadeWatchdog) {
            clearTimeout(__workspaceFadeWatchdog);
            __workspaceFadeWatchdog = null;
          }
        });
      }
    }, WORKSPACE_FADE_MS);
  }
  // True while the deferred reconcile inside performWorkspaceSwitchFade
  // is running. Read by reconcilePanelsSplitView to skip the smooth
  // scrollPanelToLeftmost auto-scroll-to-main that would otherwise
  // tail past the fade-in window as visible sliding.
  let __workspaceSwitchSwapping = false;

  // Module-level mirror of bento-tools' per-workspace strip-scroll map.
  // Populated from BENTO_PANELS payloads (which carry stripScrollLeft).
  // Read on workspace switch to decide which scroll position to restore.
  const stripScrollByWorkspace = new Map();
  // Single-shot scroll value the next reconcile should apply after
  // layout commits (workspace-switch path). Null when no restore is
  // pending. Cleared after consumption so subsequent same-workspace
  // reconciles don't re-apply it.
  let __pendingStripScrollRestore = null;
  // True while a programmatic scrollLeft write is in flight. The
  // scroll listener that dispatches panel/setStripScroll checks this
  // and skips the dispatch so we don't echo restored values back to
  // tools.
  let __suppressStripScrollDispatch = false;
  // Debounce handle for outbound panel/setStripScroll dispatches.
  // Scroll events fire continuously during a drag; coalesce to one
  // dispatch per rest. Matches the persistence DEBOUNCE_MS pattern.
  let __stripScrollDispatchTimer = null;
  const STRIP_SCROLL_DEBOUNCE_MS = 250;

  function applyChromeSidebarCollapsed(collapsed) {
    const host = document.getElementById('bento-shell-host');
    if (!host) return;
    // First apply at boot: skip the CSS width transition so the
    // persisted state paints at its target width immediately. Without
    // this the user sees the sidebar mount at 240px (the patch's inline
    // width) and animate to 4rem once the title-IPC arrives — reads as
    // a flash. Subsequent toggles get the transition for the smooth
    // collapse/expand UX.
    if (!host.__bentoSidebarApplied) {
      host.__bentoSidebarApplied = true;
      const wasCollapsed = host.classList.contains('bento-sidebar-collapsed');
      if (wasCollapsed !== collapsed) {
        host.style.transition = 'none';
        host.classList.toggle('bento-sidebar-collapsed', collapsed);
        // Force layout commit so the next style change is treated as a
        // new transition, not a continuation of the suppressed one.
         
        host.offsetWidth;
        host.style.removeProperty('transition');
      }
    } else {
      host.classList.toggle('bento-sidebar-collapsed', collapsed);
    }
    // Hide the resize splitter when collapsed — there's nothing to drag
    // when the rail is at its minimum width.
    const splitter = document.getElementById('bento-shell-splitter');
    if (splitter) splitter.classList.toggle('bento-sidebar-collapsed', collapsed);
  }

  // One-shot flag set by handlePanelsTitle when the workspace changed.
  // The reconciler reads + clears it before applying the main-panel
  // width so the change animates from old to new width instead of
  // snapping. Cleared after the first reconcile so subsequent same-
  // workspace reconciles (TabSelect within a workspace) don't transition.
  let __mainWidthTransitionForNextReconcile = false;

  // Active workspace state mirrored from the shell via BENTO_PANELS payload.
  // Cmd+1..9 reads these to scope tab activation to the current workspace
  // (so Cmd+3 picks the 3rd tab in the active workspace, not the 3rd tab
  // in Firefox's flat tab list which would jump across workspaces).
  let currentWorkspaceId = null;
  let currentPanelTabIds = new Set();
  // Preset side-panel widths surfaced in each panel header's kebab menu.
  // Mirrored from BentoSettings.customPanelSizes via the BENTO_PANELS
  // payload — same single-channel-no-race rationale as uiColorMode /
  // sidebarCollapsed (see useToolsPort.ts). Read on-demand when the
  // user opens a kebab menu; stays empty until the first payload that
  // includes it (settings store default is [320, 480, 768, 1280]).
  let currentCustomPanelSizes = [];
  // BentoSettings.panelCycleWraparound mirrored via the same payload.
  // When true, Left/Right arrow cycling wraps past the Add-panel
  // trailer back to the main panel (and vice versa). Default false:
  // cycling clamps at the endpoints.
  let currentPanelCycleWraparound = false;
  // BentoSettings.panelShadowsEnabled mirrored via BENTO_PANELS. When
  // false, the shadow proxy elements are removed and no new ones are
  // created during splitter/scroll/resize sync. Default true.
  let currentPanelShadowsEnabled = true;
  // Pinned-panel tabIds for THIS WINDOW's active workspace, mirrored
  // from BENTO_PANELS payload's `pinnedTabIdsInWorkspace` field. The
  // kebab menu reads this to pick the Pin/Unpin label without having
  // to round-trip a fresh query through bento-tools. Workspace-
  // filtered upstream (tools only includes the active workspace's
  // pin subset) so a Set.has(tabId) lookup is enough — no global pin
  // map needed chrome-side.
  let currentPinnedTabIdsInWorkspace = new Set();
  // Number of bookmarks in the "Saved panels" folder. Mirrored from
  // BENTO_PANELS payload's `savedPanelCount` field. Drives the
  // Add-panel trailer's flex-basis via applyTrailerWidth so the
  // inline favicon row has room to grow.
  let currentSavedPanelCount = 0;

  function applyChromePanelShadowsEnabled(enabled) {
    currentPanelShadowsEnabled = enabled;
    const container = document.getElementById('bento-strip-container');
    if (!container) return;
    container.classList.toggle('bento-panel-shadows-disabled', !enabled);
    if (!enabled) {
      removePanelShadows(container);
      return;
    }
    try {
      syncPanelShadows((window.gBrowser?.tabpanels?.splitViewPanels || []).slice());
    } catch (err) {
      console.warn('[bento-shell-mount] panel shadow enable sync failed:', err);
    }
  }

  function attachPaletteCloseListener() {
    const paletteFrame = document.getElementById('bento-palette-frame');
    // Both frames use polling for title-based IPC. DOMTitleChanged is
    // unreliable for our remote=true moz-extension content — the event
    // doesn't fire for either the persistent shell frame or the
    // reload-on-show palette frame in our setup. A 200ms poll loop is
    // cheap (one string comparison per tick), reliable across all
    // mount/reload states, and adds at most 200ms perceived latency
    // to palette open/close (which is fine for a manually-triggered UI).
    if (paletteFrame) {
      let lastSeenPaletteTitle = '';
      setInterval(() => {
        const title = paletteFrame.contentTitle || '';
        if (title === lastSeenPaletteTitle) return;
        lastSeenPaletteTitle = title;
        if (title.startsWith(PALETTE_CLOSE_PREFIX)) hidePalette();
      }, 200);
    }

    const confirmFrame = document.getElementById('bento-confirm-frame');
    if (confirmFrame) {
      let lastSeenConfirmTitle = '';
      setInterval(() => {
        const title = confirmFrame.contentTitle || '';
        if (title === lastSeenConfirmTitle) return;
        lastSeenConfirmTitle = title;
        if (title.startsWith(CONFIRM_CLOSE_PREFIX)) hideConfirm();
      }, 200);
    }

    const editWorkspaceFrame = document.getElementById('bento-edit-workspace-frame');
    if (editWorkspaceFrame) {
      let lastSeenEditTitle = '';
      setInterval(() => {
        const title = editWorkspaceFrame.contentTitle || '';
        if (title === lastSeenEditTitle) return;
        lastSeenEditTitle = title;
        if (title.startsWith(EDIT_WORKSPACE_CLOSE_PREFIX)) hideEditWorkspace();
      }, 200);
    }

    const welcomeFrame = document.getElementById('bento-welcome-frame');
    if (welcomeFrame) {
      let lastSeenWelcomeTitle = '';
      setInterval(() => {
        const title = welcomeFrame.contentTitle || '';
        if (title === lastSeenWelcomeTitle) return;
        lastSeenWelcomeTitle = title;
        if (title.startsWith(WELCOME_CLOSE_PREFIX)) hideWelcome();
      }, 200);
    }

    // Menu overlay: SELECT routes the chosen itemId back to the chrome
    // onSelect handler registered when showChromeMenu was called; CLOSE
    // just hides the overlay (Esc / outside-click in the React menu).
    // Faster poll than the modal overlays (60ms vs 200ms) — a menu
    // selection should feel immediate. Body is still cheap (string
    // startsWith + small map lookup) so the higher frequency is fine.
    const menuFrame = document.getElementById('bento-menu-frame');
    if (menuFrame) {
      let lastSeenMenuTitle = '';
      setInterval(() => {
        const title = menuFrame.contentTitle || '';
        if (title === lastSeenMenuTitle) return;
        lastSeenMenuTitle = title;
        if (title.startsWith(MENU_SELECT_PREFIX)) {
          const rest = title.slice(MENU_SELECT_PREFIX.length);
          const firstColon = rest.indexOf(':');
          if (firstColon < 0) {
            hideChromeMenu();
            return;
          }
          const contextId = rest.slice(0, firstColon);
          const itemId = rest.slice(firstColon + 1);
          const handler = menuOnSelectByContext.get(contextId);
          menuOnSelectByContext.delete(contextId);
          hideChromeMenu();
          if (handler) {
            try {
              handler(itemId);
            } catch (err) {
              console.warn('[bento-shell-mount] chrome menu select handler threw:', err);
            }
          }
        } else if (title.startsWith(MENU_CLOSE_PREFIX)) {
          const contextId = title.slice(MENU_CLOSE_PREFIX.length);
          menuOnSelectByContext.delete(contextId);
          hideChromeMenu();
        }
      }, 60);
    }

    const wsSwitcherFrame = document.getElementById('bento-workspace-switcher-frame');
    if (wsSwitcherFrame) {
      let lastSeenWsSwitcherTitle = '';
      setInterval(() => {
        const title = wsSwitcherFrame.contentTitle || '';
        if (title === lastSeenWsSwitcherTitle) return;
        lastSeenWsSwitcherTitle = title;
        if (title.startsWith(WORKSPACE_SWITCHER_CLOSE_PREFIX)) {
          hideWorkspaceSwitcher();
        } else if (title.startsWith(EDIT_WORKSPACE_OPEN_PREFIX)) {
          // "Edit <workspace>" menu item: the overlay set this title
          // when forwarding to the edit-workspace modal. The payload
          // already reached the edit overlay via BroadcastChannel;
          // we just need to swap the visible host here.
          hideWorkspaceSwitcher();
          showEditWorkspace();
        } else if (title.startsWith(CONFIRM_OPEN_PREFIX)) {
          // "Delete <workspace>" menu item with tabs: forwards to the
          // destructive-confirm modal. Same swap as edit above.
          hideWorkspaceSwitcher();
          showConfirm();
        }
      }, 200);
    }

    const shellFrame = document.getElementById('bento-shell-frame');
    if (shellFrame) {
      let lastSeenShellTitle = '';
      // requestAnimationFrame loop (~60Hz, paint-aligned). setInterval
      // at 200ms (or even 32ms) leaves a visible lag between the
      // sidebar flipping color modes locally and the chrome catching
      // up via the title-IPC channel — users perceive sidebar
      // changing first. rAF guarantees the chrome's data-color-mode
      // mutation lands in the SAME paint frame as the sidebar's, so
      // the entire chrome flips in one visual transition. The poll
      // body (a property read + string compare) is well within a
      // frame budget. Other modal frames stay on setInterval at 200ms
      // — they're user-triggered open/close, no sync requirement.
      const pollShellFrame = () => {
        const title = shellFrame.contentTitle || '';
        if (title !== lastSeenShellTitle) {
          lastSeenShellTitle = title;
          if (title.startsWith(PALETTE_OPEN_PREFIX)) showPalette();
          else if (title.startsWith(CONFIRM_OPEN_PREFIX)) showConfirm();
          else if (title.startsWith(EDIT_WORKSPACE_OPEN_PREFIX)) showEditWorkspace();
          else if (title.startsWith(WELCOME_OPEN_PREFIX)) showWelcome();
          else if (title.startsWith(WORKSPACE_SWITCHER_OPEN_PREFIX)) showWorkspaceSwitcher();
          else if (title.startsWith(SCROLL_TO_MAIN_PREFIX)) handleScrollToMainTitle();
          else if (title.startsWith(FOCUS_PANEL_PREFIX)) handleFocusPanelTitle(title);
          else if (title.startsWith(TAB_MOVE_PREFIX)) handleTabMoveTitle(title);
          else if (title.startsWith(COLOR_MODE_PREFIX)) handleColorModeTitle(title);
          else if (title.startsWith(THEME_PREFIX)) handleThemeTitle(title);
          else if (title.startsWith(PANELS_PREFIX)) handlePanelsTitle(title);
        }
        window.requestAnimationFrame(pollShellFrame);
      };
      window.requestAnimationFrame(pollShellFrame);
    }
  }

  // Chrome-side Esc handler — fires regardless of whether focus is in
  // palette content or anywhere else in the chrome window. Capture phase
  // so it wins over any default handler.
  function attachPaletteEscListener() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        // Stack precedence (top = highest): confirm > edit-workspace >
        // welcome > workspace-switcher > palette. If multiple overlays
        // are somehow open at once, dismiss the topmost first.
        const confirmHost = document.getElementById('bento-confirm-host');
        if (confirmHost && isConfirmVisible(confirmHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideConfirm();
          return;
        }
        const editHost = document.getElementById('bento-edit-workspace-host');
        if (editHost && isEditWorkspaceVisible(editHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideEditWorkspace();
          return;
        }
        const welcomeHost = document.getElementById('bento-welcome-host');
        if (welcomeHost && isWelcomeVisible(welcomeHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideWelcome();
          return;
        }
        const wsSwitcherHost = document.getElementById('bento-workspace-switcher-host');
        if (wsSwitcherHost && isWorkspaceSwitcherVisible(wsSwitcherHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideWorkspaceSwitcher();
          return;
        }
        const host = document.getElementById('bento-palette-host');
        if (!host || !isPaletteVisible(host)) return;
        e.preventDefault();
        e.stopPropagation();
        hidePalette();
      },
      true,
    );
  }

  function attachPaletteKeybinding() {
    // Listen on the chrome window for Cmd/Ctrl+Alt+P. Capture phase so we
    // win against any later-attached handlers; preventDefault to suppress
    // any default Firefox behavior bound to the same combo.
    //
    // Match on `e.code` (physical key, e.g. 'KeyP'), not `e.key` (typed
    // character). On macOS, Option+P produces the Greek letter π; key.toLowerCase()
    // would be 'π' and the match would silently fail. e.code is keyboard-
    // layout-independent and is the right way to spell shortcuts that
    // include modifiers like Alt/Option.
    window.addEventListener(
      'keydown',
      (e) => {
        const accel = navigator.platform.toLowerCase().includes('mac')
          ? e.metaKey
          : e.ctrlKey;
        if (!accel || !e.altKey || e.shiftKey) return;
        if (e.code !== 'KeyP') return;
        e.preventDefault();
        e.stopPropagation();
        togglePalette();
      },
      true,
    );
  }

  // ─── Cmd/Ctrl+1..9 → activate Nth tab in active workspace ──────────────
  //
  // Firefox's default Cmd+1..9 picks the Nth tab in gBrowser.tabs (a flat
  // list across workspaces). In Bento that lands the user on a tab from
  // a different workspace — Cmd+3 in workspace "Work" might activate the
  // 3rd tab in workspace "Personal". We override to pick the Nth tab
  // *within the active workspace*, matching what the sidebar shows.
  //
  // Tab → workspace lookup uses SessionStore.getCustomTabValue with the
  // key WebExtensions persists at: `extension:<addon-id>:<key>`. That's
  // documented behaviour of toolkit/components/extensions/parent/ext-
  // sessions.js — getEncodedKey returns `extension:${extensionId}:${key}`
  // and the value is JSON-encoded. Stable API; we read the same store
  // bento-tools writes via browser.sessions.setTabValue.
  //
  // Panel exclusion uses ExtensionParent.apiManager.global.tabTracker to
  // map gBrowser tabs → WebExtension tab IDs. Panels are still gBrowser
  // tabs (separate from the panel's <browser>), so without exclusion
  // Cmd+N would count them and the indices would drift from the sidebar
  // list. tabTracker is the canonical mapping used by every WebExtension
  // tabs.* API; importing it is supported via ExtensionParent.
  let __sessionStoreModule = null;
  let __tabTrackerModule = null;
  function getSessionStore() {
    if (__sessionStoreModule) return __sessionStoreModule;
    try {
      const mod = ChromeUtils.importESModule(
        'resource:///modules/sessionstore/SessionStore.sys.mjs',
      );
      __sessionStoreModule = mod.SessionStore;
    } catch (err) {
      console.warn('[bento-shell-mount] SessionStore import failed:', err);
    }
    return __sessionStoreModule;
  }
  function getTabTracker() {
    if (__tabTrackerModule) return __tabTrackerModule;
    try {
      const mod = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      __tabTrackerModule = mod.ExtensionParent?.apiManager?.global?.tabTracker || null;
    } catch (err) {
      console.warn('[bento-shell-mount] ExtensionParent import failed:', err);
    }
    return __tabTrackerModule;
  }

  const WORKSPACE_SESSION_KEY = 'extension:bento-tools@bento.app:bento.workspaceId';

  function workspaceTabsInOrder() {
    if (!window.gBrowser || !currentWorkspaceId) return [];
    const SessionStore = getSessionStore();
    if (!SessionStore) return [];
    const tabTracker = getTabTracker();
    const out = [];
    for (const tab of window.gBrowser.tabs) {
      if (tab.hidden || tab.closing) continue;
      let wsValue = null;
      try {
        const raw = SessionStore.getCustomTabValue(tab, WORKSPACE_SESSION_KEY);
        if (raw) wsValue = JSON.parse(raw);
      } catch {
        /* tab without value, treat as null */
      }
      if (wsValue !== currentWorkspaceId) continue;
      // Exclude tabs that are pinned as side panels — they don't appear
      // in the sidebar's tab list, so Cmd+N shouldn't index them either.
      if (tabTracker && currentPanelTabIds.size > 0) {
        let webExtId = null;
        try {
          webExtId = tabTracker.getId(tab);
        } catch {
          /* tabTracker may transiently not know about a tab; treat as not-a-panel */
        }
        if (webExtId !== null && currentPanelTabIds.has(webExtId)) continue;
      }
      out.push(tab);
    }
    return out;
  }

  function attachWorkspaceTabSwitchKeybinding() {
    window.addEventListener(
      'keydown',
      (e) => {
        const accel = navigator.platform.toLowerCase().includes('mac')
          ? e.metaKey
          : e.ctrlKey;
        if (!accel || e.altKey || e.shiftKey) return;
        // Match physical Digit1..Digit9 (not Digit0). e.code is layout-
        // independent so this works with non-QWERTY layouts.
        if (!e.code.startsWith('Digit')) return;
        const n = parseInt(e.code.slice(5), 10);
        if (!Number.isInteger(n) || n < 1 || n > 9) return;
        // No active workspace yet — let Firefox's default Cmd+N tab
        // switch fire so the user isn't stranded with a no-op shortcut
        // before bento-tools has connected.
        if (!currentWorkspaceId) return;
        const tabs = workspaceTabsInOrder();
        const target = tabs[n - 1];
        if (!target) {
          // Workspace has fewer than N visible tabs. Suppress the
          // default to avoid jumping into a different workspace's tab,
          // which is the behaviour the user complained about.
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        try {
          window.gBrowser.selectedTab = target;
        } catch (err) {
          console.warn('[bento-shell-mount] workspace Cmd+N: selectedTab assign failed:', err);
        }
      },
      true,
    );
  }


  // ─── Dev-reload glue ────────────────────────────────────────────────────

  // browser.runtime.reload() (Alt+Shift+R) restarts the addon but the
  // ─── Per-panel accelerator retargeting (Phase 4a) ─────────────────────
  // When DOM focus is on a Bento panel container (or an element inside
  // one), redirect Cmd+R / Cmd+Shift+R / Cmd+L to act on that panel's
  // browser instead of gBrowser.selectedTab. Falls through to Firefox's
  // default behaviour when focus is not on a panel.
  //
  // Known limitation: works for chrome-side focus only (cycle-focused
  // panel container, panel header buttons, panel URL input). When the
  // user has clicked into a panel's web content, focus is in the child
  // process and our chrome window keydown listener doesn't see Cmd+R
  // — Firefox's XUL keyset binds Cmd+R to Browser:Reload, which acts
  // on selectedTab. Fixing this needs the JSWindowActor bridge queued
  // for Phase 4c (see plans/bento-spaces-split-view-panels.md
  // "Content-key bridge"). Cmd+F / Cmd+G also deferred to that phase
  // because the existing find toolbar is per-tabbox and switching
  // selectedTab to invoke it would defeat the cycle-focus model.
  //
  // panelEl is found by walking up from document.activeElement to the
  // closest element with data-bento-main-panel or data-bento-panel-
  // tab-id (stamped on each panel container by the reconciler).
  function getFocusedPanelInfo() {
    const active = document.activeElement;
    if (!active || typeof active.closest !== 'function') return null;
    const panelEl = active.closest(
      '[data-bento-main-panel], [data-bento-panel-tab-id]',
    );
    if (!panelEl) return null;
    const browserEl = panelEl.querySelector('browser');
    if (!browserEl) return null;
    const urlInput = panelEl.querySelector('.bento-panel-header-url');
    return { panelEl, browserEl, urlInput };
  }

  function attachPanelAcceleratorListener() {
    window.addEventListener(
      'keydown',
      (e) => {
        // Match macOS-only for now (Cmd). Linux/Windows would use Ctrl;
        // can extend when Bento ships there. Skip if any other modifier
        // is held that would change semantics.
        if (!e.metaKey || e.altKey || e.ctrlKey) return;

        const key = e.key.toLowerCase();

        // Cmd+R / Cmd+Shift+R: reload focused panel
        if (key === 'r') {
          const info = getFocusedPanelInfo();
          if (!info) return;
          try {
            if (e.shiftKey) {
              const flags =
                Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE |
                Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY;
              info.browserEl.reloadWithFlags(flags);
            } else {
              info.browserEl.reload();
            }
            e.preventDefault();
            e.stopPropagation();
          } catch (err) {
            console.warn('[bento-shell-mount] panel Cmd+R retarget failed:', err);
          }
          return;
        }

        // Cmd+L: focus + select the focused panel's URL input. Cmd+
        // Shift+L is a different shortcut (downloads / library) — let
        // it fall through.
        if (key === 'l' && !e.shiftKey) {
          const info = getFocusedPanelInfo();
          if (!info?.urlInput) return;
          try {
            info.urlInput.focus();
            info.urlInput.select();
            e.preventDefault();
            e.stopPropagation();
          } catch (err) {
            console.warn('[bento-shell-mount] panel Cmd+L retarget failed:', err);
          }
        }
      },
      { capture: true },
    );
  }

  // chrome-mounted <browser> elements keep their old contentDocuments —
  // Firefox auto-reloads moz-extension:// in normal tabs but not in chrome-
  // hosted browser elements. Listen for reload events and reload both
  // frames against the new policy.
  function attachReloadListener() {
    const { AddonManager } = ChromeUtils.importESModule(
      'resource://gre/modules/AddonManager.sys.mjs',
    );
    AddonManager.addAddonListener({
      onEnabled(addon) {
        if (addon.id !== ADDON_ID) return;
        reloadFrames();
      },
    });

    function reloadFrames() {
      // Brief delay so the new addon's WebExtensionPolicy is registered
      // before we ask the <browser>s to refetch. setAttribute with the same
      // URL is a no-op for chrome <browser>, so we use reloadWithFlags to
      // force a fresh fetch and bypass any cached dist/ assets.
      setTimeout(() => {
        const ids = [
          'bento-shell-frame',
          'bento-palette-frame',
          'bento-confirm-frame',
          'bento-edit-workspace-frame',
          'bento-welcome-frame',
          'bento-workspace-switcher-frame',
          'bento-menu-frame',
          'bento-panel-trailer-frame',
        ];
        for (const id of ids) {
          const frame = document.getElementById(id);
          if (!frame) continue;
          try {
            frame.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
          } catch (e) {
            console.warn('[bento-shell-mount] reloadWithFlags failed for', id, e);
            frame.removeAttribute('src');
            if (id === 'bento-shell-frame') setBentoShellSrc();
            else if (id === 'bento-palette-frame') setBentoPaletteSrc();
            else if (id === 'bento-confirm-frame') setBentoConfirmSrc();
            else if (id === 'bento-edit-workspace-frame') setBentoEditWorkspaceSrc();
            else if (id === 'bento-welcome-frame') setBentoWelcomeSrc();
            else if (id === 'bento-workspace-switcher-frame') setBentoWorkspaceSwitcherSrc();
            else if (id === 'bento-menu-frame') setBentoMenuSrc();
            else if (id === 'bento-panel-trailer-frame') setBentoPanelTrailerSrc();
          }
        }
      }, 100);
    }
  }

  // The previous "side panel URL bar binding" (chrome URL bar mirrors +
  // navigates the focused side panel) has been replaced by per-panel
  // headers — each panel's compact urlbar is the canonical place to
  // navigate that panel. The chrome's main URL bar always reflects the
  // active main tab as Firefox normally would.

  setBentoShellSrc();
  setBentoPaletteSrc();
  setBentoConfirmSrc();
  setBentoEditWorkspaceSrc();
  setBentoWelcomeSrc();
  setBentoWorkspaceSwitcherSrc();
  setBentoMenuSrc();
  // Strip the patch's pre-baked single panel browser and configure the
  // host as a horizontal flex strip. Done at script execution time so
  // the strip is ready by the first reconcilePanels(). Wrapped in
  // DOMContentLoaded fallback for the same reason as the URL bar
  // binding — the side panel host is in a patch that inserts after
  // the script tag.
  function configureSidePanelOnce() {
    const host = document.getElementById('bento-side-panel-host');
    const main = document.getElementById('tabbrowser-tabbox');
    if (!host || !main) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, configureSidePanelOnce, { once: true });
      }
      return;
    }
    configureSidePanelStrip();
    unifyMainWithStrip();
    setupPanelNavigator();
    // Initial reconcile with no side panels — primes the strip into
    // a clean baseline state so the first panels/sync from bento-tools
    // can replace it with the real panel list. refreshPanelNav inside
    // reconcilePanels also populates the navigator with the main-panel
    // favicon.
    reconcilePanels([]);
  }
  // Window-resize repaint poke. After a window resize the active
  // tab's content frequently paints at the pre-resize size with the
  // surrounding container background showing through. Tab-out-and-
  // back-in fixes it because the focus path cycles docShellIsActive
  // = false → true, which forces the docShell to re-sync its layout
  // viewport. We do the same cycle once per resize gesture.
  //
  // Cycle UNCONDITIONALLY (don't gate on the current docShellIsActive
  // value) — empirically the active first tab's browser reads as
  // docShellIsActive=false at debounce time, likely because macOS
  // live-resize triggers visibilitychange which Firefox uses to
  // deactivate docShells; the false→true write puts it back where
  // selected browsers should be. Setting `false` first ensures the
  // setter actually re-fires even when the current value is already
  // true (Firefox's setter no-ops on same-value writes).
  function attachResizeRepaintPoke() {
    let timer = null;
    window.addEventListener('resize', () => {
      // Re-sync inter-panel splitter positions immediately so they
      // track the live resize. Cheap (just style writes), runs at
      // the resize event's native rate.
      try {
        syncInterPanelSplitters();
      } catch (err) {
        console.warn('[bento-shell-mount] resize splitter sync failed:', err);
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const browserEl = window.gBrowser?.selectedTab?.linkedBrowser;
        if (!browserEl) return;
        try {
          browserEl.docShellIsActive = false;
          browserEl.docShellIsActive = true;
        } catch (err) {
          console.warn('[bento-shell-mount] resize repaint poke failed:', err);
        }
      }, 60);
    });
  }

  // Content-key bridge — register the BentoKey JSWindowActor pair
  // (BentoKeyChild + BentoKeyParent in the same content directory)
  // ONCE per process. Without this, panel cycling (Left/Right) only
  // works while focus is on the chrome panel container, which keeps
  // content from receiving any keys — breaking page-bound keyboard
  // extensions (Vimium j/k, Surfingkeys, etc.) inside panels.
  //
  // The child listens for keydowns inside content, forwards Bento-
  // bound keys to the parent (which dispatches a CustomEvent on this
  // chrome window — see attachContentKeyBridgeListener below). All
  // other keys pass through naturally so extensions still work.
  //
  // registerWindowActor is process-wide — the second window's
  // bento-shell-mount.js boot would throw NS_ERROR_NOT_AVAILABLE
  // because the actor is already registered. Guard idempotently.
  function registerContentKeyActor() {
    try {
      ChromeUtils.registerWindowActor('BentoKey', {
        parent: { esModuleURI: 'resource:///actors/BentoKeyParent.sys.mjs' },
        child: {
          esModuleURI: 'resource:///actors/BentoKeyChild.sys.mjs',
          events: { keydown: { capture: true } },
        },
        allFrames: true,
        // *://*/* covers http(s)/ws(s); file:/// covers local files;
        // moz-extension://*/* covers Bento's own in-panel pages (settings,
        // privacy dashboard); about:newtab is where new panels land (see
        // addNewPanel); about:blank is the transient marker URL panels sit
        // at before the navigate-away setTimeout fires. Without these the
        // actor doesn't attach inside the panel's <browser>, and since the
        // chrome-side keydown handler bails when activeElement is <browser>
        // (delegating to the actor), Left/Right cycling appears to "stop"
        // whenever the focused panel is on one of these URLs.
        matches: [
          '*://*/*',
          'file:///*',
          'moz-extension://*/*',
          'about:newtab',
          'about:blank',
        ],
      });
    } catch (err) {
      // NS_ERROR_NOT_AVAILABLE = already registered (second window).
      if (!String(err).includes('NS_ERROR_NOT_AVAILABLE')) {
        console.warn('[bento-shell-mount] registerContentKeyActor failed:', err);
      }
    }
  }

  // Listen for the CustomEvent dispatched by BentoKeyParent.
  // navigatePanels is closure-private, so the actor can't call it
  // directly — the event is the bridge.
  function attachContentKeyBridgeListener() {
    window.addEventListener('BentoKey:Cycle', (e) => {
      const dir = e?.detail?.direction;
      if (dir !== 1 && dir !== -1) return;
      navigatePanels(dir);
    });
  }

  // Click-into-panel needs to update currentActiveIdx so a subsequent
  // ←/→ arrow advances from the clicked panel, not from the last
  // explicitly-cycled one. Without this, the cycle index drifts away
  // from the user's actual focus and the next arrow press lands at
  // an unexpected slot.
  //
  // Capture-phase focus listener at the chrome window picks up focus
  // changes on the panel's <browser> element (when content gains
  // focus the chrome activeElement is the browser, whose closest()
  // walks up to the panel container). The cycle focus indicator
  // moves to the clicked panel too, so a fast click during the
  // previous panel's fade-out doesn't leave the ring stranded on
  // the wrong slot.
  function attachPanelFocusTracker() {
    window.addEventListener(
      'focus',
      (e) => {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        const container = target.closest('[data-bento-panel-tab-id], [data-bento-main-panel]');
        if (!container) return;
        const targets = getPanelCycleTargets();
        const idx = targets.indexOf(container);
        if (idx < 0 || idx === currentActiveIdx) return;
        currentActiveIdx = idx;
        applyPanelFocusIndicator(idx);
      },
      true,
    );
  }

  // PopupNotifications gates "show this popup right now" on
  // _isActiveBrowser, which compares the popup's browser against
  // gBrowser.selectedBrowser. For Bento panels the panel's tab is
  // never the selected tab — the main tab is — so popups
  // originating in a panel (e.g. AMO's "Add to Firefox"
  // permissions confirmation) get queued and never shown.
  //
  // Extend _isActiveBrowser to also accept any browser whose tab
  // is in gBrowser.activeSplitView.tabs (the same set that
  // splitViewBrowsers / shouldDeactivateDocShell respects), so
  // panel-originated popups display immediately. Anchor follows
  // the standard unified-extensions-button on the navbar — the
  // popup hangs off there, visible to the user even when the
  // origin tab isn't selectedTab.
  function patchPopupNotificationsForSplitView() {
    // window.PopupNotifications is a lazy getter — touching it
    // before browser.js has wired up gBrowser (and the PopupNotifications
    // constructor's tabbrowser argument) throws "Invalid tabbrowser".
    // Defer until window load, when browser.js has finished init
    // and the lazy getter resolves to a real instance.
    const apply = () => {
      const pn = window.PopupNotifications;
      if (!pn || pn.__bentoSplitViewPatched) return;
      pn.__bentoSplitViewPatched = true;
      const original = pn._isActiveBrowser;
      pn._isActiveBrowser = function (browser) {
        if (original.call(this, browser)) return true;
        const split = window.gBrowser?.activeSplitView;
        if (split?.tabs) {
          for (const tab of split.tabs) {
            if (tab?.linkedBrowser?.frameLoader === browser?.frameLoader) {
              return true;
            }
          }
        }
        return false;
      };
    };
    if (document.readyState === 'complete') {
      apply();
    } else {
      window.addEventListener('load', apply, { once: true });
    }
  }

  // ExtensionsUI subscribes to webextension-permission-prompt and
  // related topics in its init() method (called by BrowserGlue at
  // window startup). In some persistent-dev-profile situations
  // those subscriptions don't get registered — observed
  // empirically: enumerateObservers('webextension-permission-prompt')
  // returns 0 entries even though ExtensionsUI is loaded.
  // Symptom: AMO "Add to Firefox" downloads the addon, the install
  // reaches STATE_DOWNLOADED, then hangs forever because no one's
  // listening to dispatch the permissions popup.
  //
  // Defensively re-subscribe at chrome boot. Identity-checks each
  // topic's observer list before adding so we don't double-subscribe
  // (which would fire ExtensionsUI.observe twice per event) in
  // profiles where the wiring is already correct.
  function ensureExtensionsUIObservers() {
    const apply = () => {
      try {
        const { ExtensionsUI } = ChromeUtils.importESModule(
          'resource:///modules/ExtensionsUI.sys.mjs',
        );
        const topics = [
          'webextension-permission-prompt',
          'webextension-update-permission-prompt',
          'webextension-optional-permission-prompt',
          'webextension-defaultsearch-prompt',
        ];
        for (const topic of topics) {
          let already = false;
          const enums = Services.obs.enumerateObservers(topic);
          while (enums.hasMoreElements()) {
            if (enums.getNext() === ExtensionsUI) {
              already = true;
              break;
            }
          }
          if (!already) {
            Services.obs.addObserver(ExtensionsUI, topic);
          }
        }
      } catch (err) {
        console.warn('[bento-shell-mount] ensureExtensionsUIObservers failed:', err);
      }
    };
    if (document.readyState === 'complete') {
      apply();
    } else {
      window.addEventListener('load', apply, { once: true });
    }
  }

  configureSidePanelOnce();
  attachReloadListener();
  attachPaletteKeybinding();
  attachPaletteEscListener();
  attachPaletteCloseListener();
  attachWorkspaceTabSwitchKeybinding();
  attachTabSelectListener();
  attachPanelAcceleratorListener();
  attachResizeRepaintPoke();
  registerContentKeyActor();
  attachContentKeyBridgeListener();
  attachPanelFocusTracker();
  patchPopupNotificationsForSplitView();
  ensureExtensionsUIObservers();
})();
