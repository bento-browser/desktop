// Cross-extension wire protocol. Imported by both bento-shell and bento-tools
// via the `@shared/*` TS path alias (configured in tsconfig.base.json).
//
// Pattern (§4.2): bento-shell sends Action messages to bento-tools, which
// performs the mutation against persistent state and broadcasts Event deltas
// back. The shell's Zustand stores are downstream mirrors.

export const SHELL_TOOLS_PORT = 'bento-shell<->bento-tools';

/** Compact tab payload sent over the wire. */
export interface TabSnapshot {
  id: number;
  windowId: number;
  index: number;
  /** Optional Bento-side display name for the sidebar. Does not mutate
   * the page title; the live browser title remains in `title`. */
  customTitle?: string;
  title: string;
  /** Current tab URL, when Firefox exposes one. May be absent for blank,
   * internal placeholder, or still-resolving tabs. */
  url?: string;
  favIconUrl?: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  /** True when Firefox has muted this tab. Kept separate from `audible`
   * because muted media tabs must still expose the unmute affordance. */
  muted: boolean;
  /** True while the tab is loading (browser.tabs status === 'loading').
   * Surfaces the throbber on the sidebar tab row. */
  loading?: boolean;
  /** True when Firefox has unloaded the tab (SleepPolicy or user discard).
   * Sidebar dims the favicon so users can see at a glance which tabs are
   * sleeping vs. resident in memory. */
  discarded?: boolean;
  /** Workspace this tab belongs to. Undefined during the brief window between
   * tab creation and tools assigning it to the active workspace. */
  workspaceId?: string;
  /** Optional workspace-scoped tab folder membership. Folder metadata is
   * mirrored separately through tabFolders/* events; membership rides tab
   * deltas so tab closure automatically drops the binding. */
  folderId?: string;
}

export type TabDelta =
  | { kind: 'created'; tab: TabSnapshot }
  | { kind: 'updated'; id: number; changes: Partial<TabSnapshot> }
  | { kind: 'removed'; id: number }
  | { kind: 'activated'; id: number; windowId: number };

/** Workspace metadata. `themeId` keys into the theme presets registry
 * (`extensions/bento-shell/src/theme/presets/index.ts`) and is mirrored
 * onto `<html data-bento-theme="…">` for both the shell and the chrome
 * window. */
export interface Workspace {
  id: string;
  name: string;
  /** Theme preset id. Resolves to a `BentoThemeMeta` in the shell's
   * presets registry. Undefined falls back to the Default theme. */
  themeId?: string;
  /** Optional emoji or short string rendered in the workspace switcher. */
  icon?: string;
  createdAt: number;
}

export type WorkspaceDelta =
  | { kind: 'created'; workspace: Workspace }
  | { kind: 'updated'; id: string; changes: Partial<Workspace> }
  | { kind: 'removed'; id: string }
  /** When `windowId` is present the activation is scoped to that chrome
   * window only (Zen-style per-window active workspace). When absent it's
   * a global activation: legacy single-window UI and tools-internal flows
   * use this form and every shell mirror treats it as "the active id for
   * everyone". Shells that track per-window state should apply the new
   * id to `activeIdByWindow[windowId]` when present, otherwise to the
   * fallback `activeId` field. */
  | { kind: 'activated'; id: string; windowId?: number };

export interface TabFolder {
  id: string;
  workspaceId: string;
  name: string;
  order: number;
  collapsed: boolean;
  createdAt: number;
}

export type TabFolderDelta =
  | { kind: 'created'; folder: TabFolder }
  | { kind: 'updated'; id: string; changes: Partial<TabFolder> }
  | { kind: 'removed'; id: string };

/** User-configurable Bento settings. Persisted in storage.local; defaults
 * mirror the values declared in prefs/bento.js (the latter remain the source
 * of truth for "what Bento ships as"; SettingsStore lets users override).
 *
 * Add a new field by: (1) extending this interface, (2) adding a default
 * in DEFAULT_SETTINGS in SettingsStore.ts, (3) reading it where consumed.
 * Reverting a field to default = removing it from storage.local. */
/** Exported workspace snapshot schema. Used for manual export/import and
 * auto-backups. Versioned so the importer can migrate older exports. */
export interface BentoExportSchema {
  schemaVersion: 1 | 2;
  bentoVersion: string;
  exportedAt: number;
  workspaces: Array<{
    id: string;
    name: string;
    themeId?: string;
    icon?: string;
    createdAt: number;
    tabs: Array<{
      url: string;
      title: string;
      customTitle?: string;
      pinned: boolean;
    }>;
    panels: Array<{
      panelKey?: string;
      url: string;
      widthPx?: number;
      subdivision?: {
        mode: SubdivisionMode;
        topHeightFraction: number;
        subPanelUrls: string[];
        splitRatio?: number;
      };
    }>;
    /** Workspace-scoped main content slot width in CSS pixels. */
    mainWidthPx?: number;
    /** Workspace-scoped panel-strip horizontal scroll position in CSS pixels. */
    stripScrollLeft?: number;
    panelLayout?: PanelLayoutExport;
    pinnedPanels: Array<{
      panelKey?: string;
      url?: string;
      order: number;
      widthPx?: number;
    }>;
  }>;
  settings?: Partial<BentoSettings>;
  savedPanels: Array<{
    title: string;
    url: string;
  }>;
}

