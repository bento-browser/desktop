import { describe, expect, it } from 'vitest';
import type { ExternalMergeProgress } from '@shared/protocol';
import { mergeProgressCardModel } from './mergeProgressCardModel';
import type { MergeProgressCardInput } from './mergeProgressCardModel';

const idle: MergeProgressCardInput = {
  activeOperationId: null,
  progress: null,
  progressLog: [],
  sourceName: null,
  result: null,
};

const running = (
  progress: ExternalMergeProgress | null,
  extra: Partial<MergeProgressCardInput> = {},
): MergeProgressCardInput => ({
  ...idle,
  activeOperationId: 'op-1',
  progress,
  sourceName: 'Firefox',
  ...extra,
});

const importing: ExternalMergeProgress = {
  stage: 'importing',
  totalWorkspaces: 6,
  completedWorkspaces: 1,
  totalTabs: 608,
  completedTabs: 120,
  importedTabs: 118,
  currentWorkspaceName: 'Work',
};

describe('mergeProgressCardModel', () => {
  it('shows nothing without a running or finished merge', () => {
    expect(mergeProgressCardModel(idle)).toBeNull();
  });

  it('preparing: a still ring at 0 and the source as the detail', () => {
    for (const progress of [
      null,
      {
        stage: 'preparing' as const,
        totalWorkspaces: 0,
        completedWorkspaces: 0,
        totalTabs: 0,
        completedTabs: 0,
        importedTabs: 0,
      },
    ]) {
      expect(mergeProgressCardModel(running(progress))).toEqual({
        kind: 'active',
        percent: 0,
        title: 'Preparing import',
        detail: 'Firefox',
        host: null,
        dismissible: false,
        announcement: 'Preparing import',
      });
    }
  });

  it('preparing without a source name has no detail', () => {
    expect(mergeProgressCardModel(running(null, { sourceName: null }))?.detail).toBeNull();
  });

  it('importing: workspace and counts, percent from tabs, last site host as a third line', () => {
    const model = mergeProgressCardModel(
      running(importing, {
        progressLog: [
          { kind: 'workspace', name: 'Work', status: 'started' },
          {
            kind: 'site',
            title: 'Repo',
            url: 'https://www.github.com/Bento-Browser',
            status: 'opened',
          },
          { kind: 'workspace', name: 'Work', status: 'completed' },
        ],
      }),
    );
    expect(model).toEqual({
      kind: 'active',
      percent: 20,
      title: 'Importing from Firefox',
      detail: 'Work, 120 of 608 tabs',
      host: 'github.com',
      dismissible: false,
      announcement: 'Importing from Firefox',
    });
  });

  it('importing: the announcement does not change as tabs complete', () => {
    const at = (completedTabs: number) =>
      mergeProgressCardModel(running({ ...importing, completedTabs }))!;
    expect(at(1).announcement).toBe(at(500).announcement);
    expect(at(1).detail).not.toBe(at(500).detail);
  });

  it('importing: singular tab, missing workspace, missing totals, unreadable site url', () => {
    expect(
      mergeProgressCardModel(
        running({ ...importing, totalTabs: 1, completedTabs: 0, currentWorkspaceName: undefined }),
      )?.detail,
    ).toBe('0 of 1 tab');
    const noTotals = mergeProgressCardModel(
      running(
        { ...importing, totalTabs: 0, completedTabs: 0, currentWorkspaceName: undefined },
        {
          progressLog: [{ kind: 'site', title: 'x', url: 'not a url', status: 'opened' }],
        },
      ),
    )!;
    expect(noTotals.detail).toBeNull();
    expect(noTotals.host).toBeNull();
    expect(noTotals.percent).toBe(0);
  });

  it('importing without a source name falls back to a generic title', () => {
    expect(mergeProgressCardModel(running(importing, { sourceName: null }))?.title).toBe(
      'Importing tabs',
    );
  });

  it('finalizing: finishing, ring at its share', () => {
    const model = mergeProgressCardModel(
      running({ ...importing, stage: 'finalizing', completedTabs: 608 }),
    );
    expect(model).toMatchObject({
      kind: 'active',
      percent: 100,
      title: 'Finishing import',
      detail: null,
      host: null,
    });
  });

  it('done: a full ring, the count, the source and the spaces', () => {
    expect(
      mergeProgressCardModel({
        ...idle,
        result: { kind: 'done', sourceName: 'Firefox', tabsOpened: 608, workspacesCreated: 6 },
      }),
    ).toEqual({
      kind: 'done',
      percent: 100,
      title: 'Imported 608 tabs',
      detail: 'From Firefox, 6 spaces',
      host: null,
      dismissible: true,
      announcement: 'Imported 608 tabs from Firefox',
    });
  });

  it('done: one tab, one space, no source, no new spaces', () => {
    expect(
      mergeProgressCardModel({
        ...idle,
        result: { kind: 'done', sourceName: 'Chrome', tabsOpened: 1, workspacesCreated: 1 },
      }),
    ).toMatchObject({ title: 'Imported 1 tab', detail: 'From Chrome, 1 space' });
    expect(
      mergeProgressCardModel({
        ...idle,
        result: { kind: 'done', sourceName: null, tabsOpened: 3, workspacesCreated: 0 },
      }),
    ).toMatchObject({ detail: null, announcement: 'Imported 3 tabs' });
  });

  it('cancelled: a partial ring and the tabs that were added', () => {
    expect(
      mergeProgressCardModel({
        ...idle,
        result: { kind: 'cancelled', sourceName: 'Chrome', tabsAdded: 120, percent: 20 },
      }),
    ).toEqual({
      kind: 'cancelled',
      percent: 20,
      title: 'Import cancelled',
      detail: '120 tabs added',
      host: null,
      dismissible: true,
      announcement: 'Import cancelled. 120 tabs added',
    });
    expect(
      mergeProgressCardModel({
        ...idle,
        result: { kind: 'cancelled', sourceName: null, tabsAdded: 0, percent: 0 },
      })?.detail,
    ).toBe('No tabs added');
  });

  it('failed: the short reason', () => {
    expect(
      mergeProgressCardModel({
        ...idle,
        result: {
          kind: 'failed',
          sourceName: null,
          message: 'The session could not be read.',
          percent: 0,
        },
      }),
    ).toEqual({
      kind: 'failed',
      percent: 0,
      title: 'Import failed',
      detail: 'The session could not be read.',
      host: null,
      dismissible: true,
      announcement: 'Import failed. The session could not be read.',
    });
  });

  it('a running merge takes precedence over a lingering result', () => {
    const model = mergeProgressCardModel(
      running(null, {
        result: { kind: 'done', sourceName: 'Chrome', tabsOpened: 1, workspacesCreated: 0 },
      }),
    );
    expect(model?.kind).toBe('active');
  });
});
