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
  | { kind: 'activated'; id: string };

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
}

export type Action =
  | { type: 'ping' }
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
  /** Ask the chrome process to open Firefox's MigrationWizard (import data
   * from another browser). Tools rebroadcasts as a chrome/openMigrationWizard
   * event; the sidebar (sole `sidePanelTitleBridge` consumer) translates it
   * into the BENTO_OPEN_MIGRATION_<ts> document.title-IPC the chrome script
   * already listens for. Chrome calls MigrationUtils.showMigrationWizard.
   * No payload — the wizard handles source selection internally. */
  | { type: 'chrome/openMigrationWizard' }
  /** Ask tools to read the current privacy settings via browser.privacy.*
   * and reply with a `privacy/snapshot` event. Sent on Privacy Dashboard
   * mount; tools doesn't push privacy/changed deltas (settings rarely
   * change without user action — the dashboard re-requests after any
   * write it dispatches). */
  | { type: 'privacy/requestSnapshot' }
  /** Update one privacy field. Tools writes via browser.privacy.* then
   * replies with a fresh privacy/snapshot. Per-field instead of a bulk
   * patch so the protocol stays readable and the handler doesn't have to
   * partial-update around invalid combinations. */
  | { type: 'privacy/setTrackingProtection'; mode: 'always' | 'never' | 'private_browsing' }
  | { type: 'privacy/setResistFingerprinting'; enabled: boolean }
  | { type: 'privacy/setNetworkPrediction'; enabled: boolean }
  | { type: 'privacy/setPeerConnection'; enabled: boolean }
  /** Clear browsing data per Firefox's browsingData API. `since` is a
   * Unix timestamp (ms) — pass 0 to clear everything. `dataTypes` mirror
   * browser.browsingData.DataTypeSet keys (cookies, history, cache,
   * passwords, etc.). */
  | {
      type: 'browsingData/clear';
      since: number;
      dataTypes: {
        cache?: boolean;
        cookies?: boolean;
        downloads?: boolean;
        formData?: boolean;
        history?: boolean;
        indexedDB?: boolean;
        localStorage?: boolean;
        passwords?: boolean;
        pluginData?: boolean;
        serviceWorkers?: boolean;
      };
    };

/** Snapshot of user-controllable privacy settings — read from
 * browser.privacy.* and refreshed after every privacy/set* action. */
export interface PrivacySettings {
  trackingProtectionMode: 'always' | 'never' | 'private_browsing';
  resistFingerprinting: boolean;
  networkPrediction: boolean;
  peerConnection: boolean;
}

export type Event =
  | { type: 'pong'; ts: number }
  | { type: 'tools/booted'; version: string }
  | { type: 'tabs/snapshot'; tabs: TabSnapshot[] }
  | { type: 'tabs/changed'; deltas: TabDelta[] }
  | { type: 'workspaces/snapshot'; workspaces: Workspace[]; activeId: string | null }
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
      panels: Array<{ tabId: number; url: string; favIconUrl?: string }>;
    }
  | { type: 'privacy/snapshot'; privacy: PrivacySettings }
  /** Reply to browsingData/clear — `ok` is true if the API call resolved
   * cleanly. The dashboard surfaces the result so the user sees positive
   * confirmation instead of guessing whether the click did anything. */
  | { type: 'browsingData/cleared'; ok: boolean; error?: string }
  /** Fan-out of chrome/openMigrationWizard. Tools rebroadcasts to every
   * connected shell entry; the sidebar (sole sidePanelTitleBridge owner)
   * translates this into a chrome-bound document.title sentinel that
   * bento-shell-mount.js polls for. Other shell entries (settings, palette,
   * privacy) ignore it — they didn't opt into chrome-IPC. */
  | { type: 'chrome/openMigrationWizard' };

export type WireMessage = Action | Event;