export interface ImportOptions {
  importSettings: boolean;
  importSavedPanels: boolean;
  replaceExisting: boolean;
}

export interface ImportSummary {
  workspacesCreated: number;
  tabsOpened: number;
  panelsRestored: number;
  settingsApplied: boolean;
}

export interface BackupListEntry {
  id: string;
  createdAt: number;
  workspaceCount: number;
  tabCount: number;
}

export type SidebarShortcutBehavior = 'collapse' | 'hide';

export interface BentoSettings {
  /** Tab sleep on/off. When false, SleepPolicy's sweep is a no-op. */
  tabSleepEnabled: boolean;
  /** Minutes of inactivity before a tab is eligible for discard. */
  tabSleepAfterMinutes: number;
  /** Last-N most-recently-active tabs per workspace that stay warm. */
  tabSleepKeepAlivePerWorkspace: number;
  /** Name used when creating the first workspace on a fresh profile. */
  defaultWorkspaceName: string;
  /** Cmd+K command palette enabled (M2 future feature). */
  commandPaletteEnabled: boolean;
  /** False until the user dismisses the first-run welcome banner. The banner
   * surfaces only when this is false; flipping it true hides the banner
   * everywhere (storage.local persists the choice across launches). */
  welcomeSeen: boolean;
  /** Color mode for Bento's chrome + shell UI. Plumbed by setting
   * data-color-mode on the shell's <html> AND on the chrome window's
   * <window> root — Tale UI's _color-modes.css cascade (rewritten to
   * :root selectors by scripts/generate-chrome-tokens.mjs) does the
   * rest. 'system' resolves to the current OS color scheme at render time
   * while preserving the user-facing Auto setting. */
  uiColorMode: UiColorModePref;
  /** Color mode hint forwarded to web content via
   * browser.browserSettings.overrideContentColorScheme. The page is
   * told to render in the chosen mode regardless of OS preference.
   * Independent of uiColorMode so the user can keep Bento dark while
   * pages render light, or vice versa. */
  contentColorMode: ColorModePref;
  /** Sidebar collapsed state. When true, the chrome shrinks the sidebar
   * to a narrow rail showing only tab favicons + workspace avatar; the
   * footer buttons stack vertically (with the collapse-toggle pinned at
   * the same screen position so the cursor doesn't have to move). */
  sidebarCollapsed: boolean;
  /** Sidebar hidden state. Set by the Cmd/Ctrl+S shortcut when
   * sidebarShortcutBehavior is 'hide'. The chrome removes the sidebar's
   * effective layout footprint while keeping the collapsed rail available
   * through left-edge hover; the same shortcut restores the expanded sidebar. */
  sidebarHidden: boolean;
  /** Minimized sidebar target used by Cmd/Ctrl+S. 'collapse' preserves the
   * narrow rail behavior; 'hide' removes the sidebar's effective layout
   * footprint while preserving a left-edge hover reveal for the collapsed rail. */
  sidebarShortcutBehavior: SidebarShortcutBehavior;
  /** Default width (CSS pixels) applied to a newly-added panel before
   * the user has dragged its splitter. Also used as the default minimum
   * width for an unresized main content slot while side panels consume
   * space. Persists per side panel after the first drag
   * (PanelStore.setWidth). 640 is wide enough for most sites' content
   * without horizontally squishing them yet narrow enough that 2-3
   * panels fit comfortably on a typical 1440px+ viewport. */
  defaultPanelWidthPx: number;
  /** Preset widths (CSS pixels) surfaced in each side panel header's
   * kebab menu. Clicking a preset resizes only the panel whose menu is
   * open, via panel/setWidth (same code path the drag-splitter uses).
   * Order is preserved as the user entered it — no auto-sort, no
   * dedup. Empty array = the kebab menu shows no presets (still opens,
   * lets future menu items live there). Defaults [320, 480, 768, 1280]
   * cover narrow chat / standard reading / wide research / near-full-
   * width split-screen breakpoints. */
  customPanelSizes: number[];
  /** Wrap Cmd/Ctrl+Shift+Left/Right panel cycling at the ends of the strip. When
   * false (default), pressing the Right shortcut at the Add-panel trailer (or
   * the Left shortcut at the main panel) is a no-op — cycling clamps at the
   * endpoints. When true, Right at the trailer wraps back to the main panel and
   * Left at the main panel wraps forward to the trailer. */
  panelCycleWraparound: boolean;
  /** Render outer box shadows around split-view panels. Enabled by
   * default; disabling removes the chrome-side shadow proxy elements for
   * users who prefer flatter panels or want less visual separation. */
  panelShadowsEnabled: boolean;
  /** Rounded corner radius, in CSS pixels, for Bento split-view panel
   * frames. The default matches the current Tale UI `--radius-m` panel
   * corner value. */
  panelCornerRadiusPx: number;
  /** Automatic periodic backup of workspace state to storage.local. */
  autoBackupEnabled: boolean;
  /** Minutes between automatic backups. */
  autoBackupIntervalMinutes: number;
  /** Maximum number of automatic backups to retain (FIFO). */
  autoBackupMaxCount: number;
  /** Bento privacy preset selected by the user. `custom` is computed in the
   * live privacy snapshot and is never stored here. */
  privacyProtectionLevel: SelectablePrivacyProtectionLevel;
  /** Default search engine id for the fresh-profile search bundle. */
  defaultSearchEngine: SearchEngineId;
}

