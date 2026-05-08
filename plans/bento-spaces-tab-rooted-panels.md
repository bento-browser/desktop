# Plan: Tab-Rooted Bento Spaces Panels (v0.0.2 / v0.1.0)

## Status

> **OBSOLETE — superseded by [plans/bento-spaces-split-view-panels.md](bento-spaces-split-view-panels.md).**
>
> Phase 1 of this plan was implemented and smoke-tested behind the
> `bento.panels.tabRooted` pref (default false). Both option (a)
> (chrome-script-only manual `tab.linkedBrowser` reassignment + progress-
> listener rebind) and option (b) (Firefox patch making the reassignment
> atomic inside `_swapBrowserDocShells`) ran into the same root cause:
> JSWindowActor parent-side instances are recreated when
> `browsingContext.top.embedderElement` changes, which means
> `runtime.sendMessage` (Conduits) breaks for any extension that has
> already attached content scripts to the tab being promoted. Dark
> Reader, Vimium, etc. all surfaced "Actor 'Conduits' destroyed before
> query 'RuntimeMessage' was resolved" errors on every promote.
>
> The new plan abandons the docShell-swap approach entirely and uses
> Firefox 150's native multi-panel rendering machinery
> (`tabpanels.splitViewPanels`, `MozTabSplitViewWrapper`,
> `gBrowser.showSplitViewPanels`) — which Mozilla and Zen already use
> for split-tab features. Each panel stays a regular Firefox tab whose
> `linkedBrowser` is never moved or swapped; multiple tabs are simply
> rendered simultaneously by the tabpanels deck. Extension support and
> in-page state preservation come for free because nothing about a
> tab's identity changes.
>
> All the artifacts from this plan
> (`patches/chrome-layout/04-bento-panel-host-swap.patch`,
> `src/browser/base/content/bento-panel-host.js`, the
> `bento.panels.tabRooted` pref, the `createPanelElement` /
> `reconcilePanels` branches in `bento-shell-mount.js`) get deleted in
> the new plan's Phase 0.
>
> Prior status preserved below for archival reference.

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

**Create a new `<browser>` element in `#bento-side-panel-host`, swap docShells from the tab's existing browser into it via `gBrowser._swapBrowserDocShells`, then manually reassign `tab.linkedBrowser` and the `_tabForBrowser` reverse map. The tab now references the panel's browser; content scripts and accelerators follow.**

### Mechanism evolution (third revision; superseded approaches kept for reference)

Three approaches were investigated experimentally before settling. All test scripts are at `/tmp/bento-reparent-test-{v2,v3,v4}.js` (out-of-tree).

**Rejected approach 1: reparent the panel wrapper element**
`gBrowser.getPanel(browser)` returns a `<hbox class="browserSidebarContainer">` wrapper around the browser. Calling `host.appendChild(panel)` moves the wrapper. Hypothesis was that the contained browser's docShell follows since the DOM ancestry change is small. Result: docShell `historyID` matches but `webProgress` becomes undefined and content document is destroyed (URI → about:blank, contentTitle → empty). Firefox's bind/unbind machinery rebuilds the frame loader when the panel reparents.

**Rejected approach 2: reparent the `<browser>` element directly**
Per `connectedMoveCallback` in `browser-custom-element.mjs:408` (and the bug 2007742 fix to `XULFrameElement::BindToTree`), Firefox supports atomic moves of `<browser>` elements without frame-loader reconstruction. Tested by extracting the browser from its panel wrapper and `host.appendChild(browser)`. Result: `webProgress` survives this time (frame loader preserved) but `currentWindowGlobal` is null and `contentTitle` is empty — the content document is still destroyed even though the browsingContext shell survives. The skip-reconstruction works for the frame loader but not for the document inside. Same outcome as approach 1 from the user's perspective.

**Accepted approach 3: swap-with-linkedBrowser-reassignment**
Create a _new_ `<browser>` element in our host, then call `gBrowser._swapBrowserDocShells(T, newBrowser)` which transfers the docShell (and the document inside it) atomically between two existing browser elements. This is the same primitive Mozilla uses for tab tear-out across windows — documents survive the swap. After the swap, `tab.linkedBrowser` still points at the old strip browser (a known limitation of the function), so we manually reassign:

