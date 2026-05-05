// Static keyboard binding map. Command names match manifest.json's `commands`
// entries — keep them in sync. Each binding mutates a tools-side store
// (which auto-broadcasts via existing delta listeners). Tools-initiated UI
// events go through broadcastEvent; none currently in use after PR-2.5
// (the command palette is now triggered by a chrome <key> in bento-shell-
// mount.js, not via WebExt commands).

import type { Event } from '@shared/protocol';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';

export interface BindingContext {
  workspaces: WorkspaceStore;
  broadcastEvent: (event: Event) => void;
}

const WORKSPACE_INDEX_PREFIX = 'workspace-';

/** Activate the Nth workspace (1-indexed) by ordered insertion. No-op if N
 * exceeds the current workspace count — Cmd+Alt+9 with 3 workspaces should
 * be silently ignored, not crash. */
function activateWorkspaceByIndex(ctx: BindingContext, oneBased: number): void {
  const ordered = ctx.workspaces.snapshot().workspaces;
  const target = ordered[oneBased - 1];
  if (!target) return;
  ctx.workspaces.activate(target.id);
}

export function handleCommand(command: string, ctx: BindingContext): void {
  if (command.startsWith(WORKSPACE_INDEX_PREFIX)) {
    const n = Number(command.slice(WORKSPACE_INDEX_PREFIX.length));
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      activateWorkspaceByIndex(ctx, n);
      return;
    }
  }
  console.warn('[bento-tools] unknown command:', command);
}
