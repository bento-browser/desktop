# Plan: Tab-Rooted Bento Spaces Panels (v0.0.2 / v0.1.0)

## Status

Pre-planning. Targeted at the next preview release (after v0.0.1 ships). Do not start implementation until v0.0.1 is published and we have a clean baseline.

## Problem statement

Side panels in v0.0.1 are **unbacked content browsers**, not tabs. Each panel has two browsers for the same conceptual tab:

1. The tab's real `<browser>` in `gBrowser`'s tab strip (hidden via CSS, but still part of the tab list).
2. A separate `<browser>` we create in `#bento-side-panel-host` and navigate to the same URL.

The user looks at #2; everything else in Firefox (WebExtensions, keyboard accelerators, devtools, find-in-page) talks to #1.

Validated breakage from real extension tests in v0.0.1 dev:fresh:

| Behavior                                            | Status    | Why                                                                                                    |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| uBlock Origin filtering ad requests in panels       | ✅ works  | Network-layer filtering is process-wide, not browser-bound                                             |
| Dark Reader applying CSS in panels                  | ❌ broken | Content scripts inject into the tab's browser, not the panel's display browser                         |
| Vimium key handling in panels (j/k/f/gg/G all fail) | ❌ broken | Same — content scripts not injected; Vimium has no listener attached to the visible browser            |
| Cmd+R reloading the focused panel                   | ❌ broken | Firefox accelerator routes to `gBrowser.selectedBrowser`, which is the main tab, not the panel browser |

We cannot ship to the public with extensions silently broken in panels. This plan re-roots panels in real tabs so all of Firefox's extension surface, keyboard accelerators, devtools, find-in-page, etc. work in panels indistinguishably from the main view.

## Goal

When a tab is promoted to a side panel, the panel **becomes** the tab's browser — same docShell, same content scripts, same identity from WebExtensions' point of view. There is exactly one `<browser>` per tab, regardless of whether the tab is rendered as the main panel, a side panel, or hidden.

Success criteria:

- Dark Reader, Vimium, Stylus, ColorZilla, and similar `content_scripts`-driven extensions work in side panels with no visible difference from the main panel.
- `Cmd+R` / `Cmd+Shift+R` / `Cmd+L` / `Cmd+F` / `Cmd+T` operate on whichever panel has user focus.
- DevTools (Inspect Element, Console) works when right-click → Inspect is invoked from a side panel page.
- Removing a panel cleanly returns the tab to the main tab strip, no docShell loss, no reload.
- Closing a tab that's currently a panel removes both the panel slot and the tab.

## Architectural decision

**Move the tab's browser DOM element between hosts at promote/remove time, using `gBrowser._swapBrowserDocShells` as the primitive.**

The conventional Firefox pattern for "move a tab's content elsewhere without losing state" is `swapBrowsersAndCloseOther` (used for tab tear-out into a new window). The lower-level building block is `_swapBrowserDocShells(tab, otherBrowser)` — it transplants the docShell from one browser element into another. After the swap, content scripts, history state, scroll position, audio playback, everything follows the docShell, not the DOM element.

Concretely, the panel-side flow becomes:

**On `panel/add` (tab → panel):**

1. The tab `T` exists in `gBrowser` with linked browser `B_tab` (currently the only browser for `T`).
2. We create a new placeholder browser element `B_panel` in `#bento-side-panel-host`. It's a `<browser type="content" remote="true">` with the right `messagemanagergroup`, but starts blank.
3. Call `gBrowser._swapBrowserDocShells(T, B_panel)`. This:
   - Swaps the docShell from `B_tab` into `B_panel`.
   - Re-points `T.linkedBrowser` to `B_panel`.
   - `B_tab` is now empty; `B_panel` has the live page + content scripts + everything.
