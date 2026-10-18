export interface PanelRestoreTab {
  id: number;
  /** Missing while a restored tab is still restoring: it reports `about:blank`, which is dropped. */
  url?: string;
}

/** A tab that is already a panel of the workspace, in layout order. */
export interface PanelRestoreLayoutTab {
  tabId: number;
  /**
   * The layout key its session marker carried when Firefox restored it. Missing for a marker
   * written before keys existed.
   */
  panelKey?: string;
}

export interface PanelRestoreStep<Entry> {
  entry: Entry;
  /** The tab that fills the entry's slot, or null when none came back and one must be opened. */
  tabId: number | null;
}

/**
 * Binds each persisted panel entry (in order) to a tab of its workspace, so that only an entry with
 * no tab is opened again from its address.
 *
 * Identity comes first: an entry binds to the panel whose session marker carries its `panelKey`,
 * whatever that panel shows now. A page that is still restoring reports no address (a pinned panel,
 * which Firefox restores with a real browser that reports `about:blank` until it loads) and a panel
 * may have navigated away, so neither address nor position can say which entry a panel is. The
 * entries left then bind by exact address, to panels already in the layout (those without a key, or
 * whose key matches no entry) before sidebar tabs, so a sidebar tab at a panel's address never takes
 * the entry of a panel that came back with its marker. An entry still unbound has no tab, and the
 * caller opens one. The panels left unbound stay in the layout (see `restorePersistedLayout`).
 */
export function planPanelRestore<Entry extends { panelKey: string; url: string }>(
  entries: readonly Entry[],
  tabs: readonly PanelRestoreTab[],
  layoutPanels: readonly PanelRestoreLayoutTab[],
): PanelRestoreStep<Entry>[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const panels = layoutPanels.filter((panel) => byId.has(panel.tabId));
  const panelIds = new Set(panels.map((panel) => panel.tabId));
  const taken = new Set<number>();
  const bound = entries.map((): number | null => null);
  const bind = (index: number, tabId: number) => {
    bound[index] = tabId;
    taken.add(tabId);
  };

  entries.forEach((entry, index) => {
    const panel = panels.find((p) => p.panelKey === entry.panelKey && !taken.has(p.tabId));
    if (panel) bind(index, panel.tabId);
  });

  const panelTabs = panels.map((panel) => byId.get(panel.tabId)!);
  const sidebarTabs = tabs.filter((tab) => !panelIds.has(tab.id));
  for (const pool of [panelTabs, sidebarTabs]) {
    entries.forEach((entry, index) => {
      if (bound[index] !== null) return;
      const tab = pool.find((t) => !taken.has(t.id) && t.url === entry.url);
      if (tab) bind(index, tab.id);
    });
  }

  return entries.map((entry, index) => ({ entry, tabId: bound[index] ?? null }));
}
