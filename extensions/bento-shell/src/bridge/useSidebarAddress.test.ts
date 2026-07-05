import { describe, expect, it } from 'vitest';
import { shouldAcceptSidebarAddressMessage } from './useSidebarAddress';

describe('sidebar address bridge scope', () => {
  const expected = { windowId: 7, bridgeToken: 'token-a' };

  it('accepts matching scoped messages', () => {
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'focus', windowId: 7, bridgeToken: 'token-a', mode: 'current' },
        expected,
      ),
    ).toBe(true);
    expect(
      shouldAcceptSidebarAddressMessage(
        {
          kind: 'copy-result',
          windowId: 7,
          bridgeToken: 'token-a',
          tabId: 10,
          url: 'https://example.com',
          snapshotToken: 2,
          success: true,
        },
        expected,
      ),
    ).toBe(true);
  });

  it('rejects mismatched window ids', () => {
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'focus', windowId: 8, bridgeToken: 'token-a', mode: 'current' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects mismatched and missing bridge tokens', () => {
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'snapshot', windowId: 7, bridgeToken: 'token-b', snapshotToken: 1 },
        expected,
      ),
    ).toBe(false);
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'snapshot', windowId: 7, snapshotToken: 1 },
        expected,
      ),
    ).toBe(false);
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'snapshot', windowId: 7, bridgeToken: 'token-a', snapshotToken: 1 },
        { windowId: 7, bridgeToken: null },
      ),
    ).toBe(false);
  });

  it('requires null window ids only when the local window id is unknown', () => {
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'focus', windowId: null, bridgeToken: 'token-a', mode: 'current' },
        { windowId: null, bridgeToken: 'token-a' },
      ),
    ).toBe(true);
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'focus', windowId: 7, bridgeToken: 'token-a', mode: 'current' },
        { windowId: null, bridgeToken: 'token-a' },
      ),
    ).toBe(false);
  });
});
