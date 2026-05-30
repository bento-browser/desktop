# Flat Panels With Layout-Only Containers

## Summary

Replace the current nested subdivision model with a flat panel identity model plus a separate logical layout tree. Every visible panel tab remains a first-class panel in the workspace. Layout groups describe how those panels are arranged, but groups do not own panel identity and do not require live `<browser>` hosts to be nested inside other panel hosts.

Chosen defaults:

- Use logical layout containers, not physical browser-parent containers.
- Preserve the current visual depth cap: one vertical subdivision, with optional horizontal split groups in either half.
- Add a compatibility bridge **at the persistence/export boundary only**: migrate old persisted v4 subdivisions into the new layout model on load. The protocol/action layer is _not_ bridged — old fields and actions are removed in lockstep with the chrome rewrite, since chrome and tools ship in the same build [^1].

## Core Invariants

- A live Firefox panel host/notificationbox must stay a direct, stable child of `gBrowser.tabpanels`.
- No live panel host should be appended into another panel host.
- Layout-only containers may exist in store/protocol/chrome overlay DOM, but they must not contain live browser elements.
- A layout-only operation must never call initial-content loading for an already-live panel.
- If a panel remains in the layout, its `<browser>` should retain `frameLoader`, `browsingContext`, `docShellIsActive`, and compositor layers.
- Menu state must be derived from the layout tree, not from DOM ancestry.

## New Data Model

Add a new pure layout module:

`extensions/bento-tools/src/panels/PanelLayout.ts`

Define types that **encode the depth cap structurally** so malformed trees are
unrepresentable rather than merely rejected at runtime [^1]:

```ts
export type RootNode = PanelLeafNode | VerticalGroupNode;

/** Bottom region of a vertical subdivision. */
export type VerticalBottomNode = PanelLeafNode | ChooserNode | HorizontalGroupNode;

export interface PanelLeafNode {
  kind: 'panel';
  tabId: number;
}

export interface VerticalGroupNode {
  kind: 'group';
  axis: 'vertical';
  id: string;
  ratio: number;
  /** Top is always a live panel; bottom is panel | chooser | horizontal split. */
  children: [PanelLeafNode, VerticalBottomNode];
}

export interface HorizontalGroupNode {
  kind: 'group';
  axis: 'horizontal';
  id: string;
  ratio: number;
  /** Horizontal groups hold exactly two panel leaves — no nested groups. */
  children: [PanelLeafNode, PanelLeafNode];
}

export interface ChooserNode {
  kind: 'chooser';
  id: string;
  ownerTabId: number;
}

export interface WorkspacePanelLayout {
  root: RootNode[];
}
```

`PanelLayoutStatus` (the per-panel menu/navigator status union) is **not** defined
here — it is defined in `extensions/_shared/protocol.ts` and imported by this module,
because it crosses the protocol boundary and `@bento/tools` depends on `@shared`, not
the reverse [^1].

Depth rules (now mostly enforced by the types above; normalization enforces the rest):

- `root` may contain `panel` or `vertical group` (`RootNode`).
- A `vertical group`'s top child is always a `panel`; its bottom child is `panel`,
  `chooser`, or `horizontal group` (`VerticalBottomNode`).
- A `horizontal group` may contain only two `panel` leaves.
- No group inside a horizontal group; no vertical group inside another group — both
  guaranteed by the type definitions.
- Normalize immediately after every mutation so one-child/empty groups cannot persist.

## Store Changes

Refactor `extensions/bento-tools/src/panels/PanelStore.ts` around three separate concerns:

- `#layoutByWorkspace: Map<string, WorkspacePanelLayout>`
- `#widthByTabId: Map<number, number>`
- existing main width, strip scroll, listeners, pinned-panel cleanup

Replace nested subdivision ownership helpers with layout-tree helpers:

```ts
getPanelIds(workspaceId): number[]
getVisiblePanelIds(workspaceId): number[]
containsPanel(workspaceId, tabId): boolean
getPanelLayoutStatus(workspaceId, tabId): PanelLayoutStatus
canSubdivide(workspaceId, tabId): boolean
canBreakOut(workspaceId, tabId): boolean
```

`PanelLayoutStatus` (defined in `_shared/protocol.ts`, imported here) includes:

