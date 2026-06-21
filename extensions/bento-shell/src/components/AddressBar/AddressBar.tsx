// Layer-2 component: floating address/search bar.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  CommandPalette,
  useCommandPalette,
  type CommandPaletteCommand,
} from '@tale-ui/react/command-palette';
import { Icon } from '@tale-ui/react/icon';
import { Image } from '@tale-ui/react/image';

import BookmarkIcon from 'lucide-react/dist/esm/icons/bookmark';
import ClockIcon from 'lucide-react/dist/esm/icons/clock';
import FileIcon from 'lucide-react/dist/esm/icons/file';
import PanelRightOpenIcon from 'lucide-react/dist/esm/icons/panel-right-open';
import SearchIcon from 'lucide-react/dist/esm/icons/search';

import type { AddrResult } from '@shared/protocol';
import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import { signalAddrbarNavigate, type AddrbarMode } from '../../bridge/useAddrbar';
import { useAddressBarStore } from '../../state/addressBar';
import { usePanelsStore } from '../../state/panels';
import { useTabsStore } from '../../state/tabs';
import './AddressBar.css';

export interface AddressBarProps {
  onClose: () => void;
  mode: AddrbarMode;
  openVersion?: number;
  initialQuery?: string;
}

type RowKind = 'tab' | 'panel' | 'history' | 'bookmark' | 'synthetic';

interface AddressRow extends CommandPaletteCommand {
  id: string;
  kind: RowKind;
  title: string;
  subtitle: string;
  group: 'Open Tabs' | 'Open Panels' | 'History & Bookmarks' | 'Search';
  tabId?: number;
  workspaceId?: string;
  url?: string;
  favIconUrl?: string;
}

function isUrlLike(query: string): boolean {
  const trimmed = query.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  return /^[^\s]+\.[^\s]+$/.test(trimmed);
}

function resultSubtitle(result: AddrResult): string {
  return result.kind === 'bookmark' ? `Bookmark · ${result.url}` : `History · ${result.url}`;
}

function resultToRow(result: AddrResult): AddressRow {
  return {
    id: `${result.kind}:${result.url}`,
    kind: result.kind,
    title: result.title || result.url,
    subtitle: resultSubtitle(result),
    group: 'History & Bookmarks',
    keywords: [result.url],
    url: result.url,
    favIconUrl: result.favIconUrl,
  };
}

function rowIcon(kind: RowKind) {
  switch (kind) {
    case 'tab':
      return FileIcon;
    case 'panel':
      return PanelRightOpenIcon;
    case 'history':
      return ClockIcon;
    case 'bookmark':
      return BookmarkIcon;
    case 'synthetic':
      return SearchIcon;
  }
}

function ResultIcon({ row }: { row: AddressRow }) {
  if (row.favIconUrl) {
    return (
      <Image
        className="bento-address-bar__favicon"
        src={row.favIconUrl}
        alt=""
        radius="sm"
        fit="contain"
      />
    );
  }
  return <Icon icon={rowIcon(row.kind)} size="sm" />;
}

function ResultRow({ row }: { row: AddressRow }) {
  return (
    <>
      <CommandPalette.ItemIcon>
        <ResultIcon row={row} />
      </CommandPalette.ItemIcon>
      <CommandPalette.ItemContent>
        <CommandPalette.ItemTitle>{row.title}</CommandPalette.ItemTitle>
        <CommandPalette.ItemDescription>{row.subtitle}</CommandPalette.ItemDescription>
      </CommandPalette.ItemContent>
    </>
  );
}

function rowTextValue(row: AddressRow): string {
  return [row.title, row.subtitle, row.group, row.url].filter(Boolean).join(' ');
}

