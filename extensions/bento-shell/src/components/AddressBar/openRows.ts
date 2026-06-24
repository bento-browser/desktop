import type { TabSnapshot } from '@shared/protocol';

export type OpenAddressRowKind = 'tab' | 'panel';

export interface OpenAddressRow {
  id: string;
  kind: OpenAddressRowKind;
  title: string;
  subtitle: string;
  group: 'Open Tabs' | 'Open Panels';
  tabId: number;
  workspaceId?: string;
  url?: string;
  favIconUrl?: string;
  keywords: string[];
}

export interface BuildOpenRowsInput {
  query: string;
  tabsById: Record<number, TabSnapshot>;
  orderedIds: number[];
  panelsByWorkspace: Map<string, Set<number>>;
  activeWorkspaceId: string | null;
  windowId: number | null;
  limit: number;
}

interface Candidate {
  row: OpenAddressRow;
  rank: number;
  order: number;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUrl(value: string): string {
  return normalizeText(value)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '');
}

function matchRank(query: string, title: string, url?: string): number | null {
  const textQuery = normalizeText(query);
  const urlQuery = normalizeUrl(query);
  const titleText = normalizeText(title);
  const urlText = url ? normalizeUrl(url) : '';

  if (titleText.startsWith(textQuery) || (urlText && urlText.startsWith(urlQuery))) return 0;
  if (titleText.includes(textQuery) || (urlText && urlText.includes(urlQuery))) return 1;
  return null;
}

export function buildOpenRows({
  query,
  tabsById,
  orderedIds,
  panelsByWorkspace,
  activeWorkspaceId,
  windowId,
  limit,
}: BuildOpenRowsInput): OpenAddressRow[] {
  const trimmed = query.trim();
  if (!trimmed || !activeWorkspaceId || limit <= 0) return [];

  const activePanelIds = panelsByWorkspace.get(activeWorkspaceId) ?? new Set<number>();
  const candidates: Candidate[] = [];

  for (let order = 0; order < orderedIds.length; order += 1) {
    const tab = tabsById[orderedIds[order]!];
    if (!tab) continue;
    if (typeof windowId === 'number' && tab.windowId !== windowId) continue;
    if (tab.workspaceId !== activeWorkspaceId) continue;

    const title = tab.customTitle || tab.title || 'Untitled';
    const rank = matchRank(trimmed, title, tab.url);
    if (rank === null) continue;

    const isPanel = activePanelIds.has(tab.id);
    const row: OpenAddressRow = {
      id: isPanel ? `panel:${activeWorkspaceId}:${tab.id}` : `tab:${tab.id}`,
      kind: isPanel ? 'panel' : 'tab',
      title,
      subtitle: isPanel ? 'Focus Panel' : 'Switch to Tab',
      group: isPanel ? 'Open Panels' : 'Open Tabs',
      tabId: tab.id,
      keywords: isPanel ? ['panel', title] : ['tab', title],
      favIconUrl: tab.favIconUrl,
    };
    if (isPanel) row.workspaceId = activeWorkspaceId;
    if (tab.url) {
      row.url = tab.url;
      row.keywords.push(tab.url);
    }
    candidates.push({ row, rank, order });
  }

  return candidates
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((candidate) => candidate.row);
}