- `root-panel`
- `subdivision-top`
- `subdivision-bottom`
- `split-child`
- `chooser-owner`
- `unknown`

Tools is the **sole deriver** of status: chrome consumes `panelStatusByTabId` from the
sync payload and must not recompute status by walking `layout` itself, so the two never
diverge [^1].

### Existing method → layout-tree replacement

Every current public method on `PanelStore` must map to a layout-tree replacement so
callers in `background.ts` and the protocol handler don't break silently [^1]:

| Current method                          | Replacement                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `getPanels`                             | `getVisiblePanelIds` (filters layout leaves; no more `allSubPanelTabIds` exclusion)       |
| `add` / `insertAt`                      | insert `panel(tabId)` into `root` at end / at slot                                        |
| `remove`                                | remove leaf from layout, normalize ancestors, drop width if orphaned                      |
| `removeWithSubPanels`                   | `remove` leaf + collect now-orphaned descendant leaves from the subtree to close          |
| `promoteSubPanelsWhenRemovingParent`    | remove top panel + promotion normalization (single → panel, horizontal → two root panels) |
| `removeWorkspace`                       | drop layout for workspace, return all descendant leaf tabIds to close                     |
| `reorder`                               | reorder `root` nodes (permutation check over root-node identities)                        |
| `getSubdivision` / `getAllSubdivisions` | removed; replaced by `getPanelLayout(workspaceId)`                                        |
| `allSubPanelTabIds`                     | removed; layout leaves are all first-class panels                                         |
| `findParentOfSubPanel`                  | `findContainingGroup(workspaceId, tabId)` (layout walk)                                   |
| `isFullSlotSubPanel`                    | folded into `getPanelLayoutStatus` (`subdivision-bottom`/`split-child`)                   |
| `subdivide`                             | replace `panel` with `vertical(panel, chooser)` if `canSubdivide`                         |
| `fillSubdivision`                       | replace `chooser` with `panel(new)` or `horizontal(panel, panel)`                         |
| `removeSubdivision`                     | collapse `vertical group` to its top panel, return bottom leaves to close                 |
| `closeSubdivisionTop`                   | **removed** — normal leaf removal + promotion normalization (see Protocol Changes)        |
| `breakOutSubPanel`                      | move leaf to root after its containing root slot, normalize old group                     |
| `removeSubPanelTab`                     | remove leaf from group, normalize                                                         |
| `setSubdivisionHeight`                  | set vertical group `ratio`                                                                |
| `setSubdivisionSplitRatio`              | set horizontal group `ratio`                                                              |

Mutation behavior:

- `add` / `insertAt`: insert `panel(tabId)` into `root`.
- `remove`: remove the panel leaf from the layout, normalize ancestors, delete width if no workspace owns it.
- `subdivide`: replace eligible `panel(tabId)` with `vertical(group(panel(tabId), chooser(ownerTabId: tabId)))`.
- `fillSubdivision`: replace the chooser with either `panel(newTab)` or `horizontal(group(panel(left), panel(right)))`.
- `breakOutSubPanel`: move the selected leaf to the root after its containing root slot, then normalize the old group.
- `tab closed`: remove that leaf from every layout, normalize, emit removed listeners.
- `close top panel`: no hidden `topClosed` state. Closing the top panel removes that panel leaf and normalizes the remaining layout into visible root panels/groups.

Promotion normalization:

- If a vertical group loses its top panel and bottom is a single panel, replace the group with that panel.
- If a vertical group loses its top panel and bottom is a horizontal group, replace the group with the two horizontal child panels as adjacent root panels.
- Before flattening a horizontal group to root, preserve each child's measured width in `#widthByTabId`.
- If a group loses one child, replace it with the remaining child.
- If a chooser is left without its owner/top panel, remove it.

## Protocol Changes

Update `extensions/_shared/protocol.ts`.

Add the status union here (the canonical home — see New Data Model) [^1]:

