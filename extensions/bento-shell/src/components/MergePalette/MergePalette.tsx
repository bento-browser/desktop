import { useEffect, useMemo, type ReactNode } from 'react';
import {
  CommandPalette as TaleCommandPalette,
  useCommandPalette,
  type CommandPaletteCommand,
} from '@tale-ui/react/command-palette';
import { Button } from '@tale-ui/react/button';
import { Icon } from '@tale-ui/react/icon';
import { IconButton } from '@tale-ui/react/icon-button';
import { ProgressBar } from '@tale-ui/react/progress-bar';
import MergeIcon from 'lucide-react/dist/esm/icons/merge';
import GlobeIcon from 'lucide-react/dist/esm/icons/globe';
import AlertCircleIcon from 'lucide-react/dist/esm/icons/alert-circle';
import CheckCircleIcon from 'lucide-react/dist/esm/icons/check-circle';
import RefreshCwIcon from 'lucide-react/dist/esm/icons/refresh-cw';

import { dispatch } from '../../bridge/useToolsPort';
import { useExternalMergeStore } from '../../state/externalMerge';
import type { ExternalMergeSource, ExternalMergeSummary } from '@shared/protocol';
import './MergePalette.css';

export interface MergePaletteProps {
  onClose: () => void;
}

interface MergeCommand extends CommandPaletteCommand {
  id: string;
  title: string;
  subtitle: string;
  group: 'Browser sessions';
  icon: ReactNode;
  sourceId: string;
  meta: string;
  unavailable: boolean;
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

function commandIcon(icon: typeof GlobeIcon): ReactNode {
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

function commandTextValue(command: MergeCommand): string {
  return [command.title, command.subtitle, command.meta].join(' ');
}

function useMergeCommands(): MergeCommand[] {
  const sources = useExternalMergeStore((state) => state.sources);
  const activeOperationId = useExternalMergeStore((state) => state.activeOperationId);
  const activeSourceId = useExternalMergeStore((state) => state.activeSourceId);

  return useMemo(
    () =>
      sources.map((source) => ({
        id: source.id,
        title: sourceLabel(source),
        subtitle: sourceSubtitle(source),
        group: 'Browser sessions',
        icon: commandIcon(GlobeIcon),
        sourceId: source.id,
        unavailable: !!source.unavailableReason,
        meta: source.unavailableReason
          ? 'Unavailable'
          : activeOperationId && activeSourceId === source.id
            ? 'Merging'
            : 'Merge',
        action: () => {
          if (source.unavailableReason) return;
          useExternalMergeStore.getState().startMerge(source.id, dispatch);
        },
      })),
    [sources, activeOperationId, activeSourceId],
  );
}

export function MergePalette({ onClose }: MergePaletteProps) {
  const loadingSources = useExternalMergeStore((state) => state.loadingSources);
  const activeOperationId = useExternalMergeStore((state) => state.activeOperationId);
  const activeSourceId = useExternalMergeStore((state) => state.activeSourceId);
  const summary = useExternalMergeStore((state) => state.summary);
  const error = useExternalMergeStore((state) => state.error);
  const sources = useExternalMergeStore((state) => state.sources);
  const commands = useMergeCommands();
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
  const palette = useCommandPalette<MergeCommand>({
    commands,
    close,
    closeOnSelect: false,
  });

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
          : commands.length === 0
            ? 'No mergeable sessions'
            : `${plural(palette.filteredCommands.length, 'source')}`;

  return (
    <TaleCommandPalette.Root
      open={true}
      size="lg"
      closeOnSelect={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <TaleCommandPalette.Backdrop isDismissable>
        <TaleCommandPalette.Popup
          aria-label="Merge browser session"
          className="bento-merge-palette__dialog"
          modalProps={{ className: 'bento-merge-palette__popup' }}
        >
          <TaleCommandPalette.Title className="bento-merge-palette__sr-only">
            Merge browser session
          </TaleCommandPalette.Title>
          <TaleCommandPalette.Close aria-label="Close merge browser session" />
          <TaleCommandPalette.Content
            className="bento-merge-palette__content"
            inputValue={palette.query}
            onInputChange={palette.setQuery}
          >
            <TaleCommandPalette.SearchField>
              <TaleCommandPalette.Input
                placeholder="Search browser sessions..."
                className="bento-merge-palette__input"
                autoFocus
              />
              <TaleCommandPalette.ClearButton aria-label="Clear search" />
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
            <TaleCommandPalette.ListBox
              aria-label="Browser sessions"
              className="bento-merge-palette__listbox"
            >
              {palette.groupedCommands.map((group) => (
                <TaleCommandPalette.Section key={group.id}>
                  <TaleCommandPalette.SectionHeader>{group.title}</TaleCommandPalette.SectionHeader>
                  {group.commands.map((command) => (
                    <TaleCommandPalette.Item
                      key={command.id}
                      command={command}
                      textValue={commandTextValue(command)}
                      isDisabled={!!activeOperationId || command.unavailable}
                      closeOnSelect={false}
                      onAction={() => void palette.runCommand(command)}
                    >
                      <TaleCommandPalette.ItemIcon>{command.icon}</TaleCommandPalette.ItemIcon>
                      <TaleCommandPalette.ItemContent>
                        <TaleCommandPalette.ItemTitle>{command.title}</TaleCommandPalette.ItemTitle>
                        <TaleCommandPalette.ItemDescription>
                          {command.subtitle}
                        </TaleCommandPalette.ItemDescription>
                      </TaleCommandPalette.ItemContent>
                      <TaleCommandPalette.ItemMeta>{command.meta}</TaleCommandPalette.ItemMeta>
                    </TaleCommandPalette.Item>
                  ))}
                </TaleCommandPalette.Section>
              ))}
            </TaleCommandPalette.ListBox>
            {loadingSources ? (
              <TaleCommandPalette.LoadMoreItem>
                {commandIcon(MergeIcon)} Finding browser sessions...
              </TaleCommandPalette.LoadMoreItem>
            ) : null}
            {activeOperationId ? (
              <TaleCommandPalette.LoadMoreItem className="bento-merge-palette__loader-item">
                <div className="bento-merge-palette__loader-content">
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
                  <Button
                    variant="neutral"
                    size="sm"
                    className="bento-merge-palette__cancel-button"
                    onPress={cancelMerge}
                  >
                    Cancel
                  </Button>
                </div>
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
            {!loadingSources && !error && !summary && palette.filteredCommands.length === 0 ? (
              <TaleCommandPalette.Empty>
                No mergeable browser sessions found.
              </TaleCommandPalette.Empty>
            ) : null}
            <TaleCommandPalette.Footer className="bento-merge-palette__footer">
              <span className="bento-merge-palette__footer-text">{footerText}</span>
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
        </TaleCommandPalette.Popup>
      </TaleCommandPalette.Backdrop>
    </TaleCommandPalette.Root>
  );
}
