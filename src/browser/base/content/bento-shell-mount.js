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

      /* Sidebar treatment: top/left/bottom margins (inset from the
         window edge) so it visually reads as a "panel". Right edge
         lives flush against the resize splitter (which provides the
         right-side gap). */
      #bento-shell-host {
        padding-top: var(--space-2xs);
        padding-bottom: var(--space-2xs);
        padding-left: var(--space-2xs);
      }
      #bento-shell-host > #bento-shell-frame {
        border-radius: var(--radius-m);
        overflow: clip;
      }
      /* Sidebar splitter: same width as the chrome gap so the gap
         between sidebar and main panel reads as the same rhythm as
         every other gap. Style applied here (not in the M1 patch) so
         we don't need a patch rebuild to retune the value. */
      #bento-shell-splitter {
        width: var(--space-2xs);
        background-color: transparent;
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
      }
      #bento-side-panel-host {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        overflow-x: scroll;
        overflow-y: hidden;
        border-radius: var(--radius-m);
        clip-path: inset(var(--space-2xs) 0 var(--space-2xs) 0 round var(--radius-m));
        padding-block: var(--space-2xs);
        padding-right: var(--space-2xs);
        gap: 0;
        flex: 1 1 auto;
        min-height: 0;
        /* Native scrollbar hidden — replaced by the custom always-on
           scrollbar below. macOS auto-hides native scrollbars after a
           moment regardless of CSS, which conflicts with the user's
           "always visible" requirement. */
        scrollbar-width: none;
      }
      #bento-side-panel-host::-webkit-scrollbar {
        display: none;
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
        background-color: var(--neutral-10);
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
        background-color: var(--neutral-15);
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
        /* Active-marker transition uses --bento-duration-base (200ms)
           — visible fade as the user navigates, but quick enough not
           to feel laggy. */
        transition:
          background-color var(--bento-duration-base) var(--bento-easing-standard),
          border-color var(--bento-duration-base) var(--bento-easing-standard);
      }
      .bento-panel-nav__icon:hover {
        background-color: var(--neutral-15);
        border-color: var(--neutral-30);
        transform: translateY(-1px);
      }
      .bento-panel-nav__icon--active {
        border-color: var(--color-60);
        background-color: var(--color-3);
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
        background-color: var(--neutral-5);
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
      /* Close-panel fade-and-scale animation. Opacity + transform
         only — width / flex-basis transitions used to be in here too,
         but Firefox's split-view layout owns each panel's
         flex-basis and its own width attr, so transitioning those
         from JS produced visible flicker (panel collapsed instantly
         while the fade played, then sibling panels jittered as
         they redistributed space). Animating only the painted
         surface gives clean visual feedback without fighting
         Firefox's layout. */
      .bento-panel--removing {
        pointer-events: none;
        opacity: 0;
        transform: scale(0.95);
        transition:
          opacity 140ms var(--bento-easing-standard),
          transform 180ms var(--bento-easing-standard);
      }

      /* Cycle focus indicator. Added on whichever panel is the user's
         current cycle selection (arrow keys / cycle buttons / favicon
         click). Implemented as an ::after pseudo-element overlay
         (z-index: 1, pointer-events: none) instead of inset
         box-shadow because the panel header has its own background
         which would paint OVER an inset shadow. The overlay renders
         on top of all panel content (header + browser) so the ring
         is visible everywhere. Auto-removed 1.5s after the last nav
         action; border-color transitions for the fade. */
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
        z-index: 1;
        box-sizing: border-box;
        transition: border-color var(--bento-duration-slow) var(--bento-easing-standard);
      }
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
        background-color: var(--neutral-10);
        border-bottom: var(--bento-border-hairline) solid var(--neutral-15);
        flex: 0 0 auto;
        min-height: var(--bento-panel-header-height);
        box-sizing: border-box;
      }
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
        transition:
          background-color var(--bento-duration-fast) var(--bento-easing-standard),
          color var(--bento-duration-fast) var(--bento-easing-standard);
        flex: 0 0 auto;
      }
      .bento-panel-header-button:hover:not([disabled]) {
        background-color: var(--neutral-15);
        color: var(--neutral-90);
      }
      .bento-panel-header-button[disabled] {
        opacity: 0.4;
        cursor: default;
      }
      .bento-panel-header-button--active {
        color: var(--color-60);
      }
      .bento-panel-header-button > svg {
        width: var(--bento-icon-size-xs);
        height: var(--bento-icon-size-xs);
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
        background-color: var(--neutral-0);
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
        overflow-x: auto;
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
      }
      /* The browser fills whatever vertical space the header doesn't. */
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > browser,
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > .browserContainer,
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > .browserStack {
        flex: 1 1 auto;
        min-height: 0;
      }
      /* Injected per-panel header — sits above the browser, takes its
         natural height, doesn't flex. */
      .bento-panel-header[data-bento-injected="1"] {
        flex: 0 0 auto;
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
         Override Firefox's [column="0"] and [column="1"] rules with
         contiguous order values that scale to any panel count. The
         splitter (Firefox order: 1) is intentionally hidden — its
         resize semantics (per-tab width attr on the col-0
         notificationbox, sibling-shrink instead of scroll-push)
         don't match Bento's strip model. See the Phase-5-followup
         plan for the proper inter-panel splitter implementation. */
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="0"] { order: 0; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="1"] { order: 1; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="2"] { order: 2; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="3"] { order: 3; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="4"] { order: 4; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="5"] { order: 5; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="6"] { order: 6; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="7"] { order: 7; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="8"] { order: 8; }
      #tabbrowser-tabpanels[splitview] > .split-view-panel[column="9"] { order: 9; }
      #tabbrowser-tabpanels[splitview] > .split-view-splitter {
        order: 99;
        display: none;
      }

      /* Cycle focus ring for split-view panels. Mirrors the legacy
         #bento-side-panel-host rule but scoped to tabpanels children
         (which have data-bento-main-panel / data-bento-panel-tab-id
         stamped by the reconciler). Without this, arrow-key cycling
         and Tab/click focus changes update the favicon strip marker
         but produce no visible indicator on the panel itself. */
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
        z-index: 1;
        box-sizing: border-box;
        transition: border-color var(--bento-duration-slow) var(--bento-easing-standard);
      }
      #tabbrowser-tabpanels.bento-split-active > .bento-panel--cycle-focused::after {
        border-color: var(--color-60);
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

  function setFrameSrc(frameId, path) {
    const url = moz(path);
    if (!url) {
      // Extension hasn't loaded yet; try again on the next tick.
      setTimeout(() => setFrameSrc(frameId, path), 50);
      return;
    }
    const frame = document.getElementById(frameId);
    if (!frame) return;
    // setAttribute('src') works even before the <browser>'s webNavigation
    // is initialized; the loadURI APIs throw in that window. Stay with
    // setAttribute — the chrome process forwards the URL to the extension
    // content process when ready.
    frame.setAttribute('src', url);
  }

  function setBentoShellSrc() {
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
      ' display: none; opacity: 0; transition: opacity 0.18s ease;';
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
  // Multi-panel reconciliation. Title format from sidebar:
  //   BENTO_PANELS:<ts>:<base64-of-json-array>
  // where the JSON array is [{tabId, url}, ...] for the active workspace.
  // Empty array hides the strip; non-empty rebuilds it via the
  // reconcilePanels() diff. Base64 because URLs can contain delimiter
  // chars; timestamp ensures repeated identical states still trigger
  // the title-change poll.
  const PANELS_PREFIX = 'BENTO_PANELS:';

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

  // Lucide icon paths (single-path d-string per icon — multi-segment uses M).
  const ICONS = {
    chevronLeft: 'm15 18-6-6 6-6',
    chevronRight: 'm9 18 6-6-6-6',
    rotate: 'M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.74 2.74L3 8 M3 3v5h5',
    star:
      'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
    plus: 'M12 5v14 M5 12h14',
    x: 'M18 6 6 18 M6 6l12 12',
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

    header.appendChild(backBtn);
    header.appendChild(forwardBtn);
    header.appendChild(reloadBtn);
    header.appendChild(urlInput);
    header.appendChild(starBtn);
    if (closeBtn) header.appendChild(closeBtn);

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

  // JS-driven splitter using POINTER events with setPointerCapture.
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
    return getOrderedPanels();
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
    const nextIdx = Math.max(0, Math.min(targets.length - 1, currentActiveIdx + delta));
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
    const host = document.getElementById('bento-side-panel-host');
    if (!host || !panelEl) return;
    const stripLeft = host.getBoundingClientRect().left;
    const panelLeft = panelEl.getBoundingClientRect().left;
    const targetScrollLeft = host.scrollLeft + (panelLeft - stripLeft);
    host.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
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
      mm.sendAsyncMessage('BentoShellAction', action);
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] shell action dispatch failed:', err);
      return false;
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
    if (idx < 0 || idx >= targets.length) return;
    const target = targets[idx];
    target.classList.add('bento-panel--cycle-focused');
    if (panelFocusTimer) clearTimeout(panelFocusTimer);
    panelFocusTimer = setTimeout(() => {
      target.classList.remove('bento-panel--cycle-focused');
    }, 1500);
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
    // Add-trailer target (no inner <browser>) → focus the chrome
    // element directly so Enter activates it.
    try {
      const browserEl = target.querySelector?.('browser');
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
  function refreshPanelNav(panels) {
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list) return;
    hidePanelNavContextMenu();
    list.innerHTML = '';
    // Main panel always first.
    list.appendChild(
      buildNavIcon(getMainTabFavicon(), 'Main panel', () => {
        const main = document.getElementById('tabbrowser-tabbox');
        scrollPanelToLeftmost(main);
        setActiveByIndex(0);
      }),
    );
    // Side panels in order. Capture index in closure so each click sets
    // the right active marker — including for panels that can't scroll
    // all the way to leftmost (end of the strip).
    for (let i = 0; i < panels.length; i++) {
      const tabId = panels[i].tabId;
      const navIdx = i + 1;
      list.appendChild(
        buildNavIcon(
          panels[i].favIconUrl || '',
          'Panel',
          () => {
            const el = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
            if (el) scrollPanelToLeftmost(el);
            setActiveByIndex(navIdx);
          },
          tabId,
        ),
      );
    }
    // Clamp active index to current cycle target count and re-paint the
    // marker (panel count may have decreased since the last selection).
    // The Add-panel trailer is part of keyboard cycling but has no
    // favicon marker, so applyActiveMarker naturally leaves all favicons
    // unmarked when it is selected.
    const total = getPanelCycleTargets().length;
    if (currentActiveIdx >= total) currentActiveIdx = 0;
    applyActiveMarker(currentActiveIdx);
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
    host.addEventListener('wheel', onPanelStripWheel, { capture: true, passive: false });
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
  function reconcilePanelsSplitView(panels) {
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
      const previous = tabpanels.splitViewPanels || [];
      const splitActive = tabpanels.classList.contains('bento-split-active');
      if (!previous.length && !__lastSplitViewMarker && !splitActive) {
        return; // already torn down — nothing to do
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
        if (panelEl.getAttribute('tabindex') === '-1') {
          panelEl.removeAttribute('tabindex');
        }
        panelEl.classList.remove('split-view-panel-active');
      }

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
          if (t) resolved.push({ tab: t, payload: p });
        } catch {
          // Tab might be gone (race with tab/close); skip
        }
      }
    }

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
    for (const [i, tab] of tabsToRender.entries()) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      panelEl.style.order = String(i);
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
      } else {
        delete panelEl.dataset.bentoMainPanel;
        if (tabTracker) {
          try {
            const tabId = tabTracker.getId(tab);
            if (tabId) panelEl.dataset.bentoPanelTabId = String(tabId);
          } catch {
            /* tabTracker can throw for transient/uninitialised tabs */
          }
        }
      }
    }
    // Strip stale inline order + data attrs from departing tabs so
    // they don't leak into a future split (e.g. tab returns to the
    // layout via a workspace switch with a different position) or
    // make getOrderedPanels mistakenly include them.
    for (const tab of departingTabs) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      panelEl.style.removeProperty('order');
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

    // Refresh favicon nav strip (lives outside tabpanels; reads from
    // panels/sync payload — same data the legacy reconciler consumes).
    refreshPanelNav(panels);

    // Resize/reposition the custom always-visible scrollbar thumb to
    // match the new panel count. Layout settles after this tick, so
    // queue for the next frame.
    setTimeout(updateStripScrollbar, 0);
  }

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
    console.log('[bento-shell-mount] attachTabSelectListener: attaching listeners');

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

    let lastReconciledFor = null;
    const reconcile = (_source) => {
      const sel = window.gBrowser.selectedTab;
      if (sel === lastReconciledFor) return;
      lastReconciledFor = sel;
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
      tp.addEventListener('scroll', updateStripScrollbar, { passive: true });
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(updateStripScrollbar);
        ro.observe(tp);
      }
      tp.__bentoStripScrollWired = true;
    }
  }

  function reconcilePanels(panels) {
    reconcilePanelsSplitView(panels);
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
    // Payload shape: { workspaceId: string|null, panels: Array<{tabId, ...}> }.
    // workspaceId is the currently-active Bento workspace; chrome stores it
    // so the Cmd+1..9 handler can scope tab activation. The panels array
    // drives the side-panel strip reconcile.
    let panels;
    if (Array.isArray(decoded)) {
      panels = decoded;
    } else if (decoded && Array.isArray(decoded.panels)) {
      panels = decoded.panels;
      currentWorkspaceId = typeof decoded.workspaceId === 'string' ? decoded.workspaceId : null;
      currentPanelTabIds = new Set(panels.map((p) => p.tabId));
    } else {
      return;
    }
    reconcilePanels(panels);
  }

  // Active workspace state mirrored from the shell via BENTO_PANELS payload.
  // Cmd+1..9 reads these to scope tab activation to the current workspace
  // (so Cmd+3 picks the 3rd tab in the active workspace, not the 3rd tab
  // in Firefox's flat tab list which would jump across workspaces).
  let currentWorkspaceId = null;
  let currentPanelTabIds = new Set();

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

    const shellFrame = document.getElementById('bento-shell-frame');
    if (shellFrame) {
      let lastSeenShellTitle = '';
      setInterval(() => {
        const title = shellFrame.contentTitle || '';
        if (title === lastSeenShellTitle) return;
        lastSeenShellTitle = title;
        if (title.startsWith(PALETTE_OPEN_PREFIX)) showPalette();
        else if (title.startsWith(CONFIRM_OPEN_PREFIX)) showConfirm();
        else if (title.startsWith(EDIT_WORKSPACE_OPEN_PREFIX)) showEditWorkspace();
        else if (title.startsWith(WELCOME_OPEN_PREFIX)) showWelcome();
        else if (title.startsWith(PANELS_PREFIX)) handlePanelsTitle(title);
      }, 200);
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
        // palette. If multiple overlays are somehow open at once, dismiss
        // the topmost first.
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
        matches: ['*://*/*', 'file:///*'],
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
})();