```ts
export type PanelLayoutStatus =
  | 'root-panel'
  | 'subdivision-top'
  | 'subdivision-bottom'
  | 'split-child'
  | 'chooser-owner'
  | 'unknown';

export interface PanelLayoutSync {
  root: PanelLayoutSyncNode[];
}

export type PanelLayoutSyncNode =
  | { kind: 'panel'; tabId: number }
  | {
      kind: 'group';
      id: string;
      axis: 'vertical' | 'horizontal';
      ratio: number;
      children: [PanelLayoutSyncNode, PanelLayoutSyncNode];
    }
  | { kind: 'chooser'; id: string; ownerTabId: number };
```

Extend `panels/sync`:

```ts
layout?: PanelLayoutSync;
panelStatusByTabId?: Record<number, PanelLayoutStatus>;
```

**No protocol/action alias bridge.** Chrome and tools ship in the same build and
communicate in-process over title-IPC, so there is no version skew and no out-of-process
consumer of the old wire shape. The legacy `subdivisions?: Record<number, SubdivisionSync>`
field and the `panel/subdivide`, `panel/setSubdivisionContent`, `panel/setSubdivisionHeight`,
`panel/setSubdivisionSplitRatio`, `panel/breakOutSubPanel`, `panel/removeSubdivision`,
`panel/promoteSubdivisionParent`, and `panel/closeSubdivisionTop` actions are **removed in
the same change** that updates chrome (steps 4 + 8) rather than kept as aliases — keeping
them would be unreachable code that the reconciler still has to defend against [^1].

`panel/closeSubdivisionTop` has no replacement action: closing the top panel is just a
normal leaf removal plus layout normalization.

The **only** bridge retained is the persistence/export data migration below, which crosses
a restart/file boundary and therefore genuinely must read old shapes [^1].

## Persistence And Migration

This is the **only** retained compatibility bridge (the protocol/action bridge was
dropped — see Protocol Changes) [^1]. Update
`extensions/bento-tools/src/panels/Persistence.ts` to version 5. (Current on-disk version
is 4, with chained migrations from v1–v3 already present.)

Persist:

- flat panel URLs
- per-panel widths
- `panelLayout` as a URL-based tree
- main width and strip scroll as today

Migration from v4:

- A persisted panel without subdivision becomes `panel(url)`.
- A panel with empty subdivision becomes `vertical(panel(parent), chooser(parent))`.
- A panel with one sub-panel becomes `vertical(panel(parent), panel(child))`.
- A panel with two sub-panels becomes `vertical(panel(parent), horizontal(panel(left), panel(right)))`.
- Any in-memory `topClosed` state encountered during upgrade is normalized immediately: the hidden parent is removed and surviving children are flattened into the root in visual order.

Update export/import:

- Bump `BentoExportSchema.schemaVersion` to `2`.
- Export flat panel entries plus URL-based `panelLayout`.
- Import v1 by translating old `subdivision` objects to the v5 layout tree.

## Chrome Reconciler Changes

Refactor `src/browser/base/content/bento-shell-mount.js`.

