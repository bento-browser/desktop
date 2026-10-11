// The overlay side of the lifecycle channel: the ready announcement and the
// acknowledgement, scoped to one chrome window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChromeTitle } from './fakeChromeTitle';
import { FakeBroadcastChannel, installFakeNetwork } from './overlayTestKit';

const LIFECYCLE = 'bento-overlay-lifecycle';

let chrome: ReturnType<typeof installFakeChromeTitle>;

beforeEach(() => {
  chrome = installFakeChromeTitle();
  installFakeNetwork();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Loads the module as a document that sits in `windowId`. */
async function loadAs(windowId: number | null) {
  vi.stubGlobal('location', { hash: windowId === null ? '' : `#bentoWindowId=${windowId}` });
  vi.resetModules();
  return import('./overlayReady');
}

function listen(): unknown[] {
  const seen: unknown[] = [];
  new FakeBroadcastChannel(LIFECYCLE).addEventListener('message', (event) => seen.push(event.data));
  return seen;
}

describe('overlay lifecycle channel', () => {
  it('announces readiness to chrome with a title and to senders on the bus', async () => {
    const seen = listen();
    const { signalOverlayReady, OVERLAY_READY_PREFIX } = await loadAs(1);

    signalOverlayReady('confirm');
    chrome.settle();

    expect(seen).toEqual([{ kind: 'ready', overlay: 'confirm', windowId: 1 }]);
    expect(chrome.observed).toHaveLength(1);
    expect(chrome.observed[0]).toMatch(new RegExp(`^${OVERLAY_READY_PREFIX}_\\d+$`));
  });

  it('acknowledges a request for this window', async () => {
    const seen = listen();
    const { acknowledgeOverlayRequest } = await loadAs(2);

    acknowledgeOverlayRequest('edit-workspace', 42);

    expect(seen).toEqual([{ kind: 'ack', overlay: 'edit-workspace', windowId: 2, requestId: 42 }]);
  });

  it('tells a watcher only about its own overlay in its own window', async () => {
    const sender = await loadAs(1);
    const watcher = { onReady: vi.fn(), onAck: vi.fn(), onCancel: vi.fn() };
    sender.watchOverlayLifecycle('confirm', watcher);
    const overlay = new FakeBroadcastChannel(LIFECYCLE);

    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: 2 });
    overlay.postMessage({ kind: 'ready', overlay: 'edit-workspace', windowId: 1 });
    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: null });
    overlay.postMessage({ kind: 'cancel', overlay: 'confirm', windowId: 2 });
    expect(watcher.onReady).not.toHaveBeenCalled();
    expect(watcher.onCancel).not.toHaveBeenCalled();

    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: 1 });
    overlay.postMessage({ kind: 'ack', overlay: 'confirm', windowId: 1, requestId: 7 });
    overlay.postMessage({ kind: 'cancel', overlay: 'confirm', windowId: 1 });
    expect(watcher.onReady).toHaveBeenCalledTimes(1);
    expect(watcher.onAck).toHaveBeenCalledWith(7);
    expect(watcher.onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed messages', async () => {
    const sender = await loadAs(1);
    const watcher = { onReady: vi.fn(), onAck: vi.fn(), onCancel: vi.fn() };
    sender.watchOverlayLifecycle('confirm', watcher);
    const overlay = new FakeBroadcastChannel(LIFECYCLE);

    overlay.postMessage(null);
    overlay.postMessage({ kind: 'ready' });
    overlay.postMessage({ kind: 'ack', overlay: 'confirm', windowId: 1 });
    overlay.postMessage({ kind: 'other', overlay: 'confirm', windowId: 1 });

    expect(watcher.onReady).not.toHaveBeenCalled();
    expect(watcher.onAck).not.toHaveBeenCalled();
    expect(watcher.onCancel).not.toHaveBeenCalled();
  });
});