export default function AddressBar({
  onClose,
  mode,
  openVersion = 0,
  initialQuery = '',
}: AddressBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const windowId = useCurrentWindowId();
  const tabs = useTabsStore(
    useShallow((s) => s.orderedIds.map((id) => s.byId[id]).filter((tab) => !!tab)),
  );
  const panelsByWorkspace = usePanelsStore((s) => s.byWorkspace);
  const resultQuery = useAddressBarStore((s) => s.query);
  const serverResults = useAddressBarStore((s) => s.results);

  const panelInfoByTabId = useMemo(() => {
    const out = new Map<number, string>();
    for (const [workspaceId, ids] of panelsByWorkspace.entries()) {
      for (const id of ids) out.set(id, workspaceId);
    }
    return out;
  }, [panelsByWorkspace]);

  const tabRows = useMemo<AddressRow[]>(() => {
    return tabs
      .filter((tab) => {
        if (typeof windowId === 'number' && tab.windowId !== windowId) return false;
        return !panelInfoByTabId.has(tab.id);
      })
      .map((tab) => ({
        id: `tab:${tab.id}`,
        kind: 'tab',
        title: tab.title || 'Untitled',
        subtitle: 'Switch to Tab',
        group: 'Open Tabs',
        keywords: ['tab', tab.title || 'Untitled'],
        tabId: tab.id,
        favIconUrl: tab.favIconUrl,
      }));
  }, [tabs, panelInfoByTabId, windowId]);

  const panelRows = useMemo<AddressRow[]>(() => {
    const rows: AddressRow[] = [];
    for (const tab of tabs) {
      if (typeof windowId === 'number' && tab.windowId !== windowId) continue;
      const workspaceId = panelInfoByTabId.get(tab.id);
      if (!workspaceId) continue;
      rows.push({
        id: `panel:${workspaceId}:${tab.id}`,
        kind: 'panel',
        title: tab.title || 'Untitled',
        subtitle: 'Focus Panel',
        group: 'Open Panels',
        keywords: ['panel', tab.title || 'Untitled'],
        tabId: tab.id,
        workspaceId,
        favIconUrl: tab.favIconUrl,
      });
    }
    return rows;
  }, [tabs, panelInfoByTabId, windowId]);

  const asyncRows = useMemo<AddressRow[]>(() => {
    if (resultQuery !== query) return [];
    return serverResults.map(resultToRow);
  }, [query, resultQuery, serverResults]);

  const syntheticRow = useMemo<AddressRow | null>(() => {
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
  }, [mode, query]);

  const runRow = useCallback(
    (row: AddressRow) => {
      if (row.kind === 'tab' && typeof row.tabId === 'number') {
        dispatch({ type: 'tab/activate', id: row.tabId });
        onClose();
        return;
      }
      if (row.kind === 'panel' && typeof row.tabId === 'number' && row.workspaceId) {
        dispatch({ type: 'panel/focus', workspaceId: row.workspaceId, id: row.tabId });
        onClose();
        return;
      }
      if (row.url) {
        signalAddrbarNavigate(row.url);
      }
    },
    [onClose],
  );

  const rows = useMemo<AddressRow[]>(() => {
    return [...tabRows, ...panelRows, ...asyncRows, ...(syntheticRow ? [syntheticRow] : [])].map(
      (row) => ({
        ...row,
        action: () => runRow(row),
      }),
    );
  }, [asyncRows, panelRows, runRow, syntheticRow, tabRows]);

  useEffect(() => {
    setQuery(initialQuery);
    if (!initialQuery) useAddressBarStore.getState().clear();
  }, [initialQuery, openVersion]);

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      dispatch({ type: 'addrbar/query', query: trimmed, limit: 8 });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const focusSearch = () => {
      const input = document.querySelector('.bento-address-bar__input') as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    };
    focusSearch();
    window.addEventListener('focus', focusSearch);
    return () => window.removeEventListener('focus', focusSearch);
  }, [openVersion]);

  const palette = useCommandPalette<AddressRow>({
    commands: rows,
    query,
    onQueryChange: setQuery,
    closeOnSelect: false,
    sort: () => 0,
  });

  return (
    <CommandPalette.Root
      open={true}
      size="lg"
      closeOnSelect={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <CommandPalette.Backdrop
        isDismissable
        className="tale-command-palette__backdrop--transparent bento-address-bar__backdrop"
      >
        <CommandPalette.Popup
          aria-label="Address bar"
          className="bento-address-bar__dialog"
          modalProps={{
            className: 'tale-command-palette__popup--translucent bento-address-bar__popup',
          }}
        >
          <CommandPalette.Title className="bento-address-bar__sr-only">
            Address bar
          </CommandPalette.Title>
          <CommandPalette.Content
            key={openVersion}
            className="bento-address-bar__content"
            inputValue={palette.query}
            onInputChange={palette.setQuery}
          >
            <CommandPalette.SearchField aria-label="Search or enter address">
              <CommandPalette.Input
                placeholder="Search or enter address"
                className="bento-address-bar__input"
                autoFocus
              />
              <CommandPalette.ClearButton aria-label="Clear search" />
            </CommandPalette.SearchField>
            <CommandPalette.ListBox
              aria-label="Address bar results"
              className="bento-address-bar__listbox"
            >
              {palette.groupedCommands.map((group) => (
                <CommandPalette.Section key={group.id}>
                  <CommandPalette.SectionHeader>{group.title}</CommandPalette.SectionHeader>
                  {group.commands.map((row) => (
                    <CommandPalette.Item
                      key={row.id}
                      command={row}
                      textValue={rowTextValue(row)}
                      onAction={() => void palette.runCommand(row)}
                    >
                      <ResultRow row={row} />
                    </CommandPalette.Item>
                  ))}
                </CommandPalette.Section>
              ))}
            </CommandPalette.ListBox>
            {palette.filteredCommands.length === 0 ? (
              <CommandPalette.Empty>No matching results.</CommandPalette.Empty>
            ) : null}
          </CommandPalette.Content>
        </CommandPalette.Popup>
      </CommandPalette.Backdrop>
    </CommandPalette.Root>
  );
}
