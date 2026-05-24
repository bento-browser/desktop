# Panel strip slides/scrolls during workspace switch

**Status:** Unresolved
**Last updated:** 2026-05-24
**Repro reliability:** 100% — every workspace switch
**Primary file:** [src/browser/base/content/bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js)

> **For collaborators / other models:** Append findings under "Attempts & results". Each attempt should record the hypothesis, what was changed, what was observed, and a verdict. Do NOT rewrite history — earlier failed attempts are evidence about what is and isn't the cause. New attempts get a new dated subsection.

## Symptom

When the user switches between workspaces (via the React workspace switcher overlay, or Cmd+Alt+1..9), the chrome panel strip visibly **slides / scrolls horizontally** during the transition. The user sees panels translating left/right into their final positions instead of just appearing at rest.

The opacity fade-out → fade-in itself works correctly — the issue is that motion is visible _inside_ the fade window (during fade-in specifically, after the new workspace's DOM has swapped in under the opacity-0 curtain).

User intent (from the request that started this bug): "I just want a static fade out and fade in of the workspace panels and content. No scrolling and movement of the panels."

## Architecture context (read this first)

The chrome panel strip lives in two parts of the chrome XHTML tree:

- **`#tabbrowser-tabpanels`** — Firefox's native XUL `<tabpanels>` deck. Holds the main tab's `<browser>` AND, when split-view is active, each side panel's `<browser>` in `splitViewPanels`. Visible chrome region: the horizontal strip of side-by-side panels.
- **`#bento-strip-container`** — a Bento-added `<vbox>` wrapper that holds the favicon navigator and the custom scrollbar. Visible chrome region: the strip immediately below the panels.

These are **siblings** in `browser.xhtml` (see [patches/chrome-layout/02-bento-side-panel.patch](../patches/chrome-layout/02-bento-side-panel.patch)) — no tight common ancestor. To fade everything visible in one motion, both must carry the fade class simultaneously.

### Workspace-switch event sequence

```
1. User clicks workspace B in sidebar
2. React shell dispatches { type: 'workspace/activate', id: B }
3. Tools (bento-tools background):
   a. workspaces.activate(B, sourceWindowId) → fires 'activated' delta
   b. handleWorkspaceActivation runs:
      i.  browser.tabs.move(stray, { windowId, index: -1 })          (cross-window tab move if needed)
      ii. browser.tabs.update(B's lastActiveTab, { active: true })   (← FIRES TabSelect in chrome)
      iii. emitPanelsSync(B)                                         (broadcasts panels/sync event)
4. Shell receives panels/sync, writes BENTO_PANELS title-IPC
5. Chrome polls title (rAF loop), handlePanelsTitle reads new payload
6. Chrome reconcile + fade run
```

**Critical timing:** step 3.b.ii fires TabSelect in chrome IMMEDIATELY and synchronously triggers the `TabSelect` listener inside [attachTabSelectListener](../src/browser/base/content/bento-shell-mount.js). That listener calls `reconcilePanelsSplitView(__lastPanelsPayload)` using the _previous_ workspace's payload (the new one hasn't arrived via title-IPC yet). Step 5 then arrives later (poll-bound latency) and triggers the fade.

This means the DOM-swap happens TWICE in practice: once via TabSelect (instant, no fade), once via handlePanelsTitle (with fade). The first one may already be visible to the user before the fade-out class lands.

## Reconcile-time animations that have been observed firing

Each of these can produce visible sliding if it runs during the fade-in window or before the fade-out completes. All are inside `reconcilePanelsSplitView`:

