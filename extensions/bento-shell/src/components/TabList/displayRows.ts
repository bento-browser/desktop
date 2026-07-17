import type { TabFolder, TabSnapshot } from '@shared/protocol';

export type DisplayRow =
  | { kind: 'tab'; id: number; indent: boolean }
  | { kind: 'folder'; folderId: string }
  | { kind: 'peek'; id: number; folderId: string }
  | { kind: 'new-tab'; afterPinnedSection: boolean };

interface BuildOptions {
  forceCollapsedFolders?: boolean;
}

export function buildDisplayRows(
  displayedIds: number[],
  tabsById: Record<number, TabSnapshot>,
  folders: TabFolder[],
  activeId: number | null,
  options: BuildOptions,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const folderMembers = new Map<string, number[]>();
  const regularRows: DisplayRow[] = [];

  for (const id of displayedIds) {
    const tab = tabsById[id];
    if (!tab) continue;
    if (tab.pinned) {
      rows.push({ kind: 'tab', id, indent: false });
      continue;
    }
    if (tab.folderId && folderIds.has(tab.folderId)) {
      const members = folderMembers.get(tab.folderId) ?? [];
      members.push(id);
      folderMembers.set(tab.folderId, members);
      continue;
    }
    regularRows.push({ kind: 'tab', id, indent: false });
  }

  for (const folder of folders) {
    rows.push({ kind: 'folder', folderId: folder.id });
    const members = folderMembers.get(folder.id) ?? [];
    const collapsed = options.forceCollapsedFolders || folder.collapsed;
    if (collapsed) {
      const activeMember = activeId !== null && members.includes(activeId) ? activeId : null;
      if (activeMember !== null) rows.push({ kind: 'peek', id: activeMember, folderId: folder.id });
      continue;
    }
    for (const id of members) rows.push({ kind: 'tab', id, indent: true });
  }

  rows.push({ kind: 'new-tab', afterPinnedSection: rows.length > 0 });
  rows.push(...regularRows);
  return rows;
}

export function flattenTabOrder(rows: DisplayRow[]): number[] {
  const out: number[] = [];
  for (const row of rows) {
    if (row.kind === 'tab' || row.kind === 'peek') out.push(row.id);
  }
  return out;
}

export function rowKey(row: DisplayRow): string {
  switch (row.kind) {
    case 'tab':
      return `tab:${row.id}:${row.indent ? 'in' : 'out'}`;
    case 'folder':
      return `folder:${row.folderId}`;
    case 'peek':
      return `peek:${row.folderId}:${row.id}`;
    case 'new-tab':
      return 'new-tab';
  }
}

/** Stable key for scroll effects that should only rerun when row geometry or
 * identity changes. Tab metadata updates (loading, discarded, title, favicon,
 * etc.) rebuild the rows array but do not change this key. */
export function displayRowsLayoutKey(rows: DisplayRow[]): string {
  return JSON.stringify(rows);
}

export function pruneSelection(selected: Set<number>, visualTabOrder: number[]): Set<number> {
  const allowed = new Set(visualTabOrder);
  const next = new Set<number>();
  for (const id of selected) {
    if (allowed.has(id)) next.add(id);
  }
  return next;
}
