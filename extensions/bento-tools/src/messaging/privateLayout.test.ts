// Layout actions that name a group instead of a tab cannot be checked by the private
// boundary guard, so the handler searches only the source window's own workspace.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type HandlerContext } from './protocol-handler';
import { PanelStore } from '../panels/PanelStore';
import { WorkspaceStore } from '../workspaces/WorkspaceStore';

const REGULAR_WINDOW = 1;
const PRIVATE_WINDOW = 9;

/** The id of the vertical group a panel's subdivision made in `workspaceId`. */
function groupIdIn(panels: PanelStore, workspaceId: string): string {
  const root = panels.getPanelLayout(workspaceId).root[0];
  if (!root || root.kind !== 'group') throw new Error('Expected a subdivision');
  return root.id;
}

function groupRatioIn(panels: PanelStore, workspaceId: string): number {
  const root = panels.getPanelLayout(workspaceId).root[0];
  if (!root || root.kind !== 'group') throw new Error('Expected a subdivision');
  return root.ratio;
}

async function setup() {
  const workspaces = new WorkspaceStore();
  await workspaces.init();
  const regular = workspaces.snapshot().workspaces[0]!;
  workspaces.activate(regular.id, REGULAR_WINDOW);
  const privateWorkspace = workspaces.ensurePrivate(PRIVATE_WINDOW);
  const panels = new PanelStore();
  panels.add(regular.id, 1);
  panels.subdivide(regular.id, 1);
  panels.add(privateWorkspace.id, 900);
  panels.subdivide(privateWorkspace.id, 900);
  const context = (sourceWindowId: number) =>
    ({
      tabs: {
        isPrivate: (id: number) => id === 900,
        privateWindowOfTab: (id: number) => (id === 900 ? PRIVATE_WINDOW : undefined),
      },
      workspaces,
      panels,
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId,
      sourceWindowPrivate: sourceWindowId === PRIVATE_WINDOW,
    }) as unknown as HandlerContext;
  return {
    panels,
    regularId: regular.id,
    privateId: privateWorkspace.id,
    regularGroup: groupIdIn(panels, regular.id),
    privateGroup: groupIdIn(panels, privateWorkspace.id),
    context,
  };
}

describe('panelLayout/setGroupRatio', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      windows: { getAll: vi.fn(async () => []) },
      sessions: {
        getWindowValue: vi.fn(async () => undefined),
        setWindowValue: vi.fn(async () => undefined),
        removeWindowValue: vi.fn(async () => undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets the ratio of a group in the source window own workspace', async () => {
    const { panels, regularId, privateId, regularGroup, privateGroup, context } = await setup();

    handle({ type: 'panelLayout/setGroupRatio', groupId: regularGroup, ratio: 0.7 }, context(1));
    handle({ type: 'panelLayout/setGroupRatio', groupId: privateGroup, ratio: 0.3 }, context(9));

    expect(groupRatioIn(panels, regularId)).toBe(0.7);
    expect(groupRatioIn(panels, privateId)).toBe(0.3);
  });

  it("does not let a private window change a regular workspace's group", async () => {
    const { panels, regularId, regularGroup, context } = await setup();
    const before = groupRatioIn(panels, regularId);

    handle({ type: 'panelLayout/setGroupRatio', groupId: regularGroup, ratio: 0.8 }, context(9));

    expect(groupRatioIn(panels, regularId)).toBe(before);
  });

  it("does not let a regular window change a private window's group", async () => {
    const { panels, privateId, privateGroup, context } = await setup();
    const before = groupRatioIn(panels, privateId);

    handle({ type: 'panelLayout/setGroupRatio', groupId: privateGroup, ratio: 0.8 }, context(1));

    expect(groupRatioIn(panels, privateId)).toBe(before);
  });
});
