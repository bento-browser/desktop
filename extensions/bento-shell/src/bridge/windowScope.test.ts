// Every overlay bus is window-scoped: one extension origin serves every Bento
// window and a BroadcastChannel reaches all of them, so a message names its window
// and a receiver ignores other windows'. These use the real bridge modules on an
// in-memory channel network, with one set of module instances per document.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChromeTitle } from './fakeChromeTitle';
import {
  FakeBroadcastChannel,
  installFakeNetwork,
  loadChromeSubscribers,
  loadDocument,
  postRaw,
  type OverlayKind,
} from './overlayTestKit';

beforeEach(() => {
  installFakeChromeTitle();
  installFakeNetwork();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['confirm', 'edit-workspace', 'workspace-switcher'] satisfies OverlayKind[])(
  '%s payloads',
  (kind) => {
    it('reach the overlay of the sender window', async () => {
      const sender = await loadDocument(1, kind);
      const overlay = await loadDocument(1, kind);
      const applied: string[] = [];
      overlay.subscribe((label) => applied.push(label));

      sender.request('Alpha');

      expect(applied).toEqual(['Alpha']);
    });

    it('never reach the overlay of another window', async () => {
      const senderA = await loadDocument(1, kind);
      const overlayA = await loadDocument(1, kind);
      const senderB = await loadDocument(2, kind);
      const overlayB = await loadDocument(2, kind);
      const appliedA: string[] = [];
      const appliedB: string[] = [];
      overlayA.subscribe((label) => appliedA.push(label));
      overlayB.subscribe((label) => appliedB.push(label));

      senderB.request('Beta');
      expect(appliedA).toEqual([]);
      expect(appliedB).toEqual(['Beta']);

      senderA.request('Alpha');
      expect(appliedA).toEqual(['Alpha']);
      expect(appliedB).toEqual(['Beta']);
    });

    it('are applied by documents whose window id is unknown, as on an unscoped bus', async () => {
      // Ladle, the standalone preview, or a failed chrome-side lookup.
      const sender = await loadDocument(null, kind);
      const overlay = await loadDocument(null, kind);
      const applied: string[] = [];
      overlay.subscribe((label) => applied.push(label));

      sender.request('Alpha');

      expect(applied).toEqual(['Alpha']);
    });

    it('carry the window id the receiver compares', async () => {
      const sender = await loadDocument(7, kind);
      const seen: unknown[] = [];
      new FakeBroadcastChannel(sender.busName).addEventListener('message', (event) =>
        seen.push(event.data),
      );

      sender.request('Alpha');

      expect(seen).toMatchObject([{ kind: 'show', windowId: 7 }]);
    });
  },
);

describe('confirm actions', () => {
  it('only ever run for the request the user confirmed, across windows', async () => {
    const confirmed: string[] = [];
    // The confirm overlay renders the newest applied payload and its button
    // dispatches that payload's action.
    const showDialog = async (windowId: number) => {
      const overlay = await loadDocument(windowId, 'confirm');
      let shown: string | null = null;
      overlay.subscribe((label) => (shown = label));
      return { click: () => confirmed.push(`${windowId}:${String(shown)}`) };
    };

    const senderA = await loadDocument(1, 'confirm');
    const senderB = await loadDocument(2, 'confirm');
    const dialogA = await showDialog(1);
    const dialogB = await showDialog(2);

    // Window A's dialog is open on Alpha when window B asks to delete Beta.
    senderA.request('Delete Alpha');
    senderB.request('Delete Beta');
    dialogA.click();
    dialogB.click();

    expect(confirmed).toEqual(['1:Delete Alpha', '2:Delete Beta']);
  });

  it('a later request in the same window replaces the open dialog, as it always did', async () => {
    const sender = await loadDocument(1, 'confirm');
    const overlay = await loadDocument(1, 'confirm');
    const shown: string[] = [];
    overlay.subscribe((label) => shown.push(label));

    sender.request('Delete Alpha');
    sender.request('Delete Gamma');

    expect(shown).toEqual(['Delete Alpha', 'Delete Gamma']);
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

// The frame scripts are the strings chrome loads into the overlay's process; they
// are read from the mount here so the contract test runs the code that ships.
describe('chrome-to-overlay messages', () => {
  const MOUNT = readFileSync(
    fileURLToPath(
      new URL('../../../../src/browser/base/content/bento-shell-mount.js', import.meta.url),
    ),
    'utf8',
  );

  /** Runs one frame script and returns the handler it registers for `messageName`. */
  function loadFrameScript(constant: string, messageName: string) {
    const match = new RegExp(
      `const ${constant}_SRC =\\s*([\\s\\S]*?);\\n\\s*const ${constant}_URL`,
    ).exec(MOUNT);
    if (!match) throw new Error(`${constant}_SRC not found in the mount`);
    const source = new Function(`return ${match[1]};`)() as string;
    const handlers = new Map<string, (message: { data: unknown }) => void>();
    new Function('addMessageListener', 'content', source)(
      (name: string, handler: (message: { data: unknown }) => void) => handlers.set(name, handler),
      { BroadcastChannel: FakeBroadcastChannel },
    );
    const handler = handlers.get(messageName);
    if (!handler) throw new Error(`${constant} does not listen for ${messageName}`);
    return (data: unknown) => handler({ data });
  }

  const ANCHOR = { left: 1, top: 2, width: 3, height: 4 };

  it('address bar opens reach only the address bar of the window chrome named', async () => {
    const send = loadFrameScript('ADDRBAR_OPEN_FRAME_SCRIPT', 'BentoAddrbarOpen');
    const one = await loadChromeSubscribers(1);
    const two = await loadChromeSubscribers(2);
    const opensOne: string[] = [];
    const opensTwo: string[] = [];
    one.addrbar((_mode, query) => opensOne.push(query ?? ''));
    two.addrbar((_mode, query) => opensTwo.push(query ?? ''));

    send({ openId: 'a', mode: 'current', initialQuery: 'for window 2', windowId: 2 });
    send({ openId: 'b', mode: 'current', initialQuery: 'for window 1', windowId: 1 });

    expect(opensOne).toEqual(['for window 1']);
    expect(opensTwo).toEqual(['for window 2']);
  });

  it('merge palette open and close messages reach only the window chrome named', async () => {
    const send = loadFrameScript(
      'MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT',
      'BentoMergePaletteLifecycle',
    );
    const one = await loadChromeSubscribers(1);
    const two = await loadChromeSubscribers(2);
    const eventsOne: string[] = [];
    const eventsTwo: string[] = [];
    one.mergePalette(({ type, nonce }) => eventsOne.push(`${type}:${nonce}`));
    two.mergePalette(({ type, nonce }) => eventsTwo.push(`${type}:${nonce}`));

    send({ type: 'open', nonce: 'n1', windowId: 1 });
    send({ type: 'close', nonce: 'n2', windowId: 2 });

    expect(eventsOne).toEqual(['open:n1']);
    expect(eventsTwo).toEqual(['close:n2']);
  });

  it('menu/open actions reach only the menu of the window chrome named', async () => {
    const send = loadFrameScript('SHELL_ACTION_FRAME_SCRIPT', 'BentoShellAction');
    const one = await loadChromeSubscribers(1);
    const two = await loadChromeSubscribers(2);
    const menusOne: string[] = [];
    const menusTwo: string[] = [];
    one.menu((payload) => menusOne.push(payload.contextId));
    two.menu((payload) => menusTwo.push(payload.contextId));
    const open = (contextId: string, windowId: number) => ({
      type: 'menu/open',
      contextId,
      items: [],
      anchor: ANCHOR,
      __windowId: windowId,
    });

    // Window 2's menu is open; window 1 asks for its own.
    send(open('menu-2', 2));
    send(open('menu-1', 1));

    expect(menusOne).toEqual(['menu-1']);
    expect(menusTwo).toEqual(['menu-2']);
  });

  it('messages without a window id are applied, as from a chrome whose lookup failed', async () => {
    const send = loadFrameScript(
      'MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT',
      'BentoMergePaletteLifecycle',
    );
    const one = await loadChromeSubscribers(1);
    const events: string[] = [];
    one.mergePalette(({ type }) => events.push(type));

    send({ type: 'open', nonce: 'n1' });

    expect(events).toEqual(['open']);
  });

  it('ignores a raw message for another window on every chrome bus', async () => {
    const one = await loadChromeSubscribers(1);
    const seen = vi.fn();
    one.addrbar(seen);
    one.mergePalette(seen);
    one.menu(seen);

    postRaw('bento-addrbar-bus', { kind: 'open', mode: 'current', windowId: 2 });
    postRaw('bento-merge-palette', { type: 'open', nonce: 'x', windowId: 2 });
    postRaw('bento-shell-bus', {
      kind: 'action',
      action: { type: 'menu/open', contextId: 'm', items: [], anchor: ANCHOR, __windowId: 2 },
    });

    expect(seen).not.toHaveBeenCalled();
  });
});
