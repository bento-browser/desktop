import type { CommandPaletteCommand } from '@tale-ui/react/command-palette';
import type { AddrResult, SavedPanelEntry, SearchEngineId } from '@shared/protocol';
import type { AddrbarMode } from '../../bridge/useAddrbar';
import type { OpenAddressRowKind } from './openRows';

export type AddressRowKind =
  | OpenAddressRowKind
  | 'history'
  | 'bookmark'
  | 'topSite'
  | 'clipboard'
  | 'savedPanel'
  | 'synthetic';

export interface AddressRow extends CommandPaletteCommand {
  id: string;
  kind: AddressRowKind;
  title: string;
  subtitle: string;
  group:
    | 'Clipboard'
    | 'Saved Panels'
    | 'Top Sites'
    | 'Open Tabs'
    | 'Open Panels'
    | 'History & Bookmarks'
    | 'Search';
  tabId?: number;
  workspaceId?: string;
  url?: string;
  favIconUrl?: string;
}

export function isUrlLike(query: string): boolean {
  const trimmed = query.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  return /^[^\s]+\.[^\s]+$/.test(trimmed);
}

function resultSubtitle(result: AddrResult): string {
  if (result.kind === 'bookmark') return `Bookmark · ${result.url}`;
  if (result.kind === 'topSite') return `Top site · ${result.url}`;
  return `History · ${result.url}`;
}

export function resultToRow(result: AddrResult): AddressRow {
  return {
    id: `${result.kind}:${result.url}`,
    kind: result.kind,
    title: result.title || result.url,
    subtitle: resultSubtitle(result),
    group: result.kind === 'topSite' ? 'Top Sites' : 'History & Bookmarks',
    keywords: [result.url],
    url: result.url,
    favIconUrl: result.favIconUrl,
  };
}

export function buildClipboardRow({
  mode,
  query,
  clipboardUrl,
}: {
  mode: AddrbarMode;
  query: string;
  clipboardUrl: string;
}): AddressRow | null {
  const url = clipboardUrl.trim();
  if (mode !== 'newTab' || query.trim() || !url) return null;
  return {
    id: `clipboard:${url}`,
    kind: 'clipboard',
    title: `Open ${url}`,
    subtitle: 'From clipboard',
    group: 'Clipboard',
    keywords: [url],
    url,
  };
}

export function buildSavedPanelRows({
  mode,
  query,
  savedPanels,
}: {
  mode: AddrbarMode;
  query: string;
  savedPanels: SavedPanelEntry[];
}): AddressRow[] {
  if (mode !== 'newTab' || query.trim()) return [];
  return savedPanels.map((item) => ({
    id: `saved-panel:${item.id}`,
    kind: 'savedPanel',
    title: item.title.trim().length > 0 ? item.title : item.url,
    subtitle: 'Open saved panel',
    group: 'Saved Panels',
    keywords: [item.title, item.url, 'saved panel'],
    url: item.url,
    favIconUrl: item.favIconUrl,
  }));
}

export function buildSyntheticRow({
  mode,
  query,
}: {
  mode: AddrbarMode;
  query: string;
}): AddressRow | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const open = isUrlLike(trimmed);
  return {
    id: 'synthetic:submit',
    kind: 'synthetic',
    title: open ? `Open ${trimmed}` : `Search for ${trimmed}`,
    subtitle: mode === 'newTab' ? 'Open in new tab' : 'Open in current tab',
    group: 'Search',
    keywords: [trimmed],
    url: trimmed,
  };
}

export function rowTextValue(row: AddressRow): string {
  return [row.title, row.subtitle, row.group, row.url].filter(Boolean).join(' ');
}

export function chooseSearchEngineForAddressRow({
  row,
  engineSelectionDirty,
  selectedSearchEngineId,
  defaultSearchEngine,
}: {
  row: AddressRow;
  engineSelectionDirty: boolean;
  selectedSearchEngineId: SearchEngineId | null;
  defaultSearchEngine: SearchEngineId | null;
}): SearchEngineId | undefined {
  if (row.kind !== 'synthetic' || !row.url || isUrlLike(row.url)) return undefined;
  if (!engineSelectionDirty || !selectedSearchEngineId) return undefined;
  if (selectedSearchEngineId === defaultSearchEngine) return undefined;
  return selectedSearchEngineId;
}
