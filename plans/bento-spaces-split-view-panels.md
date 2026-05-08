# Plan: Bento Spaces — Native Split-View Panels (revision 4)

## Status

Approved. Supersedes [plans/bento-spaces-tab-rooted-panels.md](bento-spaces-tab-rooted-panels.md), which is now marked obsolete.

Targeted for v0.0.x preview iteration, with a stretch goal of having the migration ship in v0.1.0.

## Background

### Why a fresh plan

The prior plan tried to make Bento side panels host the underlying tab's `linkedBrowser` directly so that WebExtension content scripts (Vimium, Dark Reader, uBlock, etc.) would attach correctly. Two implementations were tried:

- **Option (a)** — chrome-script manual reassignment of `tab.linkedBrowser` + manual `gBrowser._tabForBrowser` mutation + manual progress-listener rebind, all sequenced after `_swapBrowserDocShells`. Smoke test showed `Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved` on every Dark Reader toggle, plus knock-on `currentURI is null` errors during AsyncTabSwitcher iteration, plus broken tab activation post-demote.
- **Option (b)** — Firefox patch ([patches/chrome-layout/04-bento-panel-host-swap.patch](../patches/chrome-layout/04-bento-panel-host-swap.patch)) that adds a 4th argument `aReassignLinkedBrowserTo` to `_swapBrowserDocShells`, doing the reassignment + progress-listener rebind atomically inside Firefox between the `SwapDocShells` / `EndSwapDocShells` events that platform listeners (`MessageManagerProxy`) follow. Smoke test showed the same Conduits errors persist.

Diagnosis: JSWindowActor parent-side instances are keyed off `(browsingContext, actorName)`, but Firefox treats them as orphaned and recreates them whenever `browsingContext.top.embedderElement` changes. Pending queries on the old actor reject; new messages have to re-establish. `MessageManagerProxy` follows swaps cleanly but it sits on the legacy message-manager channel; `runtime.sendMessage` rides Conduits, which doesn't.

The fundamental issue: **Firefox does not model "this tab's `linkedBrowser` changes mid-life"**. Any solution that mutates `tab.linkedBrowser` violates a platform invariant that the WebExtension layer relies on.

### What's already in Firefox 150

Firefox 150 ships native multi-panel rendering. Each tab in a split keeps its own `linkedBrowser` exactly where it always is — inside `#tabbrowser-tabpanels`, never moved, never swapped. The split is purely a rendering concern:

- [browser/components/tabbrowser/content/tabbrowser.js:3491](../engine/browser/components/tabbrowser/content/tabbrowser.js) — `gBrowser.addTabSplitView([tab1, tab2, …])` — public API to make a split from existing tabs.
- [browser/components/tabbrowser/content/tabbrowser.js:3615](../engine/browser/components/tabbrowser/content/tabbrowser.js) — `gBrowser.showSplitViewPanels(tabs)` — for each tab, calls `_insertBrowser(tab)`, sets `linkedBrowser.docShellIsActive = true`, then sets `tabpanels.splitViewPanels = [panelId, …]`.
- [browser/components/tabbrowser/content/tabsplitview.js:35](../engine/browser/components/tabbrowser/content/tabsplitview.js) — `MozTabSplitViewWrapper` — XUL element that owns a small ordered set of tabs as a "split group". Backs the user-facing 2/4-tab split feature.
- [toolkit/content/widgets/tabbox.js:265](../engine/toolkit/content/widgets/tabbox.js) — `tabpanels.splitViewPanels` setter on the tabbox/tabpanels custom element. Takes an array of panel IDs; the deck renders all of them simultaneously instead of just `selectedPanel`.
- [browser/components/tabbrowser/content/split-view-footer.js](../engine/browser/components/tabbrowser/content/split-view-footer.js) — per-pane footer slot; useful for Bento's per-panel header (URL bar, back/forward, X close, bookmark).
- Pref `browser.tabs.splitView.enabled` (default false) gates the user-facing split-tab UI in `tab.js`. The lower-level rendering machinery (the `splitViewPanels` setter) is unconditional.
- `SessionStore.getNextSplitViewId()` and split-view session-restore handling are wired in. Closing a split-view tab and pressing Cmd+Shift+T restores it back into a split.

