// Cross-extension wire protocol. Imported by both bento-shell and bento-tools
// via the `@shared/*` TS path alias (configured in tsconfig.base.json).
//
// Pattern (§4.2): bento-shell sends Action messages to bento-tools, which
// performs the mutation against persistent state and broadcasts Event deltas
// back. The shell's Zustand stores are downstream mirrors.

export const SHELL_TOOLS_PORT = 'bento-shell<->bento-tools';

export type Action =
  | { type: 'ping' }
  | { type: 'tabs/requestSnapshot' };

export type Event =
  | { type: 'pong'; ts: number }
  | { type: 'tools/booted'; version: string };

export type WireMessage = Action | Event;