export type ColorModePref = 'light' | 'dark';
export type UiColorModePref = ColorModePref | 'system';
export type PrivacyProtectionLevel = 'standard' | 'enhanced' | 'hardened' | 'custom';
export type SelectablePrivacyProtectionLevel = Exclude<PrivacyProtectionLevel, 'custom'>;
export type SearchEngineId = string;
export interface SearchEngineChoice {
  id: SearchEngineId;
  name: string;
  isDefault: boolean;
  iconUrl?: string;
}
export interface SearchEnginesSnapshot {
  defaultSearchEngine: SearchEngineId;
  availableSearchEngines: SearchEngineChoice[];
}
export type PrivacyAdvancedKey =
  | 'safeBrowsingEnabled'
  | 'drmEnabled'
  | 'sanitizeOnShutdown'
  | 'resistFingerprinting'
  | 'letterboxing'
  | 'networkPrediction'
  | 'peerConnection'
  | 'webRTCIPHandlingPolicy'
  | 'httpsOnlyMode'
  | 'searchSuggestionsEnabled'
  | 'diskCacheEnabled'
  | 'webglEnabled'
  | 'webgpuEnabled'
  | 'passwordSavingEnabled'
  | 'formHistoryEnabled';

export type SubdivisionMode = 'single' | 'dual';

export type PanelLayoutStatus =
  | 'root-panel'
  | 'subdivision-top'
  | 'subdivision-bottom'
  | 'split-child'
  | 'chooser-owner'
  | 'unknown';

export type PanelLayoutFillMode = 'single' | 'dual';

export type PanelLayoutMoveTarget =
  | { type: 'root'; index: number }
  | { type: 'chooser'; chooserId: string }
  | {
      type: 'horizontal';
      groupId: string;
      row: 'top' | 'bottom';
      position: 'before' | 'after';
    };

export interface PanelLayoutSync {
  root: PanelLayoutSyncRootNode[];
}

export interface DevtoolsPanelLinkSync {
  devtoolsTabId: number;
  callerTabId: number | null;
  inspectedTabId: number;
}

export type PanelLayoutSyncRootNode = PanelLayoutSyncPanelNode | PanelLayoutSyncVerticalGroupNode;

export type PanelLayoutSyncVerticalTopNode =
  | PanelLayoutSyncPanelNode
  | PanelLayoutSyncHorizontalGroupNode;

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
  children: [PanelLayoutSyncVerticalTopNode, PanelLayoutSyncVerticalBottomNode];
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

export interface PanelLayoutExport {
  root: PanelLayoutExportRootNode[];
}

export type PanelLayoutExportRootNode =
  | PanelLayoutExportPanelNode
  | PanelLayoutExportVerticalGroupNode;

export type PanelLayoutExportVerticalTopNode =
  | PanelLayoutExportPanelNode
  | PanelLayoutExportHorizontalGroupNode;

export type PanelLayoutExportVerticalBottomNode =
  | PanelLayoutExportPanelNode
  | PanelLayoutExportChooserNode
  | PanelLayoutExportHorizontalGroupNode;

export interface PanelLayoutExportPanelNode {
  kind: 'panel';
  panelKey: string;
}

export interface PanelLayoutExportVerticalGroupNode {
  kind: 'group';
  id: string;
  axis: 'vertical';
  ratio: number;
  children: [PanelLayoutExportVerticalTopNode, PanelLayoutExportVerticalBottomNode];
}

export interface PanelLayoutExportHorizontalGroupNode {
  kind: 'group';
  id: string;
  axis: 'horizontal';
  ratio: number;
  children: [PanelLayoutExportPanelNode, PanelLayoutExportPanelNode];
}

export interface PanelLayoutExportChooserNode {
  kind: 'chooser';
  id: string;
  ownerPanelKey: string;
}

