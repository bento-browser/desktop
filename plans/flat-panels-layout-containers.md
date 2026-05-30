# Flat Panels With Layout-Only Containers

## Summary

Replace the current nested subdivision model with a flat panel identity model plus a separate logical layout tree. Every visible panel tab remains a first-class panel in the workspace. Layout groups describe how those panels are arranged, but groups do not own panel identity and do not require live `<browser>` hosts to be nested inside other panel hosts.

Chosen defaults:

- Use logical layout containers, not physical browser-parent containers.
- Preserve the current visual depth cap: one vertical subdivision, with an optional horizontal split group in the bottom region.
- Add a compatibility bridge **at the persistence/export boundary only**: migrate old persisted v4 subdivisions into the new layout model on load. The protocol/action layer is _not_ bridged — old subdivision fields/action names are removed in lockstep with the chrome rewrite, and replaced by explicit layout actions in the same atomic change, since chrome and tools ship in the same build [^1] [^2].

## Core Invariants

- A live Firefox panel host/notificationbox must stay a direct, stable child of `gBrowser.tabpanels`.
- No live panel host should be appended into another panel host.
- Layout-only containers may exist in store/protocol/chrome overlay DOM, but they must not contain live browser elements.
- A layout-only operation must never call initial-content loading for an already-live panel.
- If a panel remains in the layout, its `<browser>` should retain `frameLoader`, `browsingContext`, `docShellIsActive`, and compositor layers.
- Menu state must be derived from tools-provided layout status, not from DOM ancestry.

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
getVisiblePanelIds(workspaceId): number[]   // all first-class panel leaves, flattened visual order
getRootNodeIds(workspaceId): string[]       // root-slot ordering/identity (reorder, navigator, restore slot)
containsPanel(workspaceId, tabId): boolean
getPanelLayoutStatus(workspaceId, tabId): PanelLayoutStatus
canSubdivide(workspaceId, tabId): boolean
canBreakOut(workspaceId, tabId): boolean
getPanelRestoreLocation(workspaceId, tabId): PanelRestoreLocation
getPanelPersistenceSnapshot(workspaceId): PanelPersistenceSnapshot
```

These three answer **distinct** questions and are not interchangeable: `getVisiblePanelIds`
is the flat _membership/iteration_ set (now includes former sub-panels, since every leaf is
first-class); `getRootNodeIds` is the _positional/slot_ axis (root nodes, where a vertical
group occupies one slot); `containsPanel` is the membership predicate. The earlier
`getPanelIds` helper was dropped — it duplicated `getVisiblePanelIds` and was referenced
nowhere [^7].

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

Root-node identity for reorder:

- A panel root's identity is `panel:${tabId}`.
- A group root's identity is its stable `group.id`.
- Reorder actions carry root-node identities, not only tab IDs, because a vertical group
  is a draggable root item but has no single tab ID that represents the whole root slot [^2].

Return types for the two new helpers (tools-internal; `PanelRestoreLocation` is also the
payload persisted in the v2 session marker — see Implementation Sequence step 6) [^5] [^6]:

```ts
export interface PanelRestoreLocation {
  workspaceId: string;
  /** Root slot the panel (or its containing root node) occupied when closed. */
  rootIndex: number;
  /** Identity of the containing root node at close time. On restore, if this
   *  root node still exists, insert the panel immediately after it; otherwise
   *  fall back to a clamped `rootIndex`. Never reconstruct a deleted group.
   *  Group ids are per-session (see [^3]), so cross-restart restores will miss
   *  this and use `rootIndex` — acceptable, since full layout restore (not the
   *  marker) owns the cross-restart path. */
  containingRootNodeId?: string;
}

export type PanelPersistenceRootNode =
  | PanelPersistencePanelNode
  | PanelPersistenceVerticalGroupNode;

export type PanelPersistenceVerticalBottomNode =
  | PanelPersistencePanelNode
  | PanelPersistenceChooserNode
  | PanelPersistenceHorizontalGroupNode;

export interface PanelPersistencePanelNode {
  kind: 'panel';
  panelKey: string;
}

export interface PanelPersistenceVerticalGroupNode {
  kind: 'group';
  axis: 'vertical';
  id: string;
  ratio: number;
  children: [PanelPersistencePanelNode, PanelPersistenceVerticalBottomNode];
}

export interface PanelPersistenceHorizontalGroupNode {
  kind: 'group';
  axis: 'horizontal';
  id: string;
  ratio: number;
  children: [PanelPersistencePanelNode, PanelPersistencePanelNode];
}

export interface PanelPersistenceChooserNode {
  kind: 'chooser';
  id: string;
  ownerPanelKey: string;
}

export interface PanelPersistenceWorkspaceLayout {
  root: PanelPersistenceRootNode[];
}

export interface PanelPersistenceSnapshot {
  /** Deterministic, ordered keyed entries — the SINGLE source of `panelKey`
   *  assignment, consumed by BOTH PanelStore and PinnedPanelsStore persistence
   *  so their keys match. The two persisters currently debounce independently
   *  and each owns its own storage key; they must NOT mint `panelKey`s
   *  independently. If a shared snapshot can't be threaded through both, the
   *  duplicate-URL pinned-panel case is the documented non-goal below. */
  entries: Array<{ panelKey: string; tabId: number; url: string; widthPx?: number }>;
  /** The layout tree with leaves rewritten from `tabId` to `panelKey`. */
  layout: PanelPersistenceWorkspaceLayout;
}
```

### Existing method → layout-tree replacement

Every current public method on `PanelStore` must map to a layout-tree replacement so
callers in `background.ts` and the protocol handler don't break silently [^1]:

| Current method                          | Replacement                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getPanels` (top-level only today)      | **split by use** — membership/iteration → `getVisiblePanelIds` (all leaves); slot/position → `getRootNodeIds` + `PanelRestoreLocation`. NOT a drop-in rename (see note below) |
| `add` / `insertAt`                      | insert `panel(tabId)` into `root` at end / at slot                                                                                                                            |
| `remove`                                | remove leaf from layout, normalize ancestors, drop width if orphaned                                                                                                          |
| `removeWithSubPanels`                   | `remove` leaf + collect now-orphaned descendant leaves from the subtree to close                                                                                              |
| `promoteSubPanelsWhenRemovingParent`    | remove top panel + promotion normalization (single → panel, horizontal → two root panels)                                                                                     |
| `removeWorkspace`                       | drop layout for workspace, return all descendant leaf tabIds to close                                                                                                         |
| `reorder`                               | `reorderRootNodes(workspaceId, rootNodeIds)` (permutation over root-node identities)                                                                                          |
| `getSubdivision` / `getAllSubdivisions` | removed; replaced by `getPanelLayout(workspaceId)`                                                                                                                            |
| `allSubPanelTabIds`                     | removed; layout leaves are all first-class panels                                                                                                                             |
| `findParentOfSubPanel`                  | `findContainingGroup(workspaceId, tabId)` (layout walk)                                                                                                                       |
| `isFullSlotSubPanel`                    | folded into `getPanelLayoutStatus` (`subdivision-bottom`/`split-child`)                                                                                                       |
| `subdivide`                             | replace `panel` with `vertical(panel, chooser)` if `canSubdivide`                                                                                                             |
| `fillSubdivision`                       | replace `chooser` with `panel(new)` or `horizontal(panel, panel)`                                                                                                             |
| `removeSubdivision`                     | collapse `vertical group` to its top panel, return bottom leaves to close                                                                                                     |
| `closeSubdivisionTop`                   | **removed** — normal leaf removal + promotion normalization (see Protocol Changes)                                                                                            |
| `breakOutSubPanel`                      | move leaf to root after its containing root slot, normalize old group                                                                                                         |
| `removeSubPanelTab`                     | remove leaf from group, normalize                                                                                                                                             |
| `setSubdivisionHeight`                  | set vertical group `ratio`                                                                                                                                                    |
| `setSubdivisionSplitRatio`              | set horizontal group `ratio`                                                                                                                                                  |

