// Layer-2 component: floating address/search bar.

import {
  type CSSProperties,
  type Key,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { CommandPalette, useCommandPalette } from '@tale-ui/react/command-palette';
import { Icon } from '@tale-ui/react/icon';
import { Image } from '@tale-ui/react/image';
import { Row } from '@tale-ui/react/row';
import { Select } from '@tale-ui/react/select';

import BookmarkIcon from 'lucide-react/dist/esm/icons/bookmark';
import ClockIcon from 'lucide-react/dist/esm/icons/clock';
import ClipboardIcon from 'lucide-react/dist/esm/icons/clipboard';
import FileIcon from 'lucide-react/dist/esm/icons/file';
import PanelRightOpenIcon from 'lucide-react/dist/esm/icons/panel-right-open';
import SearchIcon from 'lucide-react/dist/esm/icons/search';

import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import {
  signalAddrbarNavigate,
  type AddrbarMode,
  type AddrbarPlacement,
} from '../../bridge/useAddrbar';
import { useAddressBarStore } from '../../state/addressBar';
import { usePanelsStore } from '../../state/panels';
import { useSavedPanelsStore } from '../../state/savedPanels';
import { useSearchEnginesStore } from '../../state/searchEngines';
import { useTabsStore } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow } from '../../state/workspaces';
import { applyDefaultEngineIfClean, chooseEngine, resetEngineSelection } from './engineSelection';
import { buildOpenRows, type OpenAddressRowKind } from './openRows';
import {
  buildClipboardRow,
  buildSavedPanelRows,
  buildSyntheticRow,
  chooseSearchEngineForAddressRow,
  resultToRow,
  rowTextValue,
  type AddressRow,
  type AddressRowKind,
} from './addressRows';
import './AddressBar.css';

const ENGINE_PICKER_INTERACTION_SELECTOR =
  '.bento-address-bar__engine-select, .bento-address-bar__engine-popover';

export interface AddressBarProps {
  onClose: () => void;
  mode: AddrbarMode;
  openVersion?: number;
  initialQuery?: string;
  suppressFocus?: boolean;
  clipboardUrl?: string;
  placement?: AddrbarPlacement | null;
}