export type Action =
  | { type: 'ping' }
  /** Sent once per shell-document connection so bento-tools learns which
   * chrome window this shell instance lives in. Per-window awareness is
   * the foundation for multi-window features (synced windows, per-window
   * active workspace). Architectural note: bento-shell's background is a
   * SINGLETON across all chrome windows — every shell document shares one
   * port to tools — so the port itself can't be window-tagged. Each shell
   * document instead identifies itself with this action on mount, and
   * every subsequent dispatch carries the same windowId on the wire
   * envelope (see WireAction). */
  | { type: 'shell/hello'; windowId: number }
  | { type: 'tabs/requestSnapshot' }
  | { type: 'tabFolders/requestSnapshot' }
  | { type: 'tab/activate'; id: number }
  | { type: 'tab/close'; id: number }
  | { type: 'tabs/close'; ids: number[] }
  | { type: 'tabs/reload'; ids: number[]; bypassCache?: boolean }
  | { type: 'tab/closeMain'; id: number }
  | { type: 'tab/rename'; id: number; title: string }
  | { type: 'tab/assignWorkspace'; id: number; workspaceId: string }
  /** Assign multiple existing sidebar tabs to a workspace. Used by the
   * sidebar's multi-select context menu; tools applies the same cleanup
   * policy as single-tab assignment after the batch finishes. */
  | { type: 'tabs/assignWorkspace'; ids: number[]; workspaceId: string }
  | { type: 'tabFolder/create'; id?: string; name?: string; tabIds: number[] }
  | { type: 'tabFolder/rename'; id: string; name: string }
  | { type: 'tabFolder/delete'; id: string }
  | { type: 'tabFolder/setCollapsed'; id: string; collapsed: boolean }
  | { type: 'tabFolder/reorder'; workspaceId: string; orderedIds: string[] }
  | { type: 'tabFolder/assignWorkspace'; id: string; workspaceId: string }
  /** Assign tabs to a folder, or clear folder membership. Folder members
   * are always normal unpinned tabs; tools demotes pinned sources before
   * applying a non-null folder target. */
  | { type: 'tabs/setFolder'; ids: number[]; folderId: string | null }
  /** Create a new workspace and move the selected sidebar tabs into it.
   * The new workspace auto-activates in the requesting window. */
  | { type: 'tabs/moveToNewWorkspace'; ids: number[]; name?: string }
  /** Open `url` in a new tab. When `focusExisting` is set, the handler
   * first looks for a tab in the source window's active workspace whose
   * URL exactly matches `url`; if found, it activates that tab instead
   * of creating a new one. Useful for singleton internal pages (Bento
   * Settings, Privacy) where re-opening the button should bring the
   * existing tab forward rather than stack duplicates. */
  | { type: 'tab/openUrl'; url: string; active?: boolean; focusExisting?: boolean }
  /** Restore the most recently closed tab/window entry using Firefox's
   * SessionStore-backed WebExtension sessions API. */
  | { type: 'tab/reopenClosed' }
  /** Open a new tab at the user's configured new-tab page (about:newtab,
   * about:home, or whatever the pref points at). Uses
   * browser.tabs.create({active: true}) — no explicit URL — which avoids
   * the AboutNewTabRedirector startup-race noise that hits when chrome
   * tries to resolve about:newtab before activity-stream is ready.
   * `index` is a Firefox tab-strip index, used by the sidebar context
   * menu's "New tab below" command to insert after the clicked row. */
  | { type: 'tab/create'; active?: boolean; index?: number }
  | { type: 'tab/reload'; id: number; bypassCache?: boolean }
  | { type: 'tab/unload'; id: number }
  | { type: 'tab/setPinned'; id: number; pinned: boolean }
  | { type: 'tab/togglePin'; id: number }
  | { type: 'tab/toggleMuted'; id: number }
  | { type: 'workspaces/requestSnapshot' }
  | { type: 'workspace/create'; name: string; themeId?: string; icon?: string }
  | { type: 'workspace/rename'; id: string; name: string }
  /** Atomic update for the editable workspace fields (name + themeId + icon).
   * The edit-workspace dialog dispatches a single `workspace/update` so the
   * sidebar mirror sees one delta instead of three flickering ones, and a
   * future history/undo stack records one logical change. */
  | {
      type: 'workspace/update';
      id: string;
      changes: Partial<Pick<Workspace, 'name' | 'themeId' | 'icon'>>;
    }
  | { type: 'workspace/delete'; id: string; closeTabs?: boolean }
  | { type: 'workspace/activate'; id: string }
  | { type: 'settings/requestSnapshot' }
  | { type: 'settings/update'; changes: Partial<BentoSettings> }
  | { type: 'settings/reset' }
  /** Add an existing tab to the active workspace's side panels. Appends
   * to the panel strip (rightmost slot). No-op if already a panel.
   * Multi-panel: each workspace can have arbitrary N panels, scrolled
   * horizontally if they overflow. */
  | { type: 'panel/add'; id: number }
  | { type: 'panel/addDevtools'; tabId: number; forTabId: number | null; inspectedTabId: number }
  /** Focus an existing side panel. Used by chrome-adjacent UI such as the
   * command palette: tools activates the panel's workspace for the source
   * window, then emits panels/sync with scrollToPanelTabId so chrome scrolls
   * the strip and focuses that panel without demoting it into the main slot. */
  | { type: 'panel/focus'; workspaceId: string; id: number }
  /** Open `url` in a new tab and insert it as a panel. Default
   * (`position` omitted or `'after'`): inserts immediately after the
   * source panel — `sourceTabId === null` means the right-click happened
   * in the main panel and the new panel becomes the first side panel
   * (position 0); otherwise the new panel is inserted at sourceTabId's
   * index + 1. Backs the "Open in new panel" link context-menu item.
   *
   * `position: 'end'` ignores `sourceTabId` and appends to the end of
   * the panel strip — used by the Add-panel trailer ("+" button and
   * saved-panel favicon buttons) where the natural insertion point is
   * the rightmost slot, not "after" any particular panel. */
  | {
      type: 'panel/openAt';
      url: string;
      sourceTabId: number | null;
      position?: 'after' | 'end';
    }
  /** Remove a tab from the active workspace's panels. Tab itself
   * stays open in the sidebar list — only the panel binding goes away. */
  | { type: 'panel/remove'; id: number }
  /** Chrome-side focused panel changed. Used by the sidebar rail to mirror
   * the focused panel state onto pinned-panel favicon buttons. `null`
   * means no side panel is focused. */
  | { type: 'panel/focusedChanged'; tabId: number | null }
  /** Remove ALL panels from the active workspace (e.g., footer "close
   * side panel" button). */
  | { type: 'panels/clear' }
  /** Replace the active workspace's root layout ordering. IDs are
   * `panel:<tabId>` for panel roots and stable group IDs for grouped roots. */
  | { type: 'panelLayout/reorderRoot'; rootNodeIds: string[] }
  /** Move one visible panel leaf. Root targets break sub/split panels out
   * into the root strip; horizontal targets insert a panel next to a single
   * panel in a vertical group's top or bottom row; chooser targets fill an
   * unconfigured subdivision area with the moved panel. */
  | { type: 'panelLayout/movePanel'; tabId: number; target: PanelLayoutMoveTarget }
  /** Update the persisted width (in pixels) for a panel. Dispatched by
   * chrome from endPanelDrag after the user finishes resizing a panel
   * via its inter-panel splitter. Tools persists per-tabId; on next
   * launch the width is re-applied during reconcile. */
  | { type: 'panel/setWidth'; id: number; widthPx: number }
  /** Update whether a panel's chrome header is hidden. TabId-keyed like
   * panel/setWidth, and intentionally no sync echo because chrome applies
   * the attribute optimistically at click time. */
  | { type: 'panel/setHeaderHidden'; id: number; hidden: boolean }
  /** Update the persisted width (in pixels) for the main content slot.
   * Dispatched by chrome from endPanelDrag when the user resizes the
   * main slot. Tools scopes the write to the active workspace for the
   * dispatching window. */
  | { type: 'panel/setMainWidth'; widthPx: number }
  /** Update the persisted horizontal scroll position (in pixels) of the
   * chrome panel strip for a specific workspace. Chrome captures the
   * value from the tabpanels deck's scrollLeft on a debounced scroll
   * listener and dispatches it; tools persists per workspace and
   * includes it in the next panels/sync payload so chrome can restore
   * it after a workspace-switch reconcile. No echo: chrome already
   * holds the live value it just sent.
   *
   * `workspaceId` rides on the action (rather than resolving from
   * sourceWindowId on the tools side) because the dispatch is
   * debounced: by the time it fires the user may have switched
   * workspaces, and the SOURCE workspace's scroll value would
   * otherwise leak into the destination workspace's storage. */
  | { type: 'panel/setStripScroll'; workspaceId: string; scrollLeft: number }
  | { type: 'panelLayout/subdivide'; tabId: number }
  | { type: 'panelLayout/splitTopPanel'; tabId: number; url?: string }
  | { type: 'panelLayout/splitBottomPanel'; tabId: number; url?: string }
  | {
      type: 'panelLayout/fillChooser';
      chooserId: string;
      mode: PanelLayoutFillMode;
      urls: string[];
    }
  | { type: 'panelLayout/breakOut'; tabId: number }
  | { type: 'panelLayout/removeVerticalGroup'; groupId: string; closeDelayMs?: number }
  | { type: 'panelLayout/setGroupRatio'; groupId: string; ratio: number }
  /** Ask tools to read the current privacy settings via browser.privacy.*
   * and reply with a `privacy/snapshot` event. Sent on Privacy Dashboard
   * mount; tools doesn't push privacy/changed deltas (settings rarely
   * change without user action — the dashboard re-requests after any
   * write it dispatches). */
  | { type: 'privacy/requestSnapshot' }
  | { type: 'privacy/setProtectionLevel'; level: SelectablePrivacyProtectionLevel }
  | { type: 'privacy/setAdvanced'; key: PrivacyAdvancedKey; value: boolean | string }
  | { type: 'privacy/setDefaultSearchEngine'; id: SearchEngineId }
  | { type: 'searchEngines/requestSnapshot' }
  | { type: 'addrbar/query'; query: string; limit?: number }
  /** Pin a panel binding `(workspaceId, tabId)` to the global Pinned panels
   * rail. Validated against the live panel set — tools no-ops when the
   * tab isn't currently a panel in that workspace, or when the binding is
   * already pinned. Pins persist by URL and survive panel/tab closure;
   * users remove them explicitly from the pinned rail context menu. */
  | { type: 'pinnedPanel/add'; workspaceId: string; tabId: number }
  /** Unpin a binding. Used by both the sidebar X button and the kebab
   * "Unpin this panel" item — the underlying panel/tab stays open. */
  | { type: 'pinnedPanel/remove'; workspaceId: string; tabId: number }
  /** Click on a pinned-panel rail button: focus the specific pinned panel
   * if it still exists, otherwise recreate that panel from the pin's URL
   * and rebind the pin to the replacement tab. */
  | { type: 'pinnedPanel/open'; workspaceId: string; tabId: number }
  /** Close the panel surface for a pinned binding but keep the pin. This
   * removes the side-panel binding and backing tab without removing the
   * pinned rail entry. */
  | { type: 'pinnedPanel/close'; workspaceId: string; tabId: number }
  /** Legacy focus action for callers that need to switch to the workspace
   * that owns the pinned binding and focus the existing panel. */
  | { type: 'pinnedPanel/activate'; workspaceId: string; tabId: number }
  | { type: 'pinnedPanels/requestSnapshot' }
  /** Bookmark the panel's URL into the "Saved panels" folder under
   * "Other Bookmarks". Tools find-or-creates the folder lazily and
   * de-dupes by URL (no-op when the URL is already saved). Chrome
   * dispatches this when the user picks "Save panel" from the panel
   * kebab menu — the dispatch carries the URL + title that chrome
   * read off the panel's <browser> element. */
  | { type: 'savedPanels/save'; url: string; title: string; favIconUrl?: string }
  /** Ask tools to broadcast the current "Saved panels" folder contents
   * as a `savedPanels/snapshot` event. Sent on shell entry mount so
   * the panel-trailer iframe paints its favicon row immediately. */
  | { type: 'savedPanels/requestSnapshot' }
  /** Export workspace state as a JSON snapshot. When `workspaceIds` is
   * omitted, all workspaces are exported. Tools collects the full state
   * (including tab URLs via browser.tabs.get) and replies with
   * `backup/exportReady`. */
  | { type: 'backup/export'; workspaceIds?: string[] }
  /** Import workspace state from a validated export schema. Additive:
   * creates new workspaces with fresh UUIDs, never overwrites existing. */
  | { type: 'backup/import'; data: BentoExportSchema; options: ImportOptions }
  /** Request the list of stored auto-backups (metadata only). */
  | { type: 'backup/requestList' }
  /** Restore from a stored auto-backup by id. Same additive semantics
   * as backup/import. */
  | { type: 'backup/restore'; backupId: string }
  /** Delete a stored auto-backup by id. */
  | { type: 'backup/delete'; backupId: string }
  | { type: 'externalMerge/requestSources'; requestId: string }
  | {
      type: 'externalMerge/merge';
      sourceId: string;
      operationId: string;
      /** Optional source-space/window ids. Omit to import the whole source. */
      targetIds?: string[];
    }
  | { type: 'externalMerge/cancel'; operationId: string };