**`getPanels` is not a simple rename.** Today it returns _top-level panels only_
(`PanelStore.ts:184` filters out `allSubPanelTabIds`), so its indices are a contiguous
root-slot axis. In the flat model `getVisiblePanelIds` returns _every_ leaf (former
sub-panels included), so a naive swap silently corrupts any call site that treats the result
positionally. Audit each `getPanels` caller and route it deliberately [^7] [^8]:

- **Positional/slot** — any call site that computes an index from `getPanels()` or
  writes/reads panel markers must move to root-slot identity (`getRootNodeIds` /
  `PanelRestoreLocation`), not an index into the flattened leaf list. This includes
  `promoteLeftmostPanelBeforeMainClose` rollback (`protocol-handler.ts:67–78`),
  `panel/openAt` after-source insertion (`protocol-handler.ts:625–653`), add-as-panel
  source insertion (`background.ts:891–894`), v2 marker write/restore
  (`background.ts:990–1007`), and opener-created panel insertion
  (`background.ts:1048–1051`). Otherwise a workspace with any group restores or inserts
  panels to the wrong root slot [^8].
- **Membership/iteration** — e.g. `new Set(getPanels(ws))` for "is this tab a panel,"
  close-all, and cleanup sweeps want the all-leaves set (`getVisiblePanelIds`), which is the
  intended behavior change (sub-panels are now first-class).
- **Promotion selection** — call sites that currently promote `getPanels(ws)[0]` when a
  workspace has no normal tabs left must choose the first visible leaf in layout order, then
  normalize the source group. Do not accidentally promote a group id or root slot placeholder.

**The positional list above is exhaustive for index-derived root-slot writes, not for every
`getPanels` caller with positional meaning** (verified against all 17 current `getPanels`
callers): the only index-deriving sites are `protocol-handler.ts:67, 625` and
`background.ts:891, 990, 1048`. The remaining callers are not all interchangeable
membership reads. Watch the mixed-role sites that use `getPanels` for membership and then
also select/promote/predicate from that same list — migrating one half silently breaks the
other [^9] [^10]:

- `closeMainTabWithPanelPromotion` (`protocol-handler.ts:98–108`) — the membership `Set`
  (`:99`, → `getVisiblePanelIds`, now excluding former sub-panels from "normal tabs") **and**
  the `panelTabIds[0]` promotion pick (`:108`, → first visible leaf in layout order).
- `cleanupWorkspaceAfterTabMove` (`protocol-handler.ts:148–158`) — the membership `Set`
  (`:149`, → `getVisiblePanelIds`) **and** the `panelTabIds[0]` fallback promotion pick
  (`:158`, → first visible leaf in layout order).
- the last-normal-tab close path (`background.ts:1199–1224`) — the membership `Set`
  (`:1200`, → `getVisiblePanelIds`) **and** the `panelTabIds[0]` promotion pick
  (`:1224`, → first visible leaf in layout order).
- the subdivide-eligibility check (`protocol-handler.ts:732`) — `panelList.includes(tabId)`
  **plus** its `isFullSlotSubPanel` branch both collapse into a single `containsPanel`/status
  check, since every leaf is now first-class.

**Current full classification as of 2026-05-30** (all 17 current `PanelStore.getPanels`
callers; re-run the `rg "\.getPanels\(" extensions/bento-tools/src` audit if call sites
change): 5 root-slot writes + 3 promotions + 1 predicate (the eight above) + 8 pure
membership/iteration that take `getVisiblePanelIds`/`containsPanel` unchanged
(`background.ts:204, 600, 629, 1329`; `protocol-handler.ts:366, 435, 684`;
`BackupStore.ts:67`). **Trap:** `background.ts:600` and `:1329` contain a `wsTabs[0]` pick,
but `wsTabs` is the _non-panel_ tab list there (`getPanels` is only the exclusion `Set`), so
they are membership sites, **not** promotion sites — do not re-route them [^11] [^12].

Mutation behavior:

- `add` / `insertAt`: insert `panel(tabId)` into `root`.
- `remove`: remove the panel leaf from the layout, normalize ancestors, delete width if no workspace owns it.
- `subdivide`: replace eligible `panel(tabId)` with `vertical(group(panel(tabId), chooser(ownerTabId: tabId)))`.
- `fillSubdivision`: replace the chooser with either `panel(newTab)` or `horizontal(group(panel(left), panel(right)))`.
- `breakOutSubPanel`: move the selected leaf to the root after its containing root slot, then normalize the old group.
- `tab closed`: remove that leaf from every layout, normalize, emit removed listeners.
- `close top panel`: no hidden `topClosed` state. Closing the top panel removes that panel leaf and normalizes the remaining layout into visible root panels/groups.
- `Cmd+Shift+T` restore: use `PanelRestoreLocation` from the last marker to restore as a
  root panel at the recorded root slot, or immediately after the still-existing containing
  root node. Do not try to reconstruct a deleted nested group from a session marker [^4].

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

export type PanelLayoutFillMode = 'single' | 'dual';

export interface PanelLayoutSync {
  root: PanelLayoutSyncRootNode[];
}

export type PanelLayoutSyncRootNode = PanelLayoutSyncPanelNode | PanelLayoutSyncVerticalGroupNode;

export type PanelLayoutSyncVerticalBottomNode =
  | PanelLayoutSyncPanelNode
  | PanelLayoutSyncChooserNode
  | PanelLayoutSyncHorizontalGroupNode;

export interface PanelLayoutSyncPanelNode {
  kind: 'panel';
  tabId: number;
}

export interface PanelLayoutSyncVerticalGroupNode {
  kind: 'group';
  id: string;
  axis: 'vertical';
  ratio: number;
  children: [PanelLayoutSyncPanelNode, PanelLayoutSyncVerticalBottomNode];
}