### Why this works where option (a)/(b) failed

The `splitViewPanels` setter doesn't change tab identity. It tells the tabbox deck to render N panels at once instead of one. Each tab's `linkedBrowser` stays in `#tabbrowser-tabpanels`. JSWindowActors don't see an embedder change because there isn't one. The browsingContext, frame loader, message manager, content-script registrations — all stable. Extensions work because each panel IS a normal tab from Firefox's perspective.

In-page state (scroll, form fields, JS heap, open WebSockets, video playback) survives trivially because no docShell is moved or reloaded.

## Goal

Restore extension support in Bento side panels and preserve all existing UX:

- Workspace-scoped panel sets (each workspace has its own ordered list of panels).
- **Unlimited panels per workspace** with horizontal scrolling. Bento bypasses `MozTabSplitViewWrapper` (which is built for the 2-tab Firefox UI) and drives `tabpanels.splitViewPanels` directly.
- Per-panel header: URL bar, back / forward / reload, bookmark, X close.
- Panel favicon strip at the bottom of the browser (current `#bento-panel-nav` UI).
- Drag-and-drop reorder by favicon, with the existing FLIP animation.
- Arrow-key cycling (`←` / `→`) between panels including the main panel.
- Add-panel trailer button.
- Splitter handles between panels for resize.
- Cmd+R / Cmd+L / Cmd+F / find-next operating on the **focused** panel, not the active main tab (open question: see Phase 4).
- Cmd+Shift+T restores a closed panel back into its workspace as a panel (open question: see Phase 4).
- Per-workspace session restore (panel set + URLs + scroll / form state) via Firefox's existing SessionStore.

## Architectural decision

