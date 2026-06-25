// Layer-2 component: floating address/search bar.

import { type Key, type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  CommandPalette,
  useCommandPalette,
  type CommandPaletteCommand,
} from '@tale-ui/react/command-palette';
import { Icon } from '@tale-ui/react/icon';
import { Image } from '@tale-ui/react/image';
import { Row } from '@tale-ui/react/row';
import { Select } from '@tale-ui/react/select';

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
import { useSearchEnginesStore } from '../../state/searchEngines';
import { useTabsStore } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow } from '../../state/workspaces';
import { applyDefaultEngineIfClean, chooseEngine, resetEngineSelection } from './engineSelection';
import { buildOpenRows, type OpenAddressRowKind } from './openRows';
import './AddressBar.css';

export interface AddressBarProps {
  onClose: () => void;
  mode: AddrbarMode;
  openVersion?: number;
  initialQuery?: string;
  suppressFocus?: boolean;
}

type RowKind = OpenAddressRowKind | 'history' | 'bookmark' | 'synthetic';

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
    return <Image className="bento-address-bar__favicon" src={row.favIconUrl} alt="" />;
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
  suppressFocus = false,
}: AddressBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [engineSelection, setEngineSelection] = useState(() => resetEngineSelection(null));
  const { selectedSearchEngineId, engineSelectionDirty } = engineSelection;
  const windowId = useCurrentWindowId();
  const tabsById = useTabsStore((s) => s.byId);
  const orderedIds = useTabsStore((s) => s.orderedIds);
  const panelsByWorkspace = usePanelsStore((s) => s.byWorkspace);
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const resultQuery = useAddressBarStore((s) => s.query);
  const serverResults = useAddressBarStore((s) => s.results);
  const { defaultSearchEngine, availableSearchEngines, searchEnginesHydrated } =
    useSearchEnginesStore(
      useShallow((s) => ({
        defaultSearchEngine: s.defaultSearchEngine,
        availableSearchEngines: s.availableSearchEngines,
        searchEnginesHydrated: s.hydrated,
      })),
    );

  const openRows = useMemo<AddressRow[]>(
    () =>
      buildOpenRows({
        query,
        tabsById,
        orderedIds,
        panelsByWorkspace,
        activeWorkspaceId,
        windowId,
        limit: 8,
      }),
    [activeWorkspaceId, orderedIds, panelsByWorkspace, query, tabsById, windowId],
  );

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
        const searchEngineId =
          row.kind === 'synthetic' &&
          !isUrlLike(row.url) &&
          engineSelectionDirty &&
          selectedSearchEngineId &&
          selectedSearchEngineId !== defaultSearchEngine
            ? selectedSearchEngineId
            : undefined;
        signalAddrbarNavigate(searchEngineId ? { value: row.url, searchEngineId } : row.url);
      }
    },
    [defaultSearchEngine, engineSelectionDirty, onClose, selectedSearchEngineId],
  );

  const rows = useMemo<AddressRow[]>(() => {
    return [...openRows, ...asyncRows, ...(syntheticRow ? [syntheticRow] : [])].map((row) => ({
      ...row,
      action: () => runRow(row),
    }));
  }, [asyncRows, openRows, runRow, syntheticRow]);

  useEffect(() => {
    setQuery(initialQuery);
    if (!initialQuery) useAddressBarStore.getState().clear();
  }, [initialQuery, openVersion]);

  useEffect(() => {
    setEngineSelection(resetEngineSelection(defaultSearchEngine));
  }, [openVersion]);

  useEffect(() => {
    setEngineSelection((state) => applyDefaultEngineIfClean(state, defaultSearchEngine));
  }, [defaultSearchEngine]);

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      dispatch({ type: 'addrbar/query', query: trimmed, limit: 8 });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (suppressFocus) return;
    const focusSearch = () => {
      const input = document.querySelector('.bento-address-bar__input') as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    };
    focusSearch();
    window.addEventListener('focus', focusSearch);
    return () => window.removeEventListener('focus', focusSearch);
  }, [openVersion, suppressFocus]);

  const palette = useCommandPalette<AddressRow>({
    commands: rows,
    query,
    onQueryChange: setQuery,
    closeOnSelect: false,
    sort: () => 0,
  });

  const enginePickerDisabled = !searchEnginesHydrated || availableSearchEngines.length === 0;
  const handleSearchEngineChange = useCallback((key: Key | null) => {
    const next = typeof key === 'string' || typeof key === 'number' ? String(key) : null;
    setEngineSelection((state) => chooseEngine(state, next));
  }, []);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (
        event.key !== 'Enter' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }
      const submitRow =
        rows.find((row) => row.kind === 'synthetic') ?? palette.filteredCommands[0] ?? null;
      if (!submitRow) return;
      event.preventDefault();
      event.stopPropagation();
      void palette.runCommand(submitRow);
    },
    [palette, rows],
  );

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
            <Row gap="xs" align="center" className="bento-address-bar__toolbar">
              <CommandPalette.SearchField
                aria-label="Search or enter address"
                className="bento-address-bar__search-field"
              >
                <CommandPalette.Input
                  placeholder="Search or enter address"
                  className="bento-address-bar__input"
                  autoFocus={!suppressFocus}
                  onKeyDown={handleInputKeyDown}
                />
                <CommandPalette.ClearButton
                  aria-label="Clear search"
                  className="tale-button tale-button--ghost tale-button--sm bento-address-bar__clear-button"
                >
                  Clear
                </CommandPalette.ClearButton>
              </CommandPalette.SearchField>
              <Select.Root
                size="sm"
                placeholder="Search"
                selectedKey={selectedSearchEngineId}
                onSelectionChange={handleSearchEngineChange}
                isDisabled={enginePickerDisabled}
                className="bento-address-bar__engine-select"
              >
                <Select.Label className="bento-address-bar__sr-only">Search engine</Select.Label>
                <Select.Trigger className="bento-address-bar__engine-trigger">
                  <Select.Value />
                  <Select.Icon />
                </Select.Trigger>
                <Select.Popover className="bento-address-bar__engine-popover">
                  <Select.ListBox>
                    {availableSearchEngines.map((engine) => (
                      <Select.Item key={engine.id} id={engine.id} textValue={engine.name}>
                        {engine.name}
                      </Select.Item>
                    ))}
                  </Select.ListBox>
                </Select.Popover>
              </Select.Root>
            </Row>
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
            {query.trim().length > 0 && palette.filteredCommands.length === 0 ? (
              <CommandPalette.Empty>No matching results.</CommandPalette.Empty>
            ) : null}
          </CommandPalette.Content>
        </CommandPalette.Popup>
      </CommandPalette.Backdrop>
    </CommandPalette.Root>
  );
}