```js
// 1. Build the new browser in our host.
const newBrowser = document.createXULElement('browser');
newBrowser.setAttribute('type', 'content');
newBrowser.setAttribute('remote', 'true');
newBrowser.setAttribute('remoteType', oldBrowser.remoteType);
newBrowser.setAttribute('messagemanagergroup', 'browsers');
panelHost.appendChild(newBrowser);

// 2. Transfer the docShell (and its content document).
gBrowser._swapBrowserDocShells(tab, newBrowser);

// 3. Repoint linkedBrowser + reverse map.
tab.linkedBrowser = newBrowser;
gBrowser._tabForBrowser.set(newBrowser, tab);
gBrowser._tabForBrowser.delete(oldBrowser);

// 4. Move the tab's progress listener from oldBrowser to newBrowser.
//    _swapBrowserDocShells re-attaches the listener to oldBrowser as part
//    of its cleanup; we need it on newBrowser instead, since that's now
//    tab.linkedBrowser. Without this, demote-time _swapBrowserDocShells
//    throws NS_ERROR_FAILURE on removeProgressListener. (See v4 test
//    output for the exact failure mode.)
//    Implementation: detach from oldBrowser, re-attach to newBrowser
//    using the same TabProgressListener instance.
```

Verified: `newBrowser.contentTitle` and `newBrowser.currentURI` reflect the actual page (not about:blank). `gBrowser.getTabForBrowser(newBrowser) === tab`.

**On `panel/add` (tab → panel):**

1. Build a new `<browser>` element in the panel host with matching remoteType + messagemanagergroup as the tab's existing browser.
2. Yield once to let the new browser's frame loader initialize its empty docShell (~100 ms is enough).
3. `gBrowser._swapBrowserDocShells(T, newBrowser)` — content moves into newBrowser; oldBrowser becomes empty.
4. `T.linkedBrowser = newBrowser` + update `_tabForBrowser` map both directions.
5. Re-bind the tab's progress listener from oldBrowser to newBrowser.
6. Set `T.hidden = true` — keeps T in `gBrowser.tabs` (so close-tab still closes the panel) but invisible from any tab-strip UI.
7. Remove oldBrowser's `<browser>` from the strip's panel container (or leave it as garbage; it has no docShell, takes minimal memory).
8. Update PanelStore to record T is panel-hosted.

**On `panel/remove` (panel → tab):**

1. Look up T's strip slot — gBrowser still has the `linkedPanel` wrapper in `tabpanels`, just with the oldBrowser empty inside it. Or we removed oldBrowser entirely in step 7 of promote; in that case, recreate a stub browser in the original panel position.
2. Mirror image of promote: swap docShell from panel browser back into the strip browser via `_swapBrowserDocShells(T, restoredOldBrowser)`.
3. Reassign `T.linkedBrowser` back to the strip browser; fix `_tabForBrowser` map.
4. Re-bind progress listener back.
5. Restore `T.hidden = false`.
6. Remove the panel browser from our host.

**On tab close while it's a panel:**

`browser.tabs.onRemoved` fires. The panel browser still exists in our host. Our PanelStore listener (already exists) drops the panel entry; reconcilePanels removes the panel browser from the strip; the docShell was destroyed by tab close, so nothing to swap back.

**On workspace switch:**

Each workspace has its own panel set. Switching `A → B`:

1. For every panel in A: demote (swap docShells back into the strip browser, restore linkedBrowser, set T.hidden=true since A is no longer active).
2. For every panel in B: promote into `#bento-side-panel-host`.
3. Cost per panel: 1 swap + 5 small attribute mutations. Sub-millisecond. No per-workspace parking optimization needed.

### Why this approach is unavoidable

Both reparent variants destroyed the inner document. The skip-reconstruction support for `<browser>` element moves only preserves the frame loader, not the document. The swap-via-`swapDocShells` mechanism is the _only_ primitive Mozilla provides that transfers a document between two browser-element hosts without destroying it — that's why tab tear-out across windows uses exactly this. We piggyback on it.

The cost is depth: we mutate `tab.linkedBrowser` and `_tabForBrowser` directly, which are gBrowser internals not part of any documented API. Firefox version bumps could break this. Mitigation: each Firefox bump runs the full Phase 4 edge-case bash to catch regressions.

## Implementation phases

### Phase 1: Foundation — single-tab promote/demote

Build the core swap-and-reassign mechanism in isolation, behind a pref so we can A/B against current behavior during development.