4. Hide `B_tab` from the tab strip (it's still in `gBrowser`'s tabs array — we don't want to remove the tab, just relocate its rendering). Or remove `B_tab` from DOM entirely; `gBrowser` permits this for "tabs without browsers" patterns used internally.
5. Update PanelStore to record that `T` is now panel-hosted.

**On `panel/remove` (panel → tab):**

1. Reverse the swap: create or reuse a browser slot inside `gBrowser`, call `_swapBrowserDocShells(T, B_tab_slot)` to move the docShell back.
2. Remove the now-empty `B_panel` from the panel host.
3. The tab is back in the strip with no reload.

**On tab close while it's a panel:**

`browser.tabs.onRemoved` fires. PanelStore listener (already exists) drops the panel entry; reconcilePanels removes `B_panel` from the strip; the docShell was already destroyed by tab close, so nothing to swap back.

**On workspace switch:**

Currently each workspace has its own panel set. With tab-rooted panels, switching workspace `A → B`:

1. For every panel in `A`: swap docShell back into `gBrowser` (panel becomes a regular hidden tab).
2. For every panel in `B`: swap docShell from `gBrowser` into a new `B_panel`.
3. The chrome reconciler tears down `A`'s panel hosts and builds `B`'s.

This is a lot of swaps per workspace activation. We may want to keep panel browsers around per-workspace (one set per workspace, all parked with empty docShells when their workspace isn't active) to avoid creating + destroying browsers on every switch. **Open question** — measure first.

## Implementation phases

### Phase 1: Foundation — single-tab promote/demote

Build the core swap mechanism without integrating into the existing panel store yet. Behind a pref so we can toggle between old (separate-browser) and new (swap-rooted) behavior during development.

- New module: `extensions/bento-shell/src/experiments/chrome-bridge/api.js` already exists for chrome→shell calls. Add a chrome-side helper file `src/browser/base/content/bento-panel-swap.js` with:
  - `promoteTabToPanel(tabId, panelHostElement)` — creates `B_panel`, calls `_swapBrowserDocShells`, hides `B_tab`. Returns the new panel browser.
  - `demotePanelToTab(tabId)` — reverses.
- Pref `bento.panels.tabRooted` (default `false` for v0.0.2 alpha, `true` once stable).
- `bento-shell-mount.js` checks the pref in `createPanelElement` / `reconcilePanels`. If true, route through the new swap helpers; if false, use the old (current) path.
- Smoke test: open a tab, promote, verify URL bar still shows tab URL, verify `gBrowser.tabs[].linkedBrowser` points at the panel browser.

### Phase 2: Wire into existing panel flow

Once Phase 1's swap is reliable for one tab:

- Update `reconcilePanels(panels)` to use the swap path when the pref is on. The reconciler's diff logic stays the same — the changes are in element creation/destruction and the swap calls.
- Update `panel/add`, `panel/remove`, `panels/clear` action handlers in `protocol-handler.ts` to be aware of the new flow (they don't need to change much — they still operate on PanelStore — but tests should cover the new path).
- Tab strip hiding: figure out the cleanest way to keep the tab in `gBrowser.tabs` but not visible in the strip. Options:
  - Set `tab.hidden = true` (tab is hidden from the strip but still in the tab list). Tab-strip hide CSS we already have means strip is invisible anyway, but `hidden` is the supported API.
  - Remove `B_tab` from DOM entirely and rely on the swap to reattach when needed. Riskier.

### Phase 3: Workspace switch perf

- Measure how long N-panel workspace switches take with the swap-on-switch approach.
- If it's noticeable (>50 ms for 5 panels), implement the per-workspace panel-host parking: each workspace has its own hidden host with its panel browsers attached, switching just toggles `display`/visibility.

### Phase 4: Edge case bash

The full list of things to verify works:

- Panel page navigates externally → URL bar reflects the new URL.
- `Cmd+L` while focused in a panel → URL bar enters edit mode for that panel's URL (currently the URL bar is bound to gBrowser.selectedBrowser; we may need to retarget it on panel focus, OR accept that URL bar always shows the main panel and use the panel's own URL input).
- `Cmd+F` while focused in a panel → find toolbar appears for the panel's content.
- DevTools → Inspect Element on a panel page — does the developer toolbox attach to the right docShell?
- Right-click → Save Page As / View Source / Inspect — all of these go through `gContextMenu` which uses `gBrowser.selectedBrowser`. May need to retarget on panel right-click.
- Picture-in-Picture, autoplay, video controls — exercise via YouTube.
- Audio indicator on tab — when a panel plays audio, does the (hidden) tab still get the audio indicator? Does our panel UI need its own indicator?
- Closing the tab via `panel/remove` + tab also being `tab/close` racing — current code handles tab/onRemoved but the swap path might leak `B_panel` if we don't destroy it correctly.
- Session restore — does Firefox's sessionstore handle a tab whose linkedBrowser is in a non-standard DOM location?

### Phase 5: Cmd+R, Cmd+L, Cmd+F retargeting

Even with tab-rooted panels, Firefox's keyboard accelerators are bound to `gBrowser.selectedBrowser`. If panels live outside `gBrowser`'s active selection, accelerators still target the main tab.

Option (a): When the user clicks/focuses a panel, set `gBrowser.selectedTab = T_panel`. The panel's tab becomes "selected" from gBrowser's POV. Cmd+R then reloads it. Side effect: visible "main panel" content also changes (we'd swap the displayed tab). Probably wrong.

Option (b): Track our own "focused panel" state in the chrome script. Intercept Cmd+R / Cmd+L / Cmd+F at the window level (capture phase, before Firefox's binding) and route to the focused panel's browser. Window-level keydown handler returns early when no panel is focused, letting Firefox's normal binding fire.

Option (b) is cleaner. Work needed:

- `bento-shell-mount.js` already has the `shouldHandlePanelArrowKey` helper. Add a similar pattern for accelerators.
- For each accelerator: `Cmd+R`, `Cmd+Shift+R`, `Cmd+L`, `Cmd+F` (find), `Cmd+G` (find next), `Cmd+T` (new tab — should this open a new panel? new tab? user choice?), back/forward (Cmd+[ / Cmd+]).
- Each retargets to the focused panel's browser. If no panel is focused, do nothing (let Firefox's binding handle it).

## Risk register

| Risk                                                                           | Severity | Mitigation                                                                                                                              |
| ------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `_swapBrowserDocShells` breaks on edge cases (audio playback, fullscreen, PiP) | High     | Phase 4 edge case bash; pref toggle for fast revert                                                                                     |
| Hidden tab counts toward various tab-count limits / lifecycle behaviors        | Medium   | `tab.hidden = true` is the supported API for this; document any quirks found                                                            |
| Workspace switch becomes noticeably slow with many panels                      | Medium   | Phase 3 measurement + per-workspace parking                                                                                             |
| Session restore breaks when tab.linkedBrowser is in a non-tabbrowser parent    | High     | Test session restore explicitly in Phase 4; may need to swap back before quit                                                           |
| Devtools refuses to attach to a tab whose browser isn't where it expects       | Medium   | Test in Phase 4; Mozilla's devtools APIs go through tab.linkedBrowser, which should follow our swap                                     |
| Panel reorder still triggers reload even with tab-rooted                       | Low      | The existing in-place CSS-`order` reorder doesn't move DOM, so the swap stays put. Verify with Vimium's state preserved across reorder. |

## Estimated effort

- Phase 1: 2–3 days (Firefox internals deep-dive + first reliable swap)
- Phase 2: 1–2 days (integrate, kill the old panel-browser path under the pref)
- Phase 3: 1 day (measure + park-per-workspace if needed)
- Phase 4: 2–3 days (edge case bash, fix what surfaces)
- Phase 5: 1 day (accelerator retargeting)

Total: **7–10 days** of focused work. This is the headline change for v0.1.0.

## Backward compatibility / migration

No user-visible state change. Existing panel persistence (URLs in storage.local) keeps working — the swap is invisible to users. If Phase 1 lands behind a pref, old users on `bento.panels.tabRooted=false` keep the v0.0.1 behavior with documented extension limitations; new users default to the new behavior once we flip the pref.

## Definition of done

1. All four extension scenarios from the validation table above (Dark Reader, Vimium, uBlock, generic content_scripts) work in side panels.
2. Cmd+R / Cmd+Shift+R / Cmd+L / Cmd+F operate on the focused panel.
3. Devtools (Inspect Element from a panel page) attaches to the right document.
4. Workspace switch with 5 panels takes < 100 ms (per the M2 perf budget).
5. Closing Bento with active panels and reopening preserves the panel set (session restore + panel persistence both intact).
6. The `bento.panels.tabRooted` pref defaults to `true`, the old separate-browser path is removed.

## Open questions for implementation kickoff

1. Does `tab.hidden = true` keep the tab in `browser.tabs.query()`? (Probably yes.) Does it keep the tab focusable via Cmd+number keyboard shortcuts? (Probably no.)
2. When a tab is panel-hosted and the user does Cmd+W (close tab), what should happen — close the tab (= remove the panel + close), or remove it from the panel and put it back in the strip? Likely the former (matches "close" semantics) but worth confirming UX.
3. When a tab page navigates to a different origin, does the docShell get replaced (would invalidate our swap)? In Firefox 150 with Fission, cross-origin navigation can change remoteness; `_swapBrowserDocShells` calls `_insertBrowser` defensively but we should test with a panel that navigates cross-origin.

## Out of scope

- Tab tear-out (drag panel to a new window). Useful, but separate work and not blocking.
- Multi-window support for panels. Each window has its own panel set today; that stays.
- Panel content saved without a backing tab (the "ghost panel" idea). Not part of this plan.
