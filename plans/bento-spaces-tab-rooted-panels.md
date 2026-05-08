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

**Reparent the tab's existing panel-wrapper DOM element from `#tabbrowser-tabpanels` into `#bento-side-panel-host` at promote time. No swap, no second browser. The browser is the same element, the tab still owns it, the docShell follows.**

### Why not the swap approach (rejected during planning)

An earlier draft of this plan proposed creating a second browser element per panel and using `gBrowser._swapBrowserDocShells(tab, otherBrowser)` to move the docShell between them. **That approach is wrong.** Reading the function carefully:

- `_swapBrowserDocShells` swaps docShells between two `<browser>` elements via `ourBrowser.swapDocShells(aOtherBrowser)` (line 6570 of `engine/browser/components/tabbrowser/content/tabbrowser.js`).
- It also swaps `permanentKey`, progress listeners, registered URIs.
- It does **NOT** update `tab.linkedBrowser` to point at the other browser. After the swap, `tab.linkedBrowser` still references the original strip browser — which now holds the OTHER browser's old (empty) docShell.

WebExtensions content scripts attach to `tab.linkedBrowser`. Cmd+R hits `gBrowser.selectedBrowser`, which derives from `tab.linkedBrowser`. With the swap approach, both still point at the empty strip browser — we accomplish nothing for our goal.

### How the reparent approach works

Each tab's `<browser>` element lives inside a wrapper structure: `panel > browser-container > browser-stack > browser`. The outermost wrapper is what `gBrowser.getPanel(browser)` returns. `tab.linkedPanel` is the wrapper's `id` attribute. Lookups go through `document.getElementById(tab.linkedPanel)` — DOM-location-agnostic.

This means we can move the wrapper to a different DOM parent without breaking any of `gBrowser`'s identity tracking. The tab still has the same `linkedBrowser`, the same `linkedPanel`, the same `permanentKey`. WebExtensions still injects content scripts into `tab.linkedBrowser`. Cmd+R still reloads `tab.linkedBrowser`. The only difference: the user sees the browser rendered in our `#bento-side-panel-host` instead of in `#tabbrowser-tabpanels`.

**On `panel/add` (tab → panel):**

1. Tab `T` exists in `gBrowser`; `panel = document.getElementById(T.linkedPanel)` is its wrapper element, currently a child of `#tabbrowser-tabpanels`.
2. `host.appendChild(panel)` — moves the wrapper from `tabpanels` into our `#bento-side-panel-host`. (`appendChild` of an existing node moves it; no clone, no docShell churn.)
3. Set `panel.style.display = 'block'` (or whatever): tabpanels' deck-style "show only the selected panel" mechanism doesn't apply once the panel isn't in tabpanels. We want it always visible.
4. Set `T.linkedBrowser.docShellIsActive = true`: tabpanels' selection mechanism would normally toggle this; we take ownership.
5. Set `T.hidden = true`: keeps the tab in `gBrowser.tabs` (so closing the tab still closes the panel) but invisible from any tab-strip UI. Bento already hides the strip via CSS, but `hidden` is the supported API for "in the tab list but not shown."
6. Update PanelStore to record `T` is panel-hosted.

**On `panel/remove` (panel → tab):**

1. `tabpanels.appendChild(panel)` — moves the wrapper back. Same primitive in reverse.
2. Restore `T.hidden = false`.
3. Restore tabpanels' control of `docShellIsActive` (set by `gBrowser`'s tab switcher when this tab is selected).

**On tab close while it's a panel:**

`browser.tabs.onRemoved` fires. The wrapper is still in our panel host. We need to remove it — let the existing `PanelStore` cleanup + `reconcilePanels` handle that, with the reconciler aware that an "absent" panel needs `panel.remove()` (its docShell is already gone).

**On workspace switch:**

Each workspace has its own panel set. Switching `A → B`:

1. For every panel in `A`: reparent back to `tabpanels`, set `T.hidden = true` (the tab still belongs to workspace A and shouldn't appear in B's strip; per-workspace tab visibility is managed elsewhere).
2. For every panel in `B`: reparent into `#bento-side-panel-host`.
3. Total cost per panel: one DOM move + a couple of attribute toggles. No browser creation, no docShell swap. Should be near-instant even for many panels.

