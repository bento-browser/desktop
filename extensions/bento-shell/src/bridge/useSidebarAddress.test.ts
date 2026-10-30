import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarAddressStore } from '../state/sidebarAddress';
import { installFakeChromeTitle } from './fakeChromeTitle';
import {
  applySidebarAddressBusMessage,
  SIDEBAR_ADDRESS_READY_PREFIX,
  shouldAcceptSidebarAddressMessage,
  signalSidebarAddressReady,
} from './useSidebarAddress';

describe('sidebar address bridge scope', () => {
  const expected = { windowId: 7, bridgeToken: 'token-a' };

  it('accepts matching scoped messages', () => {
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'open-request', windowId: 7, bridgeToken: 'token-a', requestId: 'r', mode: 'current' },
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
        { kind: 'open-request', windowId: 8, bridgeToken: 'token-a', requestId: 'r', mode: 'current' },
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
        { kind: 'open-request', windowId: null, bridgeToken: 'token-a', requestId: 'r', mode: 'current' },
        { windowId: null, bridgeToken: 'token-a' },
      ),
    ).toBe(true);
    expect(
      shouldAcceptSidebarAddressMessage(
        { kind: 'open-request', windowId: 7, bridgeToken: 'token-a', requestId: 'r', mode: 'current' },
        { windowId: null, bridgeToken: 'token-a' },
      ),
    ).toBe(false);
  });
});

describe('palette-over-row message', () => {
  const expected = { windowId: 7, bridgeToken: 'token-a' };
  const message = (open: boolean, overrides: { windowId?: number; bridgeToken?: string } = {}) =>
    ({
      kind: 'palette-over-row',
      windowId: 7,
      bridgeToken: 'token-a',
      open,
      ...overrides,
    }) as const;

  beforeEach(() => {
    useSidebarAddressStore.getState().reset();
  });

  it('is accepted only for the matching window and bridge token', () => {
    expect(shouldAcceptSidebarAddressMessage(message(true), expected)).toBe(true);
    expect(shouldAcceptSidebarAddressMessage(message(true, { windowId: 8 }), expected)).toBe(false);
    expect(
      shouldAcceptSidebarAddressMessage(message(true, { bridgeToken: 'token-b' }), expected),
    ).toBe(false);
  });

  it('sets and clears the row flag', () => {
    applySidebarAddressBusMessage(message(true));
    expect(useSidebarAddressStore.getState().paletteOverRow).toBe(true);
    applySidebarAddressBusMessage(message(false));
    expect(useSidebarAddressStore.getState().paletteOverRow).toBe(false);
  });
});

describe('signalSidebarAddressReady', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes the title chrome reads as a new sidebar document listening', () => {
    const chrome = installFakeChromeTitle();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    signalSidebarAddressReady();
    chrome.settle();

    expect(chrome.observed).toEqual([`${SIDEBAR_ADDRESS_READY_PREFIX}1000`]);
  });
});
