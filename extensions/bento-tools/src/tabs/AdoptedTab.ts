// A tab can arrive in a window by itself: torn out of another window, dragged
// into one, or adopted as the first tab of a new window. Firefox keeps the tab
// id, and its SessionStore values come along, so the tab still names the
// workspace (and panel slot) of the window it left. Without releasing that, the
// tab is hidden from the destination sidebar and the new window opens an extra
// blank tab for its own, apparently empty, workspace.

import type { TabSnapshot } from '@shared/protocol';

export interface AdoptedTabDeps {
  tabs: {
    snapshot(): TabSnapshot[];
    clearWorkspace(id: number): Promise<void>;
    assignWorkspaceEagerly(id: number, workspaceId: string): Promise<boolean>;
  };
  /** Tabs Bento itself moved between windows; see `createProgrammaticMoves`. */
  moves: Pick<ProgrammaticMoves, 'take'>;
  /** Whether chrome handed the tab to `windowId` as its old window closed; see `tabs/Handover.ts`. */
  handedOver(tabId: number, windowId: number): Promise<boolean>;
  workspaces: {
    findOwningWindow(workspaceId: string): number | null;
    getActiveId(windowId: number): string | null;
  };
  panels: {
    findWorkspacesContainingTab(tabId: number): string[];
    remove(workspaceId: string, tabId: number): boolean;
  };
  clearPanelMarker(tabId: number): Promise<void>;
  syncPanelMarkers(workspaceId: string): void;
  emitPanelsSync(workspaceId: string): void;
}

/**
 * Detach a tab that arrived in `newWindowId` from the workspace it carried.
 * A tab Bento moved itself keeps its workspace, and so does one a closing window
 * handed over and one whose workspace the destination window shows. Otherwise the
 * tab leaves its panel layouts, loses the stale workspace, and joins the
 * destination's workspace now when it has one; a window that has not claimed a
 * workspace yet assigns it on its first activation (`adoptableTabs`).
 */
export async function releaseAdoptedTab(
  deps: AdoptedTabDeps,
  tabId: number,
  newWindowId: number,
): Promise<void> {
  // Checked first: the window that asked for the move may show another workspace by
  // the time the tab arrives, which would make the move look like a user drag.
  if (deps.moves.take(tabId, newWindowId) !== undefined) return;
  if (await deps.handedOver(tabId, newWindowId)) return;
  const tab = deps.tabs.snapshot().find((candidate) => candidate.id === tabId);
  // The tab moved on while this event waited: the event for its latest window releases it.
  if (!tab?.workspaceId || tab.windowId !== newWindowId) return;
  if (deps.workspaces.findOwningWindow(tab.workspaceId) === newWindowId) return;

  const panelWorkspaceIds = deps.panels
    .findWorkspacesContainingTab(tabId)
    .filter((workspaceId) => deps.panels.remove(workspaceId, tabId));
  if (panelWorkspaceIds.length > 0) await deps.clearPanelMarker(tabId);
  for (const workspaceId of panelWorkspaceIds) {
    deps.syncPanelMarkers(workspaceId);
    deps.emitPanelsSync(workspaceId);
  }

  await deps.tabs.clearWorkspace(tabId);
  const destinationId = deps.workspaces.getActiveId(newWindowId);
  if (destinationId) await deps.tabs.assignWorkspaceEagerly(tabId, destinationId);
}

/**
 * The tabs a freshly opened window should treat as its own when its workspace
 * has no tab yet, instead of opening a blank one: tabs without a workspace (the
 * window's initial tab, or tabs `releaseAdoptedTab` detached when several were
 * moved in together). Only a window where no tab has a workspace qualifies, so
 * switching to an empty workspace in a working window still opens its own tab.
 */
export function adoptableTabs(
  windowTabs: readonly TabSnapshot[],
  isClosing: (tabId: number) => boolean,
  isPrivate: (tabId: number) => boolean,
): TabSnapshot[] {
  if (windowTabs.some((tab) => tab.workspaceId)) return [];
  return windowTabs.filter((tab) => !isClosing(tab.id) && !isPrivate(tab.id));
}

/**
 * Moves Bento starts itself (a window claiming its workspace's tabs, an import
 * relocating tabs): tab id to the workspace the tab belongs to and the window it
 * moves to. `onAttached` cannot tell these from a user drag by looking at ownership,
 * because the window can switch workspace before the attach event arrives. An entry
 * is taken when the tab attaches and expires if it never does.
 */
export interface ProgrammaticMoves {
  expect(tabIds: readonly number[], workspaceId: string, windowId: number): void;
  forget(tabIds: readonly number[]): void;
  /**
   * The workspace the move was made for, once. A tab that attaches to another window than
   * the one the move targeted was moved by someone else: the record is discarded.
   */
  take(tabId: number, windowId: number): string | undefined;
}

export function createProgrammaticMoves(ttlMs = 10_000): ProgrammaticMoves {
  const expected = new Map<number, { workspaceId: string; windowId: number; until: number }>();
  return {
    expect(tabIds, workspaceId, windowId) {
      const now = Date.now();
      for (const [tabId, entry] of expected) if (entry.until <= now) expected.delete(tabId);
      for (const tabId of tabIds)
        expected.set(tabId, { workspaceId, windowId, until: now + ttlMs });
    },
    forget(tabIds) {
      for (const tabId of tabIds) expected.delete(tabId);
    },
    take(tabId, windowId) {
      const entry = expected.get(tabId);
      expected.delete(tabId);
      return entry && entry.windowId === windowId && entry.until > Date.now()
        ? entry.workspaceId
        : undefined;
    },
  };
}

