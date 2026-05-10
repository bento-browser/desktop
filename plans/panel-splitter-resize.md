# Panel splitter / resize — follow-up plan

After Phase 5 of [bento-spaces-split-view-panels.md](bento-spaces-split-view-panels.md) deleted the legacy parallel-browser reconciler and its JS-driven splitter machinery, three UX gaps surfaced in split-view-only mode:

1. **No visible / draggable splitter between panels.** Firefox's split-view-splitter only appears between col 0 and col 1, has per-tab resize semantics that don't match Bento's strip model, and offers nothing past col 1.
2. **Resize-by-drag squeezes other panels** instead of pushing them along the strip's horizontal scroll. This is Firefox's flex-shrink-by-default behaviour at the splitter boundary.
3. **Main slot width is per-tab, not universal.** Firefox writes the resize result to the col-0 notificationbox's `width` attribute. Each tab has its own col-0 notificationbox. Switching tabs reveals a different col-0 with its own width.

Firefox's splitter is intentionally hidden via CSS in [src/browser/base/content/bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js) (`#tabbrowser-tabpanels[splitview] > .split-view-splitter { display: none; }`) because un-hiding it makes (2) and (3) visible without giving us multi-panel coverage.

## Goal

Per-pair draggable splitters that match the legacy reconciler's UX:

- Visible 6px col-resize bar between every pair of adjacent panels (main↔first, first↔second, …).
- Drag resizes the panel on the LEFT of the splitter only. The strip widens / narrows by the drag delta; right-side panels shift along the horizontal scroll without changing their own widths.
- Main slot width is **universal across tabs** — drag once, all tabs see the new main width.

## Approach

The legacy implementation that did this lived at the deleted `createPanelSplitter` / `startPanelDrag` / `onPanelDragMove` / `endPanelDrag` / `setMainSize` / `unsetMainSize` / `lockMainIfNeeded` helpers. Resurrecting them isn't quite right — those targeted the legacy host vbox and per-tab `<browser>` elements, neither of which exist in split-view mode.

Adapted approach for split-view:

1. **Inject splitter elements as siblings of split-view panels.** After `reconcilePanelsSplitView` lays out the panels in `#tabbrowser-tabpanels`, walk adjacent `[data-bento-panel-tab-id]` / `[data-bento-main-panel]` pairs and insert a `<hbox class="bento-panel-splitter">` between each. The splitter goes at an odd CSS `order` slot (1, 3, 5, …) so it falls between the panels' even orders (0, 2, 4, …).

2. **Drag handler updates the LEFT panel's CSS width.** For side panels, set `style.width = N + 'px'` on the `.split-view-panel-active` notificationbox. For the main panel (col 0), the width needs to apply universally — see (4).

3. **`flex: 0 0 auto` + explicit width** on each panel container so flex doesn't redistribute. `#tabbrowser-tabpanels.bento-split-active` already has `overflow-x: auto` so the strip scrolls horizontally past viewport width.

4. **Universal main width across tabs.** Two options:
   - **Apply to tabbox container**: the main slot is `#tabbrowser-tabbox`. If we set `style.width` there, all tabs share it. Need to verify Firefox's split-view layout respects it (vs Firefox setting per-tab widths).
   - **Sync across tabs**: track the desired main width in JS state, re-apply to the active tab's col-0 notificationbox on every TabSelect. Simpler but causes a brief flash on tab switch.
   - Likely option 1; fallback to 2 if Firefox overrides the container width.

5. **Pointer capture for cross-process drags.** Same `setPointerCapture` pattern as the legacy implementation — required because the cursor crosses into remote `<browser>` content during drag and chrome wouldn't see pointermove without capture.

6. **Splitter cleanup on panel close / reconcile.** Reuse / re-inject splitters as panels come and go. Idempotent walk after every reconcile, similar to the legacy `reconcilePanels` rebuild-trailer pattern.

## Open questions

- Does Firefox's split-view layout reject CSS-set widths on the col-0 notificationbox? If so, we need to find the JS hook Firefox uses and patch it.
- Width persistence across browser restart: legacy used XUL `persist="width"` on the host vbox. Split-view notificationboxes don't have that. Either persist via `Services.prefs` or accept session-only widths.
- Drag interaction with Bento's custom horizontal scrollbar (`#bento-strip-scrollbar`): the scrollbar tracks `tabpanels.scrollLeft`. Resizing should update the scrollbar's thumb size on `pointerup`.

## Effort estimate

Half a day for the basic splitter + drag flow. Another half-day if (4) requires a Firefox patch instead of a CSS-only fix. Total: 0.5–1 day.

## Related

- The deletion that surfaced this: commit landing Phase 5 of [bento-spaces-split-view-panels.md](bento-spaces-split-view-panels.md).
- The hidden splitter CSS rule lives at `#tabbrowser-tabpanels[splitview] > .split-view-splitter { display: none; }` in [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js).
- AMO install popup ("Add to Firefox" doesn't show the permissions confirmation popper inside a panel) is a separate, more involved problem — popups anchor to chrome surfaces (urlbar / addons icon) that panels don't expose. Tracked separately.
