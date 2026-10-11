// Window-scoped, ordered overlay requests, with the real bridge modules on an
// in-memory BroadcastChannel network (overlayTestKit.ts). Each "document" has
// its own module instances and its own window id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChromeTitle } from './fakeChromeTitle';
import {
  FakeBroadcastChannel,
  installFakeNetwork,
  loadDocument,
  postRaw,
  type OverlayAdapter,
  type OverlayKind,
} from './overlayTestKit';

const KINDS: OverlayKind[] = ['confirm', 'edit-workspace', 'workspace-switcher'];
const LIFECYCLE = 'bento-overlay-lifecycle';

let now = 1_000_000;

beforeEach(() => {
  installFakeChromeTitle();
  installFakeNetwork();
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** An overlay document that records every payload it applies. */
function mount(overlay: OverlayAdapter): string[] {
  const applied: string[] = [];
  overlay.subscribe((label) => applied.push(label));
  overlay.signalReady();
  return applied;
}

describe.each(KINDS)('%s requests', (kind) => {
  it('reach an overlay that is already mounted, once', async () => {
    const sender = await loadDocument(1, kind);
    const overlay = await loadDocument(1, kind);
    const applied = mount(overlay);

    sender.request('Alpha');
    expect(applied).toEqual(['Alpha']);

    // The overlay acknowledged it, so a reload's readiness posts nothing again.
    overlay.signalReady();
    expect(applied).toEqual(['Alpha']);
  });

  it('are posted again when the overlay mounts later', async () => {
    const sender = await loadDocument(1, kind);
    const overlay = await loadDocument(1, kind);

    sender.request('Alpha');
    const applied = mount(overlay);

    expect(applied).toEqual(['Alpha']);
  });

  it('wait for the overlay however long it takes to load', async () => {
    const sender = await loadDocument(1, kind);
    const overlay = await loadDocument(1, kind);

    sender.request('Alpha');
    now += 10 * 60_000;
    const applied = mount(overlay);

    expect(applied).toEqual(['Alpha']);
  });

  it('are applied once however often they are posted', async () => {
    const sender = await loadDocument(1, kind);
    const overlay = await loadDocument(1, kind);
    const applied = mount(overlay);
    const seen: unknown[] = [];
    new FakeBroadcastChannel(overlay.busName).addEventListener('message', (event) =>
      seen.push(event.data),
    );

    sender.request('Alpha');
    // The same message again, as a late replay would deliver it.
    postRaw(overlay.busName, seen[0]);
    postRaw(overlay.busName, seen[0]);

    expect(applied).toEqual(['Alpha']);
  });

  it('are replaced by a newer request for the same window before the overlay exists', async () => {
    const sender = await loadDocument(1, kind);
    const overlay = await loadDocument(1, kind);

    sender.request('Alpha');
    now += 5;
    sender.request('Beta');
    const applied = mount(overlay);

    expect(applied).toEqual(['Beta']);
  });

  it('cannot be overwritten by a delayed replay of an older request from another document', async () => {
    // Two documents of window 1 each hold a pending request and the overlay
    // mounts. The first document to register replays first, so run both orders
    // of "older request replays first" and "newer request replays first".
    for (const firstIsNewer of [false, true]) {
      installFakeNetwork();
      now = 1_000_000;
      const first = await loadDocument(1, kind);
      const second = await loadDocument(1, kind);
      const overlay = await loadDocument(1, kind);

      now = firstIsNewer ? 1_000_100 : 1_000_000;
      first.request('from-first');
      now = firstIsNewer ? 1_000_000 : 1_000_100;
      second.request('from-second');

      const applied = mount(overlay);

      const newer = firstIsNewer ? 'from-first' : 'from-second';
      const older = firstIsNewer ? 'from-second' : 'from-first';
      expect(applied.at(-1)).toBe(newer);
      // The older request may show first but never after the newer one.
      expect(applied.lastIndexOf(older)).toBeLessThan(applied.indexOf(newer));
    }
  });

  it('are dropped when chrome cancels the open of that window', async () => {
    const sender = await loadDocument(1, kind);
    const overlay = await loadDocument(1, kind);

    sender.request('Alpha');
    postRaw(LIFECYCLE, { kind: 'cancel', overlay: overlay.overlay, windowId: 1 });
    const applied = mount(overlay);

    expect(applied).toEqual([]);
  });

  it('survive a cancel that is for another window or another overlay', async () => {
    const sender = await loadDocument(1, kind);
    const overlay = await loadDocument(1, kind);

    sender.request('Alpha');
    postRaw(LIFECYCLE, { kind: 'cancel', overlay: overlay.overlay, windowId: 2 });
    postRaw(LIFECYCLE, { kind: 'cancel', overlay: 'palette', windowId: 1 });
    const applied = mount(overlay);

    expect(applied).toEqual(['Alpha']);
  });

  describe('across windows', () => {
    it('never reach another window, mounted or not', async () => {
      const senderA = await loadDocument(1, kind);
      const overlayA = await loadDocument(1, kind);
      const senderB = await loadDocument(2, kind);
      const overlayB = await loadDocument(2, kind);
      const appliedA = mount(overlayA);
      const appliedB = mount(overlayB);

      senderB.request('Beta');
      expect(appliedA).toEqual([]);
      expect(appliedB).toEqual(['Beta']);

      senderA.request('Alpha');
      expect(appliedA).toEqual(['Alpha']);
      expect(appliedB).toEqual(['Beta']);
    });

    it("a deferred replay in window B does not replace window A's current request", async () => {
      // The review scenario: B asks while its overlay is still loading, A then
      // asks and shows its dialog, and only then does B's overlay become ready.
      const senderA = await loadDocument(1, kind);
      const overlayA = await loadDocument(1, kind);
      const senderB = await loadDocument(2, kind);
      const overlayB = await loadDocument(2, kind);
      const appliedA = mount(overlayA);

      senderB.request('Beta');
      now += 50;
      senderA.request('Alpha');
      expect(appliedA).toEqual(['Alpha']);

      const appliedB = mount(overlayB);

      expect(appliedA).toEqual(['Alpha']);
      expect(appliedB).toEqual(['Beta']);
    });

    it("another window's overlay becoming ready neither releases nor clears a pending request", async () => {
      const senderA = await loadDocument(1, kind);
      const overlayA = await loadDocument(1, kind);
      const overlayB = await loadDocument(2, kind);

      senderA.request('Alpha');
      mount(overlayB);
      const appliedA = mount(overlayA);

      expect(appliedA).toEqual(['Alpha']);
    });
  });
});

describe('confirm actions', () => {
  it('only ever run for the request the user confirmed', async () => {
    const confirmed: string[] = [];
    // The confirm overlay renders the newest applied payload and its button
    // dispatches that payload's action.
    const showDialog = (overlay: OverlayAdapter) => {
      let shown: string | null = null;
      overlay.subscribe((label) => (shown = label));
      overlay.signalReady();
      return { click: () => confirmed.push(`${String(shown)}`) };
    };

    const senderA = await loadDocument(1, 'confirm');
    const overlayA = await loadDocument(1, 'confirm');
    const senderB = await loadDocument(2, 'confirm');
    const overlayB = await loadDocument(2, 'confirm');
    const dialogA = showDialog(overlayA);
    const dialogB = showDialog(overlayB);

    // Window A's dialog is open on Alpha when window B asks to delete Beta.
    senderA.request('Delete Alpha');
    now += 10;
    senderB.request('Delete Beta');
    dialogA.click();
    dialogB.click();

    expect(confirmed).toEqual(['Delete Alpha', 'Delete Beta']);
  });

  it('never run for a superseded request, even when its replay arrives last', async () => {
    const senderA = await loadDocument(1, 'confirm');
    const senderA2 = await loadDocument(1, 'confirm');
    const overlayA = await loadDocument(1, 'confirm');
    const shownOverTime: string[] = [];
    overlayA.subscribe((label) => shownOverTime.push(label));

    // Both senders ask while the overlay is loading: Gamma is the newer request.
    senderA.request('Delete Alpha');
    now += 10;
    senderA2.request('Delete Gamma');
    overlayA.signalReady();
    expect(shownOverTime.at(-1)).toBe('Delete Gamma');

    // A stale replay of the older request arriving now changes nothing.
    now += 10;
    overlayA.signalReady();
    expect(shownOverTime.at(-1)).toBe('Delete Gamma');
    expect(shownOverTime.filter((label) => label === 'Delete Gamma')).toHaveLength(1);
  });
});

describe('workspace switcher close notices', () => {
  it('reach the sidebar of the same window only', async () => {
    vi.stubGlobal('location', { hash: '#bentoWindowId=1' });
    vi.resetModules();
    const sidebarA = await import('./useWorkspaceSwitcher');
    vi.stubGlobal('location', { hash: '#bentoWindowId=2' });
    vi.resetModules();
    const overlayB = await import('./useWorkspaceSwitcher');

    const closedA = vi.fn();
    sidebarA.subscribeToWorkspaceSwitcherClose(closedA);

    overlayB.notifyWorkspaceSwitcherClosed();
    expect(closedA).not.toHaveBeenCalled();

    vi.stubGlobal('location', { hash: '#bentoWindowId=1' });
    vi.resetModules();
    const overlayA = await import('./useWorkspaceSwitcher');
    overlayA.notifyWorkspaceSwitcherClosed();
    expect(closedA).toHaveBeenCalledTimes(1);
  });
});