| Decision                 | Choice                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering surface        | `#tabbrowser-tabpanels` (Firefox's native panel deck) — NOT a parallel Bento-owned host                                                           |
| Multi-panel mechanism    | `tabpanels.splitViewPanels = [panelId, …]` driven directly from chrome script                                                                     |
| Panel identity           | Each panel is a regular Firefox tab; the tab's `linkedBrowser` stays in tabpanels for its lifetime                                                |
| Panel-vs-not bookkeeping | bento-tools `PanelStore` (existing) — workspace → ordered tab IDs                                                                                 |
| Per-panel custom UI      | Chrome-side DOM injection (header / splitter) into each panel's `linkedPanel` notificationbox                                                     |
| Workspace scoping        | Switching workspaces sets `tabpanels.splitViewPanels = [active workspace's panel tab IDs]`                                                        |
| Hidden-from-strip        | Panels' tabs get `tab.hidden = true` so they're absent from the native tab strip (Bento hides `#TabsToolbar` anyway, but it's the right contract) |

Bento does NOT use `MozTabSplitViewWrapper` because:

1. It's built for the 2/4-tab Firefox split-tab feature; Bento needs unbounded panels.
2. Its tab-management semantics (the wrapper "owns" the tabs as a group) don't map cleanly onto Bento workspaces.
3. We need finer control over per-panel header rendering and ordering than the wrapper exposes.

The lower-level `tabpanels.splitViewPanels` setter is what the wrapper uses internally; we use it directly.

## UX preservation contract

The user-facing behaviour must match the v0.0.1 implementation, with two material additions:

| Behaviour                                                | v0.0.1                           | post-migration                           |
| -------------------------------------------------------- | -------------------------------- | ---------------------------------------- |
| "Open in side panel" promotes the tab into a panel       | ✓                                | ✓                                        |
| Closing a panel removes it (no demote)                   | new                              | ✓                                        |
| Cmd+Shift+T restores a closed panel as a panel           | new                              | ✓ (via SessionStore marker, see Phase 4) |
| In-page state preserved on promote                       | ✗ (parallel browser, fresh load) | ✓ (no docShell mutation)                 |
| **Extensions work in panels**                            | ✗                                | ✓                                        |
| Panel header (URL bar, back/forward/reload, X, bookmark) | ✓                                | ✓                                        |
| Panel favicon nav strip with arrow cycling               | ✓                                | ✓                                        |
| Drag-reorder by favicon                                  | ✓                                | ✓                                        |
| Workspace scoping                                        | ✓                                | ✓                                        |
| Splitter handles between panels                          | ✓                                | ✓                                        |
| Unlimited panels with horizontal scroll                  | ✓                                | ✓                                        |
| Add-panel trailer                                        | ✓                                | ✓                                        |

## Architecture

### Data flow

```
sidebar (React)                   bento-tools (TS)              chrome (bento-shell-mount.js)         Firefox tabpanels
─────────────────                 ─────────────────             ─────────────────────────────         ────────────────
user clicks "open in       ─►     panel/add action      ─►      via existing reconciler       ─►     tabpanels.splitViewPanels =
side panel" on tab T              PanelStore.add(ws, T)         (driven by panels/sync                  [main, ...panel tab linkedPanels]
                                  emit panels/sync              title-IPC)                              (multiple panels render simultaneously)
                                                                + tab.hidden = true on each
                                                                + apply Bento custom UI
                                                                  per-panel
```

The bento-tools side stays largely unchanged. The `panels/sync` event continues to carry `{workspaceId, panels: [{tabId, url}, …]}` exactly as today. The chrome-side panel reconciler is what changes substantially.

### Chrome-side reconciler (replaces today's parallel-browser path)

`bento-shell-mount.js`'s `reconcilePanels(panels)` becomes:

1. Compute the desired `splitViewPanels` value: `[mainTabPanelId, ...panelTabPanelIds]`. Each panel ID is the tab's `linkedPanel` (a string like `"panel-N"` set on the tab and its panel container in tabpanels).
2. For each panel tab, ensure `tab.hidden = true` (call `gBrowser.hideTab(tab)` which is the public API).
3. For each panel tab, ensure `_insertBrowser(tab)` has been called so `linkedBrowser` is in tabpanels. Call `tab.linkedBrowser.docShellIsActive = true` so it renders.
4. Set `gBrowser.tabpanels.splitViewPanels = [main.linkedPanel, ...panelTabs.map(t => t.linkedPanel)]`. The deck reconciles automatically: panels not in the array stop rendering; panels in the array start.
5. For each panel tab's `linkedPanel`, inject Bento's custom header (URL bar, back/forward/reload, bookmark, X close) as a child of the panel container — sibling to the `linkedBrowser`. Idempotent: skip if the header already exists for that panel.
6. Insert / update the splitter elements between panels and the add-panel trailer at the end.
7. The existing favicon nav strip (`#bento-panel-nav`) keeps reading panel state from the same `panels/sync` payload; no change to its rendering logic.

The current `#bento-side-panel-host` (added by [patches/chrome-layout/02-bento-side-panel.patch](../patches/chrome-layout/02-bento-side-panel.patch)) becomes redundant — panel rendering moves into `#tabbrowser-tabpanels` proper. That patch may be reduced or removed in Phase 1 (decision deferred to Phase 1; see open questions).

### Per-panel header injection

Today, `createPanelElement(tabId, url)` creates a `<vbox>` containing `[header, browser]` and the host renders it. After migration, the `<browser>` is owned by Firefox's tabpanels container. We can't wrap it. Two options:

- **(A) Inject the Bento header INTO the panel's notificationbox** as a sibling of the `<browser>`. The `linkedPanel` element is a notificationbox; its children are typically `[notificationstack, browser]`. We add `[bento-panel-header, notificationstack, browser]` so the header appears above the content.
- **(B) Inject a wrapper around the `<browser>`** — repositioning DOM nested inside the panel container. More invasive; might fight Firefox's layout.

Plan favours (A) because it's the lighter touch. Mock the structure first in a probe before committing.

The header logic (URL bar progress listener, back/forward enabled state refresh, bookmark detection) stays as-is; it operates on `browserEl` which is unchanged in identity.

### Add-panel trailer + splitters

Both are chrome-side decorations injected as siblings of the panel containers in tabpanels, alongside Bento's per-panel header. The reconciler rebuilds them in the right slots whenever `splitViewPanels` changes.

CSS: `#tabbrowser-tabpanels` becomes `display: flex; flex-direction: row; overflow-x: auto;` (when split is active) so unlimited panels scroll horizontally — the same layout the current `#bento-side-panel-host` uses today.

### Workspace switching

When the active workspace changes:

- bento-tools emits `panels/sync` with the new workspace's panel set.
- Chrome reconciler computes the new `splitViewPanels` array and sets it.
- Previous workspace's panel tabs stop rendering (their `linkedPanel`s are no longer in `splitViewPanels`). Their `linkedBrowser` stays alive in tabpanels — `docShellIsActive = false` to pause rendering / suspend timers, freeing GPU layers. (Memory stays allocated; switching back is instant.)
- New workspace's panel tabs activate via `docShellIsActive = true` and join `splitViewPanels`.

This is exactly how Firefox's tab switcher already pauses tabs that aren't currently selected. No new platform behaviour; we just orchestrate it for multiple panels at once.

### Active "main" tab

Bento's "main panel" is the active main tab — `gBrowser.selectedTab` from Firefox's perspective. It's always the first entry in `splitViewPanels`. When the user clicks a non-panel tab in the sidebar, that tab becomes `gBrowser.selectedTab`; the reconciler updates `splitViewPanels[0]` to its `linkedPanel`. Side panels stay.

When the user clicks a side panel (focuses it), what happens to `gBrowser.selectedTab`?

- **Option I**: leave `selectedTab` as the main tab. Cmd+R, Cmd+L, Cmd+F target the main tab. Bento's existing per-panel URL bar handles in-panel navigation; chrome-side accelerator interception (Phase 4) routes Cmd+R / Cmd+L / Cmd+F to the focused panel's browser.
- **Option II**: set `gBrowser.selectedTab = focusedPanelTab`. Cmd+R reloads the focused panel naturally; AMO install trusts it. But the "main" panel concept blurs — is the focused panel the new main?

Option I is closer to current Bento UX (main panel is sticky; side panels are pinned add-ons). Option II makes the platform happier (accelerators just work). Final call deferred to Phase 4 spike.

## Implementation phases

### Phase 0: Tear down Phase 1 (option a/b) artifacts

Half a day. Removes the dead-end work so the codebase is clean before Phase 1.

- Delete `src/browser/base/content/bento-panel-host.js`.
- Delete `patches/chrome-layout/04-bento-panel-host-swap.patch`.
- Delete the `bento.panels.tabRooted` pref entry from `prefs/bento.js`.
- Delete the `<script src="bento-panel-host.js">` line + jar.mn entry from `patches/chrome-layout/01-bento-shell-mount.patch`.
- In `bento-shell-mount.js`: delete `isTabRootedEnabled`, the `if (isTabRootedEnabled() && BentoPanelHost?.promoteTabToPanel) { … }` branch in `createPanelElement`, and the `BentoPanelHost.demotePanelToTab(id)` call in `reconcilePanels`.
- Verify `npm run build` produces a working binary on the legacy parallel-browser path (matches v0.0.1 behaviour exactly).

### Phase 1: Probe — drive `tabpanels.splitViewPanels` from chrome script

1 day. Validate the assumption that we can render multiple Bento panels via `splitViewPanels` without going through `MozTabSplitViewWrapper`. Lands behind a new pref `bento.panels.splitView` (default false) so we can compare against the legacy path during development.

- Write a chrome-script probe (similar to the v4 probe in the prior plan): given two existing tabs, set `gBrowser.tabpanels.splitViewPanels = [tab1.linkedPanel, tab2.linkedPanel]` and verify both render simultaneously.
- Verify each tab's `linkedBrowser.currentURI`, `messageManager`, `frameLoader` all stay valid before / during / after.
- Smoke-test extensions: install Vimium, set the split, verify j/k scrolls each panel independently.
- Smoke-test in-page state: scroll a long page, set the split, verify scroll is preserved.
- Smoke-test docShellIsActive: when a tab leaves `splitViewPanels`, set its `docShellIsActive = false` and verify that's reversible (re-enter the array, set true, content resumes).

If the probe passes, Phase 2 starts. If it doesn't, surface specifics here and revise the plan.

### Phase 2: Reconciler rewrite

2 days. Replace the parallel-browser path in `reconcilePanels` with the split-view path. Remains gated by `bento.panels.splitView`.

- Implement the chrome-side reconciler per Architecture §"Chrome-side reconciler" above.
- Implement per-panel header injection per §"Per-panel header injection" — the header is a chrome-side `<hbox>` injected into the `linkedPanel` notificationbox. The existing `createPanelHeader(browserEl, url, tabId)` function moves into the per-panel-header module; logic unchanged.
- Implement add-panel trailer + splitter injection in tabpanels.
- CSS for `#tabbrowser-tabpanels` when split is active: `display: flex; overflow-x: auto;` — port the existing `#bento-side-panel-host` styles.
- Hide the legacy `#bento-side-panel-host` (CSS `display: none`) when `bento.panels.splitView` is on. Don't delete the host yet — keep it for instant fallback during smoke-testing.
- Verify all existing UX works behind the pref: drag-reorder favicons, arrow-key cycling, splitter resize, add-panel button, X close, URL bar Enter to navigate, bookmark, etc.
- Smoke-test extensions: Dark Reader toggles cleanly across all panels; Vimium scrolls in each; uBlock applies filters; AMO "Add to Firefox" works on the focused panel-tab.

Exit criterion: behind `bento.panels.splitView=true`, all v0.0.1 UX works AND extensions function in panels.

### Phase 3: Workspace switching

1 day.

- When `panels/sync` arrives with a different active workspace, reconciler diffs old vs new panel tabs:
  - Tabs leaving the active set: `docShellIsActive = false` on their `linkedBrowser`, removed from `splitViewPanels`.
  - Tabs entering: `_insertBrowser(tab)` if not yet inserted, `docShellIsActive = true`, added to `splitViewPanels`.
  - Stable tabs (in both old and new sets, if a tab can be a panel in two workspaces — doesn't happen today but the reconciler is order-tolerant).
- Verify <100 ms perceived latency on workspace switch with 5 panels per workspace (per the M2 perf budget).
- Verify per-workspace state (each workspace's panels, ordering, URLs) round-trips correctly across workspace switches.

### Phase 4: Cmd+R / Cmd+L / Cmd+F retargeting + Cmd+Shift+T restore

2 days. The hardest phase, but well-trodden territory.

#### Accelerator retargeting

Decide between Option I and Option II from the architecture section. Likely **Option I** (sticky main, chrome-side keydown interception). Implementation pattern matches the existing `attachPaletteKeybinding` / arrow-key panel cycling in `bento-shell-mount.js`:

- Window-level capture-phase keydown listeners for Cmd+R, Cmd+Shift+R, Cmd+L, Cmd+F, Cmd+G.
- If a panel has focus (track via the existing focused-panel state used for arrow-key cycling): `preventDefault`, `stopPropagation`, route the action to the focused panel's `linkedBrowser` (e.g. `panelBrowser.reload()`, `panelBrowser.fixupAndLoadURIString(...)`, find-toolbar invocation against the panel's webNavigation).
- If no panel is focused, let Firefox's default fire — accelerator targets the main panel as before.

#### Cmd+Shift+T restore

Firefox's `gBrowser.undoCloseTab()` (Cmd+Shift+T) restores the most recently closed tab from `SessionStore`. SessionStore preserves custom tab values across the close → restore round-trip.

- When a tab is promoted to a panel, mark it via `browser.sessions.setTabValue(tabId, 'bento.isPanel', JSON.stringify({workspaceId, position}))`. This already lives in the bento-tools side (or close to it — see existing `WORKSPACE_SESSION_KEY` handling in `TabRegistry.ts`).
- bento-tools listens to `browser.tabs.onCreated`. When a created tab has `bento.isPanel` session value AND the workspace it belongs to is loaded, automatically promote it back into that workspace's panel set at the recorded position.
- Verify: open a tab, "open in side panel", close panel, Cmd+Shift+T → tab returns to its original panel slot in its original workspace.

#### Edge cases

- Panel tab navigates externally: URL bar (per-panel) reflects the new URL; bento-tools' `panels/sync` payload's `url` field updates.
- Audio in a panel: tab's audible indicator fires; existing `audible` field in TabSnapshot already wired through.
- DevTools on a panel page: `gContextMenu` and devtools resolve via `tab.linkedBrowser` — works.
- Closing a panel via X / favicon middle-click / `panel/remove` action: same as today, calls `gBrowser.removeTab(tab)`. Firefox's session-restore + our `bento.isPanel` marker mean Cmd+Shift+T brings it back as a panel.
- Picture-in-picture: panel tabs work as normal tabs; PIP works.
- Tab switcher (`gBrowser._switcher`) interacting with multiple visible panels: untested. Phase 1 probe should catch surprises.

### Phase 5: Cleanup + flip the pref

Half a day.

- Delete `#bento-side-panel-host` from [patches/chrome-layout/02-bento-side-panel.patch](../patches/chrome-layout/02-bento-side-panel.patch). The reconciler no longer uses it.
- Delete the legacy parallel-browser path from `createPanelElement` / `reconcilePanels`.
- Flip `bento.panels.splitView` default to true.
- Remove the pref gate from `bento-shell-mount.js`.
- Update `extensions/_shared/protocol.ts` if any panel-related protocol fields became unused.

## Removed / replaced artifacts

The following from the obsolete tab-rooted-panels plan are deleted in Phase 0:

- `src/browser/base/content/bento-panel-host.js`
- `patches/chrome-layout/04-bento-panel-host-swap.patch`
- `bento.panels.tabRooted` pref entry in `prefs/bento.js`
- The `bento-panel-host.js` `<script>` tag + jar.mn entry in `patches/chrome-layout/01-bento-shell-mount.patch`
- `isTabRootedEnabled()`, the promote branch in `createPanelElement`, the demote call in `reconcilePanels` — all in `bento-shell-mount.js`

After Phase 5:

- `patches/chrome-layout/02-bento-side-panel.patch` — deleted (the host vbox is no longer needed).
- The legacy parallel-browser path inside `createPanelElement` — deleted.
- `bento.panels.splitView` pref — kept as a kill-switch for the first preview release after migration; can be removed once stable.

## Risk register

| Risk                                                                                                                                                                     | Severity | Mitigation                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabpanels.splitViewPanels` setter has hidden invariants we haven't found (e.g. requires `MozTabSplitViewWrapper` to be the caller)                                      | Medium   | Phase 1 probe explicitly drives the setter directly; surfaces any guard before we commit.                                                                                                                                                                     |
| Per-panel header injection into `linkedPanel` notificationbox conflicts with Firefox's notificationstack layout                                                          | Medium   | Phase 2 verifies; fall back to wrapper-around-browser approach (B) if A doesn't fit.                                                                                                                                                                          |
| Many panels (10+) in `splitViewPanels` exceeds Firefox's expected use case and causes layout / paint issues                                                              | Medium   | Phase 2 stress-test with 10 / 20 / 50 panels per workspace. If layout breaks, cap at a sensible number per workspace and document.                                                                                                                            |
| Workspace switching with 5+ panels per workspace exceeds the 100 ms M2 perf budget                                                                                       | Low      | Phase 3 measures; `docShellIsActive` toggle is sub-ms per panel, splitViewPanels diffing is O(N). Should be well under budget.                                                                                                                                |
| Cmd+Shift+T restore of a panel doesn't roundtrip cleanly because workspace state is async-loaded                                                                         | Medium   | Phase 4 explicitly tests; bento-tools' onCreated handler waits for workspace load before re-promoting.                                                                                                                                                        |
| Firefox version bump renames `splitViewPanels` / `MozTabSplitViewWrapper` / `showSplitViewPanels`                                                                        | Medium   | These APIs are new to Firefox 150; could shift in 151+. Pin to specific Firefox versions; covered by the existing Surfer fork's version-bump rehearsal process.                                                                                               |
| Native Firefox split-tab UI (gated by `browser.tabs.splitView.enabled`) interferes if a user enables it in `about:config`                                                | Low      | Bento's reconciler runs on workspace change. If the user manually triggers Firefox's split-tab UI, the reconciler will overwrite `splitViewPanels` on next workspace event. Document; don't fight.                                                            |
| `_isTabAboutPreferencesOrSettings` / similar Firefox iterations over `gBrowser.visibleTabs` hit panel tabs (now hidden) and either skip them or error on null currentURI | Low      | `tab.hidden = true` excludes them from `visibleTabs`. The null-currentURI errors we hit in option (a) came from parked stripBrowsers; with split-view there are no parked stripBrowsers — every panel tab has a real `linkedBrowser` with valid `currentURI`. |

## Estimated effort

- Phase 0 (tear down option a/b artifacts): 0.5 days
- Phase 1 (probe `splitViewPanels` directly): 1 day
- Phase 2 (reconciler rewrite + per-panel header injection): 2 days
- Phase 3 (workspace switching): 1 day
- Phase 4 (accelerator retargeting + Cmd+Shift+T restore): 2 days
- Phase 5 (cleanup + flip default): 0.5 days

**Total: 7 days** of focused work. Slightly higher than the 2–3 day napkin estimate because we're being honest about Phase 4's Cmd+R/L/F retargeting and Cmd+Shift+T panel-restore, both of which are real engineering work that the prior plan also called out (Phase 5 of the obsolete plan).

## Backward compatibility / migration

No user-visible state change for users on legacy v0.0.1 panels — they continue working until Phase 5 flips the default. Users opting into `bento.panels.splitView=true` during Phase 2/3/4 development get the new behaviour.

PanelStore's persistence (URLs per workspace) is unchanged. Existing workspace data carries over.

## Definition of done

1. All four extension scenarios (Dark Reader, Vimium, uBlock, generic content_scripts) work in side panels under the default configuration.
2. Cmd+R / Cmd+Shift+R / Cmd+L / Cmd+F operate on the focused panel.
3. DevTools (Inspect Element from a panel page) attaches to the right document.
4. Workspace switch with 5 panels per workspace stays under 100 ms (M2 perf budget).
5. Closing Bento with active panels and reopening preserves the panel set per workspace, with each panel's session state (scroll, form fields, history) intact.
6. Cmd+Shift+T after closing a panel restores it back into its original workspace at its original position.
7. `bento.panels.splitView` defaults to `true`; the legacy parallel-browser path and `#bento-side-panel-host` are deleted.

## Open questions for implementation kickoff

1. **`browser.tabs.splitView.enabled` pref required?** — The user-facing split-tab UI is gated by this pref; the lower-level `splitViewPanels` setter likely isn't. Phase 1 probe answers definitively.
2. **Per-panel header injection mechanism** — Option A (header as sibling inside `linkedPanel` notificationbox) vs Option B (wrapper around `<browser>`). Phase 2 picks based on which one renders cleanly.
3. **Active main tab vs focused panel for accelerators** — Option I (sticky main, intercept and route) vs Option II (selectedTab follows focus). Phase 4 spike.
4. **Bento workspace ↔ Firefox split-view-id mapping** — should each workspace get a stable split-view ID (`SessionStore.getNextSplitViewId()`) for session-restore purposes, or do we manage workspace identity entirely in Bento? Likely the latter; SessionStore already preserves `bento.workspaceId` per-tab via the existing custom tab value. Phase 4.
5. **Tab switcher interactions** — `gBrowser._switcher` is the legacy Mozilla tab-warming mechanism; with multiple panels active, does it warm all of them or just `selectedTab`? Phase 1 probe inspects.
6. **Per-panel `tab.hidden = true`** — does this cause unexpected side effects (multi-account-containers interactions, sessionstore quirks)? Bento already hides `#TabsToolbar`, so the visual side is fine; this is about API contract surprises. Phase 2 verifies.

## Out of scope

- Panel tear-out (drag a panel into a new window). Different work, not blocking.
- Multi-window panel synchronization. Each window's gBrowser owns its own splitView state; that's fine.
- Cross-process iframes inside panels (Fission). Should work because each panel is a real tab with normal Fission behaviour, but explicit testing not in scope of this plan.
- Custom Bento panel motions / animations beyond what v0.0.1 already has (FLIP reorder, etc.).
- Replacing the existing `#bento-panel-nav` favicon strip with anything new — it stays as-is and reads from `panels/sync`.
