import { useEffect, useMemo, useState } from 'react';
import { CommandPalette as TaleCommandPalette } from '@tale-ui/react/command-palette';
import { Button } from '@tale-ui/react/button';
import { Column } from '@tale-ui/react/column';
import { Icon } from '@tale-ui/react/icon';
import { IconButton } from '@tale-ui/react/icon-button';
import { ProgressBar } from '@tale-ui/react/progress-bar';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import MergeIcon from 'lucide-react/dist/esm/icons/merge';
import GlobeIcon from 'lucide-react/dist/esm/icons/globe';
import AlertCircleIcon from 'lucide-react/dist/esm/icons/alert-circle';
import CheckCircleIcon from 'lucide-react/dist/esm/icons/check-circle';
import RefreshCwIcon from 'lucide-react/dist/esm/icons/refresh-cw';
import ChevronDownIcon from 'lucide-react/dist/esm/icons/chevron-down';
import ChevronRightIcon from 'lucide-react/dist/esm/icons/chevron-right';
import AppWindowIcon from 'lucide-react/dist/esm/icons/app-window';
import LayoutPanelTopIcon from 'lucide-react/dist/esm/icons/layout-panel-top';
import XIcon from 'lucide-react/dist/esm/icons/x';

import { dispatch } from '../../bridge/useToolsPort';
import { useExternalMergeStore } from '../../state/externalMerge';
import type {
  ExternalMergeImportTarget,
  ExternalMergeSource,
  ExternalMergeSummary,
} from '@shared/protocol';
import './MergePalette.css';

export interface MergePaletteProps {
  onClose: () => void;
}

interface VisibleMergeSource {
  source: ExternalMergeSource;
  targets: ExternalMergeImportTarget[];
}

