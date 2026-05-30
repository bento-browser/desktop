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

  it('can clear the closing marker when a closed panel is restored', async () => {
    const tabs = new TabRegistry();

    await tabs.markClosing(123);
    expect(tabs.isClosing(123)).toBe(true);

    await tabs.unmarkClosing(123);

    expect(tabs.isClosing(123)).toBe(false);
    await expect(tabs.isClosingOrMarked(123)).resolves.toBe(false);
    expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(123, 'bento.closingTab');
  });
});