The original plan worried about per-workspace parking for perf. With the reparent approach, this is unnecessary — DOM moves are cheap.

## Implementation phases

### Phase 1: Foundation — single-tab promote/demote

Build the core reparent mechanism in isolation, behind a pref so we can A/B against current behavior during development.

- New chrome-side helper `src/browser/base/content/bento-panel-host.js`:
  - `promoteTabToPanel(tabId, panelHostElement)` — looks up the tab via `gBrowser.tabs`, gets its panel wrapper via `gBrowser.getPanel(tab.linkedBrowser)`, calls `panelHostElement.appendChild(panel)`, sets `panel.style.display = 'block'`, sets `tab.linkedBrowser.docShellIsActive = true`, sets `tab.hidden = true`. Returns the panel wrapper element so the chrome script can append a Bento header / splitter alongside it.
  - `demotePanelToTab(tabId)` — reverse: `gBrowser.tabpanels.appendChild(panel)`, restore `tab.hidden = false`, restore tabpanels-controlled docShellIsActive (probably unset our explicit assignment so the tab switcher takes back over).
- Pref `bento.panels.tabRooted` (default `false`); to be flipped to `true` once Phase 4 is green.
- `bento-shell-mount.js` checks the pref in `createPanelElement` / `reconcilePanels`. If true, route through the new helpers; if false, use the current separate-browser path.
- Smoke test path: with `bento.panels.tabRooted = true`, open a tab with Vimium installed, promote it via the sidebar's "open in side panel" button. Verify:
  - The page renders in the panel host (no reload).
  - Vimium's `j`/`k` keys scroll the page from inside the panel.
  - Dark Reader (if installed) applies CSS to the panel page.
  - `gBrowser.tabs.find(t => t.id matches).linkedBrowser` is the same browser element rendering inside our host.
  - The tab is still in `browser.tabs.query({})` results (not removed).
  - Demote: panel returns to tab strip with no reload, Vimium still works there.

### Phase 2: Wire into existing panel flow

Once Phase 1's reparent is reliable for one tab:

