// The readiness announcement: one title per call, which chrome recognises by its
// prefix.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChromeTitle } from './fakeChromeTitle';
import { OVERLAY_READY_PREFIX, signalOverlayReady } from './overlayReady';

let chrome: ReturnType<typeof installFakeChromeTitle>;

beforeEach(() => {
  chrome = installFakeChromeTitle();
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('signalOverlayReady', () => {
  it('writes a title chrome recognises as the announcement of the overlay', () => {
    signalOverlayReady('confirm');
    chrome.settle();

    expect(chrome.observed).toEqual([`${OVERLAY_READY_PREFIX}:confirm_1000`]);
    expect(chrome.observed[0]?.startsWith(OVERLAY_READY_PREFIX)).toBe(true);
  });
});
