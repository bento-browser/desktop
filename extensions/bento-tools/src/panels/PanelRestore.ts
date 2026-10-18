export interface PanelRestoreTab {
  id: number;
  /** Missing while a restored tab is still restoring: it reports `about:blank`, which is dropped. */
  url?: string;
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
 * A tab that shows the entry's address is bound first, preferring tabs already in the workspace's
 * layout (`layoutTabIds`, in layout order) over sidebar tabs. The entries left over then take the
 * panels still in the layout in their place: those came back through their session marker, so
 * their slot is filled even when the address is unreadable (a pinned panel, which Firefox restores
 * with a real browser that reports `about:blank` until it loads) or changed. Opening a tab for such
 * an entry would show the panel twice.
 */
export function planPanelRestore<Entry extends { url: string }>(
  entries: readonly Entry[],
  tabs: readonly PanelRestoreTab[],
  layoutTabIds: readonly number[],
): PanelRestoreStep<Entry>[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const inLayout = layoutTabIds.flatMap((id) => byId.get(id) ?? []);
  const free = new Set(byId.keys());
  const candidates = [...inLayout, ...tabs.filter((tab) => !layoutTabIds.includes(tab.id))];

  const steps = entries.map((entry): PanelRestoreStep<Entry> => {
    const match = candidates.find((tab) => free.has(tab.id) && tab.url === entry.url);
    if (match) free.delete(match.id);
    return { entry, tabId: match?.id ?? null };
  });

  const filledByMarker = inLayout.filter((tab) => free.has(tab.id));
  return steps.map((step) => {
    const slot = step.tabId === null ? filledByMarker.shift() : undefined;
    return slot ? { ...step, tabId: slot.id } : step;
  });
}
