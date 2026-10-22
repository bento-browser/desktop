import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPanelMarker, setDevtoolsPanelMarker, setPanelMarker } from './SessionMarker';

describe('panel session markers', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(),
        setTabValue: vi.fn(),
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

  it('writes the panel key into the marker and reads it back', async () => {
    await setPanelMarker(42, 'ws', {
      rootIndex: 1,
      containingRootNodeId: 'root-1',
      panelKey: 'panel-2',
    });

    const [, key, written] = vi.mocked(browser.sessions.setTabValue).mock.calls[0]!;
    expect(key).toBe('bento.isPanel');
    vi.mocked(browser.sessions.getTabValue).mockResolvedValue(written);

    await expect(readPanelMarker(42)).resolves.toMatchObject({
      workspaceId: 'ws',
      rootIndex: 1,
      containingRootNodeId: 'root-1',
      panelKey: 'panel-2',
    });
  });

  it('reads a marker written before keys existed as having none', async () => {
    vi.mocked(browser.sessions.getTabValue).mockResolvedValue(
      JSON.stringify({ version: 2, workspaceId: 'ws', rootIndex: 0 }),
    );

    const marker = await readPanelMarker(42);

    expect(marker?.workspaceId).toBe('ws');
    expect(marker?.panelKey).toBeUndefined();
  });

  it('writes no marker for a private window panel, whoever asks', async () => {
    await setPanelMarker(900, 'private:abc', { rootIndex: 0 });
    await setDevtoolsPanelMarker(900, 'private:abc');

    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });

  it('still marks a DevTools panel of a regular workspace', async () => {
    await setDevtoolsPanelMarker(42, 'ws');

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(42, 'bento.isDevtoolsPanel', '1');
  });
});
