import type { ExternalMergeProgress, ExternalMergeProgressActivity } from '@shared/protocol';
import { mergeProgressPercent } from '../../state/externalMerge';
import type { ExternalMergeResult } from '../../state/externalMerge';

/** What the merge progress card shows. Pure data: the component only lays it out. */
export interface MergeProgressCardModel {
  /** Drives the ring and its icon: a running import, or how a finished one ended. */
  kind: 'active' | 'done' | 'cancelled' | 'failed';
  /** Ring fill, 0 to 100. Never indeterminate: before the totals arrive the ring is still, at 0. */
  percent: number;
  title: string;
  detail: string | null;
  /** Hostname of the last site opened, a third line while importing. */
  host: string | null;
  /** Finished imports stay until dismissed; a running one cannot be. */
  dismissible: boolean;
  /**
   * What a screen reader hears. It names the stage or the outcome and carries no counts,
   * so it changes only when the stage does, not on every tab.
   */
  announcement: string;
}

export interface MergeProgressCardInput {
  activeOperationId: string | null;
  progress: ExternalMergeProgress | null;
  progressLog: readonly ExternalMergeProgressActivity[];
  sourceName: string | null;
  result: ExternalMergeResult | null;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function lastSiteHost(log: readonly ExternalMergeProgressActivity[]): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const activity = log[i];
    if (activity?.kind === 'site') return hostOf(activity.url);
  }
  return null;
}

function activeModel({
  progress,
  progressLog,
  sourceName,
}: MergeProgressCardInput): MergeProgressCardModel {
  const percent = mergeProgressPercent(progress);
  const base = { kind: 'active', percent, dismissible: false } as const;

  if (!progress || progress.stage === 'preparing') {
    return {
      ...base,
      title: 'Preparing import',
      detail: sourceName,
      host: null,
      announcement: 'Preparing import',
    };
  }
  if (progress.stage === 'finalizing') {
    return {
      ...base,
      title: 'Finishing import',
      detail: null,
      host: null,
      announcement: 'Finishing import',
    };
  }

  const title = sourceName ? `Importing from ${sourceName}` : 'Importing tabs';
  const tabs =
    progress.totalTabs > 0
      ? `${progress.completedTabs} of ${count(progress.totalTabs, 'tab')}`
      : null;
  const detail = [progress.currentWorkspaceName, tabs].filter(Boolean).join(', ') || null;
  return { ...base, title, detail, host: lastSiteHost(progressLog), announcement: title };
}

function resultModel(result: ExternalMergeResult): MergeProgressCardModel {
  const base = { host: null, dismissible: true } as const;
  switch (result.kind) {
    case 'done': {
      const title = `Imported ${count(result.tabsOpened, 'tab')}`;
      const spaces = result.workspacesCreated > 0 ? count(result.workspacesCreated, 'space') : null;
      const detail =
        [result.sourceName ? `From ${result.sourceName}` : null, spaces]
          .filter(Boolean)
          .join(', ') || null;
      return {
        ...base,
        kind: 'done',
        percent: 100,
        title,
        detail,
        announcement: result.sourceName ? `${title} from ${result.sourceName}` : title,
      };
    }
    case 'cancelled': {
      const detail =
        result.tabsAdded > 0 ? `${count(result.tabsAdded, 'tab')} added` : 'No tabs added';
      return {
        ...base,
        kind: 'cancelled',
        percent: result.percent,
        title: 'Import cancelled',
        detail,
        announcement: `Import cancelled. ${detail}`,
      };
    }
    case 'failed':
      return {
        ...base,
        kind: 'failed',
        percent: result.percent,
        title: 'Import failed',
        detail: result.message,
        announcement: `Import failed. ${result.message}`,
      };
  }
}

/** The card for the merge in progress, else for the one that ended, else none. */
export function mergeProgressCardModel(
  input: MergeProgressCardInput,
): MergeProgressCardModel | null {
  if (input.activeOperationId) return activeModel(input);
  return input.result ? resultModel(input.result) : null;
}