- Update `reconcilePanels(panels)` to use the reparent helpers when the pref is on. The diff logic stays the same — the changes are in what runs at "add a panel" / "remove a panel" decision points.
- Each panel container in our host needs to wrap (Bento header, splitter, browser-panel-wrapper, splitter, ...) — currently the wrapper holds (header, browser). With reparenting, the wrapper holds (header, panelElement-from-gBrowser). Test that splitter drag still resizes correctly.
- Confirm `tab.hidden = true` keeps the tab in `gBrowser.tabs` but invisible from native tab-strip UI (doesn't matter for Bento since strip is hidden, but is the right API contract).
- `panel/add` / `panel/remove` / `panels/clear` action handlers in `protocol-handler.ts` keep their current shape — the bento-tools side doesn't change at all, only the chrome-side interpretation of the resulting `panels/sync` event.

### Phase 3: Workspace switch handling

- When activating workspace `B` from `A`: for each panel in `A`, reparent back to `tabpanels` and set `tab.hidden = true` (it still belongs to A's tabs, A is no longer active so its tabs aren't shown anyway). For each panel in `B`, reparent into `#bento-side-panel-host`.
- DOM move cost is `O(panels)` and each move is a single `appendChild` — should be sub-millisecond per panel. No special parking needed (the original plan's concern was based on the swap approach which created/destroyed browsers).
- Verify the tab switcher and `gBrowser.selectedTab` semantics still work after a workspace switch — selectedTab might point to a tab whose panel is in our host; tabpanels-deck-selection might misbehave if it tries to "show" that selected tab's panel that's no longer in tabpanels.

### Phase 4: Edge case bash

The full list of things to verify works:

- Panel page navigates externally → URL bar reflects the new URL.
- `Cmd+L` while focused in a panel → URL bar enters edit mode for that panel's URL (currently the URL bar is bound to gBrowser.selectedBrowser; we may need to retarget it on panel focus, OR accept that URL bar always shows the main panel and use the panel's own URL input).
- `Cmd+F` while focused in a panel → find toolbar appears for the panel's content.
- DevTools → Inspect Element on a panel page — does the developer toolbox attach to the right docShell?
- Right-click → Save Page As / View Source / Inspect — all of these go through `gContextMenu` which uses `gBrowser.selectedBrowser`. May need to retarget on panel right-click.
- Picture-in-Picture, autoplay, video controls — exercise via YouTube.
- Audio indicator on tab — when a panel plays audio, does the (hidden) tab still get the audio indicator? Does our panel UI need its own indicator?
- Closing the tab via `panel/remove` + tab also being `tab/close` racing — `tab/onRemoved` fires after Firefox destroys the panel wrapper. Our reconciler needs to handle the wrapper already being gone (vs the previous architecture where we owned the wrapper).
- Session restore — does Firefox's sessionstore handle a tab whose linkedPanel is in a non-tabpanels parent? Probably yes (sessionstore reads tab attributes + browser docShell, neither cares where in DOM the panel lives), but worth verifying explicitly.
- Tab switcher (`gBrowser._switcher` — Mozilla's tab-warming feature) operates on `tabpanels.children`. With panels reparented out, the switcher might trip on the missing children when activating a non-panel tab. May need to guard.
- Tabpanels `selectedPanel` deck mechanism — when gBrowser sets `tabpanels.selectedPanel = somePanel`, what happens if the panel isn't a child of tabpanels? Probably no-ops; verify it doesn't throw.

### Phase 5: Cmd+R, Cmd+L, Cmd+F retargeting

Even with tab-rooted panels, Firefox's keyboard accelerators are bound to `gBrowser.selectedBrowser`. If panels live outside `gBrowser`'s active selection, accelerators still target the main tab.

Option (a): When the user clicks/focuses a panel, set `gBrowser.selectedTab = T_panel`. The panel's tab becomes "selected" from gBrowser's POV. Cmd+R then reloads it. Side effect: visible "main panel" content also changes (we'd swap the displayed tab). Probably wrong.

Option (b): Track our own "focused panel" state in the chrome script. Intercept Cmd+R / Cmd+L / Cmd+F at the window level (capture phase, before Firefox's binding) and route to the focused panel's browser. Window-level keydown handler returns early when no panel is focused, letting Firefox's normal binding fire.

Option (b) is cleaner. Work needed:

- `bento-shell-mount.js` already has the `shouldHandlePanelArrowKey` helper. Add a similar pattern for accelerators.
- For each accelerator: `Cmd+R`, `Cmd+Shift+R`, `Cmd+L`, `Cmd+F` (find), `Cmd+G` (find next), `Cmd+T` (new tab — should this open a new panel? new tab? user choice?), back/forward (Cmd+[ / Cmd+]).
- Each retargets to the focused panel's browser. If no panel is focused, do nothing (let Firefox's binding handle it).

## Risk register

| Risk                                                                                                    | Severity | Mitigation                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reparenting the panel wrapper triggers Firefox to detach + reattach the docShell (= reload, state loss) | **High** | Phase 1 first-test verifies this. Mozilla's own pattern of `tabpanels.appendChild(panel)` (in `_insertBrowser`) is a reparent of an existing element when one was previously created elsewhere; the comment at line 2851-2856 warns it triggers constructors but says nothing about docShell churn. If reparenting DOES reload, fall back to a more invasive swap-with-frame-loader approach. |
| Tab switcher (`_switcher`) crashes when tabs have panels outside `tabpanels`                            | Medium   | Phase 4 verification with rapid tab switching. May need to disable the switcher (`gBrowser._switcher = null`?) for sessions where any panel is hosted, or guard our reparent against active switcher state.                                                                                                                                                                                   |
| `tabpanels` deck `selectedPanel` setter throws when the target isn't a child                            | Medium   | Phase 4 verification; if it throws, override or guard.                                                                                                                                                                                                                                                                                                                                        |
| Session restore loses the panel-rooted tab on next launch                                               | **High** | Phase 4 explicit test: launch with a panel, quit cleanly, relaunch. Sessionstore writes tab state from `tab.linkedBrowser` regardless of DOM location, so should work — but verify.                                                                                                                                                                                                           |
| Devtools refuses to attach to a panel browser whose DOM parent isn't tabpanels                          | Medium   | Phase 4 test with right-click → Inspect on a panel page. Devtools APIs go through `tab.linkedBrowser`, which we don't change — should work.                                                                                                                                                                                                                                                   |
| Hidden tab counts toward various tab-count limits / lifecycle behaviors                                 | Low      | `tab.hidden = true` is Mozilla's supported API; well-trodden by the multi-account-containers extension.                                                                                                                                                                                                                                                                                       |
| Cross-origin navigation in a panel changes remoteness, breaking our reparented state                    | Medium   | Mozilla's remoteness change destroys/recreates the browser inside the panel wrapper, but the wrapper itself is unchanged. Should be transparent to our reparent. Phase 4 verification.                                                                                                                                                                                                        |
| Panel reorder still triggers reload                                                                     | Low      | Existing in-place CSS-`order` reorder doesn't move DOM, so the wrapper stays put. Vimium state preserved across reorder.                                                                                                                                                                                                                                                                      |

## Estimated effort

Reparenting is a much smaller mechanism than the swap-based approach. Revised estimates:

- Phase 1: 1–2 days (mechanism + smoke test in isolation)
- Phase 2: 1 day (wire reconciler to use reparent path; rip out the parallel-browser path under the pref)
- Phase 3: half a day (workspace switch handling — DOM moves are cheap)
- Phase 4: 2–3 days (edge case bash; this is where unknowns will surface)
- Phase 5: 1 day (accelerator retargeting — same as before, independent of mechanism)

Total: **5–7 days** of focused work. (Down from the original swap-based 7–10 day estimate.)

If Phase 1's first-test reveals reparenting DOES trigger docShell reload, we fall back to the swap approach (with the additional `tab.linkedBrowser =` reassignment to fix the linked-browser problem) — that fallback adds ~2 days.

## Backward compatibility / migration

No user-visible state change. Existing panel persistence (URLs in storage.local) keeps working — the reparent is invisible to users. While the `bento.panels.tabRooted` pref is `false` (during development), behavior matches v0.0.1 with documented extension limitations; flipping to `true` is the v0.1.0 cutover moment.

## Definition of done

1. All four extension scenarios from the validation table above (Dark Reader, Vimium, uBlock, generic content_scripts) work in side panels.
2. Cmd+R / Cmd+Shift+R / Cmd+L / Cmd+F operate on the focused panel (Phase 5).
3. Devtools (Inspect Element from a panel page) attaches to the right document.
4. Workspace switch with 5 panels takes < 100 ms (per the M2 perf budget). With the reparent approach this should be trivially under budget.
5. Closing Bento with active panels and reopening preserves the panel set (session restore + panel persistence both intact).
6. The `bento.panels.tabRooted` pref defaults to `true`, the old separate-browser path is removed.

## Open questions for implementation kickoff

1. **Does `tabpanels.appendChild(panelFromOurHost)` cleanly reparent without reload?** (The whole plan hinges on this. Phase 1 first-test answers it. If no, fall back to the swap approach with explicit `tab.linkedBrowser` reassignment.)
2. **Does `tab.hidden = true` keep the tab in `browser.tabs.query()`?** Probably yes (multi-account-containers relies on this). Does it keep the tab focusable via Cmd+number keyboard shortcuts? Probably no — that's actually fine for our model where panels aren't reachable via the strip's number keys.
3. **When a tab is panel-hosted and the user does Cmd+W (close tab), what should happen?** Close the tab (= remove the panel + close)? Or remove it from the panel and put it back in the strip? Likely the former (matches "close" semantics) but worth confirming UX.
4. **What does `gBrowser._switcher` do when activated for a tab whose panel is in our host?** The switcher's role is to "warm up" the next tab's docShell; if our panel browsers are always-active anyway, the switcher might be irrelevant for them. Verify it doesn't crash.
5. **What does `tabpanels.selectedPanel = X` do when X isn't a child of tabpanels?** The deck mechanism might no-op, throw, or insert silently. Verify in Phase 1.

## Out of scope

- Tab tear-out (drag panel to a new window). Useful, but separate work and not blocking.
- Multi-window support for panels. Each window has its own panel set today; that stays.
- Panel content saved without a backing tab (the "ghost panel" idea). Not part of this plan.
