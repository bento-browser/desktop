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
}

export type TabDelta =
  | { kind: 'created'; tab: TabSnapshot }
  | { kind: 'updated'; id: number; changes: Partial<TabSnapshot> }
  | { kind: 'removed'; id: number }
  | { kind: 'activated'; id: number; windowId: number };

export type Action =
  | { type: 'ping' }
  | { type: 'tabs/requestSnapshot' }
  | { type: 'tab/activate'; id: number }
  | { type: 'tab/close'; id: number };

export type Event =
  | { type: 'pong'; ts: number }
  | { type: 'tools/booted'; version: string }
  | { type: 'tabs/snapshot'; tabs: TabSnapshot[] }
  | { type: 'tabs/changed'; deltas: TabDelta[] };

export type WireMessage = Action | Event;