/** One entry in the "Saved panels" bookmark folder. `id` is the Firefox
 * bookmark id; `title` and `url` come straight from browser.bookmarks. */
export interface SavedPanelEntry {
  id: string;
  title: string;
  url: string;
  favIconUrl?: string;
}

/** A pinned-panel entry. Identity is `(workspaceId, tabId)` while the
 * backing tab exists. If the tab has been closed, `tabId` can be a
 * synthetic negative id until the user opens the pin and tools rebinds it
 * to a replacement tab. `order` is append-on-add and stable across
 * rebinds/restarts; the shell renders pins in ascending `order`. */
export interface PinnedPanelEntry {
  workspaceId: string;
  tabId: number;
  order: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  widthPx?: number;
}

/** Pinned-panel delta. `reordered` is currently unused (drag-to-reorder is
 * a future feature) but reserved so the wire schema doesn't need to be
 * widened later. */
export type PinnedPanelDelta =
  | { kind: 'added'; entry: PinnedPanelEntry }
  | { kind: 'updated'; workspaceId: string; tabId: number; changes: Partial<PinnedPanelEntry> }
  | { kind: 'removed'; workspaceId: string; tabId: number }
  | { kind: 'reordered'; entries: PinnedPanelEntry[] };

/** Snapshot of user-controllable privacy settings — read from
 * browser.privacy.* and refreshed after every privacy/set* action.
 * Only fields that have a Bento-side toggle. */
