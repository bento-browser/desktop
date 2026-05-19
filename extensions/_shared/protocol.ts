// Cross-extension wire protocol. Imported by both bento-shell and bento-tools
// via the `@shared/*` TS path alias (configured in tsconfig.base.json).
//
// Pattern (§4.2): bento-shell sends Action messages to bento-tools, which
// performs the mutation against persistent state and broadcasts Event deltas
// back. The shell's Zustand stores are downstream mirrors.

export const SHELL_TOOLS_PORT = 'bento-shell<->bento-tools';

/** Compact tab payload sent over the wire (§6.5: no `url` until tooltip-needed). */
export interface TabSnapshot {
  id: number;
  windowId: number;
  index: number;
  title: string;
  favIconUrl?: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
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
}

export type TabDelta =
  | { kind: 'created'; tab: TabSnapshot }
  | { kind: 'updated'; id: number; changes: Partial<TabSnapshot> }
  | { kind: 'removed'; id: number }
  | { kind: 'activated'; id: number; windowId: number };

/** Workspace metadata. `color` keys into `data-workspace-color` on <html>
 * (see bento-tokens.css per-workspace accent presets). */
export interface Workspace {
  id: string;
  name: string;
  /** Accent palette key. Must match a [data-workspace-color="<color>"] block
   * in bento-tokens.css ('blue' | 'emerald' | 'amber' | … or undefined for default). */
  color?: string;
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

/** User-configurable Bento settings. Persisted in storage.local; defaults
 * mirror the values declared in prefs/bento.js (the latter remain the source
 * of truth for "what Bento ships as"; SettingsStore lets users override).
 *
 * Add a new field by: (1) extending this interface, (2) adding a default
 * in DEFAULT_SETTINGS in SettingsStore.ts, (3) reading it where consumed.
 * Reverting a field to default = removing it from storage.local. */
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
   * rest. Only 'light' / 'dark' — the previous 'system' (follow-OS)
   * option was removed in favour of explicit user choice; persisted
   * 'system' values from older builds are migrated to 'dark' on load
   * (see SettingsStore.init). */
  uiColorMode: ColorModePref;
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
  /** Default width (CSS pixels) applied to a newly-added panel before
   * the user has dragged its splitter. Persists per panel after the
   * first drag (PanelStore.setWidth). 640 is wide enough for most
   * sites' content without horizontally squishing them yet narrow
   * enough that 2-3 panels fit comfortably on a typical 1440px+
   * viewport. */
  defaultPanelWidthPx: number;
}

