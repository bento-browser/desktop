// Layer-2 component: floating address/search bar.

import {
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/shallow';
import { Button, CommandPalette, Image, Select, useCommandPalette } from '@muxui/react';

import BookmarkIcon from 'lucide-react/dist/esm/icons/bookmark';
import ChevronDownIcon from 'lucide-react/dist/esm/icons/chevron-down';
import ClockIcon from 'lucide-react/dist/esm/icons/clock';
import ClipboardIcon from 'lucide-react/dist/esm/icons/clipboard';
import FileIcon from 'lucide-react/dist/esm/icons/file';
import PanelRightOpenIcon from 'lucide-react/dist/esm/icons/panel-right-open';
import RotateCcwIcon from 'lucide-react/dist/esm/icons/rotate-ccw';
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
import { replaceSelectionWithSafePaste } from './unsafeProtocol';
import { BentoIcon, Row } from '../primitives';
import { IN_TAB_ORDER } from '../primitives/inTabOrder';
import {
  FOCUS_ON_HOVER,
  ROW_HIGHLIGHT_CLASS,
  useRowHighlight,
} from '../primitives/useRowHighlight';
import {
  buildClipboardRow,
  buildSavedPanelRows,
  buildSyntheticRow,
  chooseSearchEngineForAddressRow,
  resultToRow,
  resultAge,
  rowTextValue,
  type AddressRow,
  type AddressRowKind,
} from './addressRows';
import { useAddressBarGrow } from './useAddressBarGrow';
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

type AddressBarBackdropStyle = CSSProperties & {
  '--bento-address-bar-popup-left'?: string;
  '--bento-address-bar-popup-top'?: string;
  '--bento-address-bar-popup-width'?: string;
  '--bento-address-bar-popup-height'?: string;
};

function rowIcon(kind: AddressRowKind | OpenAddressRowKind) {
  switch (kind) {
    case 'tab':
      return FileIcon;
    case 'panel':
      return PanelRightOpenIcon;
    case 'recentlyClosed':
      return RotateCcwIcon;
    case 'recentHistory':
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
  return <BentoIcon icon={rowIcon(row.kind)} size="sm" />;
}

function SearchEngineIcon({
  engine,
  className,
}: {
  engine: { name: string; iconUrl?: string } | null;
  className: string;
}) {
  if (engine?.iconUrl) return <Image className={className} src={engine.iconUrl} alt="" />;
  return <BentoIcon icon={SearchIcon} size="sm" className={className} />;
}

function ResultRow({ row, pending }: { row: AddressRow; pending: boolean }) {
  return (
    <>
      <CommandPalette.ItemIcon>
        <ResultIcon row={row} />
      </CommandPalette.ItemIcon>
      <CommandPalette.ItemContent>
        <CommandPalette.ItemTitle>{row.title}</CommandPalette.ItemTitle>
        <CommandPalette.ItemDescription>{row.subtitle}</CommandPalette.ItemDescription>
      </CommandPalette.ItemContent>
      {row.kind === 'recentlyClosed' ? (
        <CommandPalette.ItemMeta className="bento-address-bar__reopen">
          {pending ? 'Reopening…' : 'Reopen'}
        </CommandPalette.ItemMeta>
      ) : null}
      {row.timestamp !== undefined ? (
        <CommandPalette.ItemMeta className="bento-address-bar__timestamp">
          {resultAge(row.timestamp)}
        </CommandPalette.ItemMeta>
      ) : null}
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
  const highlightRef = useRowHighlight();
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const [enginePickerHost, setEnginePickerHost] = useState<HTMLDivElement | null>(null);
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
  const pendingRestore = useAddressBarStore((s) => s.pendingRestore);
  const restored = useAddressBarStore((s) => s.restored);
  const restoreError = useAddressBarStore((s) => s.error);
  const refreshVersion = useAddressBarStore((s) => s.refreshVersion);
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
    if (resultQuery !== query.trim()) return [];
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
      const store = useAddressBarStore.getState();
      if (store.pendingRestore || store.restored) return;
      if (row.kind === 'recentlyClosed' && row.sessionId) {
        const requestId = crypto.randomUUID();
        if (store.beginRestore(requestId, row.sessionId)) {
          dispatch({ type: 'addrbar/restoreClosed', requestId, sessionId: row.sessionId });
        }
        return;
      }
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
    const defaults = [...(clipboardRow ? [clipboardRow] : []), ...savedPanelRows];
    return [
      ...(!query.trim() ? [...asyncRows, ...defaults] : [...defaults, ...openRows, ...asyncRows]),
      ...(syntheticRow ? [syntheticRow] : []),
    ].map((row) => ({
      ...row,
      action: () => runRow(row),
      disabled: pendingRestore !== null,
    }));
  }, [
    asyncRows,
    clipboardRow,
    openRows,
    pendingRestore,
    query,
    runRow,
    savedPanelRows,
    syntheticRow,
  ]);

  useLayoutEffect(() => {
    setQuery(initialQuery);
    useAddressBarStore.getState().clear();
  }, [initialQuery, openVersion]);

  useEffect(() => {
    setEngineSelection(resetEngineSelection(defaultSearchEngine));
    setEnginePickerOpen(false);
  }, [openVersion]);

  useEffect(() => {
    setEngineSelection((state) => applyDefaultEngineIfClean(state, defaultSearchEngine));
  }, [defaultSearchEngine]);

  useLayoutEffect(() => {
    // Register before dispatch, including unchanged queries on a fresh open.
    const trimmed = query.trim();
    const requestId = crypto.randomUUID();
    useAddressBarStore.getState().beginQuery(requestId, trimmed);
    const timer = window.setTimeout(() => {
      dispatch({ type: 'addrbar/query', requestId, query: trimmed, limit: 8 });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      if (useAddressBarStore.getState().requestId === requestId) {
        useAddressBarStore.setState({ requestId: null });
      }
    };
  }, [query, openVersion, refreshVersion]);

  useEffect(() => {
    if (restored) onClose();
  }, [onClose, restored]);

  const changeQuery = useCallback((value: string) => {
    useAddressBarStore.getState().clear();
    setQuery(value);
  }, []);

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
      if (target.closest('.muxui-command-palette__popup, .bento-address-bar__engine-popover')) {
        return;
      }
      onClose();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [onClose]);

  const palette = useCommandPalette<AddressRow>({
    commands: rows,
    query,
    onQueryChange: changeQuery,
    closeOnSelect: false,
    sort: () => 0,
  });

  useAddressBarGrow(dialog, placement, openVersion);

  const enginePickerDisabled = !searchEnginesHydrated || availableSearchEngines.length === 0;
  const backdropStyle = useMemo<AddressBarBackdropStyle>(() => {
    if (!placement) return {};
    return {
      '--bento-address-bar-popup-left': `${placement.left}px`,
      '--bento-address-bar-popup-top': `${placement.top}px`,
      '--bento-address-bar-popup-width': `${placement.width}px`,
      '--bento-address-bar-popup-height': `${placement.height}px`,
    };
  }, [placement]);
  const handleSearchEngineChange = useCallback((value?: string) => {
    setEngineSelection((state) => chooseEngine(state, value ?? null));
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
        !query.trim() ||
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
    [palette, query, rows],
  );

  const handleInputPaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      const pasted = event.clipboardData.getData('text/plain');
      const result = replaceSelectionWithSafePaste(
        event.currentTarget.value,
        event.currentTarget.selectionStart,
        event.currentTarget.selectionEnd,
        pasted,
      );
      if (!result.changed) return;
      event.preventDefault();
      const input = event.currentTarget;
      palette.setQuery(result.value);
      requestAnimationFrame(() => input.setSelectionRange(result.cursor, result.cursor));
    },
    [palette],
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
        className="bento-address-bar__backdrop"
        dismissable={false}
        style={backdropStyle}
      >
        {placement ? <div className="bento-address-bar__shadow" aria-hidden="true" /> : null}
        <CommandPalette.Popup
          ref={setDialog}
          aria-label="Address bar"
          className={`bento-address-bar__dialog bento-address-bar__popup${placement ? ' bento-address-bar__popup--anchored' : ''}`}
          onPointerDownCapture={handlePalettePointerDownCapture}
        >
          <CommandPalette.Title className="bento-address-bar__sr-only">
            Address bar
          </CommandPalette.Title>
          <CommandPalette.Content key={openVersion} className="bento-address-bar__content">
            <Row
              gap="xs"
              align="center"
              className={`bento-address-bar__toolbar${placement ? ' bento-address-bar__toolbar--anchored' : ''}`}
            >
              <CommandPalette.SearchField
                aria-label="Search or enter address"
                className="bento-address-bar__search-field"
              >
                {placement ? (
                  <span className="bento-address-bar__row-icon">
                    <BentoIcon icon={SearchIcon} size="sm" />
                  </span>
                ) : null}
                <CommandPalette.Input
                  readOnly={pendingRestore !== null}
                  placeholder="Search or enter address"
                  className="bento-address-bar__input"
                  value={palette.query}
                  onChange={(event) => palette.setQuery(event.currentTarget.value)}
                  autoFocus={!suppressFocus}
                  onKeyDown={handleInputKeyDown}
                  onPaste={handleInputPaste}
                />
                {palette.query.length > 0 ? (
                  <Button
                    disabled={pendingRestore !== null}
                    variant="ghost"
                    size="sm"
                    aria-label="Clear search"
                    className="bento-address-bar__clear-button"
                    onActivate={() => palette.setQuery('')}
                    {...IN_TAB_ORDER}
                  >
                    Clear
                  </Button>
                ) : null}
              </CommandPalette.SearchField>
              <div ref={setEnginePickerHost} className="bento-address-bar__engine-slot" />
            </Row>
            <CommandPalette.ListBox
              ref={highlightRef}
              aria-label="Address bar results"
              className={`bento-address-bar__listbox ${ROW_HIGHLIGHT_CLASS}${!query.trim() ? ' bento-address-bar__listbox--recents' : ''}`}
              aria-busy={pendingRestore !== null}
              {...FOCUS_ON_HOVER}
            >
              {palette.groupedCommands.map((group) => (
                <CommandPalette.Section key={group.id}>
                  <CommandPalette.SectionHeader>{group.title}</CommandPalette.SectionHeader>
                  {group.commands.map((row) => (
                    <CommandPalette.Item
                      key={row.id}
                      {...palette.getItemProps(row)}
                      textValue={rowTextValue(row)}
                      data-kind={row.kind}
                      data-pending={
                        (row.kind === 'recentlyClosed' &&
                          pendingRestore?.sessionId === row.sessionId) ||
                        undefined
                      }
                      aria-label={
                        row.kind === 'recentlyClosed'
                          ? `Reopen ${row.title}, ${row.subtitle}`
                          : undefined
                      }
                    >
                      <ResultRow row={row} pending={pendingRestore?.sessionId === row.sessionId} />
                    </CommandPalette.Item>
                  ))}
                </CommandPalette.Section>
              ))}
            </CommandPalette.ListBox>
            {restoreError ? (
              <div role="status" className="bento-address-bar__status">
                {restoreError}
              </div>
            ) : null}
            {query.trim().length > 0 && palette.filteredCommands.length === 0 ? (
              <CommandPalette.Empty className="bento-address-bar__empty">
                No matching results.
              </CommandPalette.Empty>
            ) : null}
          </CommandPalette.Content>
          {/* Keep Select outside Content's Autocomplete context; the portal only restores its toolbar position. */}
          {enginePickerHost
            ? createPortal(
                <Select.Root
                  size="sm"
                  placeholder="Search"
                  value={selectedSearchEngineId ?? undefined}
                  onChange={handleSearchEngineChange}
                  open={enginePickerOpen}
                  onOpenChange={setEnginePickerOpen}
                  disabled={enginePickerDisabled}
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
                    <Select.Value className="bento-address-bar__sr-only">
                      {selectedEngine?.name ?? 'Search'}
                    </Select.Value>
                    <BentoIcon
                      icon={ChevronDownIcon}
                      size="sm"
                      className="muxui-select-arrow bento-address-bar__engine-chevron"
                    />
                  </Select.Trigger>
                  <Select.Popup className="bento-address-bar__engine-popover" modal={false}>
                    <Select.List>
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
                    </Select.List>
                  </Select.Popup>
                </Select.Root>,
                enginePickerHost,
              )
            : null}
        </CommandPalette.Popup>
      </CommandPalette.Backdrop>
    </CommandPalette.Root>
  );
}
