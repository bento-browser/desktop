// The overlay readiness handshake: a payload posted before an overlay document
// exists reaches it once it announces itself, and only in the window it belongs to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChromeTitle } from './fakeChromeTitle';

/** In-memory BroadcastChannel: delivers to every other instance of the same name. */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  closed = false;

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.#listeners.add(listener);
  }

  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.instances) {
      if (other === this || other.closed || other.name !== this.name) continue;
      for (const listener of other.#listeners) listener({ data } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

describe('overlay readiness handshake', () => {
  let chrome: ReturnType<typeof installFakeChromeTitle>;

  beforeEach(() => {
    FakeBroadcastChannel.instances = [];
    chrome = installFakeChromeTitle();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('location', { hash: '#bentoWindowId=1' });
    vi.resetModules();
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

  it('tells chrome with a title and tells senders on the bus', async () => {
    const listener = vi.fn();
    const watcher = new FakeBroadcastChannel('bento-overlay-ready');
    watcher.addEventListener('message', (event) => listener(event.data));

    const { signalOverlayReady, OVERLAY_READY_PREFIX } = await loadAs(1);
    signalOverlayReady('confirm');
    chrome.settle();

    expect(listener).toHaveBeenCalledWith({ kind: 'ready', overlay: 'confirm', windowId: 1 });
    expect(chrome.observed).toHaveLength(1);
    expect(chrome.observed[0]).toMatch(new RegExp(`^${OVERLAY_READY_PREFIX}_\\d+$`));
  });

  it('sends the payload again when the overlay in this window becomes ready', async () => {
    const sender = await loadAs(1);
    const send = vi.fn();
    sender.resendWhenOverlayReady('confirm', send);
    expect(send).not.toHaveBeenCalled();

    const overlay = new FakeBroadcastChannel('bento-overlay-ready');
    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: 1 });
    expect(send).toHaveBeenCalledTimes(1);

    // The overlay announces once; a second announcement finds nothing pending.
    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores an overlay of another window or another name', async () => {
    const sender = await loadAs(1);
    const send = vi.fn();
    sender.resendWhenOverlayReady('confirm', send);

    const overlay = new FakeBroadcastChannel('bento-overlay-ready');
    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: 2 });
    overlay.postMessage({ kind: 'ready', overlay: 'edit-workspace', windowId: 1 });
    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: null });
    expect(send).not.toHaveBeenCalled();

    // The payload is still waiting for its own window's overlay.
    overlay.postMessage({ kind: 'ready', overlay: 'confirm', windowId: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('matches documents that have no window id with each other', async () => {
    const sender = await loadAs(null);
    const send = vi.fn();
    sender.resendWhenOverlayReady('menu', send);

    new FakeBroadcastChannel('bento-overlay-ready').postMessage({
      kind: 'ready',
      overlay: 'menu',
      windowId: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest payload per overlay', async () => {
    const sender = await loadAs(1);
    const first = vi.fn();
    const second = vi.fn();
    sender.resendWhenOverlayReady('edit-workspace', first);
    sender.resendWhenOverlayReady('edit-workspace', second);

    new FakeBroadcastChannel('bento-overlay-ready').postMessage({
      kind: 'ready',
      overlay: 'edit-workspace',
      windowId: 1,
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('drops a payload whose open was abandoned long ago', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const sender = await loadAs(1);
    const send = vi.fn();
    sender.resendWhenOverlayReady('confirm', send);

    clock.mockReturnValue(1_000_000 + sender.OVERLAY_RESEND_WINDOW_MS + 1);
    new FakeBroadcastChannel('bento-overlay-ready').postMessage({
      kind: 'ready',
      overlay: 'confirm',
      windowId: 1,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores messages that are not ready announcements', async () => {
    const sender = await loadAs(1);
    const send = vi.fn();
    sender.resendWhenOverlayReady('confirm', send);

    const bus = new FakeBroadcastChannel('bento-overlay-ready');
    bus.postMessage(null);
    bus.postMessage('ready');
    bus.postMessage({ kind: 'closed', overlay: 'confirm', windowId: 1 });
    expect(send).not.toHaveBeenCalled();
  });
});
