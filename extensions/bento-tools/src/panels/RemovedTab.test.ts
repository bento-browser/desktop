import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelStore } from './PanelStore';
import { dropRemovedTabFromPanels, type RemovedTabDeps } from './RemovedTab';

const REGULAR_ACTIVE = 'ws-active';
const REGULAR_OTHER = 'ws-other';
const PRIVATE_WORKSPACE = 'private:9';

function setup() {
  const panels = new PanelStore();
  panels.add(REGULAR_ACTIVE, 1);
  panels.add(REGULAR_OTHER, 2);
  panels.add(PRIVATE_WORKSPACE, 900);
  panels.add(PRIVATE_WORKSPACE, 901);
  const emitted: string[] = [];
  const synced: string[] = [];
  const deps: RemovedTabDeps = {
    panels,
    pinnedPanels: { removeForTab: vi.fn() },
    closeDevtoolsPanelTabs: vi.fn(),
    syncPanelMarkers: (workspaceId) => synced.push(workspaceId),
    emitPanelsSync: (workspaceId) => emitted.push(workspaceId),
  };
  return { panels, deps, emitted, synced };
}

describe('dropRemovedTabFromPanels', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A private tab that moves to another private window is a removal for the old window.
  // Its Private workspace is never the regular workspace the global active id names.
  it("publishes a private window's panels when one of its tabs is removed", () => {
    const { panels, deps, emitted, synced } = setup();

    dropRemovedTabFromPanels(deps, 900);

    expect(panels.getVisiblePanelIds(PRIVATE_WORKSPACE)).toEqual([901]);
    expect(emitted).toEqual([PRIVATE_WORKSPACE]);
    expect(synced).toEqual([PRIVATE_WORKSPACE]);
  });

  it('publishes a regular workspace no matter which workspace is globally active', () => {
    const { panels, deps, emitted } = setup();

    dropRemovedTabFromPanels(deps, 2);

    expect(panels.getVisiblePanelIds(REGULAR_OTHER)).toEqual([]);
    expect(emitted).toEqual([REGULAR_OTHER]);
  });

  it('publishes nothing for a tab that is no panel', () => {
    const { deps, emitted, synced } = setup();

    dropRemovedTabFromPanels(deps, 4242);

    expect(emitted).toEqual([]);
    expect(synced).toEqual([]);
  });

  it('closes the devtools panels of a removed inspected tab', () => {
    const { panels, deps } = setup();
    vi.spyOn(panels, 'findLinksForInspectedTab').mockReturnValue([
      { devtoolsTabId: 77, inspectedTabId: 900 } as never,
    ]);

    dropRemovedTabFromPanels(deps, 900);

    expect(deps.closeDevtoolsPanelTabs).toHaveBeenCalledWith([77], 'inspected-tab devtools close');
  });
});