> **Highest-risk area — validate with the spike (step 0) before building.** This plan
> calls `gBrowser.showSplitViewPanels(allLeafTabs)` **only** to keep every leaf's docShell
> active, then owns all 2-D geometry itself (vertical subdivision containing a nested
> horizontal split cannot come from Firefox's linear split-view flow). The open question:
> does Firefox's split-view layout re-flow and clobber Bento's inline rects on its own
> ticks (the existing `showSplitViewPanels` retry path at ~`:8650` already shows Firefox
> re-asserting state asynchronously)? The spike must prove the inline geometry **sticks**
> across a tab switch and a workspace switch. If it doesn't, the rendering model needs
> rethinking before steps 5–9 proceed [^1].

Create a new layout pipeline:

```js
sanitizePanelLayoutPayload(rawLayout, panels);
flattenPanelLayout(layout);
computePanelLayoutRects(layout, mainRect, viewport, widthByTabId);
applyPanelLayoutRects(rects);
applyPanelLayoutStatusAttributes(statusByTabId);
```

Rendering rules:

- Resolve every visible panel leaf to a live tab/panel host.
- Include main tab plus all visible panel tabs in the split-view active marker.
- Call `gBrowser.showSplitViewPanels()` only with direct tabpanels children.
- Do not pass logical groups/choosers to Firefox split-view.
- Position live panel hosts from computed rects using inline geometry, while keeping hosts direct under `tabpanels`.
- Add non-browser overlay elements for splitters, chooser buttons, drag targets, focus rings, and scroll extent.
- Remove use of `data-bento-subpanel` for steady-state live panels once layout mode is active.
- Delete the legacy nested-subdivision rendering path (and its `[data-bento-subdivision-top-closed]` / `data-bento-subdivided` CSS, ~10 selectors) in the same change — there is no protocol bridge keeping it reachable [^1].

Paint preservation:

- On any layout-only mutation, mark surviving panel tabs as preserved.
- Skip `ensurePanelInitialContent()` when current URL is real and the tab already has a live browser.
- Always keep surviving panel browsers in the active split marker before cleanup.
- Never remove/recreate a surviving panel header; update it in place.
- Before closing a panel that will cause promotion, capture affected panel rects and send widths to tools.

## Menu Semantics

Replace DOM-ancestry checks like `canSubdivideFromPanelHeader()` and `canBreakOutFromPanelHeader()` with layout-status checks from `panelStatusByTabId`.

Menu rules:

- `root-panel`: show `Subdivide panel`; hide `Break out this panel`.
- `subdivision-top`: hide `Subdivide panel`; hide `Break out this panel`.
- `subdivision-bottom`: hide `Subdivide panel`; show `Break out this panel`.
- `split-child`: hide `Subdivide panel`; show `Break out this panel`.
- After promotion/normalization to root, the same tab must become `root-panel`, so the menu shows `Subdivide panel`.
- If the tab already owns a chooser/group or would violate the depth cap, hide `Subdivide panel`.

## Navigator Semantics

Update navigator generation to read the layout tree:

- Root panel leaves render as individual icons.
- Vertical groups render as stacked icons while the group exists.
- Horizontal child panels promoted to root render as separate icons.
- No hidden parent/top panel may remain in the navigator after its panel tab is closed.
- Drag reorder operates on root layout nodes, not on hidden subdivision ancestry.

## Implementation Sequence

0. **Spike (de-risk first):** prove that `showSplitViewPanels(allLeafTabs)` for docShell-activation only + Bento-owned inline rects survives a tab switch and a workspace switch without Firefox re-flowing over the geometry. Do not proceed past step 4 until this holds [^1].
1. Add Vitest to `@bento/tools` (devDep + `test` script + minimal config); this is new test infra — the repo currently has no test runner [^1].
2. Add `PanelLayout.ts` with pure tree helpers, normalization, status derivation, flattening, and v4-to-v5 conversion.
3. Refactor `PanelStore` to own `layoutByWorkspace` and delegate all layout mutations to `PanelLayout.ts` (per the method-mapping table above).
4. Update persistence to v5 and migrate v4 on load.
5. Add `PanelLayoutStatus` + `layout` + `panelStatusByTabId` to protocol and **remove** the old subdivision field and actions in the same change (no aliases) [^1].
6. Update shell store filtering to derive panel exclusion from `layout`, not `subdivisions`.
7. Update chrome title-IPC parsing to read `layout`.
8. Implement logical layout rect computation and overlay splitters/choosers in `bento-shell-mount.js` (gated on the step-0 spike).
9. Switch header menus, navigator, keyboard cycling, focus rings, and close behavior to layout status.
10. Remove steady-state nested panel DOM usage and delete legacy `topClosed`, `isFullSlotSubPanel`, and nested-subdivision rendering/CSS.

## Test Cases

Add Vitest to the repo and test `PanelLayout.ts` as a pure module.

Unit tests:

- add/insert/remove root panels
- subdivide root panel into chooser
- fill chooser with single panel
- fill chooser with dual horizontal split
- remove top panel and promote single bottom panel to root
- remove top panel and flatten bottom horizontal split into two root panels
- preserve widths when flattening split children
- reject subdivision beyond the current depth cap
- derive correct `PanelLayoutStatus` before and after promotion
- break out split child and normalize remaining layout
- migrate v4 persisted subdivision shapes to v5 layout

Chrome/manual scenarios:

- Create top/bottom subdivision, close top, bottom panel does not refresh.
- Create bottom split, close top, both split panels become root panels, keep widths, keep content painted.
- Promoted panels show `Subdivide panel`, not `Break out this panel`.
- Split children inside an active layout show `Break out this panel`, not `Subdivide panel`.
- Repeated subdivide/split/remove cycles cannot exceed the depth cap.
- Panel navigator contains only visible panels/groups; no hidden top panel remains.
- Cmd+W and header close do not produce `linkedBrowser is null`, stale `splitViewPanels`, or blank panel states.
- Workspace switch preserves layout and panel paint.
- Restart restores v5 layout and migrated v4 layouts.

Verification commands:

- `pnpm --filter @bento/tools test` — run the new Vitest suite for `PanelLayout.ts` [^1]
- `pnpm --filter @bento/tools typecheck`
- `pnpm --filter @bento/shell typecheck`
- `pnpm --filter @bento/tools lint`
- `pnpm --filter @bento/shell lint`
- `pnpm run ext:build`
- `node --check src/browser/base/content/bento-shell-mount.js`

## Acceptance Criteria

- No live panel host is nested inside another panel host in steady state.
- Closing/removing any panel normalizes the layout tree immediately.
- Promoted panels are actual root layout panels, not hidden-parent descendants.
- Surviving panels do not reload, blank, or lose their live browser content during layout mutations.
- Menu items always match the panel's current layout status.
- Navigator state matches visible layout state exactly.
- Existing v4 persisted subdivision layouts load into the new model without data loss.

---

[^1]:
    **Revisions made by Claude (Opus 4.8) on 2026-05-30**, after scrutinising the
    original plan against the actual codebase (`PanelStore.ts`, `Persistence.ts`,
    `_shared/protocol.ts`, `bento-shell-mount.js`). Changes and rationale:

    1. **Relocated `PanelLayoutStatus` to `_shared/protocol.ts`.** The original defined it
       in `PanelLayout.ts` (`@bento/tools`) but used it in the protocol's `panels/sync`.
       `protocol.ts` imports nothing and `@bento/tools` depends on `@shared` (not the
       reverse), so the original would have inverted the dependency and failed to
       typecheck. The status union now lives in protocol and is imported by the tools
       module.
    2. **Dropped the protocol/action alias bridge.** Verified that the only runtime
       dispatchers of the old `panel/subdivide…` actions are `bento-shell-mount.js`
       (chrome) and the tools-side handler — both ship in the same build and talk
       in-process via title-IPC, so there is no version skew or external consumer. Keeping
       the old `subdivisions` field and actions as aliases would be unreachable code the
       reconciler still had to defend against (double-render risk). The old field/actions
       are now removed in lockstep with the chrome update. Only the persistence/export
       data migration (which crosses a restart/file boundary) is retained as a bridge.
    3. **Added a step-0 geometry spike.** The riskiest, least-specified part —
       Bento-owned inline rects over a flat `showSplitViewPanels` host list — was a single
       sub-bullet. The existing `showSplitViewPanels` retry path (~`:8650`) already shows
       Firefox re-asserting layout/docShell state asynchronously, so whether inline
       geometry survives a tab/workspace switch must be proven before the dependent steps
       are built.
    4. **Tightened the data-model types to encode the depth cap.** The original union
       allowed arbitrary group nesting and a chooser at root — shapes the prose forbade but
       the types permitted. Replaced with `RootNode` / `VerticalGroupNode` (top is always a
       panel) / `HorizontalGroupNode` (exactly two panel leaves) so the compiler enforces
       the invariants normalization would otherwise have to catch at runtime.
    5. **Made Vitest setup an explicit step and added a test-run verification command.**
       The repo has no test runner today; "Add Vitest" was buried in the test section and
       the verification list never actually ran the tests it specified.
    6. **Added an explicit existing-method → layout-replacement mapping table** so callers
       of `removeWithSubPanels`, `promoteSubPanelsWhenRemovingParent`, `removeSubPanelTab`,
       etc. (in `background.ts` and the protocol handler) are migrated rather than broken
       silently.
    7. **Named tools as the sole deriver of `panelStatusByTabId`** to prevent chrome and
       tools computing divergent status from the same `layout` tree.

    The plan's core direction (flat panel identity + logical layout tree, replacing the
    current model where sub-panel `<browser>` hosts are appended into parent panel hosts at
    `bento-shell-mount.js:4358`) was assessed as sound and was not changed.