function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function formatAge(timestamp: number): string {
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'saved just now';
  if (minutes < 60) return `saved ${plural(minutes, 'min')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `saved ${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  return `saved ${plural(days, 'day')} ago`;
}

function sourceSubtitle(source: ExternalMergeSource): string {
  if (source.unavailableReason) {
    return [source.unavailableReason, formatAge(source.lastModified)].join(' - ');
  }
  return [
    plural(source.windowCount, 'window'),
    plural(source.tabCount, 'tab'),
    plural(source.groupCount, 'group'),
    formatAge(source.lastModified),
  ].join(' - ');
}

function commandIcon(icon: typeof GlobeIcon) {
  return <Icon icon={icon} size="sm" />;
}

function summaryText(summary: ExternalMergeSummary): string {
  return [
    `Created ${plural(summary.workspacesCreated, 'workspace')}`,
    `opened ${plural(summary.tabsOpened, 'tab')}`,
    `skipped ${plural(summary.skippedDuplicates, 'duplicate')}`,
  ].join(', ');
}

function sourceLabel(source: ExternalMergeSource): string {
  return `${source.browserName} - ${source.profileName}`;
}

function targetKey(sourceId: string, targetId: string): string {
  return `${sourceId}:${targetId}`;
}

function targetKindLabel(target: ExternalMergeImportTarget): string {
  return target.kind === 'workspace' ? 'space' : 'window';
}

function targetSubtitle(target: ExternalMergeImportTarget): string {
  const parts =
    target.kind === 'workspace'
      ? [plural(target.windowCount, 'window'), plural(target.tabCount, 'tab')]
      : [plural(target.tabCount, 'tab')];
  if (target.groupCount > 0) parts.push(plural(target.groupCount, 'group'));
  return parts.join(' - ');
}

function sourceTargetSummary(source: ExternalMergeSource): string {
  const targets = source.targets ?? [];
  if (targets.length === 0) return 'Whole session';
  const spaceCount = targets.filter((target) => target.kind === 'workspace').length;
  const windowCount = targets.length - spaceCount;
  if (spaceCount > 0 && windowCount === 0) return plural(spaceCount, 'space');
  if (windowCount > 0 && spaceCount === 0) return plural(windowCount, 'window');
  return [plural(spaceCount, 'space'), plural(windowCount, 'window')].join(' - ');
}

function tabPreviewLabel(tab: ExternalMergeImportTarget['previewTabs'][number]): string {
  return [tab.title, tab.url].filter(Boolean).join(' ');
}

function sourceSearchText(source: ExternalMergeSource): string {
  return [
    sourceLabel(source),
    sourceSubtitle(source),
    sourceTargetSummary(source),
    source.unavailableReason ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function targetSearchText(target: ExternalMergeImportTarget): string {
  return [
    target.name,
    targetKindLabel(target),
    targetSubtitle(target),
    ...target.previewTabs.map(tabPreviewLabel),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function visibleSources(sources: ExternalMergeSource[], query: string): VisibleMergeSource[] {
  const needle = query.trim().toLowerCase();
  return sources
    .map((source) => {
      const targets = source.targets ?? [];
      if (!needle) return { source, targets };
      const sourceMatches = sourceSearchText(source).includes(needle);
      const matchingTargets = targets.filter((target) => targetSearchText(target).includes(needle));
      return {
        source,
        targets: sourceMatches ? targets : matchingTargets,
      };
    })
    .filter(({ source, targets }) => {
      if (!needle) return true;
      return targets.length > 0 || sourceSearchText(source).includes(needle);
    });
}

function toggleKey(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

interface TargetItemProps {
  source: ExternalMergeSource;
  target: ExternalMergeImportTarget;
  expanded: boolean;
  isDisabled: boolean;
  onToggle: () => void;
  onImport: () => void;
}

function TargetItem({ source, target, expanded, isDisabled, onToggle, onImport }: TargetItemProps) {
  const moreCount = Math.max(0, target.tabCount - target.previewTabs.length);
  const icon = target.kind === 'workspace' ? LayoutPanelTopIcon : AppWindowIcon;
  const kind = targetKindLabel(target);

  return (
    <Column gap="xs" className="bento-merge-palette__target-item">
      <Row gap="xs" align="center" className="bento-merge-palette__target-row">
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={`${expanded ? 'Hide' : 'Show'} ${target.name} tabs`}
          onPress={onToggle}
        >
          <Icon icon={expanded ? ChevronDownIcon : ChevronRightIcon} size="sm" />
        </IconButton>
        <Icon icon={icon} size="sm" />
        <Column gap="4xs" className="bento-merge-palette__target-main">
          <Text variant="label" size="s" className="bento-merge-palette__target-title">
            {target.name}
          </Text>
          <Text variant="text" size="s" color="muted">
            {kind} - {targetSubtitle(target)}
          </Text>
        </Column>
        <Button variant="neutral" size="sm" isDisabled={isDisabled} onPress={onImport}>
          Import
        </Button>
      </Row>
      {expanded ? (
        <Column gap="4xs" className="bento-merge-palette__tab-preview-list">
          {target.previewTabs.map((tab, index) => (
            <Row
              key={`${source.id}-${target.id}-${tab.url}-${index}`}
              gap="xs"
              align="baseline"
              className="bento-merge-palette__tab-preview-row"
            >
              <Text variant="text" size="s" className="bento-merge-palette__tab-title">
                {tab.title || tab.url}
              </Text>
              <Text variant="text" size="s" color="muted" className="bento-merge-palette__tab-url">
                {tab.url}
              </Text>
              {tab.pinned ? (
                <Text variant="label" size="xs" color="muted">
                  Pinned
                </Text>
              ) : null}
            </Row>
          ))}
          {moreCount > 0 ? (
            <Text variant="text" size="s" color="muted" className="bento-merge-palette__more-tabs">
              {moreCount} more {moreCount === 1 ? 'tab' : 'tabs'}
            </Text>
          ) : null}
        </Column>
      ) : null}
    </Column>
  );
}

export function MergePalette({ onClose }: MergePaletteProps) {
  const loadingSources = useExternalMergeStore((state) => state.loadingSources);
  const activeOperationId = useExternalMergeStore((state) => state.activeOperationId);
  const activeSourceId = useExternalMergeStore((state) => state.activeSourceId);
  const summary = useExternalMergeStore((state) => state.summary);
  const error = useExternalMergeStore((state) => state.error);
  const sources = useExternalMergeStore((state) => state.sources);
  const [query, setQuery] = useState('');
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(() => new Set());
  const [expandedTargetIds, setExpandedTargetIds] = useState<Set<string>>(() => new Set());
  const filteredSources = useMemo(() => visibleSources(sources, query), [sources, query]);
  const filteredTargetCount = filteredSources.reduce((sum, { targets }) => sum + targets.length, 0);
  const isMerging = !!activeOperationId;
  const activeSource = sources.find((source) => source.id === activeSourceId);
  const importStatus = activeSource
    ? `Importing ${sourceLabel(activeSource)}...`
    : 'Importing browser session...';
  const close = () => onClose();
  const refreshSources = () => {
    useExternalMergeStore.getState().refreshSources(dispatch);
  };
  const cancelMerge = () => {
    useExternalMergeStore.getState().cancelMerge(dispatch);
  };
  const startSourceMerge = (source: ExternalMergeSource) => {
    if (source.unavailableReason) return;
    useExternalMergeStore.getState().startMerge(source.id, dispatch);
  };
  const startTargetMerge = (source: ExternalMergeSource, target: ExternalMergeImportTarget) => {
    if (source.unavailableReason) return;
    useExternalMergeStore.getState().startMerge(source.id, dispatch, [target.id]);
  };

  useEffect(() => {
    setExpandedSourceIds(new Set());
    setExpandedTargetIds(new Set());
  }, [sources]);

  useEffect(() => {
    const focusSearch = () => {
      const input = document.querySelector(
        '.bento-merge-palette__input',
      ) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    };
    focusSearch();
    window.addEventListener('focus', focusSearch);
    return () => window.removeEventListener('focus', focusSearch);
  }, []);

  const footerText = activeOperationId
    ? 'Merging...'
    : summary
      ? summaryText(summary)
      : error
        ? error.message
        : loadingSources
          ? 'Finding browser sessions...'
          : sources.length === 0
            ? 'No mergeable sessions'
            : `${plural(filteredSources.length, 'source')} - ${plural(filteredTargetCount, 'import option')}`;

  return (
    <TaleCommandPalette.Root
      open={true}
      size="lg"
      closeOnSelect={false}
      onOpenChange={(next) => {
        if (!next && !isMerging) close();
      }}
    >
      <TaleCommandPalette.Backdrop isDismissable={!isMerging}>
        <TaleCommandPalette.Popup
          aria-label="Merge browser session"
          className="bento-merge-palette__dialog"
          data-merging={isMerging || undefined}
          modalProps={{ className: 'bento-merge-palette__popup' }}
        >
          <TaleCommandPalette.Title className="bento-merge-palette__sr-only">
            Merge browser session
          </TaleCommandPalette.Title>
          <TaleCommandPalette.Close aria-label="Close merge browser session" />
          <TaleCommandPalette.Content
            className="bento-merge-palette__content"
            inputValue={query}
            onInputChange={setQuery}
          >
            <TaleCommandPalette.SearchField>
              <TaleCommandPalette.Input
                placeholder="Search browser sessions..."
                className="bento-merge-palette__input"
                autoFocus
              />
              <TaleCommandPalette.ClearButton
                aria-label="Clear search"
                className="tale-button tale-button--ghost tale-button--sm"
              >
                Clear
              </TaleCommandPalette.ClearButton>
              <IconButton
                variant="ghost"
                size="sm"
                className="bento-merge-palette__refresh"
                aria-label="Refresh browser sessions"
                isDisabled={loadingSources || !!activeOperationId}
                onPress={refreshSources}
              >
                <Icon icon={RefreshCwIcon} size="sm" />
              </IconButton>
            </TaleCommandPalette.SearchField>
            <Column
              gap="xs"
              className="bento-merge-palette__source-list"
              aria-label="Browser sessions"
            >
              <Text
                variant="label"
                size="s"
                color="muted"
                className="bento-merge-palette__section-label"
              >
                Browser sessions
              </Text>
              {filteredSources.map(({ source, targets }) => {
                const sourceExpanded = expandedSourceIds.has(source.id);
                const isUnavailable = !!source.unavailableReason;
                const isSourceMerging = !!activeOperationId && activeSourceId === source.id;
                const importDisabled = !!activeOperationId || isUnavailable;
                const targetCount = source.targets?.length ?? 0;
                return (
                  <Column
                    key={source.id}
                    gap="xs"
                    className="bento-merge-palette__source-card"
                    data-unavailable={isUnavailable || undefined}
                  >
                    <Row gap="s" align="center" className="bento-merge-palette__source-row">
                      <Icon icon={GlobeIcon} size="sm" />
                      <Column gap="4xs" className="bento-merge-palette__source-main">
                        <Text
                          variant="label"
                          size="s"
                          className="bento-merge-palette__source-title"
                        >
                          {sourceLabel(source)}
                        </Text>
                        <Text variant="text" size="s" color="muted">
                          {sourceSubtitle(source)}
                        </Text>
                      </Column>
                      <Text
                        variant="label"
                        size="s"
                        color="muted"
                        className="bento-merge-palette__source-meta"
                      >
                        {isUnavailable
                          ? 'Unavailable'
                          : isSourceMerging
                            ? 'Merging'
                            : sourceTargetSummary(source)}
                      </Text>
                      {targetCount > 0 ? (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={`${sourceExpanded ? 'Hide' : 'Show'} ${sourceLabel(source)} spaces and windows`}
                          onPress={() => {
                            setExpandedSourceIds((current) => toggleKey(current, source.id));
                          }}
                        >
                          <Icon
                            icon={sourceExpanded ? ChevronDownIcon : ChevronRightIcon}
                            size="sm"
                          />
                        </IconButton>
                      ) : null}
                      <Button
                        variant="primary"
                        size="sm"
                        isDisabled={importDisabled}
                        onPress={() => startSourceMerge(source)}
                      >
                        Import all
                      </Button>
                    </Row>
                    {(sourceExpanded || query.trim()) && targets.length > 0 ? (
                      <Column gap="xs" className="bento-merge-palette__target-list">
                        {targets.map((target) => {
                          const key = targetKey(source.id, target.id);
                          return (
                            <TargetItem
                              key={key}
                              source={source}
                              target={target}
                              expanded={expandedTargetIds.has(key)}
                              isDisabled={importDisabled}
                              onToggle={() => {
                                setExpandedTargetIds((current) => toggleKey(current, key));
                              }}
                              onImport={() => startTargetMerge(source, target)}
                            />
                          );
                        })}
                      </Column>
                    ) : null}
                  </Column>
                );
              })}
            </Column>
            {loadingSources ? (
              <TaleCommandPalette.LoadMoreItem>
                {commandIcon(MergeIcon)} Finding browser sessions...
              </TaleCommandPalette.LoadMoreItem>
            ) : null}
            {!loadingSources && error ? (
              <TaleCommandPalette.LoadMoreItem className="bento-merge-palette__status">
                {commandIcon(AlertCircleIcon)} {error.message}
              </TaleCommandPalette.LoadMoreItem>
            ) : null}
            {!loadingSources && summary ? (
              <TaleCommandPalette.LoadMoreItem className="bento-merge-palette__status">
                {commandIcon(CheckCircleIcon)} {summaryText(summary)}
              </TaleCommandPalette.LoadMoreItem>
            ) : null}
            {!loadingSources && !error && !summary && filteredSources.length === 0 ? (
              <TaleCommandPalette.Empty>
                {sources.length === 0
                  ? 'No mergeable browser sessions found.'
                  : 'No matching browser sessions found.'}
              </TaleCommandPalette.Empty>
            ) : null}
            <TaleCommandPalette.Footer className="bento-merge-palette__footer">
              <Text variant="text" size="s" className="bento-merge-palette__footer-text">
                {footerText}
              </Text>
              <Button
                variant="neutral"
                size="sm"
                className="bento-merge-palette__close-button"
                onPress={close}
              >
                Close
              </Button>
            </TaleCommandPalette.Footer>
          </TaleCommandPalette.Content>
          {isMerging ? (
            <Column
              gap="m"
              align="stretch"
              justify="center"
              className="bento-merge-palette__import-overlay"
              aria-label="Browser session import in progress"
              aria-live="polite"
            >
              <IconButton
                variant="ghost"
                size="sm"
                className="bento-merge-palette__overlay-close-button"
                aria-label="Close merge browser session"
                onPress={close}
              >
                <Icon icon={XIcon} size="sm" />
              </IconButton>
              <ProgressBar.Root
                isIndeterminate
                minValue={0}
                maxValue={100}
                className="bento-merge-palette__loader"
              >
                <ProgressBar.Label>{importStatus}</ProgressBar.Label>
                <ProgressBar.Track>
                  <ProgressBar.Indicator />
                </ProgressBar.Track>
              </ProgressBar.Root>
              <Row gap="s" justify="center" className="bento-merge-palette__overlay-actions">
                <Button
                  variant="neutral"
                  size="sm"
                  className="bento-merge-palette__cancel-button"
                  onPress={cancelMerge}
                >
                  Cancel
                </Button>
              </Row>
            </Column>
          ) : null}
        </TaleCommandPalette.Popup>
      </TaleCommandPalette.Backdrop>
    </TaleCommandPalette.Root>
  );
}