| Source                                                      | What it animates                                       | Duration                          | Trigger condition                                      |
| ----------------------------------------------------------- | ------------------------------------------------------ | --------------------------------- | ------------------------------------------------------ |
| `__mainWidthTransitionForNextReconcile`                     | Main panel `width`, `min-width`, `flex-basis`          | 200 ms (`--bento-duration-base`)  | `wsChanged` in `handlePanelsTitle`                     |
| `scrollPanelToLeftmost(mainEl)`                             | `tabpanels.scrollLeft` (smooth)                        | ~500 ms native smooth-scroll      | `mainChanged && panels.length > 0`                     |
| `scrollPanelIntoViewFromRight`                              | `tabpanels.scrollLeft` (smooth)                        | ~500 ms                           | New panel added (`newTabIds.length > 0`)               |
| Favicon `.bento-panel-nav__icon` `--entering` / `--leaving` | `width`, `padding`, `margin`, `opacity`                | 200 ms (`--bento-duration-base`)  | refreshPanelNav adds/removes icons                     |
| Strip scroll restore                                        | `tabpanels.scrollLeft` (instant)                       | 0 (instant via direct assignment) | `__pendingStripScrollRestore !== null` after wsChanged |
| Inter-panel splitter repositioning                          | Absolute-positioned splitter `left` (instant JS write) | 0                                 | `syncInterPanelSplitters` called from scroll listener  |
| `runPendingPanelFlip` (FLIP animation for drag-reorder)     | `transform: translateX`                                | 200 ms (`--bento-duration-base`)  | `__bentoPendingFlip` set (drag commit only)            |

## Current fade implementation (at HEAD)

Commit `c35af31` ("Persist panel strip scroll per workspace") + the workspace-switch fade landed in [src/browser/base/content/bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js).

**CSS** (next to `#bento-strip-container` rule):

```css
#tabbrowser-tabpanels,
#bento-strip-container {
  transition: opacity var(--bento-duration-fast, 140ms)
    var(--bento-easing-snappy, cubic-bezier(0.32, 0.72, 0, 1));
}
#tabbrowser-tabpanels.bento-workspace-switching,
#bento-strip-container.bento-workspace-switching {
  opacity: 0;
}
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
```

**JS** — `handlePanelsTitle` routes through `performWorkspaceSwitchFade(panels)` on workspace transition. That function:

1. Arms a 1500 ms watchdog.
2. Adds `.bento-workspace-switching` to both elements (opacity → 0 over 140 ms).
3. `setTimeout(140ms)` then:
   - Sets `__mainWidthTransitionForNextReconcile = false` (snap main width)
   - Sets `__workspaceSwitchSwapping = true` (gates auto-scroll-to-main in `reconcilePanelsSplitView`)
   - Calls `reconcilePanels(panels)` in try/catch
   - Applies pending scroll restore SYNCHRONOUSLY (no double-rAF, no smooth-scroll)
4. `finally` → `requestAnimationFrame` removes the class → CSS fades back in.

## Attempts & results

### Attempt 1 (2026-05-24) — Suppress favicon nav transitions

**Hypothesis:** Favicon icons going through `--entering` (width 0) → natural width over 200 ms tails past the fade-in window.

**Change:** CSS `transition: none !important` on `.bento-panel-nav__icon` and `.bento-panel-nav__list` while `.bento-workspace-switching` is present.

**Result:** Did not eliminate the slide. Favicons no longer grow, but panels still slide. **FAILED as a complete fix; kept as a partial mitigation.**

### Attempt 2 (2026-05-24) — Suppress main-width transition

**Hypothesis:** `__mainWidthTransitionForNextReconcile = true` (set on `wsChanged`) animates the main panel's width over 200 ms; side panels reflow alongside.

**Change:** Set `__mainWidthTransitionForNextReconcile = false` in `performWorkspaceSwitchFade` BEFORE calling reconcile. Reconcile then assigns `panelEl.style.width = mainPanelWidth + 'px'` without an inline transition.

**Result:** Partial improvement — main panel no longer animates width. Slide persists for side panels. **PARTIAL FIX; kept.**

### Attempt 3 (2026-05-24) — Gate scrollPanelToLeftmost auto-scroll