export interface PrivacySettings {
  protectionLevel: PrivacyProtectionLevel;
  defaultSearchEngine: SearchEngineId;
  availableSearchEngines: SearchEngineChoice[];
  safeBrowsingEnabled: boolean;
  drmEnabled: boolean;
  sanitizeOnShutdown: boolean;
  resistFingerprinting: boolean;
  letterboxing: boolean;
  networkPrediction: boolean;
  peerConnection: boolean;
  webRTCIPHandlingPolicy: string;
  httpsOnlyMode: string;
  searchSuggestionsEnabled: boolean;
  diskCacheEnabled: boolean;
  webglEnabled: boolean;
  webgpuEnabled: boolean;
  passwordSavingEnabled: boolean;
  formHistoryEnabled: boolean;
}

export interface AddrResult {
  kind: 'history' | 'bookmark' | 'topSite';
  url: string;
  title: string;
  favIconUrl?: string;
  score: number;
}

export interface AddrbarNavigatePayload {
  value: string;
  searchEngineId?: SearchEngineId;
}

export type ExternalMergeSourceKind =
  | 'firefox'
  | 'zen'
  | 'chrome'
  | 'chromium'
  | 'brave'
  | 'edge'
  | 'opera'
  | 'vivaldi';

export interface ExternalMergeTabPreview {
  title: string;
  url: string;
  pinned?: boolean;
  active?: boolean;
}