export const bentoTabMoves = createProgrammaticMoves();

/**
 * `tabs.move` into `windowId` for tabs that belong to `workspaceId`, recorded as Bento's own.
 * The record is made before the move because the attach events can arrive before its promise
 * resolves, and trimmed to the tabs that did move: `tabs.move` skips some (a pinned tab moved
 * to the end), and a user dragging one of those out later must not read as Bento's move.
 * `index` is where they land in the destination (-1: the end).
 */
export async function moveTabsToWindow(
  tabIds: number[],
  windowId: number,
  workspaceId: string,
  index = -1,
): Promise<void> {
  bentoTabMoves.expect(tabIds, workspaceId, windowId);
  try {
    const moved = new Set(
      [await browser.tabs.move(tabIds, { windowId, index })].flat().map((t) => t.id),
    );
    bentoTabMoves.forget(tabIds.filter((tabId) => !moved.has(tabId)));
  } catch (err) {
    bentoTabMoves.forget(tabIds);
    throw err;
  }
}

/**
 * A workspace's tabs into `windowId`, pinned ones first and into the pinned region: Firefox
 * only moves a pinned tab to a position inside or right after the pinned tabs, and leaves one
 * moved to the end where it is, so the workspace would lose its pinned tabs on the way.
 */
export async function moveWorkspaceTabsToWindow(
  tabs: ReadonlyArray<{ id: number; pinned: boolean }>,
  windowId: number,
  workspaceId: string,
): Promise<void> {
  for (const pinned of [true, false]) {
    const tabIds = tabs.filter((tab) => tab.pinned === pinned).map((tab) => tab.id);
    if (tabIds.length > 0) {
      await moveTabsToWindow(tabIds, windowId, workspaceId, pinned ? 0 : -1);
    }
  }
}

/**
 * Which windows may adopt unassigned tabs. SessionStore restores tabs (and their
 * `bento.workspaceId` values) after the registry's first read, so before startup
 * has settled and hydrated an unassigned tab may only be an unread one, and writing
 * the window's workspace onto it would overwrite the real assignment. Only windows
 * created after that point qualify.
 */
export interface AdoptionGate {
  /** Remember a window that exists before the gate settles. */
  noteWindow(windowId: number): void;
  settle(): void;
  isSettled(): boolean;
  allows(windowId: number): boolean;
}

export function createAdoptionGate(): AdoptionGate {
  const startupWindows = new Set<number>();
  let settled = false;
  return {
    noteWindow(windowId) {
      if (!settled) startupWindows.add(windowId);
    },
    settle() {
      settled = true;
    },
    isSettled: () => settled,
    allows: (windowId) => settled && !startupWindows.has(windowId),
  };
}

/**
 * The tabs a window may adopt when its workspace has none: `adoptableTabs`, for a
 * window the gate allows, once their session metadata has been read and found
 * empty. One tab with a value (a restored window, an undone window close) means
 * the window is not fresh and nothing is adopted.
 */
export async function tabsToAdopt(args: {
  gate: Pick<AdoptionGate, 'allows'>;
  windowId: number;
  snapshot: () => TabSnapshot[];
  isClosing: (tabId: number) => boolean;
  isPrivate: (tabId: number) => boolean;
  confirmUnassigned: (tabIds: number[]) => Promise<number[]>;
}): Promise<TabSnapshot[]> {
  if (!args.gate.allows(args.windowId)) return [];
  const inWindow = () => args.snapshot().filter((tab) => tab.windowId === args.windowId);
  const first = adoptableTabs(inWindow(), args.isClosing, args.isPrivate);
  if (first.length === 0) return [];
  const confirmed = new Set(await args.confirmUnassigned(first.map((tab) => tab.id)));
  // Tabs can change while the metadata is read; judge the window as it is now.
  const current = adoptableTabs(inWindow(), args.isClosing, args.isPrivate);
  return current.every((tab) => confirmed.has(tab.id)) ? current : [];
}

/**
 * The tabs an activation works with for a workspace in a window: the workspace's own tabs, or for
 * an empty one the window's tabs to adopt, or else a new tab to create. Reading the adopted tabs'
 * session values takes a moment and other handlers keep assigning tabs meanwhile, so the
 * workspace's tabs are read again afterwards; creating a tab from the earlier read opened an
 * extra one next to a tab that had just been assigned.
 */
export async function settleWorkspaceTabs(args: {
  readTabs: () => TabSnapshot[];
  parkedTabsRestored: boolean;
  adoptable: () => Promise<TabSnapshot[]>;
}): Promise<{ tabs: TabSnapshot[]; adopt: TabSnapshot[]; create: boolean }> {
  let tabs = args.readTabs();
  let adopt: TabSnapshot[] = [];
  if (tabs.length === 0 && !args.parkedTabsRestored) {
    adopt = await args.adoptable();
    tabs = args.readTabs();
    if (tabs.length > 0) adopt = [];
  }
  return {
    tabs,
    adopt,
    create: tabs.length === 0 && adopt.length === 0 && !args.parkedTabsRestored,
  };
}