- New chrome-side helper `src/browser/base/content/bento-panel-host.js` (or reuse an existing chrome script):
  - `promoteTabToPanel(tabId, panelHostElement)` — implements the 8-step promote sequence from the architectural decision above. Returns the new panel browser element so callers can wire a Bento header / splitter around it.
  - `demotePanelToTab(tabId)` — implements the 6-step demote sequence.
  - Both functions are guarded against re-entrant calls (a tab can only be promoted once).
- Pref `bento.panels.tabRooted` (default `false`); to be flipped to `true` once Phase 4 is green.
- `bento-shell-mount.js` checks the pref in `createPanelElement` / `reconcilePanels`. If true, route through the new helpers; if false, use the current separate-browser path.
- Smoke test path: with `bento.panels.tabRooted = true`, open a tab with Vimium installed, promote it via the sidebar's "open in side panel" button. Verify:
  - Page renders in the panel host with the actual content (not about:blank, no reload).
  - Vimium's `j`/`k` keys scroll the page from inside the panel.
  - Dark Reader (if installed) applies CSS to the panel page.
  - `gBrowser.getTabForBrowser(panelBrowser) === tab` (reverse map correct).
  - `tab.linkedBrowser === panelBrowser` (forward map correct).
  - `browser.tabs.query({})` still includes the tab (not removed).
  - Demote: docShell swaps back into the strip browser; if the user switches to that tab, the page is there with no reload, Vimium still works.
- The progress-listener rebind (step 5 of promote) needs special care. `_swapBrowserDocShells` re-creates a `TabProgressListener` bound to `oldBrowser` as part of its cleanup. We need to either:
  - (a) Detach that listener and re-attach it to `newBrowser` — but reaching into `_tabFilters` / `_tabListeners` to swap targets requires careful sequencing.
  - (b) Patch `_swapBrowserDocShells` to accept an "actually I'm reassigning the linkedBrowser too" flag that does the right thing internally.
  - (b) is cleaner long-term but requires a Firefox patch (one of our chrome-layout patches grows). (a) keeps everything in our chrome script. Phase 1 starts with (a); revisit (b) in Phase 4 if (a) proves brittle.

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

| Risk                                                                                                                                              | Severity | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual `tab.linkedBrowser =` + `_tabForBrowser.set/.delete` mutations are gBrowser internals — Firefox version bumps could rename or change shape | **High** | The Phase 4 edge-case bash runs on every Firefox version bump (existing process, see [docs/maintaining-surfer.md](../docs/maintaining-surfer.md)). Catch breakage there. If `linkedBrowser` becomes a setter with side effects in a future Firefox, our manual assignment may misbehave; verify by reading tabbrowser.js source on each bump.                                                                    |
| Progress-listener rebind from oldBrowser to newBrowser is fragile                                                                                 | **High** | Phase 1 demote test exposes this — the v4 probe hit `NS_ERROR_FAILURE` on the second `_swapBrowserDocShells` because the listener was attached to oldBrowser instead of the now-current linkedBrowser. Phase 1 needs an explicit "move TabProgressListener" helper. If that proves brittle, fall back to a Firefox patch that gives `_swapBrowserDocShells` an option to also reassign linkedBrowser internally. |
| Tab switcher (`_switcher`) misbehaves when `tab.linkedBrowser` is a `<browser>` outside `#tabbrowser-tabpanels`                                   | Medium   | Phase 4 verification with rapid tab switching while panels are active. May need `gBrowser._switcher = null` when any panel is hosted, or guard against switcher state.                                                                                                                                                                                                                                           |
| Session restore loses the panel-rooted tab on next launch                                                                                         | **High** | Phase 4 explicit test: launch with a panel, quit cleanly, relaunch. Sessionstore writes tab state via `tab.linkedBrowser.permanentKey` — `_swapBrowserDocShells` swaps `permanentKey`, so it should follow our `newBrowser`. Verify.                                                                                                                                                                             |
| Devtools refuses to attach to a panel browser that isn't `gBrowser.selectedBrowser`                                                               | Medium   | Phase 4 test with right-click → Inspect on a panel page. Devtools resolves the docShell via `tab.linkedBrowser` (which we correctly point at `newBrowser`); should work. If it fails, Cmd+Option+I from a panel may need explicit retargeting.                                                                                                                                                                   |
| Hidden tab counts toward various tab-count limits / lifecycle behaviors                                                                           | Low      | `tab.hidden = true` is Mozilla's supported API; well-trodden by multi-account-containers.                                                                                                                                                                                                                                                                                                                        |
| Cross-origin navigation in a panel changes remoteness, breaking the swapped state                                                                 | Medium   | Mozilla's remoteness change creates a new browser inside the panel wrapper. Since our `newBrowser` IS that wrapper-equivalent for the tab now, remoteness change should rebuild it in place. Phase 4 verification with web → about:config navigation.                                                                                                                                                            |
| `_swapBrowserDocShells` is private API (leading underscore)                                                                                       | Low      | Stable since Firefox 78+. Mozilla uses it for their own swap-windows feature. Same risk profile as the `linkedBrowser` mutation above.                                                                                                                                                                                                                                                                           |
| Panel reorder still triggers reload                                                                                                               | Low      | Existing in-place CSS-`order` reorder doesn't move DOM. Document survives reorder.                                                                                                                                                                                                                                                                                                                               |

