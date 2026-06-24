import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabRegistry } from './TabRegistry';

describe('TabRegistry closing markers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn().mockResolvedValue('1'),
        setTabValue: vi.fn().mockResolvedValue(undefined),
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('can clear the closing marker when a closed tab is restored', async () => {
    const tabs = new TabRegistry();

    await tabs.markClosing(123);
    expect(tabs.isClosing(123)).toBe(true);

    await tabs.unmarkClosing(123);

    expect(tabs.isClosing(123)).toBe(false);
    await expect(tabs.isClosingOrMarked(123)).resolves.toBe(false);
    expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(123, 'bento.closingTab');
  });

  it('reports whether eager workspace assignment persisted to the session store', async () => {
    const tabs = new TabRegistry();

    await expect(tabs.assignWorkspaceEagerly(456, 'ws-imported')).resolves.toBe(true);

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(
      456,
      'bento.workspaceId',
      'ws-imported',
    );
  });

  it('returns false when eager workspace assignment cannot persist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.sessions.setTabValue).mockRejectedValueOnce(new Error('write failed'));
    const tabs = new TabRegistry();

    try {
      await expect(tabs.assignWorkspaceEagerly(456, 'ws-imported')).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports whether eager folder assignment persisted to the session store', async () => {
    const tabs = new TabRegistry();

    await expect(tabs.assignFolderEagerly(456, 'folder-imported')).resolves.toBe(true);

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(
      456,
      'bento.folderId',
      'folder-imported',
    );
  });

  it('returns false when eager folder assignment cannot persist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.sessions.setTabValue).mockRejectedValueOnce(new Error('write failed'));
    const tabs = new TabRegistry();

    try {
      await expect(tabs.assignFolderEagerly(456, 'folder-imported')).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