function rowIcon(kind: AddressRowKind | OpenAddressRowKind) {
  switch (kind) {
    case 'tab':
      return FileIcon;
    case 'panel':
      return PanelRightOpenIcon;
    case 'history':
    case 'topSite':
      return ClockIcon;
    case 'bookmark':
      return BookmarkIcon;
    case 'clipboard':
      return ClipboardIcon;
    case 'savedPanel':
      return PanelRightOpenIcon;
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

function SearchEngineIcon({
  engine,
  className,
}: {
  engine: { name: string; iconUrl?: string } | null;
  className: string;
}) {
  if (engine?.iconUrl) return <Image className={className} src={engine.iconUrl} alt="" />;
  return <Icon icon={SearchIcon} size="sm" className={className} />;
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

export default function AddressBar({
  onClose,
  mode,
  openVersion = 0,
  initialQuery = '',
  suppressFocus = false,
  clipboardUrl = '',
  placement = null,
}: AddressBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [engineSelection, setEngineSelection] = useState(() => resetEngineSelection(null));
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
  const { selectedSearchEngineId, engineSelectionDirty } = engineSelection;
  const windowId = useCurrentWindowId();
  const tabsById = useTabsStore((s) => s.byId);
  const orderedIds = useTabsStore((s) => s.orderedIds);
  const panelsByWorkspace = usePanelsStore((s) => s.byWorkspace);
  const savedPanels = useSavedPanelsStore((s) => s.items);
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
  const selectedEngine = useMemo(() => {
    return (
      availableSearchEngines.find((engine) => engine.id === selectedSearchEngineId) ||
      availableSearchEngines.find((engine) => engine.id === defaultSearchEngine) ||
      availableSearchEngines[0] ||
      null
    );
  }, [availableSearchEngines, defaultSearchEngine, selectedSearchEngineId]);

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

  const clipboardRow = useMemo<AddressRow | null>(() => {
    return buildClipboardRow({ mode, query, clipboardUrl });
  }, [clipboardUrl, mode, query]);

  const savedPanelRows = useMemo<AddressRow[]>(() => {
    return buildSavedPanelRows({ mode, query, savedPanels });
  }, [mode, query, savedPanels]);

  const syntheticRow = useMemo<AddressRow | null>(() => {
    return buildSyntheticRow({ mode, query });
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
      if (row.kind === 'savedPanel' && row.url) {
        dispatch({ type: 'panel/openAt', url: row.url, sourceTabId: null, position: 'end' });
        onClose();
        return;
      }
      if (row.url) {
        const searchEngineId = chooseSearchEngineForAddressRow({
          row,
          engineSelectionDirty,
          selectedSearchEngineId,
          defaultSearchEngine,
        });
        signalAddrbarNavigate(searchEngineId ? { value: row.url, searchEngineId } : row.url);
      }
    },
    [defaultSearchEngine, engineSelectionDirty, onClose, selectedSearchEngineId],
  );

  const rows = useMemo<AddressRow[]>(() => {
    return [
      ...(clipboardRow ? [clipboardRow] : []),
      ...savedPanelRows,
      ...openRows,
      ...asyncRows,
      ...(syntheticRow ? [syntheticRow] : []),
    ].map((row) => ({
      ...row,
      action: () => runRow(row),
    }));
  }, [asyncRows, clipboardRow, openRows, runRow, savedPanelRows, syntheticRow]);

  useEffect(() => {
    setQuery(initialQuery);
    if (!initialQuery) useAddressBarStore.getState().clear();
  }, [initialQuery, openVersion]);

  useEffect(() => {
    setEngineSelection(resetEngineSelection(defaultSearchEngine));
    setEnginePickerOpen(false);
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

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.bento-address-bar__popup, .bento-address-bar__engine-popover')) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [onClose]);

  const palette = useCommandPalette<AddressRow>({
    commands: rows,
    query,
    onQueryChange: setQuery,
    closeOnSelect: false,
    sort: () => 0,
  });

  const enginePickerDisabled = !searchEnginesHydrated || availableSearchEngines.length === 0;
  const popupStyle = useMemo<CSSProperties | undefined>(() => {
    if (!placement) return undefined;
    return {
      left: placement.left,
      top: placement.top,
      width: placement.width,
      height: placement.height,
    };
  }, [placement]);
  const handleSearchEngineChange = useCallback((key: Key | null) => {
    const next = typeof key === 'string' || typeof key === 'number' ? String(key) : null;
    setEngineSelection((state) => chooseEngine(state, next));
  }, []);

  const handlePalettePointerDownCapture = useCallback(
    (event: ReactPointerEvent) => {
      if (!enginePickerOpen) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(ENGINE_PICKER_INTERACTION_SELECTOR)) return;

      event.preventDefault();
      event.stopPropagation();
      setEnginePickerOpen(false);
    },
    [enginePickerOpen],
  );

  const handleEngineTriggerPointerDownCapture = useCallback(
    (event: ReactPointerEvent) => {
      if (!enginePickerOpen) return;

      event.preventDefault();
      event.stopPropagation();
      setEnginePickerOpen(false);
    },
    [enginePickerOpen],
  );

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
      <CommandPalette.Backdrop className="bento-address-bar__backdrop" isDismissable={false}>
        <CommandPalette.Popup
          aria-label="Address bar"
          className="bento-address-bar__dialog"
          onPointerDownCapture={handlePalettePointerDownCapture}
          modalProps={{
            className:
              'bento-address-bar__popup' + (placement ? ' bento-address-bar__popup--anchored' : ''),
            style: popupStyle,
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
                isOpen={enginePickerOpen}
                onOpenChange={setEnginePickerOpen}
                isDisabled={enginePickerDisabled}
                className="bento-address-bar__engine-select"
              >
                <Select.Label className="bento-address-bar__sr-only">Search engine</Select.Label>
                <Select.Trigger
                  className="bento-address-bar__engine-trigger"
                  onPointerDownCapture={handleEngineTriggerPointerDownCapture}
                >
                  <SearchEngineIcon
                    engine={selectedEngine}
                    className="bento-address-bar__engine-icon"
                  />
                  <Select.Icon />
                </Select.Trigger>
                <Select.Popover className="bento-address-bar__engine-popover" isNonModal>
                  <Select.ListBox>
                    {availableSearchEngines.map((engine) => (
                      <Select.Item key={engine.id} id={engine.id} textValue={engine.name}>
                        <span className="bento-address-bar__engine-option">
                          <SearchEngineIcon
                            engine={engine}
                            className="bento-address-bar__engine-option-icon"
                          />
                          <span className="bento-address-bar__engine-option-name">
                            {engine.name}
                          </span>
                        </span>
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