**Hypothesis:** `reconcilePanelsSplitView` calls `scrollPanelToLeftmost(mainEl)` with `behavior: 'smooth'` (~500 ms native smooth scroll) whenever `mainChanged`. On workspace switch, main always changes.

**Change:** Added `&& !__workspaceSwitchSwapping` to the auto-scroll condition inside `reconcilePanelsSplitView`. `performWorkspaceSwitchFade` sets the flag during its deferred reconcile.

**Result:** Native smooth scroll suppressed during the swap. Slide persists. **PARTIAL FIX; kept.**

### Attempt 4 (2026-05-24) — Synchronous scroll restore under the curtain

**Hypothesis:** `applyPendingStripScrollRestore` uses double `requestAnimationFrame` to wait for `scrollWidth` to settle, then assigns `scrollLeft`. This deferred write lands AFTER the fade-out class has been removed → visible scroll jump during fade-in.

**Change:** In `performWorkspaceSwitchFade`, apply the scroll restore SYNCHRONOUSLY inside the deferred reconcile (no rAF defer), so it lands while opacity is still 0.

**Result:** Scroll jump is hidden, but the overall sliding feel persists. **PARTIAL FIX; kept.**

### Attempt 5 (2026-05-24) — Brute-force suppress ALL descendant transitions/animations

**Hypothesis:** Some unknown transition / animation is firing on a descendant during the fade. Suppress everything broadly.

**Change:** CSS rule:

```css
#tabbrowser-tabpanels.bento-workspace-switching *,
#bento-strip-container.bento-workspace-switching * {
  transition: none !important;
  animation: none !important;
}
```

**Result:** Panel strip went blank — `animation: none !important` on every descendant interferes with Firefox's internal panel-rendering pipeline. **REVERTED. Do not retry without scoping more narrowly.**

### Attempt 6 (2026-05-24) — `Element.getAnimations({ subtree: true })` diagnostic

**Hypothesis:** Identify exactly which Web-Animations-API entries are running at each phase of the fade.

**Change:** Added `logActiveAnimationsForFadeDiagnostic(phase)` instrumentation that logs running animations at `fade-start`, `post-reconcile`, `fade-in-start`, `fade-in-end`.

**Result from user's run:**

```
fade-start: 129 animations
post-reconcile: 0 animations
fade-in-start: 28 animations
fade-in-end: 25 animations
```

The 28 animations at fade-in-start are the smoking gun — these started when the fade class was removed (because their `transition: none` suppression lifted and some property difference re-engaged a transition). The user did not yet expand and paste the JSON contents of the summary arrays, so the exact targets/properties are unknown.

**Verdict:** Inconclusive without the summary content. Most likely candidates are properties on panel containers (`width`, `min-width`, `flex-basis`, `transform`) or on the strip-container itself.

### Attempt 7 (2026-05-24) — Drain pending panels-title before TabSelect reconcile

**Hypothesis:** TabSelect's reconcile (using `__lastPanelsPayload` from the OLD workspace) fires BEFORE handlePanelsTitle processes the new payload. The DOM swap therefore happens twice, and the first one (no fade) is visible.

**Change:** Added `drainPendingPanelsTitle()` that synchronously polls `shellFrame.contentTitle` and processes it BEFORE the TabSelect-triggered reconcile.

