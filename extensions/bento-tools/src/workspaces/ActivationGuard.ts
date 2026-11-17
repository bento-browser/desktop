// Decisions a workspace activation makes before it moves, creates or selects tabs. Kept apart from
// background.ts so they can be tested with a real WorkspaceStore.

import type { TabSnapshot } from '@shared/protocol';

/**
 * Whether `workspaceId` is still the workspace its window shows (`windowId` null: the global
 * fallback). An activation can wait before it acts (boot holds them until the restore is done)
 * and it awaits tab moves and reads on the way; if the window switched workspaces meanwhile, a
 * later activation owns the window and this one must stop, or it would select a tab of the
 * workspace the window no longer shows. The workspace alone cannot tell A, B, A apart: both A
 * activations match, so `ActivationGenerations` also tells which one is the latest.
 */
export function isActivationCurrent(
  workspaceId: string,
  windowId: number | null,
  getActiveId: (windowId: number | null) => string | null,
): boolean {
  return getActiveId(windowId) === workspaceId;
}

export interface ActivationGenerations {
  /**
   * Registers an activation for the window (null: the global fallback) and returns a check that
   * holds until a later activation begins for the same window, or the window is forgotten. Call
   * it when the activation is requested, before it waits for anything.
   */
  begin(windowId: number | null): () => boolean;
  /** Supersedes whatever is still running for a window that no longer exists. */
  forget(windowId: number): void;
}

/**
 * A generation counter per window. Every activation takes the next number when it is requested
 * and may go on only while it holds the window's latest, so with A, B, A held at startup the
 * first A stops as well as B, and only the last A acts.
 */
export function createActivationGenerations(): ActivationGenerations {
  const latestByWindow = new Map<number | null, number>();
  let counter = 0;
  return {
    begin(windowId) {
      const generation = ++counter;
      latestByWindow.set(windowId, generation);
      return () => latestByWindow.get(windowId) === generation;
    },
    forget(windowId) {
      latestByWindow.delete(windowId);
    },
  };
}

/**
 * Whether a tab of the workspace is already the selected tab of the window (`windowId` null: of
 * any window). A selected panel counts as much as a selected sidebar tab: the panel is the page
 * the user was on, and selecting the workspace's first sidebar tab would take the selection away.
 */
export function hasSelectedWorkspaceTab(
  tabs: ReadonlyArray<Pick<TabSnapshot, 'workspaceId' | 'windowId' | 'active'>>,
  workspaceId: string,
  windowId: number | null,
): boolean {
  return tabs.some(
    (tab) =>
      tab.active &&
      tab.workspaceId === workspaceId &&
      (windowId === null || tab.windowId === windowId),
  );
}

/**
 * Selects a tab for an activation, unless a later activation took the window while the tab was
 * read (resolves false, nothing selected). A missing tab or failed selection rejects.
 */
export async function selectTabIfCurrent(
  tabId: number,
  stillCurrent: () => boolean,
): Promise<boolean> {
  await browser.tabs.get(tabId);
  if (!stillCurrent()) return false;
  await browser.tabs.update(tabId, { active: true });
  return true;
}

/**
 * Waits for an activation's tab selection, then emits its panels, also when the selection failed;
 * not when the activation was superseded meanwhile. Chrome must see the destination tab's
 * TabSelect before the panels: the switch curtain cuts with no fade-out, so panels that arrive
 * first are reconciled around the outgoing tab and lift the curtain.
 */
export async function selectThenEmitPanels(
  selection: Promise<unknown> | null,
  stillCurrent: () => boolean,
  emitPanels: () => void,
): Promise<void> {
  try {
    await selection;
  } catch (err) {
    console.warn('[bento-tools] workspace tab selection failed:', err);
  }
  if (stillCurrent()) emitPanels();
}
