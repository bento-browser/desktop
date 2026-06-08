import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPanelMarker } from './SessionMarker';

describe('panel session markers', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads imported pinned-panel markers from restored session data', async () => {
    vi.mocked(browser.sessions.getTabValue).mockResolvedValue(
      JSON.stringify({
        version: 2,
        workspaceId: 'zen-workspace',
        rootIndex: 3,
        pinnedPanel: true,
      }),
    );

    await expect(readPanelMarker(42)).resolves.toEqual({
      workspaceId: 'zen-workspace',
      rootIndex: 3,
      pinnedPanel: true,
    });
    expect(browser.sessions.getTabValue).toHaveBeenCalledWith(42, 'bento.isPanel');
  });
});