**Result:** Did not eliminate the slide. The drain runs but the title may not yet be the new one when TabSelect fires (tools' `emitPanelsSync` is async and arrives via the port → shell → document.title — latency outlasts the TabSelect listener). **REVERTED with the rest of the experimental work via `git checkout`.**

### Attempt 8 (2026-05-24) — Arm fade on cross-workspace TabSelect and keep layout transitions suppressed through fade-in

**Hypothesis:** The stale TabSelect reconcile is still the earliest visible mutation: Firefox selects the destination workspace's tab before the BENTO_PANELS payload arrives, so chrome can paint a mismatched split strip before the fade path begins. Separately, descendant transitions can restart exactly when `.bento-workspace-switching` is removed, causing motion during fade-in.

**Change:** In `src/browser/base/content/bento-shell-mount.js`, the TabSelect reconciler now reads the selected tab's persisted workspace id. If it differs from `currentWorkspaceId`, it immediately arms the workspace fade, cancels any native smooth strip scroll, and skips the stale reconcile. The later BENTO_PANELS payload still performs the real hidden reconcile. Added `.bento-workspace-stabilizing` so layout-affecting transitions on direct panel containers, splitters, and favicon nav stay disabled until after fade-in completes.

**Result:** Pending user verification in a built browser.

**Verdict:** PENDING — intended to address both the pre-payload paint race and fade-in transition restart without broad descendant `animation: none`.

## What we know

- The fade itself (opacity transition on the parents) is working.
- Five known animation sources have been suppressed (Attempts 1–4 + 5's intent), and slide still happens.
- The diagnostic at attempt 6 confirms 28 active animations at fade-in-start — _something_ is animating, we don't yet know what.
- Reduced-motion users (`prefers-reduced-motion: reduce`) skip the fade entirely; we don't know if they also see sliding (the user didn't test this).

## What we don't know

- The exact targets and properties of the 28 fade-in-start animations.
- Whether the slide is CSS-transition-driven, JS-driven, or compositor-driven (Firefox's native tab-switching machinery, `AsyncTabSwitcher`, may animate panels independently of our chrome script).
- Whether `splitViewPanels` setter triggers any internal Firefox animation on the deck.
- Whether `transform` properties on panels are being mutated by `runPendingPanelFlip` or by Firefox itself.

## Next-attempt ideas (untested)

These are hypotheses worth exploring. Each should be tried in isolation:

1. **Capture the 28 active animations** properly. Get the user to re-run the diagnostic with the summary stringified to JSON so the targets and properties are pasteable. Without this, every other attempt is a guess.
2. **Targeted descendant CSS suppression** — instead of the broken `*` selector, enumerate specific descendant types (`notificationbox`, `tabpanel`, etc.) and apply `transition: none` only to layout-affecting properties (`width`, `min-width`, `max-width`, `flex`, `flex-basis`, `transform`, `left`, `right`).
3. **Pause the AsyncTabSwitcher** during the fade — `gBrowser._switcher` may be running a tab-switch animation in parallel with our fade. Check if forcing it through `finish()` before the fade clears the animation.
4. **Snapshot via canvas / `drawWindow`** — paint the OLD workspace into a `<canvas>` overlay, fade THAT out while the live DOM swaps underneath, then fade the canvas out completely. Removes any dependency on the live DOM behaving statically during the fade.
5. **CSS `view-transition-name`** — modern CSS view transitions (`document.startViewTransition`) handle the crossfade-with-DOM-swap pattern natively and produce a SNAPSHOT-based crossfade. Check if Firefox 150 supports this in chrome documents.
6. **Defer TabSelect-driven reconcile during fade** — gate `reconcile` calls on a flag that's true between fade-out start and the class-removal rAF. The TabSelect listener then becomes a no-op while the fade is in flight; only `handlePanelsTitle`'s deferred reconcile runs.
7. **`pointer-events: none` + `visibility: hidden`** — combined with opacity:0 during the fade, prevent any layout/paint contribution from descendants while the class is on. Less likely to break Firefox internals than `animation: none !important`.
8. **Cache the rendered panel set via `position: absolute` snapshot** — clone the panel strip into a sibling absolute-positioned element, fade it out while the live strip swaps underneath, then remove. Same idea as canvas but DOM-based.

## How to add a new attempt to this doc

Add a new section under "Attempts & results":

```markdown
### Attempt N (YYYY-MM-DD) — short description

**Hypothesis:** What you think is causing the slide.

**Change:** What you modified (file + brief description; link the commit/diff if possible).

**Result:** What you observed when you ran the repro. Be specific — "slide is gone", "slide still visible during fade-in", "slide is now in the opposite direction", "main panel rendered blank for 200 ms", etc.

**Verdict:** FIXED / PARTIAL FIX / FAILED / REVERTED, and a one-line reason.
```

## Repro recipe

1. Build: `npm run build`
2. Launch a fresh profile: `engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/MacOS/bento --new-instance --jsdebugger --profile $(mktemp -d)`
3. Create two workspaces, each with 2–4 side panels of different widths (right-click links → Open in New Panel).
4. Switch between workspaces via the sidebar workspace switcher or Cmd+Alt+1 / Cmd+Alt+2.
5. Observe the panel strip during the transition.

**Expected:** Static opacity fade — no horizontal motion of any panel.
**Actual:** Panels visibly slide left/right during the fade-in window.

## Diagnostic snippets

### Inspect chrome state mid-fade

Run in Browser Toolbox Console (Cmd+Opt+Shift+I, parent process):

```js
(() => {
  const tp = window.gBrowser?.tabpanels;
  const sc = document.getElementById('bento-strip-container');
  console.log({
    tabpanels: {
      hasFadeClass: tp?.classList?.contains('bento-workspace-switching'),
      opacity: tp ? getComputedStyle(tp).opacity : null,
      splitViewPanels: tp?.splitViewPanels || null,
    },
    stripContainer: {
      hasFadeClass: sc?.classList?.contains('bento-workspace-switching'),
      opacity: sc ? getComputedStyle(sc).opacity : null,
    },
  });
})();
```

### Enumerate active animations under the strip

```js
(() => {
  const targets = [
    window.gBrowser?.tabpanels,
    document.getElementById('bento-strip-container'),
  ].filter(Boolean);
  const all = targets.flatMap((t) => t.getAnimations({ subtree: true }));
  const summary = all.map((a) => {
    const el = a.effect?.target;
    return {
      tag: el?.tagName + (el?.id ? '#' + el.id : ''),
      classes: el?.className || '',
      transitionProperty: a.transitionProperty,
      animationName: a.animationName,
      playState: a.playState,
      currentTime: a.currentTime,
    };
  });
  console.log(JSON.stringify(summary, null, 2));
})();
```

Run this just after triggering a workspace switch — ideally inside `setTimeout(..., 200)` so it samples the fade-in window.

## Related code references

- [`performWorkspaceSwitchFade`](../src/browser/base/content/bento-shell-mount.js) — the fade coordinator (search the file for the function name)
- [`reconcilePanelsSplitView`](../src/browser/base/content/bento-shell-mount.js) — does the DOM swap; contains the auto-scroll-to-main path gated on `__workspaceSwitchSwapping`
- [`handlePanelsTitle`](../src/browser/base/content/bento-shell-mount.js) — entry point; computes `isWorkspaceTransition`, routes to fade or direct reconcile
- [`attachTabSelectListener`](../src/browser/base/content/bento-shell-mount.js) — registers TabSelect → reconcile path (the parallel race)
- [tools' `handleWorkspaceActivation`](../extensions/bento-tools/src/background.ts) — fires the `tabs.update(active:true)` that triggers chrome TabSelect

## Open questions for collaboration

If you're another model picking this up: please answer any of these in your attempt section before changing code.

1. Is the slide a single visible motion or multiple staggered motions?
2. Does the slide direction correlate with the relative scroll-position difference between source and destination workspace?
3. Does the slide reproduce on a workspace switch where the destination workspace has IDENTICAL panels to the source (same tab ids, same widths)? If so, it's not data-driven.
4. With `prefers-reduced-motion: reduce` (instant swap, no fade), is the slide still visible?
5. Does the slide stop if you set `host.scrollLeft = host.scrollLeft` inside the fade-out class addition (force a no-op scroll)?