export interface PanelLayoutSyncHorizontalGroupNode {
  kind: 'group';
  id: string;
  axis: 'horizontal';
  ratio: number;
  children: [PanelLayoutSyncPanelNode, PanelLayoutSyncPanelNode];
}

export interface PanelLayoutSyncChooserNode {
  kind: 'chooser';
  id: string;
  ownerTabId: number;
}
```

Replace the legacy `subdivisions` field on `panels/sync` with required layout/status
fields:

```ts
layout: PanelLayoutSync;
panelStatusByTabId: Record<number, PanelLayoutStatus>;
```

Both fields are required on every `panels/sync` event. Empty workspaces send
`layout: { root: [] }` and `panelStatusByTabId: {}`. Keeping these optional would let the
producer or `BENTO_PANELS` relay omit the new contract while still typechecking, which is
exactly the failure mode the producer→relay→consumer audit is meant to prevent [^16].

Add replacement layout actions:

```ts
| { type: 'panelLayout/subdivide'; tabId: number }
| { type: 'panelLayout/fillChooser'; chooserId: string; mode: PanelLayoutFillMode; urls: string[] }
| { type: 'panelLayout/breakOut'; tabId: number }
| { type: 'panelLayout/removeVerticalGroup'; groupId: string; closeDelayMs?: number }
| { type: 'panelLayout/setGroupRatio'; groupId: string; ratio: number }
| { type: 'panelLayout/reorderRoot'; rootNodeIds: string[] }
```

`panelLayout/fillChooser` creates new real tabs. Every created tab must be assigned eagerly
to the active workspace, inserted into the layout as a first-class panel leaf, given the
default panel width when configured, included in panel marker sync, and included in the
next `panels/sync` payload. Otherwise the React sidebar and Cmd+Shift+T restore path can
see an orphan tab that is visually a panel but not workspace-owned [^4].

`panelLayout/removeVerticalGroup` accepts only vertical group IDs. Horizontal groups have
no standalone "remove group" command; they collapse through leaf removal, break-out, or
normalization after the containing vertical group changes [^4].

**No protocol/action alias bridge.** Chrome and tools ship in the same build and
communicate in-process over title-IPC, so there is no version skew and no out-of-process
consumer of the old wire shape. The legacy `subdivisions?: Record<number, SubdivisionSync>`
field and the `panel/subdivide`, `panel/setSubdivisionContent`, `panel/setSubdivisionHeight`,
`panel/setSubdivisionSplitRatio`, `panel/breakOutSubPanel`, `panel/removeSubdivision`,
`panel/promoteSubdivisionParent`, and `panel/closeSubdivisionTop` actions are **removed in
the same atomic change** that adds the `panelLayout/*` actions and updates chrome dispatch
sites, rather than kept as aliases — keeping them would be unreachable code that the
reconciler still has to defend against [^1] [^2].

`panel/closeSubdivisionTop` has no replacement action: closing the top panel is just a
normal leaf removal plus layout normalization. If that close will promote bottom leaves,
chrome captures each surviving leaf's current rect and dispatches existing `panel/setWidth`
updates before dispatching `tab/close`.

The **only** bridge retained is the persistence/export data migration below, which crosses
a restart/file boundary and therefore genuinely must read old shapes [^1].

## Persistence And Migration

This is the **only** retained compatibility bridge (the protocol/action bridge was
dropped — see Protocol Changes) [^1]. Update
`extensions/bento-tools/src/panels/Persistence.ts` to version 5. (Current on-disk version
is 4, with chained migrations from v1–v3 already present.)

Persist:

- flat panel entries, each carrying a `panelKey`, a URL, and an optional width
- `panelLayout` as a `panelKey`-based tree
- pinned panel references as keyed panel references, not URL-only references
- main width and strip scroll as today

Do **not** key persisted/exported layout leaves by URL alone. Duplicate panel URLs are
valid; URL is only the content address used to match or create a tab during restore.
`panelKey` is the layout identity, and URL **and width** are data attached to keyed panel
entries [^2].

The same duplicate-URL rule applies to pinned panels. Version pinned-panel persistence and
backup/export/import so a pin references the keyed panel entry for the same snapshot
(`panelKey` plus workspace), with URL retained only as a v1 migration/fallback field. If
the implementation cannot write panel and pinned-panel snapshots from a shared
`PanelPersistenceSnapshot`, duplicate-URL pinned panels remain lossy and must be called out
as an explicit non-goal before implementation [^4].

`panelKey` is a **snapshot-local** join token, not a cross-session-stable per-tab ID, and
it is **not** stored on the live tab. The runtime layout tree continues to key leaves by
`tabId` (see `PanelLeafNode`); persistence converts the `tabId` tree → `panelKey` tree on
write, and on restore binds each entry's `panelKey` → a live `tabId` via the existing
URL-consuming match (`background.ts:104`), then rebuilds the runtime `tabId` tree. The key
only needs to be unique _within one persisted snapshot_ — enough to disambiguate duplicate
URLs and join the entries list to the tree. Group `id`s are likewise minted per session and
do not need to survive restart [^3].

Migration from v4:

- Assign deterministic workspace-local keys to every v4 parent panel and sub-panel in
  visual order.
- A persisted panel without subdivision becomes `panel(panelKey)`.
- A panel with empty subdivision becomes `vertical(panel(parentKey), chooser(ownerPanelKey: parentKey))`.
- A panel with one sub-panel becomes `vertical(panel(parentKey), panel(childKey))`.
- A panel with two sub-panels becomes `vertical(panel(parentKey), horizontal(panel(leftKey), panel(rightKey)))`.
- v4 does not persist `topClosed` as an explicit boolean. Treat `topHeightFraction <= 0`
  with one or more sub-panel URLs as the old top-closed shape, then normalize immediately:
  remove the hidden parent and flatten surviving children into the root in visual order [^2].

Update export/import:

- Bump `BentoExportSchema.schemaVersion` in `extensions/_shared/protocol.ts` to `2`.
- Export flat keyed panel entries plus `panelKey`-based `panelLayout`.
- Export pinned panels by keyed panel reference, with URL fallback only for v1 import.
- Update both import validators to accept v1 and v2: the tools validator
  (`extensions/bento-tools/src/backup/ExportSchema.ts`) and the Settings UI preflight
  validator (`extensions/bento-shell/src/features/Settings/validateExport.ts`). The shell
  validator gates file-import preview before tools sees the payload, so updating only tools
  would still reject v2 imports in the UI [^16].
- Import v1 by translating old `subdivision` objects to the v5 layout tree.

## Chrome Reconciler Changes

Refactor `src/browser/base/content/bento-shell-mount.js`.

> **Highest-risk area — validate with the spike (step 0) before the
> protocol/rendering teardown.** This plan
> calls `gBrowser.showSplitViewPanels(allLeafTabs)` **only** to keep every leaf's docShell
> active, then owns all 2-D geometry itself (vertical subdivision containing a nested
> horizontal split cannot come from Firefox's linear split-view flow). The open question:
> does Firefox's split-view layout re-flow and clobber Bento's inline rects on its own
> ticks (the existing `showSplitViewPanels` retry path at ~`:8650` already shows Firefox
> re-asserting state asynchronously)? The spike must prove the inline geometry **sticks**
> across a tab switch, workspace switch, panel focus/click, splitter resize, strip-scroll
> restore, and a layout mutation that promotes a child to root. If it doesn't, the
> rendering model needs rethinking before the atomic protocol/rendering pass (steps 7,
> 10–12) proceeds [^1] [^5] [^6].

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
- Before closing a panel that will cause promotion, capture affected panel rects and send widths to tools via `panel/setWidth`.

## Menu Semantics

Replace DOM-ancestry checks like `canSubdivideFromPanelHeader()` and `canBreakOutFromPanelHeader()` with layout-status checks from `panelStatusByTabId`.

Menu rules:

- `root-panel`: show `Subdivide panel`; hide `Break out this panel`.
- `subdivision-top`: hide `Subdivide panel`; hide `Break out this panel`.
- `chooser-owner`: hide `Subdivide panel`; hide `Break out this panel`.
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
- Drag reorder operates on root layout nodes and dispatches root-node identities, not tab IDs.

## Implementation Sequence

0. **Spike (de-risk first):** prove that `showSplitViewPanels(allLeafTabs)` for docShell-activation only + Bento-owned inline rects survives a tab switch, workspace switch, panel focus/click, splitter resize, strip-scroll restore, and child-to-root promotion without Firefox re-flowing over the geometry. Complete this before landing step 7. Steps 1–6 may proceed only while they remain reversible tools/persistence prep and do not remove `subdivisions` or depend on the new chrome geometry; step 7 removes the `subdivisions` field and is the point of no return [^1] [^2] [^5] [^6].
1. Add Vitest to `@bento/tools` (devDep + `test` script + minimal config); this is new test infra — the repo currently has no test runner [^1].
2. Add `PanelLayout.ts` with pure tree helpers, normalization, status derivation, flattening, and v4-to-v5 conversion.
3. Refactor `PanelStore` to own `layoutByWorkspace` and delegate all layout mutations to `PanelLayout.ts` (per the method-mapping table above).
4. Update persistence to v5 and migrate v4 on load.
5. Update pinned-panel persistence/export/import to use keyed panel references from the same panel persistence snapshot, with v1 URL fallback.
6. Update panel session markers to store a v2 restore location compatible with grouped layouts; v1 `{workspaceId, position}` markers restore as root panels at the old flat slot.
7. In one atomic protocol/tools/chrome/**shell** pass, add `PanelLayoutStatus` + required `layout` + required `panelStatusByTabId` + `panelLayout/*` actions, update every dispatcher/handler **and both `@bento/shell` `panels/sync` surfaces** (`bridge/useToolsPort.ts`'s local store update and its `BENTO_PANELS` title-IPC producer, both of which today read/forward `event.subdivisions`), and remove the old subdivision field/action names with no aliases. The **origin** of this data flow is the tools-side sync producer `emitPanelsSync` (`background.ts:193`): it must emit `panels` from `getVisiblePanelIds` (all leaves — replacing the top-level-only `getPanels` at `:204`), add `layout` + `panelStatusByTabId`, and delete the `getAllSubdivisions()` block (`:244`) that builds `subdivisions`. Its missing-tab cleanup (`missingPanelIds` at `background.ts:226`) must switch to generic leaf removal + normalization; once the list contains every leaf, a missing id is not necessarily a top-panel parent. The full chain is `emitPanelsSync` → `useToolsPort` relay → `bento-shell-mount` decode [^1] [^2] [^13] [^14] [^15] [^16].
8. **Delete** the shell's local `subPanelTabIds` exclusion mechanism, don't re-derive it: drop the `subdivisions` parsing used for the Zustand mirror in `bridge/useToolsPort.ts` and the `subPanelTabIds` set in `state/panels.ts`. For the React sidebar tab-list filter specifically, the panels/sync flat panel list already carries every leaf (former sub-panels are now first-class) — **because `emitPanelsSync` now sources it from `getVisiblePanelIds` (`background.ts:204`), not top-level `getPanels`** — so the shell's existing `byWorkspace` set subtracts them with **no `layout` parsing needed** [^13] [^14] [^15].
9. Update the title-IPC producer and consumer together: `bridge/useToolsPort.ts` must include `layout` and `panelStatusByTabId` in the `BENTO_PANELS` payload and omit `subdivisions`; `bento-shell-mount.js` must parse those fields from the title payload and stop reading `decoded.subdivisions` [^14].
10. Implement logical layout rect computation and overlay splitters/choosers in `bento-shell-mount.js` (gated on the step-0 spike).
11. Switch header menus, navigator, keyboard cycling, focus rings, and close behavior to layout status.
12. Remove steady-state nested panel DOM usage and delete legacy `topClosed`, `isFullSlotSubPanel`, and nested-subdivision rendering/CSS.

**Steps 7–12 share a hard build-ordering constraint.** Removing `subdivisions` from the
sync payload (step 7) instantly breaks every reader/forwarder of that field: the legacy
nested-subdivision renderer in chrome (deleted at step 12), the `@bento/shell` local sync
reader that feeds sidebar filtering (updated at step 8), and the `@bento/shell`
`BENTO_PANELS` title-IPC producer that currently forwards `event.subdivisions` to chrome
(updated with the chrome parser at step 9). Removing the field from the protocol type also
fails `@bento/shell`'s typecheck immediately. The "no bridge" decision means there is no
transitional dual-emit. So the field swap, the new rendering pipeline (step 10), the
status/menu/navigator switch (step 11), and the legacy-renderer/CSS removal (step 12) must
either **land as one atomic change**, or tools must **transiently derive `subdivisions`
from `layout`** purely as a build scaffold — emitted only until step 12 lands, then
deleted. Do **not** ship step 7 in a commit that leaves the old renderer reading a field
tools no longer sends. (This scaffold is an internal build-ordering aid, not a revival of
the rejected protocol/action alias bridge: it carries no inbound actions and is removed
within this work, not kept for version skew.) [^3] [^14]

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
- preserve duplicate URLs as distinct keyed panels during v4 migration, export, import, and restart restore
- preserve duplicate-URL pinned panel references via keyed panel refs, including v1 URL fallback migration
- migrate legacy top-closed persisted state represented by `topHeightFraction <= 0`
- reject malformed root reorder payloads that omit group root IDs or duplicate root IDs
- distinguish `getVisiblePanelIds` from root-slot helpers: grouped layouts return all
  leaves for membership, root-node identities for reorder/slot operations, and
  `PanelRestoreLocation` values whose `rootIndex` is not a flattened leaf index
- mixed-role `getPanels` migrations cover membership plus first-panel promotion selection
  in `closeMainTabWithPanelPromotion`, `cleanupWorkspaceAfterTabMove`, and the last-normal-tab
  close path
- reject subdivision beyond the current depth cap
- derive correct `PanelLayoutStatus` before and after promotion
- break out split child and normalize remaining layout
- migrate v4 persisted subdivision shapes to v5 layout
- `panelLayout/fillChooser` assigns created tabs to the workspace, sets default width, syncs markers, and emits panels/sync
- v2 panel session markers restore grouped child panels as root panels at the recorded root location
- missing-tab cleanup removes any missing root/top/bottom/split leaf through generic layout removal and normalization, then emits a required `layout`/`panelStatusByTabId` payload
- backup import validation accepts both v1 and v2 exports in tools and in the Settings UI preflight validator

Chrome/manual scenarios:

- Create top/bottom subdivision, close top, bottom panel does not refresh.
- Create bottom split, close top, both split panels become root panels, keep widths, keep content painted.
- Promoted panels show `Subdivide panel`, not `Break out this panel`.
- Split children inside an active layout show `Break out this panel`, not `Subdivide panel`.
- Repeated subdivide/split/remove cycles cannot exceed the depth cap.
- Panel navigator contains only visible panels/groups; no hidden top panel remains.
- Cmd+W and header close do not produce `linkedBrowser is null`, stale `splitViewPanels`, or blank panel states.
- Workspace switch preserves layout and panel paint.
- Panel click/focus does not select a panel tab as main or reorder the layout.
- Vertical and horizontal splitter drags persist the correct group ratio via `panelLayout/setGroupRatio`.
- Workspace switch restores strip scroll after the flat layout rects are applied.
- Restart restores v5 layout and migrated v4 layouts.
- Duplicate-URL pinned panels restore to the intended panel entries after restart and backup import.
- Cmd+Shift+T on a closed split child restores it as a root panel without recreating stale groups.
- Subdivided/split panels (former sub-panels) never appear in the React sidebar tab list, with no `subdivisions` field present in `panels/sync` [^13].
- The `BENTO_PANELS` title payload carries `layout` and `panelStatusByTabId`, does not carry `subdivisions`, and chrome renders grouped layouts from those new fields [^14].
- `emitPanelsSync` emits a `panels` list containing every leaf (former sub-panels included) for every workspace, so sidebar filtering and chrome both see the complete panel set without `subdivisions` [^15].
- Every `panels/sync` payload, including empty workspaces and cleanup re-emits, includes `layout` and `panelStatusByTabId` [^16].

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
- Existing v4 persisted subdivision layouts load into the new model without data loss,
  including duplicate URLs and old top-closed states.
- Duplicate-URL pinned panels are restored by keyed panel reference, or any remaining
  URL-only ambiguity is explicitly documented as out of scope.
- Tabs created from a chooser are workspace-owned first-class panels immediately.
- Positional panel operations use root-node slots or `PanelRestoreLocation`, never indexes
  from a flattened visible-leaf list.
- First-panel promotion paths choose the first visible panel leaf in layout order, not the
  first root-node id or a flattened index reused for root insertion.
- Every `panels/sync` event carries the complete all-leaf panel list plus required
  `layout`/`panelStatusByTabId`, and no production path emits `subdivisions` [^16].

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

[^2]:
    **Revisions made by Codex on 2026-05-30**, after scrutinising the revised plan against
    the current codebase. Changes and rationale:

    1. **Added explicit replacement layout actions.** The previous revision removed
       `panel/subdivide`, `panel/setSubdivisionContent`, ratio actions, and
       `panel/breakOutSubPanel` without naming the new commands chrome should dispatch.
       The UI still needs mutation commands for chooser fill, split ratio changes,
       subdivision, break-out, group removal, and root reorder. The plan now introduces
       `panelLayout/*` actions and requires those to land atomically with chrome changes.
    2. **Changed persisted/exported layout identity from URL-based to keyed.** Duplicate
       panel URLs are valid, and the current restore path already uses a `consumed` set
       because URL matching is ambiguous. The plan now separates `panelKey` identity from
       URL content so duplicate URLs survive migration, restart restore, export, and import.
    3. **Made old top-closed migration concrete.** v4 persistence does not store a
       `topClosed` boolean; it can persist the state as `topHeightFraction <= 0`. The
       migration now detects that persisted shape and normalizes it into root children.
    4. **Fixed root reorder semantics.** A vertical group root has a group ID, not a tab ID,
       so navigator drag reorder must send root-node identities rather than the current
       `panel/reorder` tabId array.
    5. **Marked protocol/tools/chrome as an atomic pass.** Removing the old actions before
       updating chrome dispatch, title-IPC parsing, and tools handlers would make the
       intermediate tree unbuildable. The sequence now states that the protocol change,
       handler rewrite, chrome dispatch rewrite, and legacy action removal land together.
    6. **Broadened the spike.** Current `bento-shell-mount.js` has specific workarounds for
       panel click/focus, docShell reactivation, strip scroll, and split-view listener
       behavior. Testing only tab and workspace switches would not prove the new flat
       geometry model is stable enough.

[^3]:
    **Second review pass by Claude (Opus 4.8) on 2026-05-30**, after verifying Codex's
    `[^2]` changes against the codebase. All six of Codex's changes were confirmed accurate
    (verified: `consumed`-set URL matching at `background.ts:104,547`; v4 persists no
    `topClosed` boolean and stores `topHeightFraction=0` for top-closed state; `ExportSchema.ts`
    hard-rejects all but `schemaVersion === 1`; `panel/reorder` is tabId-based). Two issues
    that survived both prior passes were then fixed:

    1. **Resolved the renderer/protocol sequencing flaw.** The "no bridge" decision (`[^1]` #2)
       removes the `subdivisions` sync field, but the legacy renderer that reads it is not
       deleted until the legacy-renderer removal step and there is no dual-emit — so the
       numbered sequence implied a commit that would leave the old renderer reading a field
       tools no longer sends, i.e. a non-functional intermediate. Added an explicit
       build-ordering constraint: the protocol/rendering block lands atomically, or tools
       transiently derives `subdivisions` from `layout` as a scaffold removed with the
       legacy renderer. Clarified this scaffold is distinct from the rejected action-alias
       bridge (no inbound actions, removed within this work).
    2. **Corrected the `panelKey` identity model.** Codex labeled `panelKey` "stable," which
       could be read as a cross-session per-tab ID stored on the live tab. The runtime
       layout tree keys leaves by `tabId`; `panelKey` is only a snapshot-local join token
       between the persisted entries list and the persisted tree, bound to a live `tabId` on
       restore via the existing URL-consuming match. Spelled this out (and noted group `id`s
       are likewise per-session) so an implementer doesn't build needless cross-session key
       persistence. Also tied per-panel **width** explicitly to the keyed entry, since the
       duplicate-URL collision Codex fixed for layout applies equally to URL-keyed widths.

    No changes were made to Codex's `[^2]` revisions or the `[^1]` revisions — both were
    assessed as correct. The plan's core direction remains sound.

[^4]:
    **Additional revisions made by Codex on 2026-05-30**, after re-checking the full plan
    and Claude's `[^3]` changes against the current codebase. Changes and rationale:

    1. **Made chooser-created tabs explicitly first-class.** The current
       `panel/setSubdivisionContent` path creates tabs and fills the subdivision, but unlike
       `panel/openAt` it does not eagerly assign the tab to the workspace, set default panel
       width, or sync panel markers. Once sub-panels become first-class layout leaves,
       `panelLayout/fillChooser` must do those things immediately or the shell/sidebar and
       Cmd+Shift+T restore path can see orphan visual panels.
    2. **Extended keyed identity to pinned panels.** `panelKey` fixed duplicate URLs for
       panel layout persistence, but pinned-panel persistence, backup export, and import were
       still URL-keyed. Duplicate-URL pins would therefore remain ambiguous. The plan now
       requires keyed pinned-panel references from the same panel persistence snapshot, with
       URL retained only for v1 migration/fallback.
    3. **Added grouped-layout session-marker semantics.** The current `bento.isPanel`
       marker stores only `{ workspaceId, position }`, which is a flat strip slot. Grouped
       layouts need a v2 restore location. The plan now states that restored grouped-child
       panels come back as root panels at the recorded root location instead of trying to
       recreate stale deleted groups.
    4. **Narrowed group removal semantics.** The broad `panelLayout/removeGroup` action did
       not define what removing a horizontal group meant. The plan now uses
       `panelLayout/removeVerticalGroup`; horizontal groups collapse through leaf removal,
       break-out, or normalization.
    5. **Renumbered the implementation sequence and build-order constraint.** Adding
       pinned-panel and marker work changed the sequence, so the hard protocol/rendering
       ordering note was updated to point at the new steps.

[^5]:
    **Third review pass by Claude (Opus 4.8) on 2026-05-30**, verifying Codex's `[^4]`
    changes against the codebase. All four code-level `[^4]` claims were confirmed accurate:
    `panel/setSubdivisionContent` (`protocol-handler.ts:808–835`) creates tabs without the
    workspace assignment / default width / marker sync that `panel/openAt:660–663` performs;
    `PinnedPanelsStore` persistence and `ExportSchema.ts:43–47` are URL-keyed; the
    `PanelMarker` is `{workspaceId, position}` (`SessionMarker.ts:17–20`); the
    `removeVerticalGroup` narrowing is consistent. Two defects introduced by the `[^4]` pass
    were then fixed:

    1. **Repaired stale step references left by Codex's renumbering.** The sequence grew from
       11 to 13 steps (inserting pinned-panel persistence and v2 session markers), but two
       gating references were not updated: step 0 still said "do not proceed past step 4,"
       and the geometry-spike blockquote still said "before steps 5–9 proceed." Post-renumber
       the irreversible `subdivisions` teardown is step 7 and the rendering block is steps
       10–12. Updated the spike gate to "past step 6 / before step 7" (naming step 7 as the
       point of no return) and the blockquote to "steps 7, 10–12."
    2. **Defined the two return types Codex introduced but left unspecified.**
       `getPanelRestoreLocation(): PanelRestoreLocation` and
       `getPanelPersistenceSnapshot(): PanelPersistenceSnapshot` were added to the helper
       list and referenced by the Cmd+Shift+T restore behavior, the v2 marker step, and the
       pinned-panel keyed-snapshot prose — but, unlike `PanelLayoutStatus`, their shapes were
       never given. Added concrete definitions: `PanelRestoreLocation` ({workspaceId,
       rootIndex, optional containingRootNodeId} with documented restore/fallback semantics
       and the cross-restart caveat tying back to `[^3]`'s per-session ids), and
       `PanelPersistenceSnapshot` (the single shared source of `panelKey` assignment,
       explicitly noting that the independently-debounced PanelStore and PinnedPanelsStore
       persisters must not mint keys separately — which is exactly the constraint behind
       Codex's "shared snapshot or it's a non-goal" hedge).

    No changes were made to the `[^1]`–`[^4]` revisions — all were assessed as correct. The
    plan's core direction remains sound.

[^6]:
    **Additional revisions made by Codex on 2026-05-30**, after re-checking Claude's
    `[^5]` changes and the full plan. Changes and rationale:

    1. **Corrected the persisted layout type.** `[^5]` added
       `PanelPersistenceSnapshot.layout` but typed it as `WorkspacePanelLayout`, whose panel
       leaves carry `tabId: number`. The persisted snapshot rewrites leaves to `panelKey`,
       so it needs its own `PanelPersistenceWorkspaceLayout` type with `panelKey` leaves and
       `ownerPanelKey` for chooser ownership.
    2. **Clarified the spike gate.** The text said the spike was required "before building,"
       while step 0 allowed reversible prep through step 6. The plan now states the spike
       must complete before landing step 7, and that steps 1–6 may proceed only while they
       stay reversible and independent of the new chrome geometry.
    3. **Tightened `[^5]` wording.** `[^4]` has five numbered revisions, but only four were
       code-level claims; the fifth was sequence renumbering. The footnote now says
       "four code-level `[^4]` claims" to avoid a count mismatch.

[^7]:
    **Fourth review pass by Claude (Opus 4.8) on 2026-05-30**, verifying Codex's `[^6]`
    changes and re-scanning the whole plan. `[^6]` is correct: the persisted layout needed
    its own `panelKey`-keyed node family (`PanelPersistenceWorkspaceLayout` with
    `ownerPanelKey`), and the migration prose (line ~388) was consistently updated; the
    spike-gate clarification aligns step 0, the blockquote, and the build-order note. No
    changes were made to `[^1]`–`[^6]`. One defect that survived all six prior passes was
    fixed:

    1. **`getPanels` was mapped as a drop-in rename when it is a semantic change.** Verified
       `getPanels` today returns _top-level panels only_ (`PanelStore.ts:184` filters
       `allSubPanelTabIds`), so its indices form a contiguous root-slot axis. The mapping
       table replaced it with `getVisiblePanelIds`, which in the flat model returns _every_
       leaf (former sub-panels included). A naive swap silently breaks positional call sites:
       `protocol-handler.ts:67` captures `getPanels(ws).indexOf(tabId)` and feeds it to
       `insertAt(…, originalPosition)` during main-close panel promotion rollback, and the
       same root-slot assumption exists in panel insertion and marker restore paths. Split the
       mapping row by use (positional → `getRootNodeIds`/`PanelRestoreLocation`; membership →
       `getVisiblePanelIds`) and added an audit note. This is exactly the silent-caller-break
       class the mapping table was introduced (`[^1]` #6) to prevent, so it belongs there.
    2. **Removed the vestigial `getPanelIds` helper.** It was listed in the accessor block but
       defined nowhere, referenced nowhere, and duplicated `getVisiblePanelIds`. Documented
       the now-distinct roles of `getVisiblePanelIds` (membership/iteration),
       `getRootNodeIds` (slot/position), and `containsPanel` (predicate) so the redundancy
       doesn't reappear.

    The plan's core direction remains sound.

[^8]:
    **Additional revisions made by Codex on 2026-05-30**, after checking Claude's `[^7]`
    changes against every current `getPanels()` call site. Changes and rationale:

    1. **Corrected the positional-call-site example.** `protocol-handler.ts:67` is not an
       unpin/Cmd+Shift+T restore path; it is the rollback path for promoting a panel to the
       main tab during `tab/closeMain`. The underlying concern was correct, but the cited
       behavior was wrong.
    2. **Expanded the audit from one example to the actual positional class.** Other current
       paths also derive root-slot indexes from `getPanels()`: `panel/openAt`
       (`protocol-handler.ts:625–653`), add-as-panel source insertion
       (`background.ts:891–894`), panel marker write/restore (`background.ts:990–1007`),
       and opener-created panel insertion (`background.ts:1048–1051`). The plan now says
       all of these must use root-node identity or `PanelRestoreLocation`, not flattened
       visible-leaf indexes.
    3. **Added enforceable coverage.** The test and acceptance sections now require the
       accessor split to be verified so grouped layouts cannot regress to using flattened
       leaf indexes for positional behavior.

[^9]:
    **Fifth review pass by Claude (Opus 4.8) on 2026-05-30**, verifying Codex's `[^8]`
    changes. All `[^8]` claims were confirmed accurate against the code:
    `protocol-handler.ts:67` is `promoteLeftmostPanelBeforeMainClose` (the `tab/closeMain`
    promotion rollback, not the unpin/Cmd+Shift+T restore my `[^7]` wrongly named — `[^8]`
    correctly repaired that in place); `panel/openAt` (`:625`), add-as-panel
    (`background.ts:891`), the marker round-trip (`background.ts:990` writes
    `setPanelMarker(tabId, ws, idx)` from the flat index, restored via `insertAt(marker.position)`),
    and opener insertion (`background.ts:1048`) all derive root-slot indexes from `getPanels`;
    the test (lines 546–548) and acceptance (lines 596–597) additions are present. No changes
    were made to `[^1]`–`[^8]`. One refinement was added:

    1. **Confirmed the positional audit is exhaustive and flagged the dual-role sites.** I
       classified all 17 current `getPanels` callers. Every index-deriving site is already in
       `[^8]`'s list (`protocol-handler.ts:67, 625`; `background.ts:891, 990, 1048`); the other
       eleven are membership/iteration. The audit note previously read as illustrative
       ("This includes…"), leaving open whether other positional sites lurked — it is now
       marked exhaustive. The classification also exposed mixed-role uses of `getPanels`
       where membership and selection/predicate need different replacements; the initial
       callout named `closeMainTabWithPanelPromotion` and the subdivide-eligibility check.
       Codex later expanded that list in `[^10]`.

    The plan's core direction remains sound.

[^10]:
    **Additional revisions made by Codex on 2026-05-30**, after verifying Claude's `[^9]`
    call-site classification against the current codebase. Changes and rationale:

    1. **Corrected the mixed-role count.** `[^9]` correctly identified all five
       index-derived root-slot writers (`protocol-handler.ts:67,625` and
       `background.ts:891,990,1048`), but the remaining callers were not all simple
       membership/iteration reads. `cleanupWorkspaceAfterTabMove`
       (`protocol-handler.ts:148–158`) and the last-normal-tab close path
       (`background.ts:1199–1224`) also build a membership `Set` and then promote
       `panelTabIds[0]`. They need the same split as `closeMainTabWithPanelPromotion`:
       membership from `getVisiblePanelIds`, promotion target from the first visible leaf in
       layout order.
    2. **Narrowed the "exhaustive" claim.** The plan now says the five-item list is
       exhaustive for index-derived root-slot writes, not for every `getPanels` caller with
       positional meaning.
    3. **Added coverage for first-panel promotion paths.** The test and acceptance sections
       now require first-panel promotion to use visible-leaf layout order, not root-node ids
       or flattened indexes reused for root insertion.

[^11]:
    **Sixth review pass by Claude (Opus 4.8) on 2026-05-30**, verifying Codex's `[^10]`
    changes. `[^10]` is correct and caught two real errors in my `[^9]`: I had labeled
    `cleanupWorkspaceAfterTabMove` (`protocol-handler.ts:148`) and the last-normal-tab close
    path (`background.ts:1199`) as pure membership, but both are dual-role — verified each
    builds a membership `Set` and then promotes `panelTabIds[0]`
    (`protocol-handler.ts:158` `promoteLeftmostPanelToTabAfterMove`; `background.ts:1224`
    `promoteLeftmostPanelToTab`). My `[^9]` "exhaustive" framing was overconfident because I
    read only three lines of context per site; `[^10]`'s narrowing to "index-derived
    root-slot writes" is the right scoping. No changes were made to `[^1]`–`[^10]`. One
    addition was made to make the current audit reproducible:

    1. **Recorded the settled full classification and flagged a re-audit trap.** I
       re-verified all 17 `getPanels` callers with adequate context: 5 root-slot writes, 3
       promotions, 1 predicate, and 8 pure membership/iteration (`background.ts:204, 600,
629, 1329`; `protocol-handler.ts:366, 435, 684`; `BackupStore.ts:67`) — the body
       previously enumerated the first three classes but not the membership set, leaving the
       count open and inviting another re-audit. While confirming the membership set I
       found the trap that caused my own `[^9]` miss in reverse: `background.ts:600` and
       `:1329` _do_ contain a `wsTabs[0]` pick, but `wsTabs` is the non-panel tab list there
       (`getPanels` supplies only the exclusion `Set`), so they are membership sites, not
       promotion sites. The plan now states the complete 5+3+1+8 split and names that trap so
       a later reviewer does not re-flag those two `[0]`s and reopen a closed question.

    The plan's core direction remains sound.

[^12]:
    **Additional revisions made by Codex on 2026-05-30**, after verifying Claude's `[^11]`
    classification against the current codebase. Changes and rationale:

    1. **Kept the classification, removed the permanent-audit wording.** The 5+3+1+8 split is
       accurate for the current 17 `PanelStore.getPanels` call sites, but "no further
       re-audit is needed" was too absolute for a plan that depends on live code. The plan now
       marks the classification as current as of 2026-05-30 and names the exact `rg` audit to
       rerun if call sites change.
    2. **Softened footnote 11's permanence claim.** The footnote now says the audit is
       reproducible rather than permanently closed. The underlying `background.ts:600` /
       `:1329` trap remains documented because it is correct and useful.

[^13]:
    **Seventh review pass by Claude (Opus 4.8) on 2026-05-30**, verifying Codex's `[^12]`
    changes. `[^12]` is correct: I re-ran its named audit (`rg "\.getPanels\(" extensions/bento-tools/src`)
    and it returns exactly the 17 call sites (the regex's leading `.` excludes the
    `PanelStore.ts:184` definition), and the "current as of date + reproducible" softening is
    the right call for a line-number-based classification. No changes were made to
    `[^1]`–`[^12]`. Stepping off the (now-settled) `getPanels` table, I scrutinised a surface
    that twelve passes had skipped — the **`@bento/shell` React sidebar as a consumer of the
    `subdivisions` sync field** — and found a real gap:

    1. **The shell is an unnamed `subdivisions` consumer, and step 8 was mis-scoped.**
       `bridge/useToolsPort.ts:182–195` parses `event.subdivisions` into `subPanelIds`, and
       `state/panels.ts:18–55` keeps a `subPanelTabIds` set, used (per that file's header) to
       subtract sub-panels from the sidebar tab list — needed today only because tools' flat
       panel list (`getPanels`) is top-level-only. The `[^1]` "no-bridge" reasoning enumerated
       _dispatchers_ (chrome + tools handler) and so skipped this _reader_. Removing the
       `subdivisions` field breaks it (and fails `@bento/shell`'s typecheck) just as it breaks
       the chrome renderer. Fixes: (a) step 7 now names `@bento/shell`'s `useToolsPort.ts` as
       a surface in the atomic pass; (b) the build-order note lists the shell reader as the
       second consumer broken by the field removal; (c) step 8 was rewritten — in the flat
       model `getVisiblePanelIds` already carries every leaf, so the shell's `subPanelTabIds`
       mechanism is **deleted**, not "re-derived from `layout`." The React sidebar state path
       renders/filters the tab list (not the panels), so it needs neither the group tree nor
       `panelStatusByTabId`;
       the old "derive exclusion from layout" wording implied unnecessary tree parsing and
       preserved an obsolete exclusion concept. Added a verification scenario that former
       sub-panels never appear in the sidebar and `panels/sync` carries no `subdivisions`.

    The plan's core direction remains sound.

[^14]:
    **Additional revisions made by Codex on 2026-05-30**, after verifying Claude's `[^13]`
    changes and re-checking the whole plan. `[^13]` is correct that `@bento/shell` is a
    real `subdivisions` consumer and that the local sidebar store should delete, not
    re-derive, `subPanelTabIds`. One related gap remained:

    1. **Separated the shell's local reader from its chrome title-IPC producer.**
       `bridge/useToolsPort.ts` has two `subdivisions` responsibilities today: it parses
       `event.subdivisions` into local `subPanelIds` for `state/panels.ts` (`:182–195`), and
       it also types/forwards `payload.subdivisions` through `BENTO_PANELS` for chrome
       (`:224–302`). `bento-shell-mount.js` currently reads that forwarded field as
       `decoded.subdivisions` (`:10193`). Updating only the local sidebar path would still
       fail `@bento/shell` typecheck and would not give chrome the new layout/status data.
       The plan now states that the React sidebar needs no `layout` parsing, while the
       title-IPC producer must forward `layout` and `panelStatusByTabId` to chrome and omit
       `subdivisions`. The build-order note, manual scenarios, and `[^13]`'s local-sidebar
       wording were updated to cover this producer/consumer pair explicitly.

    The plan's core direction remains sound.

[^15]:
    **Eighth review pass by Claude (Opus 4.8) on 2026-05-30**, verifying Codex's `[^14]`
    changes. `[^14]` is correct on all three code points: `bridge/useToolsPort.ts` both reads
    `event.subdivisions` locally (`:182–195`) and forwards it through the `BENTO_PANELS`
    title-IPC channel (`:239, :296–302`, written to `document.title` at `:302`), and chrome
    decodes it at `bento-shell-mount.js:10193` (`sanitizeSubdivisionPayload(decoded.subdivisions)`).
    The producer/consumer split it added to steps 7–9 and the build-order note is accurate.
    No changes were made to `[^1]`–`[^14]`. Tracing that data flow to its source exposed the
    one link still unnamed:

    1. **Named the tools-side sync producer that originates the flow.** `[^13]`/`[^14]`
       mapped the shell relay and chrome consumer, but step 8's load-bearing assumption — "the
       panels/sync flat panel list already carries every leaf" — is only true if the _emitter_
       changes. Verified `emitPanelsSync` (`background.ts:193`) builds `event.panels` from
       `getPanels` (top-level only, `:204`) and builds `subdivisions` from
       `getAllSubdivisions()` (`:244`). For the flat list to carry every leaf and for `layout`
       to reach chrome, `:204` must switch to `getVisiblePanelIds` and the `:244` block must be
       replaced by emitting `layout` + `panelStatusByTabId`. The full producer→relay→consumer
       chain (`emitPanelsSync` → `useToolsPort` → `bento-shell-mount`) is now named end to end,
       step 8's assumption is grounded in the specific call site that makes it true, and a
       verification scenario was added. (`background.ts:204` is one of the eight membership
       callers in the `[^11]`/`[^12]` audit; its mapping to `getVisiblePanelIds` was already
       correct — this pass elevates it from a generic membership swap to the named origin of
       the sync contract.)

    The plan's core direction remains sound.

[^16]:
    **Additional revisions made by Codex on 2026-05-30**, after verifying Claude's `[^15]`
    changes and re-checking the full plan. `[^15]` is correct: `emitPanelsSync` is the
    tools-side origin of the flow, and it currently builds `event.panels` from top-level
    `getPanels` plus a separate `getAllSubdivisions()` block. Three final contract issues were
    fixed:

    1. **Made `layout` and `panelStatusByTabId` required on `panels/sync`.** The plan text
       required the producer and title-IPC relay to carry the new fields, but the protocol
       snippet still used `layout?` and `panelStatusByTabId?`. Optional fields would let the
       exact omission caught in `[^13]`–`[^15]` pass typecheck. The plan now requires both
       fields on every sync payload, with empty structures for workspaces with no panels.
    2. **Called out `emitPanelsSync`'s missing-tab cleanup path.** Today
       `missingPanelIds` (`background.ts:226–231`) is sourced from top-level panels only, so it
       can call `promoteSubPanelsWhenRemovingParent`. After `event.panels` switches to all
       visible leaves, a missing id can be a root panel, subdivision top, subdivision bottom,
       or split child. The plan now requires generic leaf removal plus normalization before
       the re-emit, and adds coverage so this old top-parent assumption does not survive the
       migration.
    3. **Named the second export/import validator.** The export section already said to update
       tools-side `ExportSchema.ts` for schema v2, but Settings has a separate UI preflight
       validator at `extensions/bento-shell/src/features/Settings/validateExport.ts` that also
       hard-rejects `schemaVersion !== 1` before the import reaches tools. The plan now names
       both validators and adds coverage so v2 imports work through the actual Settings UI, not
       only through the background handler.

    With these changes, the remaining likely revisions are implementation details rather
    than plan-level blockers.