## Estimated effort

The swap-with-linkedBrowser-reassignment approach (the chosen mechanism) sits between the original swap-only estimate and the rejected reparent estimate:

- Phase 1: 2–3 days (swap+reassign mechanism, progress-listener rebind, isolated smoke test). The mechanism is proven via the v4 probe; engineering it cleanly takes a real chunk of work.
- Phase 2: 1–2 days (wire reconciler; tear down the parallel-browser path under the pref; promote/demote round-trip in the real flow).
- Phase 3: 1 day (workspace switch handling — multiple swap+reassign per switch is the main work).
- Phase 4: 2–3 days (edge case bash, especially session restore + remoteness change + tab switcher interactions).
- Phase 5: 1 day (accelerator retargeting — independent of mechanism).

Total: **7–10 days** of focused work. Same as the original estimate. The probe results don't shorten the work; they just confirm the right mechanism upfront so we don't waste days on a dead-end.

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

Resolved (via the v2/v3/v4 probe sequence):

- ~~Does `tabpanels.appendChild(panelFromOurHost)` cleanly reparent without reload?~~ **No**, v2 confirmed. Reparenting the panel destroys frame loader + content document.
- ~~Does moving the `<browser>` element directly preserve the document?~~ **No**, v3 confirmed. `connectedMoveCallback` preserves frame loader but content document still dies.
- ~~Does `_swapBrowserDocShells` + manual `linkedBrowser` reassignment preserve the document?~~ **Yes**, v4 confirmed. `contentTitle` and `currentURI` survived; `getTabForBrowser` returned the right tab. Mechanism is viable.

Still open:

1. **Progress-listener rebind**: v4 surfaced an `NS_ERROR_FAILURE` on the demote-side `_swapBrowserDocShells` because the listener was attached to the old browser. Phase 1 needs an explicit "move TabProgressListener" helper. Investigate whether it's safe to grab `gBrowser._tabFilters.get(tab)` + `gBrowser._tabListeners.get(tab)`, detach from oldBrowser.webProgress, re-attach to newBrowser.webProgress, without disrupting tabbrowser's tracking.
2. **Tab switcher interactions**: when does `gBrowser._switcher` activate, and what happens if the activated tab's `linkedBrowser` is in our panel host? Verify in Phase 4.
3. **`gBrowser.selectedTab` semantics for hidden tabs**: when the user closes the currently-selected tab and Firefox needs to pick a new selectedTab, does it skip `tab.hidden = true` tabs (= our panels)? If yes, good. If no, our panels could become "selected" which would do who-knows-what.
4. **Cmd+W on a panel-hosted tab**: close the tab (= remove the panel + close)? Or demote and keep? Likely former. Confirm UX.
5. **Session restore round-trip**: launch with a panel, quit, relaunch. Sessionstore writes via `tab.linkedBrowser.permanentKey` which should follow our newBrowser. Verify.
6. **Cross-origin navigation triggering remoteness change**: the panel browser may need to be recreated by Firefox in place. Test web → about:config navigation in a panel.

## Out of scope

- Tab tear-out (drag panel to a new window). Useful, but separate work and not blocking.
- Multi-window support for panels. Each window has its own panel set today; that stays.
- Panel content saved without a backing tab (the "ghost panel" idea). Not part of this plan.
