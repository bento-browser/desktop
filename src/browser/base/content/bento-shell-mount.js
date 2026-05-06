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
      }
      .bento-panel-nav__icon--active {
        border-color: var(--color-60);
        background-color: var(--color-3);
      }
      .bento-panel-nav__icon > img {
        width: var(--bento-icon-size-sm);
        height: var(--bento-icon-size-sm);
        display: block;
      }
      .bento-panel-nav__icon--placeholder::before {
        content: '';
        position: absolute;
        inset: var(--space-3xs);
        border-radius: 50%;
        background-color: var(--neutral-30);
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
         at 0 0 auto so the JS splitter's width updates take effect
         (XUL splitter doesn't mutate sibling widths reliably inside a
         CSS-flex container — see createPanelSplitter comment). */
      #bento-side-panel-host > [data-bento-panel-tab-id] {
        display: flex;
        flex-direction: column;
        flex: 0 0 auto;
        min-width: var(--bento-panel-min-width);
        background-color: var(--neutral-5);
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

      /* JS-driven inter-panel splitter. Bare div (HTML, not XUL) with
         a pointerdown handler that re-measures sibling widths and
         updates them on pointermove (with setPointerCapture so drags
         survive the cursor crossing into a remote content browser).
         Width matches --space-2xs so the gap reads as the same rhythm
         as the strip's outer padding and the sidebar splitter. The
         hover tint makes the grabbable area visible — without it the
         splitter is a 6px transparent gap that's hard to discover. */
      .bento-panel-splitter {
        flex: 0 0 var(--space-2xs);
        cursor: col-resize;
        background-color: transparent;
        align-self: stretch;
        transition: background-color var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-panel-splitter:hover,
      .bento-panel-splitter--dragging {
        background-color: var(--color-60);
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

      /* Add-panel trailer: a button slot at the end of the strip,
         matches panel height (stretches via align-items:stretch on
         strip), narrow fixed width. Dashed outline + neutral colors
         so it reads as "empty slot, click to fill". */
      .bento-panel-add-trailer {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--space-2xs);
        flex: 0 0 var(--bento-add-panel-trailer-width);
        padding: var(--space-s);
        background-color: transparent;
        border: var(--bento-border-hairline) dashed var(--neutral-20);
        border-radius: var(--radius-m);
        color: var(--neutral-60);
        cursor: pointer;
        font-size: var(--font-xs);
        font-family: inherit;
        transition:
          background-color var(--bento-duration-fast) var(--bento-easing-standard),
          color var(--bento-duration-fast) var(--bento-easing-standard),
          border-color var(--bento-duration-fast) var(--bento-easing-standard);
        box-sizing: border-box;
      }
      .bento-panel-add-trailer:hover {
        background-color: var(--neutral-10);
        border-color: var(--neutral-30);
        color: var(--neutral-80);
      }
      .bento-panel-add-trailer > svg {
        width: var(--bento-icon-size-md);
        height: var(--bento-icon-size-md);
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
  const PANEL_DEFAULT_WIDTH = 480;
  const sidePanelShowHooks = [];
  const sidePanelHideHooks = [];

  // Lucide icon paths (single-path d-string per icon — multi-segment uses M).
  const ICONS = {
    chevronLeft: 'm15 18-6-6 6-6',
    chevronRight: 'm9 18 6-6-6-6',
    rotate: 'M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.74 2.74L3 8 M3 3v5h5',
    star:
      'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
    plus: 'M12 5v14 M5 12h14',
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

  // Strip the patch's pre-baked single browser child if it's still there.
  // Idempotent: if it was already removed (or the patch evolved out of
  // it), this is a no-op.
  function clearLegacySidePanelFrame() {
    const legacy = document.getElementById('bento-side-panel-frame');
    if (legacy) legacy.remove();
  }

  // Move the main tab content (#tabbrowser-tabbox) into the strip as its
  // FIRST child, then drop the M2 patch's `bento-side-panel-splitter`
  // (the splitter that used to live between main and the strip — now
  // meaningless since main IS in the strip). The strip becomes the
  // entire content area right of the sidebar — main + side panels +
  // Add-panel trailer share one horizontal scroll context, one
  // bottom-padding gap, etc.
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

    const oldSplitter = document.getElementById('bento-side-panel-splitter');
    if (oldSplitter) oldSplitter.remove();

    // Strip now grows to fill remaining space — drop the patch's
    // fixed-width / persist-width attributes so it behaves like a
    // flex-1 container.
    host.removeAttribute('width');
    host.removeAttribute('persist');
    host.setAttribute('flex', '1');
    host.removeAttribute('hidden');
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
  function createPanelHeader(browserEl, initialUrl) {
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
    urlInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = urlInput.value.trim();
      if (!value) return;
      loadInPanel(browserEl, value);
      urlInput.blur();
    });

    const starBtn = makeHeaderButton('Bookmark page', ICONS.star, () =>
      bookmarkPanelPage(browserEl, starBtn),
    );

    header.appendChild(backBtn);
    header.appendChild(forwardBtn);
    header.appendChild(reloadBtn);
    header.appendChild(urlInput);
    header.appendChild(starBtn);

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

  function createPanelElement(tabId, url) {
    const vbox = document.createXULElement('vbox');
    vbox.dataset.bentoPanelTabId = String(tabId);
    // tabindex="-1" makes the panel programmatically focusable (so cycle
    // navigation can focus it) but keeps it out of the natural Tab
    // order — TAB still walks header buttons → URL input → star → page.
    vbox.setAttribute('tabindex', '-1');
    // XUL width attribute (not CSS flex-basis) so the splitter can
    // mutate it as the user drags. CSS in injectChromeStyles maps width
    // to the rendered size via `flex: 0 0 auto`.
    vbox.setAttribute('width', String(PANEL_DEFAULT_WIDTH));
    const browserEl = document.createXULElement('browser');
    browserEl.setAttribute('type', 'content');
    browserEl.setAttribute('remote', 'true');
    browserEl.setAttribute('remoteType', 'web');
    browserEl.setAttribute('flex', '1');
    browserEl.setAttribute('disablefullscreen', 'true');
    // Wire up the standard Firefox content context menu (right-click →
    // Inspect, View Source, Save As, etc.) and tooltip handler. Without
    // these the panel browser has no right-click affordance — Inspect
    // wouldn't show. messagemanagergroup="browsers" puts this browser
    // in the same IPC group as gBrowser tabs so devtools can attach.
    browserEl.setAttribute('context', 'contentAreaContextMenu');
    browserEl.setAttribute('tooltip', 'aHTMLTooltip');
    browserEl.setAttribute('messagemanagergroup', 'browsers');
    // The panel <browser> is a SEPARATE element from the underlying
    // tab's <browser> — its src is what the panel renders. If the URL
    // came from the Add-Panel marker (about:blank?bento_add_as_panel=1),
    // substitute about:newtab here so the panel shows the new-tab page
    // instead of a blank page with marker query string. The underlying
    // tab is also navigated to about:newtab by addNewPanel after a short
    // delay, so the tab title cleans up too.
    let panelUrl = url || '';
    if (panelUrl.includes('bento_add_as_panel=1')) {
      panelUrl = 'about:newtab';
    }
    // src must be set BEFORE the header attaches its progress listener,
    // otherwise the header's setTimeout(refresh, 50) catches the
    // about:blank initial state but never sees onLocationChange for the
    // eventual URL because progress listeners attached after navigation
    // start may miss the first location change.
    if (panelUrl) browserEl.setAttribute('src', panelUrl);
    const header = createPanelHeader(browserEl, panelUrl);
    vbox.appendChild(header);
    vbox.appendChild(browserEl);
    return vbox;
  }

  // JS-driven splitter using POINTER events with setPointerCapture.
  //
  // Why not XUL <splitter>: empirically the resizebefore/resizeafter
  // width mutations don't round-trip reliably through CSS layout when
  // the parent uses `display: flex`, which our strip does.
  //
  // Why not mousedown + window-level mousemove: when the cursor moves
  // over a remote=true content <browser> (the panel's webpage), mouse
  // events are consumed by the content process and never reach the
  // chrome window, so the drag stops the moment the user crosses into
  // a panel's webpage. setPointerCapture solves this — once a pointer
  // is captured by a chrome element, every subsequent pointer event
  // for that pointerId fires on the capturing element regardless of
  // which element the cursor is over (cross-process safe).
  // Splitter behaviour: every splitter resizes ONLY the panel on its
  // left side. Right-side panels keep their widths and shift along
  // the strip's horizontal scroll (the strip total width grows /
  // shrinks by the drag delta). This is uniform across the first
  // splitter (main ↔ first side panel) and every subsequent
  // inter-panel splitter — main is no different from any other
  // fixed-width panel once locked.
  //
  // Sizing main panel — the nuclear approach. tabbrowser-tabbox is a
  // XUL <tabbox> with a `flex="1"` attribute and Firefox internals'
  // own CSS rules. Setting `flex: 0 0 auto !important` + `width`
  // empirically did NOT keep it at a fixed width — flex layout still
  // redistributed space when neighbouring side panels resized.
  // min-width = max-width = w is the only constraint CSS flex layout
  // literally cannot violate, so we use that. Removing the XUL flex
  // attribute eliminates one more competing input.
  function setMainSize(target, w) {
    target.removeAttribute('flex');
    target.style.setProperty('flex', '0 0 ' + w + 'px', 'important');
    target.style.setProperty('width', w + 'px', 'important');
    target.style.setProperty('min-width', w + 'px', 'important');
    target.style.setProperty('max-width', w + 'px', 'important');
    target.setAttribute('width', String(w));
  }

  function unsetMainSize(target) {
    target.setAttribute('flex', '1');
    target.style.removeProperty('flex');
    target.style.removeProperty('width');
    target.style.removeProperty('min-width');
    target.style.removeProperty('max-width');
    target.removeAttribute('width');
  }

  function lockMainIfNeeded(target) {
    if (!target.dataset || !target.dataset.bentoMainPanel) return;
    if (target.style.width) return; // already locked
    const w = target.getBoundingClientRect().width;
    if (w <= 0) return;
    setMainSize(target, w);
  }

  function startPanelDrag(splitter, e) {
    if (e.button !== 0) return;
    const target = splitter.previousElementSibling;
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();

    lockMainIfNeeded(target);

    splitter._panelDragState = {
      target,
      startX: e.clientX,
      startWidth: target.getBoundingClientRect().width,
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
    const t = drag.target;
    const next = Math.max(200, drag.startWidth + delta);
    if (t.dataset && t.dataset.bentoMainPanel) {
      setMainSize(t, next);
    } else {
      t.style.width = next + 'px';
      t.setAttribute('width', String(next));
    }
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
    splitter._panelDragState = null;
    splitter.classList.remove('bento-panel-splitter--dragging');
    document.documentElement.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('user-select');
  }

  function createPanelSplitter() {
    const splitter = document.createElementNS(HTML_NS, 'div');
    splitter.className = 'bento-panel-splitter';
    splitter.addEventListener('pointerdown', (e) => startPanelDrag(splitter, e));
    splitter.addEventListener('pointermove', (e) => onPanelDragMove(splitter, e));
    splitter.addEventListener('pointerup', (e) => endPanelDrag(splitter, e));
    splitter.addEventListener('pointercancel', (e) => endPanelDrag(splitter, e));
    splitter.addEventListener('lostpointercapture', () => endPanelDrag(splitter, null));
    return splitter;
  }

  // ─── Arrow-key panel navigation ────────────────────────────────────────
  // Left / Right arrow keys cycle through panels — main + each side
  // panel, in DOM order. The "current" panel is whichever is closest to
  // the leftmost visible position; pressing Right scrolls the next
  // panel's left edge to the strip's left edge, Left scrolls the
  // previous one. Stops at the ends (no wraparound).
  //
  // Suppressed when focus is inside any input / textarea / contenteditable
  // (URL bars, form fields, etc.) so the keys still move the text caret.
  // Arrow keys pressed inside a remote content browser don't bubble to
  // chrome — the content process consumes them — so webpages keep
  // their arrow-key behaviour for free.
  function getOrderedPanels() {
    const host = document.getElementById('bento-side-panel-host');
    if (!host) return [];
    const out = [];
    for (const child of host.children) {
      if (
        (child.dataset && child.dataset.bentoMainPanel) ||
        (child.dataset && child.dataset.bentoPanelTabId)
      ) {
        out.push(child);
      }
    }
    return out;
  }

  function shouldHandlePanelArrowKey(target) {
    if (!target) return true;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    if (target.isContentEditable) return false;
    return true;
  }

  function navigatePanels(delta) {
    const host = document.getElementById('bento-side-panel-host');
    if (!host) return;
    const panels = getOrderedPanels();
    if (panels.length === 0) return;

    // Index advances from the user's CURRENT selection — not from
    // wherever the strip happens to be scrolled to. Decoupling these
    // means: (a) repeated cycle clicks always advance one panel even
    // when the strip can't physically scroll further (end of list),
    // (b) the bottom marker stays in sync with what the user just
    // selected, (c) manual scroll (mouse wheel) doesn't change the
    // selection.
    const nextIdx = Math.max(0, Math.min(panels.length - 1, currentActiveIdx + delta));
    if (nextIdx === currentActiveIdx) return;

    const targetPanel = panels[nextIdx];
    const stripLeft = host.getBoundingClientRect().left;
    const panelLeft = targetPanel.getBoundingClientRect().left;
    const targetScrollLeft = host.scrollLeft + (panelLeft - stripLeft);
    host.scrollTo({
      left: Math.max(0, targetScrollLeft),
      behavior: 'smooth',
    });
    setActiveByIndex(nextIdx);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!shouldHandlePanelArrowKey(e.target)) return;
    e.preventDefault();
    navigatePanels(e.key === 'ArrowRight' ? 1 : -1);
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
    const panels = getOrderedPanels();
    for (const p of panels) p.classList.remove('bento-panel--cycle-focused');
    if (idx < 0 || idx >= panels.length) return;
    const target = panels[idx];
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
    // Move keyboard focus to the panel container so subsequent TAB
    // walks into the panel's elements (header buttons → URL input →
    // star → page content). Each panel container has tabindex="-1"
    // so it's programmatically focusable. Without this step, TAB
    // would continue from wherever the user last clicked, completely
    // unrelated to the cycle navigation.
    const panels = getOrderedPanels();
    if (idx >= 0 && idx < panels.length) {
      try {
        panels[idx].focus({ preventScroll: true });
      } catch {
        /* focus best-effort; some browser elements may reject */
      }
    }
  }

  function buildNavIcon(favIconUrl, title, onClick) {
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
    btn.addEventListener('click', onClick);
    return btn;
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
        buildNavIcon(panels[i].favIconUrl || '', 'Panel', () => {
          const el = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
          if (el) scrollPanelToLeftmost(el);
          setActiveByIndex(navIdx);
        }),
      );
    }
    // Clamp active index to current panel count and re-paint the marker
    // (panel count may have decreased since the last selection).
    const total = panels.length + 1; // main + side panels
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
  function updateStripScrollbar() {
    const host = document.getElementById('bento-side-panel-host');
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
      const host = document.getElementById('bento-side-panel-host');
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
      const host = document.getElementById('bento-side-panel-host');
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
      const host = document.getElementById('bento-side-panel-host');
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

    const nextBtn = document.createElementNS(HTML_NS, 'button');
    nextBtn.type = 'button';
    nextBtn.className = 'bento-panel-nav__btn';
    nextBtn.title = 'Next panel';
    nextBtn.setAttribute('aria-label', 'Next panel');
    nextBtn.appendChild(makeIcon(ICONS.chevronRight));
    nextBtn.addEventListener('click', () => navigatePanels(1));

    nav.appendChild(prevBtn);
    nav.appendChild(list);
    nav.appendChild(nextBtn);
    wrap.appendChild(nav);

    // Live updates: tab switches and tab attribute changes (icon, title)
    // refresh the main panel's favicon. We deliberately do NOT update
    // the active marker on scroll — currentActiveIdx is set only by
    // explicit nav (click / button / key), so manual scroll doesn't
    // override the user's selection. The custom scrollbar's thumb
    // position DOES update on scroll though.
    host.addEventListener('scroll', updateStripScrollbar, { passive: true });
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
  function createAddPanelTrailer() {
    const btn = document.createElementNS(HTML_NS, 'button');
    btn.type = 'button';
    btn.className = 'bento-panel-add-trailer';
    btn.dataset.bentoAddPanel = '1';
    btn.title = 'Add panel';
    btn.setAttribute('aria-label', 'Add panel');
    btn.appendChild(makeIcon(ICONS.plus, 20));
    const label = document.createElementNS(HTML_NS, 'span');
    label.textContent = 'Add panel';
    btn.appendChild(label);
    btn.addEventListener('click', addNewPanel);
    return btn;
  }

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
    // The PANEL <browser> handles the marker URL itself by substituting
    // about:newtab when it sees the marker (createPanelElement). But the
    // underlying tab also needs to navigate away from the marker URL so
    // the tab title and main URL bar (when this tab becomes active) show
    // a clean state. Chrome's loadURI bypasses any WebExtension API
    // restrictions on about:newtab navigation. The 250ms delay gives
    // bento-tools' tabs.onCreated listener time to fire with the marker
    // URL and add the tab to the panel list before we navigate away.
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

  // Reconcile the strip's children against `panels` (Array<{tabId, url}>).
  // Target layout: [main, splitter, p1, splitter, p2, ..., splitter, add-trailer].
  //
  // INCREMENTAL strategy — never call insertBefore on a panel that is
  // already at the destination position. Earlier versions tore down all
  // splitters + the trailer and re-walked the panel list, which caused
  // every existing panel to be moved via host.insertBefore(panel, X)
  // even when it was already at X. Moving a chrome <browser> within
  // its parent triggers Firefox to detach and reattach the docShell,
  // which reloads the panel's content. Reusing splitters + only moving
  // mis-positioned panels keeps existing panels intact across reconciles.
  function isSplitter(node) {
    return !!(node && node.classList && node.classList.contains('bento-panel-splitter'));
  }
  function isTrailer(node) {
    return !!(node && node.classList && node.classList.contains('bento-panel-add-trailer'));
  }
  function reconcilePanels(panels) {
    const host = document.getElementById('bento-side-panel-host');
    const main = document.getElementById('tabbrowser-tabbox');
    if (!host) {
      console.warn('[bento-shell-mount] reconcilePanels: bento-side-panel-host missing');
      return;
    }

    // Main panel sizing — UNLOCK path runs first (so a 0-panels
    // reconcile restores main to flex-fill before we touch anything
    // else). The LOCK path runs at the end of this function, AFTER
    // the new panel layout has been inserted, so main's
    // getBoundingClientRect() reflects the post-shrink width
    // (flex:1 yields to the new fixed-width panel). Locking at that
    // width keeps the new panel visible — locking before would
    // capture main's pre-shrink full width and the new panel would
    // overflow off-screen.
    if (main && panels.length === 0 && main.style.width) {
      unsetMainSize(main);
    }

    // Index existing panels by tabId. Splitters and the trailer are
    // handled positionally below; we don't pre-snapshot them.
    const existing = new Map();
    for (const child of Array.from(host.children)) {
      if (child === main) continue;
      if (child.dataset && child.dataset.bentoPanelTabId) {
        existing.set(Number(child.dataset.bentoPanelTabId), child);
      }
    }

    // Drop panels not in the desired list, plus the splitter
    // immediately to the LEFT of each removed panel (that splitter
    // owned the boundary between the removed panel and its predecessor).
    const desiredIds = new Set(panels.map((p) => p.tabId));
    for (const [id, el] of existing) {
      if (desiredIds.has(id)) continue;
      const before = el.previousElementSibling;
      if (isSplitter(before)) before.remove();
      el.remove();
      existing.delete(id);
    }

    // Always remove the trailer + its leading splitter — they get
    // re-built in the right place after the panel walk. Cheap; trailer
    // and trailing splitter carry no state.
    for (const child of Array.from(host.children)) {
      if (!isTrailer(child)) continue;
      const before = child.previousElementSibling;
      if (isSplitter(before)) before.remove();
      child.remove();
    }

    const newlyCreated = [];

    // Walk desired panels left-to-right. Reuse the splitter currently
    // sitting at the boundary if one is there; create one only when
    // missing. Move the panel only when it isn't already at the slot —
    // skipping the no-op insertBefore is what keeps Firefox from
    // reattaching the panel's docShell on every reconcile.
    let prev = main;
    for (const panel of panels) {
      let el = existing.get(panel.tabId);
      if (!el) {
        el = createPanelElement(panel.tabId, panel.url);
        newlyCreated.push({ tabId: panel.tabId, el });
      } else {
        const browserEl = el.querySelector('browser');
        if (browserEl) {
          let currentSpec = '';
          try {
            currentSpec = browserEl.currentURI ? browserEl.currentURI.spec : '';
          } catch {
            currentSpec = '';
          }
          if (panel.url && currentSpec !== panel.url) {
            browserEl.setAttribute('src', panel.url);
          }
        }
      }

      let splitter = prev.nextSibling;
      if (!isSplitter(splitter)) {
        splitter = createPanelSplitter();
        host.insertBefore(splitter, prev.nextSibling);
      }

      if (splitter.nextSibling !== el) {
        host.insertBefore(el, splitter.nextSibling);
      }

      prev = el;
    }

    // Trailing splitter + Add-panel trailer — only when at least one
    // side panel exists. With only the main panel the strip needs no
    // Add-panel affordance (user creates the first panel from the
    // sidebar's tab-row actions or the command palette).
    if (panels.length > 0) {
      let trailingSplitter = prev.nextSibling;
      if (!isSplitter(trailingSplitter)) {
        trailingSplitter = createPanelSplitter();
        host.insertBefore(trailingSplitter, prev.nextSibling);
      }
      const trailer = createAddPanelTrailer();
      host.insertBefore(trailer, trailingSplitter.nextSibling);
    } else {
      // Solo-main: any leftover splitter immediately after main is dead.
      const next = main.nextSibling;
      if (isSplitter(next)) next.remove();
    }

    // Refresh the bottom navigator (favicons + active marker) to
    // match the new panel list. Cheap rebuild — list re-rendered from
    // scratch on every reconcile. Custom scrollbar also updates so
    // its thumb size reflects the new total scrollable width.
    refreshPanelNav(panels);
    setTimeout(updateStripScrollbar, 0);

    // Lock main panel AT POST-INSERTION WIDTH if going from 0 → ≥1
    // panels. Reading main's bounding rect now (after the new panels
    // are in the DOM) gives the width main has shrunk to under flex:1
    // pressure — locking at that width keeps the new panel visible.
    // Idempotent via the !main.style.width check: subsequent reconciles
    // (more panels added, panels re-ordered, etc.) don't re-lock and
    // don't change main's width.
    if (main && panels.length > 0 && !main.style.width) {
      const w = main.getBoundingClientRect().width;
      if (w > 0) setMainSize(main, w);
    }

    // Post-insertion: scroll newly-created panels into view + focus.
    // Skipped if no panels were freshly created — avoids stealing
    // focus from the main browser when the reconcile is triggered by
    // an unrelated event (URL change in another panel, workspace
    // switch with same panels, etc.).
    if (newlyCreated.length > 0) {
      setTimeout(() => {
        for (const { el } of newlyCreated) {
          try {
            el.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
            const browserEl = el.querySelector('browser');
            if (browserEl) browserEl.focus();
          } catch (e) {
            console.warn('[bento-shell-mount] post-create focus/scroll failed:', e);
          }
        }
      }, 0);
    }

    // Side-panel show/hide hooks were used by the old urlbar binding
    // (since removed). Kept the arrays for future cross-cutting
    // subscribers but they're effectively no-ops now — the strip is
    // always visible because main lives in it.
    for (const hook of sidePanelShowHooks) {
      try {
        hook();
      } catch (e) {
        console.warn('[bento-shell-mount] side panel show hook failed:', e);
      }
    }
    if (panels.length === 0) {
      for (const hook of sidePanelHideHooks) {
        try {
          hook();
        } catch (e) {
          console.warn('[bento-shell-mount] side panel hide hook failed:', e);
        }
      }
    }
  }

  function handlePanelsTitle(rawTitle) {
    // Format: BENTO_PANELS:<ts>:<base64-of-json-array>
    // Skip the prefix and the timestamp segment.
    const tail = rawTitle.slice(PANELS_PREFIX.length);
    const colonAfterTs = tail.indexOf(':');
    if (colonAfterTs < 0) return;
    const b64 = tail.slice(colonAfterTs + 1);
    let panels;
    try {
      // Counterpart of the sidebar's btoa(unescape(encodeURIComponent(json))).
      panels = JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) {
      console.warn('[bento-shell-mount] failed to decode BENTO_PANELS payload:', e);
      return;
    }
    if (!Array.isArray(panels)) return;
    reconcilePanels(panels);
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


  // ─── Dev-reload glue ────────────────────────────────────────────────────

  // browser.runtime.reload() (Alt+Shift+R) restarts the addon but the
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
    clearLegacySidePanelFrame();
    configureSidePanelStrip();
    unifyMainWithStrip();
    setupPanelNavigator();
    // Initial reconcile with no side panels: builds [main, splitter,
    // add-trailer] so the Add-panel button is visible from boot. The
    // first panels/sync from bento-tools will replace this with the
    // real panel list. refreshPanelNav inside reconcilePanels also
    // populates the navigator with the main-panel favicon.
    reconcilePanels([]);
  }
  configureSidePanelOnce();
  attachReloadListener();
  attachPaletteKeybinding();
  attachPaletteEscListener();
  attachPaletteCloseListener();
})();
