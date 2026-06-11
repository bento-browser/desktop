// Layer-2 component: floating address/search bar.

import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { Dialog } from '@tale-ui/react/dialog';
import { Autocomplete } from '@tale-ui/react/autocomplete';
import { Row } from '@tale-ui/react/row';
import { Column } from '@tale-ui/react/column';
import { Text } from '@tale-ui/react/text';
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

interface AddressRow {
  id: string;
  kind: RowKind;
  title: string;
  subtitle: string;
  textValue: string;
  tabId?: number;
  workspaceId?: string;
  url?: string;
  favIconUrl?: string;
}

function contains(text: string, search: string): boolean {
  if (!search) return true;
  return text.toLowerCase().includes(search.toLowerCase());
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
    textValue: result.title || result.url,
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

function RowGlyph({ row }: { row: AddressRow }) {
  if (row.favIconUrl) {
    return (
      <Image
        className="bento-address-bar__favicon"
        src={row.favIconUrl}
        alt=""
        radius="sm"
        fit="contain"
        width={18}
        height={18}
      />
    );
  }
  return (
    <Row className="bento-address-bar__glyph" align="center" justify="center" aria-hidden="true">
      <Icon icon={rowIcon(row.kind)} size="sm" />
    </Row>
  );
}

function ResultRow({ row }: { row: AddressRow }) {
  return (
    <Row gap="xs" align="center" className="bento-address-bar__row">
      <RowGlyph row={row} />
      <Column gap="4xs" className="bento-address-bar__row-text">
        <Text variant="label" size="s" className="bento-address-bar__row-title">
          {row.title}
        </Text>
        <Text variant="text" size="xs" color="muted" className="bento-address-bar__row-subtitle">
          {row.subtitle}
        </Text>
      </Column>
    </Row>
  );
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
        textValue: tab.title || 'Untitled',
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
        textValue: tab.title || 'Untitled',
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
      textValue: trimmed,
      url: trimmed,
    };
  }, [mode, query]);

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

  const runRow = (row: AddressRow) => {
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
  };

  return (
    <Dialog.Root
      isOpen={true}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Backdrop isDismissable>
        <Dialog.Popup className="bento-address-bar__popup">
          <Dialog.Title className="bento-address-bar__sr-only">Address bar</Dialog.Title>
          <Autocomplete.Root key={openVersion} filter={contains}>
            <div className="bento-address-bar__autocomplete">
              <Autocomplete.SearchField aria-label="Search or enter address">
                <Autocomplete.Input
                  placeholder="Search or enter address"
                  className="bento-address-bar__input"
                  autoFocus
                  defaultValue={initialQuery}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </Autocomplete.SearchField>
              <Autocomplete.ListBox
                aria-label="Address bar results"
                className="bento-address-bar__listbox"
              >
                {tabRows.length > 0 ? (
                  <Autocomplete.Section>
                    <Autocomplete.Header>Open Tabs</Autocomplete.Header>
                    {tabRows.map((row) => (
                      <Autocomplete.Item
                        key={row.id}
                        id={row.id}
                        textValue={row.textValue}
                        onAction={() => runRow(row)}
                        className="bento-address-bar__item"
                      >
                        <ResultRow row={row} />
                      </Autocomplete.Item>
                    ))}
                  </Autocomplete.Section>
                ) : null}
                {panelRows.length > 0 ? (
                  <Autocomplete.Section>
                    <Autocomplete.Header>Open Panels</Autocomplete.Header>
                    {panelRows.map((row) => (
                      <Autocomplete.Item
                        key={row.id}
                        id={row.id}
                        textValue={row.textValue}
                        onAction={() => runRow(row)}
                        className="bento-address-bar__item"
                      >
                        <ResultRow row={row} />
                      </Autocomplete.Item>
                    ))}
                  </Autocomplete.Section>
                ) : null}
                {asyncRows.length > 0 ? (
                  <Autocomplete.Section>
                    <Autocomplete.Header>History &amp; Bookmarks</Autocomplete.Header>
                    {asyncRows.map((row) => (
                      <Autocomplete.Item
                        key={row.id}
                        id={row.id}
                        textValue={query}
                        onAction={() => runRow(row)}
                        className="bento-address-bar__item"
                      >
                        <ResultRow row={row} />
                      </Autocomplete.Item>
                    ))}
                  </Autocomplete.Section>
                ) : null}
                {syntheticRow ? (
                  <Autocomplete.Section>
                    <Autocomplete.Header>Search</Autocomplete.Header>
                    <Autocomplete.Item
                      id={syntheticRow.id}
                      textValue={syntheticRow.textValue}
                      onAction={() => runRow(syntheticRow)}
                      className="bento-address-bar__item"
                    >
                      <ResultRow row={syntheticRow} />
                    </Autocomplete.Item>
                  </Autocomplete.Section>
                ) : null}
              </Autocomplete.ListBox>
            </div>
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}
