// Static keyboard binding map. Command names match manifest.json's `commands`
// entries — keep them in sync. Each binding mutates a tools-side store
// (which auto-broadcasts via existing delta listeners). Tools-initiated UI
// events go through broadcastEvent; none currently in use after PR-2.5
// (the command palette is now triggered by a chrome <key> in bento-shell-
// mount.js, not via WebExt commands).

import type { Event } from '@shared/protocol';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import { activateWorkspaceInWindow } from '../workspaces/activateInWindow';

export interface BindingContext {
  workspaces: WorkspaceStore;
  broadcastEvent: (event: Event) => void;
}

const WORKSPACE_INDEX_PREFIX = 'workspace-';

/** The window a command was issued in. Firefox passes the active tab of that window
 * with the command (126+); without it the last focused window is the best answer. */
function commandWindow(tab: browser.tabs.Tab | undefined): Promise<browser.windows.Window> {
  return typeof tab?.windowId === 'number'
    ? browser.windows.get(tab.windowId)
    : browser.windows.getLastFocused();
}

/** Switch the command's window to the Nth workspace (1-indexed), in the order the
 * switcher and the palette show. Same outcome as choosing it there: if another window
 * already shows it, that window is focused instead. Does nothing outside a regular
 * window (a popup or a private window has no workspace to switch) or for an N past the
 * last workspace. */
async function activateWorkspaceByIndex(
  ctx: BindingContext,
  oneBased: number,
  tab: browser.tabs.Tab | undefined,
): Promise<void> {
  const window = await commandWindow(tab);
  if (typeof window.id !== 'number' || window.type !== 'normal' || window.incognito) return;
  const target = ctx.workspaces.snapshot().workspaces[oneBased - 1];
  if (!target) return;
  activateWorkspaceInWindow(ctx.workspaces, target.id, window.id);
}

export async function handleCommand(
  command: string,
  ctx: BindingContext,
  tab?: browser.tabs.Tab,
): Promise<void> {
  if (command.startsWith(WORKSPACE_INDEX_PREFIX)) {
    const n = Number(command.slice(WORKSPACE_INDEX_PREFIX.length));
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      await activateWorkspaceByIndex(ctx, n, tab);
      return;
    }
  }
  console.warn('[bento-tools] unknown command:', command);
}