export interface ExternalMergeImportTarget {
  id: string;
  kind: 'workspace' | 'window';
  name: string;
  windowCount: number;
  tabCount: number;
  groupCount: number;
  previewTabs: ExternalMergeTabPreview[];
}

export interface ExternalMergeSource {
  id: string;
  kind: ExternalMergeSourceKind;
  browserName: string;
  profileName: string;
  lastModified: number;
  windowCount: number;
  tabCount: number;
  groupCount: number;
  targets?: ExternalMergeImportTarget[];
  unavailableReason?: string;
}

export interface ExternalMergeSummary {
  sourceId: string;
  workspacesCreated: number;
  foldersCreated: number;
  tabsOpened: number;
  pinnedTabsOpened: number;
  skippedDuplicates: number;
  skippedUnsupportedUrls: number;
  failedTabs: number;
}

export type ExternalMergeErrorCode =
  | 'busy'
  | 'cancelled'
  | 'unreadable'
  | 'unsupported-session'
  | 'unknown-source'
  | 'no-importable-tabs';

export type Event =
  | { type: 'pong'; ts: number }
  | { type: 'tools/booted'; version: string }
  | { type: 'tabs/snapshot'; tabs: TabSnapshot[] }
  | { type: 'tabs/changed'; deltas: TabDelta[] }
  | { type: 'tabFolders/snapshot'; folders: TabFolder[] }
  | { type: 'tabFolders/changed'; deltas: TabFolderDelta[] }
  | {
      type: 'workspaces/snapshot';
      workspaces: Workspace[];
      /** Global fallback active id — used by legacy clients and for any
       * window that hasn't yet activated a workspace per-window. Persists
       * across sessions. */
      activeId: string | null;
      /** Per-window active workspace map. Empty at boot (windows fall back
       * to `activeId` until each one explicitly activates per-window).
       * Populated by Zen-style per-window activations dispatched with a
       * non-null `__windowId` on the wire envelope. In-memory in tools;
       * phase G's disk sidebar will persist this. */
      activeIdByWindow: Record<number, string>;
    }
  | { type: 'workspaces/changed'; deltas: WorkspaceDelta[] }
  | { type: 'settings/snapshot'; settings: BentoSettings }
  | { type: 'settings/changed'; settings: BentoSettings }
  /** Snapshot of the active workspace's panels. Sidebar receives this and
   * forwards to chrome via title-IPC (BENTO_PANELS:<ts>:<base64-json>);
   * chrome reconciles its panel strip — adds new <browser> hosts for new
   * panels, removes hosts for gone panels, navigates existing hosts whose
   * URL changed. Sent on:
   *   - workspace activation (active panel set may differ)
   *   - panel/add (and the new tab is in the active workspace)
   *   - panel/remove / panels/clear
   *   - tab removal (if removed tab was a panel in the active workspace)
   * Title-IPC is the only chrome-bound channel bento-tools has; chrome
   * has no extension-API access. */
  | {
      type: 'panels/sync';
      /** Workspace whose panel set this event describes. The chrome shell
       * keys its panelsStore by this so the sidebar filter for any workspace
       * can read the right panel ids — solves the workspace-switch
       * transient where the previous-active panel set briefly filtered
       * the new-active tab list, leaking panel tabs into the sidebar
       * during the slide animation. */
      workspaceId: string;
      /** Optional WebExtension windowId that this sync is intended to
       * initialize. Used for new-window activation races where the shell
       * has its windowId before its local workspace mirror has applied the
       * corresponding `activated` delta. */
      windowId?: number;
      /** Active theme for this workspace at the moment tools emitted the
       * sync. Carried from tools' authoritative workspace store so chrome
       * does not depend on the shell mirror having applied the matching
       * workspaces/changed delta first. */
      themeId?: string;
      panels: Array<{
        tabId: number;
        url: string;
        title?: string;
        favIconUrl?: string;
        audible?: boolean;
        muted?: boolean;
        /** True when Firefox has unloaded the panel's backing tab. Chrome
         * dims the panel frame and its navigator icon until the tab wakes. */
        discarded?: boolean;
        widthPx?: number;
        headerHidden?: boolean;
      }>;
      /** Per-workspace main-panel width in CSS pixels. Undefined when the
       * user hasn't dragged the main splitter for this workspace yet —
       * chrome falls back to its default flex sizing in that case. */
      mainWidthPx?: number;
      /** Current Bento Settings default panel width. Chrome mirrors this
       * into the main content slot's minimum width so a fresh workspace
       * with many spawned panels keeps a normal tab-content width instead
       * of shrinking to the low chrome fallback. */
      defaultPanelWidthPx?: number;
      /** Current Bento Settings panel corner radius in CSS pixels. Chrome
       * mirrors this into `--bento-panel-corner-radius` for panel frames,
       * content clips, focus rings, and subdivision chooser frames. */
      panelCornerRadiusPx?: number;
      /** Per-workspace horizontal scroll position of the chrome panel
       * strip in CSS pixels. Chrome restores tabpanels.scrollLeft to
       * this value after the workspace-switch reconcile. Undefined
       * when nothing has been recorded for the workspace (fresh
       * workspace or never-scrolled). */
      stripScrollLeft?: number;
      /** Subset of `workspaceId`'s panel tabIds that are currently
       * pinned. Workspace-filtered (not the global pin set) so chrome's
       * kebab menu for THIS window's active workspace can `Set.has(tabId)`
       * to pick the "Pin" vs "Unpin" label without having to track the
       * cross-workspace pin map. */
      pinnedTabIdsInWorkspace?: number[];
      /** Total count of bookmarks in the "Saved panels" folder. Global —
       * not workspace-scoped — but rides on panels/sync because chrome
       * already polls this channel and needs the count to size the
       * Add-panel trailer's inline favicon row. Undefined means tools
       * has no info to share (boot path before SavedPanelsStore.init
       * has finished) and chrome should treat as zero. */
      savedPanelCount?: number;
      /** Snapshot of saved-panel bookmark options for chrome-owned surfaces
       * outside the React shell iframe, such as the subdivision chooser. */
      savedPanelItems?: SavedPanelEntry[];
      devtoolsPairs?: DevtoolsPanelLinkSync[];
      /** One-shot chrome scroll target for a panel that was just created
       * by an explicit user action. Used when panel creation races chrome
       * tab resolution: chrome retries until the panel element exists. */
      scrollToPanelTabId?: number;
      /** How chrome should reveal `scrollToPanelTabId`. `full` aligns the
       * panel's left edge for explicit focus targets. `right-edge` keeps
       * creation flows visually adjacent to the source panel by nudging the
       * new panel's right edge into view. */
      scrollToPanelReveal?: 'full' | 'right-edge';
      layout: PanelLayoutSync;
      panelStatusByTabId: Record<number, PanelLayoutStatus>;
    }
  | { type: 'privacy/snapshot'; privacy: PrivacySettings }
  | { type: 'searchEngines/snapshot'; snapshot: SearchEnginesSnapshot }
  | { type: 'addrbar/results'; query: string; results: AddrResult[] }
  | { type: 'panel/focusedChanged'; tabId: number | null; windowId?: number }
  | { type: 'pinnedPanels/snapshot'; entries: PinnedPanelEntry[] }
  | { type: 'pinnedPanels/changed'; deltas: PinnedPanelDelta[] }
  /** Full list of bookmarks in the "Saved panels" folder. Emitted on
   * shell connect, on `savedPanels/requestSnapshot`, and whenever
   * SavedPanelsStore detects a change (bookmark added/removed/renamed
   * inside the folder). The panel-trailer iframe mirrors this into its
   * Zustand store and re-renders the favicon row. */
  | { type: 'savedPanels/snapshot'; items: SavedPanelEntry[] }
  | { type: 'backup/exportReady'; json: string; filename: string }
  | { type: 'backup/importComplete'; summary: ImportSummary }
  | { type: 'backup/importError'; message: string }
  | { type: 'backup/list'; backups: BackupListEntry[] }
  | {
      type: 'externalMerge/sources';
      requestId: string;
      windowId: number | null;
      sources: ExternalMergeSource[];
    }
  | {
      type: 'externalMerge/started';
      operationId: string;
      windowId: number | null;
      sourceId: string;
    }
  | {
      type: 'externalMerge/complete';
      operationId: string;
      windowId: number | null;
      summary: ExternalMergeSummary;
    }
  | {
      type: 'externalMerge/error';
      requestId?: string;
      operationId?: string;
      windowId: number | null;
      sourceId?: string;
      code?: ExternalMergeErrorCode;
      message: string;
    };

/** Wire-level envelope around an Action: the action itself plus an
 * optional routing field that bento-shell's dispatcher stamps with the
 * source chrome window's WebExtension windowId. bento-tools reads this
 * to set `HandlerContext.sourceWindowId` so per-window state (active
 * workspace, panel emissions) routes correctly.
 *
 * `__windowId` lives in the prefix-double-underscore namespace because
 * it is NOT part of the action's semantic body — it's a routing hint
 * the action-handling code strips before dispatching to the action's
 * effect. Discriminated-union narrowing on `type` keeps working
 * unchanged: TS allows extra optional properties on union variants. */
export type WireAction = Action & { __windowId?: number };

export type WireMessage = WireAction | Event;
