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
  | { type: 'workspaces/requestSnapshot' }
  | { type: 'workspace/create'; name: string; color?: string; icon?: string }
  | { type: 'workspace/rename'; id: string; name: string }
  | { type: 'workspace/recolor'; id: string; color?: string }
  | { type: 'workspace/delete'; id: string }
  | { type: 'workspace/activate'; id: string }
  | { type: 'settings/requestSnapshot' }
  | { type: 'settings/update'; changes: Partial<BentoSettings> }
  | { type: 'settings/reset' };

export type Event =
  | { type: 'pong'; ts: number }
  | { type: 'tools/booted'; version: string }
  | { type: 'tabs/snapshot'; tabs: TabSnapshot[] }
  | { type: 'tabs/changed'; deltas: TabDelta[] }
  | { type: 'workspaces/snapshot'; workspaces: Workspace[]; activeId: string | null }
  | { type: 'workspaces/changed'; deltas: WorkspaceDelta[] }
  | { type: 'settings/snapshot'; settings: BentoSettings }
  | { type: 'settings/changed'; settings: BentoSettings };

export type WireMessage = Action | Event;