export type ColorModePref = 'light' | 'dark';

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
  | { type: 'tab/activate'; id: number }
  | { type: 'tab/close'; id: number }
  | { type: 'tab/assignWorkspace'; id: number; workspaceId: string }
  | { type: 'tab/openUrl'; url: string; active?: boolean }
  /** Open a new tab at the user's configured new-tab page (about:newtab,
   * about:home, or whatever the pref points at). Uses
   * browser.tabs.create({active: true}) — no explicit URL — which avoids
   * the AboutNewTabRedirector startup-race noise that hits when chrome
   * tries to resolve about:newtab before activity-stream is ready. */
  | { type: 'tab/create'; active?: boolean }
  | { type: 'tab/reload'; id: number; bypassCache?: boolean }
  | { type: 'tab/togglePin'; id: number }
  | { type: 'workspaces/requestSnapshot' }
  | { type: 'workspace/create'; name: string; color?: string; icon?: string }
  | { type: 'workspace/rename'; id: string; name: string }
  | { type: 'workspace/recolor'; id: string; color?: string }
  /** Atomic update for the editable workspace fields (name + color + icon).
   * The edit-workspace dialog dispatches a single `workspace/update` so the
   * sidebar mirror sees one delta instead of three flickering ones, and a
   * future history/undo stack records one logical change. */
  | {
      type: 'workspace/update';
      id: string;
      changes: Partial<Pick<Workspace, 'name' | 'color' | 'icon'>>;
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
  /** Open `url` in a new tab and insert it as a panel immediately
   * after the source panel. `sourceTabId === null` means the right-
   * click happened in the main panel — the new panel becomes the
   * first side panel (position 0). Otherwise the new panel is
   * inserted at sourceTabId's index + 1. Backs the "Open in new
   * panel" link context-menu item in chrome. */
  | { type: 'panel/openAt'; url: string; sourceTabId: number | null }
  /** Remove a tab from the active workspace's panels. Tab itself
   * stays open in the sidebar list — only the panel binding goes away. */
  | { type: 'panel/remove'; id: number }
  /** Remove ALL panels from the active workspace (e.g., footer "close
   * side panel" button). */
  | { type: 'panels/clear' }
  /** Replace the active workspace's panel ordering with `tabIds`. Must be
   * a permutation of the current panel set — the handler validates and
   * drops the reorder if it isn't (no add/remove via this channel). Sent
   * by chrome after a navigator drag-and-drop completes (drop-on-release,
   * not live during the drag). */
  | { type: 'panel/reorder'; tabIds: number[] }
  /** Update the persisted width (in pixels) for a panel. Dispatched by
   * chrome from endPanelDrag after the user finishes resizing a panel
   * via its inter-panel splitter. Tools persists per-tabId; on next
   * launch the width is re-applied during reconcile. */
  | { type: 'panel/setWidth'; id: number; widthPx: number }
  /** Update the persisted width (in pixels) for the main panel of the
   * active workspace. Dispatched by chrome from endPanelDrag when the
   * user resizes the main slot. Per-workspace because users size their
   * main slot differently for different workflows (wide for reading,
   * narrow for tool-strip workspaces, etc.). */
  | { type: 'panel/setMainWidth'; widthPx: number }
  /** Ask tools to read the current privacy settings via browser.privacy.*
   * and reply with a `privacy/snapshot` event. Sent on Privacy Dashboard
   * mount; tools doesn't push privacy/changed deltas (settings rarely
   * change without user action — the dashboard re-requests after any
   * write it dispatches). */
  | { type: 'privacy/requestSnapshot' }
  /** Update one privacy field. Tools writes via browser.privacy.* then
   * replies with a fresh privacy/snapshot. Per-field instead of a bulk
   * patch so the protocol stays readable and the handler doesn't have to
   * partial-update around invalid combinations.
   *
   * Tracking protection (browser.privacy.websites.trackingProtectionMode) and
   * browsing-data clearing live in Firefox's about:preferences#privacy,
   * not in Bento — those are first-party Firefox surfaces and duplicating
   * them in the Bento UI was just visual indirection. The three controls
   * below are the prefs Firefox does NOT expose in its preferences UI
   * (about:config only); Bento exposes them in Settings → Privacy. */
  | { type: 'privacy/setResistFingerprinting'; enabled: boolean }
  | { type: 'privacy/setNetworkPrediction'; enabled: boolean }
  | { type: 'privacy/setPeerConnection'; enabled: boolean };

/** Snapshot of user-controllable privacy settings — read from
 * browser.privacy.* and refreshed after every privacy/set* action.
 * Only fields that have a Bento-side toggle. */
export interface PrivacySettings {
  resistFingerprinting: boolean;
  networkPrediction: boolean;
  peerConnection: boolean;
}

export type Event =
  | { type: 'pong'; ts: number }
  | { type: 'tools/booted'; version: string }
  | { type: 'tabs/snapshot'; tabs: TabSnapshot[] }
  | { type: 'tabs/changed'; deltas: TabDelta[] }
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
      panels: Array<{ tabId: number; url: string; favIconUrl?: string; widthPx?: number }>;
      /** Per-workspace main-panel width in CSS pixels. Undefined when the
       * user hasn't dragged the main splitter for this workspace yet —
       * chrome falls back to its default flex sizing in that case. */
      mainWidthPx?: number;
    }
  | { type: 'privacy/snapshot'; privacy: PrivacySettings };

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
