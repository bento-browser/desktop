import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newLayerRequestId, type LayerRequestId } from '../bridge/layerRequest';
import type { ConfirmPayload } from '../bridge/useConfirm';

// A hosted document with just the parts the presentation follows. Like the actor, `present`
// writes the root attributes first and then fires the event, synchronously.
let attributes: Map<string, string>;
let listeners: Set<() => void>;

type Shown = { layer: string; id: string };

function present(target: Shown | null) {
  attributes.set('data-bento-host-presented', String(target !== null));
  if (target) {
    attributes.set('data-bento-host-layer', target.layer);
    attributes.set('data-bento-host-request', target.id);
  } else {
    attributes.delete('data-bento-host-layer');
    attributes.delete('data-bento-host-request');
  }
  for (const listener of listeners) listener();
}

const CONFIRM: ConfirmPayload = {
  title: 'Delete?',
  description: '',
  confirmLabel: 'Delete',
  variant: 'danger',
  action: { type: 'workspace/delete', id: 'w1', closeTabs: true },
};
const SWITCHER = {
  triggerRect: { x: 0, y: 0, width: 1, height: 1 },
  sidebarScreenX: 0,
  sidebarScreenY: 0,
};

async function load() {
  vi.resetModules();
  const layers = await import('./layers');
  const dropped: string[] = [];
  layers.observeWorkspaceLayersPresentation((layer) => dropped.push(layer));
  const shown = () => layers.visibleWorkspaceLayer(layers.useWorkspaceLayers.getState());
  const confirm = (id: LayerRequestId, title = CONFIRM.title) =>
    layers.showWorkspaceLayer({ layer: 'confirm', id, payload: { ...CONFIRM, title } });
  const switcher = (id: LayerRequestId, sidebarScreenX = 0) =>
    layers.showWorkspaceLayer({
      layer: 'workspace-switcher',
      id,
      payload: { ...SWITCHER, sidebarScreenX },
    });
  return { ...layers, dropped, shown, confirm, switcher };
}

const confirmOf = (id: string): Shown => ({ layer: 'confirm', id });
const switcherOf = (id: string): Shown => ({ layer: 'workspace-switcher', id });

beforeEach(() => {
  attributes = new Map();
  listeners = new Set();
  vi.stubGlobal('location', { hash: '#bentoHostedOverlay=1&bentoWindowId=3' });
  vi.stubGlobal('document', {
    documentElement: { getAttribute: (name: string) => attributes.get(name) ?? null },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('workspace layers', () => {
  it('renders a request only once chrome presents its id, in either order', async () => {
    const early = await load();
    const a = newLayerRequestId();
    early.confirm(a);
    expect(early.shown()).toBeNull();
    present(confirmOf(a));
    expect(early.shown()?.id).toBe(a);

    const late = await load();
    const b = newLayerRequestId();
    present(confirmOf(b));
    expect(late.shown()).toBeNull();
    late.confirm(b);
    expect(late.shown()?.id).toBe(b);
  });

  it('shows nothing for a presentation that names no valid id or another layer', async () => {
    const layers = await load();
    const a = newLayerRequestId();
    layers.confirm(a);
    present({ layer: 'confirm', id: 'not-an-id' });
    expect(layers.shown()).toBeNull();
    present(switcherOf(a));
    expect(layers.shown()).toBeNull();
  });

  // Review finding, order 1: while A fades out (still presented), chrome takes B's open and
  // presents B before B's payload lands; that presentation bound to the retained A.
  it('shows B when its presentation arrives before its payload while A fades out', async () => {
    const layers = await load();
    const a = newLayerRequestId();
    const b = newLayerRequestId();
    layers.confirm(a, 'A');
    present(confirmOf(a));
    present(confirmOf(b));
    expect(layers.shown()).toBeNull();
    layers.confirm(b, 'B');
    expect(layers.shown()?.payload).toMatchObject({ title: 'B' });
  });

  // Review finding, order 2: chrome cancelled A before A's payload arrived; the delayed A then
  // bound to B's presentation.
  it('shows B, not a cancelled A whose payload lands after B is presented', async () => {
    const layers = await load();
    const a = newLayerRequestId();
    const b = newLayerRequestId();
    present(confirmOf(b));
    layers.confirm(a, 'A');
    expect(layers.shown()).toBeNull();
    layers.confirm(b, 'B');
    expect(layers.shown()?.payload).toMatchObject({ title: 'B' });
  });

  it('never shows a request chrome cancelled before its payload arrived', async () => {
    const layers = await load();
    const a = newLayerRequestId();
    const b = newLayerRequestId();
    // Chrome took A's title and cancelled the open, so it never presents A; A's payload lands.
    layers.confirm(a, 'A');
    expect(layers.shown()).toBeNull();
    // B's presentation comes before B's payload: the host shows nothing, not A.
    present(confirmOf(b));
    expect(layers.shown()).toBeNull();
    layers.confirm(b, 'B');
    expect(layers.shown()?.payload).toMatchObject({ title: 'B' });
  });

  it('keeps showing the newer request when a stale payload arrives after it', async () => {
    const layers = await load();
    const a = newLayerRequestId();
    const b = newLayerRequestId();
    layers.confirm(b, 'B');
    present(confirmOf(b));
    layers.confirm(a, 'A');
    expect(layers.shown()?.payload).toMatchObject({ title: 'B' });
    present(null);
    expect(layers.shown()).toBeNull();
    expect(layers.useWorkspaceLayers.getState().requests.has(b)).toBe(false);
  });

  it('hands the host from the switcher to the layer it opens, then drops it on the hide', async () => {
    const layers = await load();
    const s = newLayerRequestId();
    const c = newLayerRequestId();
    layers.switcher(s);
    present(switcherOf(s));
    layers.confirm(c);
    // The switcher's close after its item action leaves the layer that replaced it.
    layers.clearWorkspaceLayer(s);
    expect(layers.shown()).toBeNull();
    present(confirmOf(c));
    expect(layers.shown()?.id).toBe(c);

    present(null);
    expect(layers.useWorkspaceLayers.getState().requests.size).toBe(0);
    expect(layers.dropped).toEqual(['confirm']);
  });

  it('keeps a request for another layer that arrives during the fade-out', async () => {
    const layers = await load();
    const c = newLayerRequestId();
    const s = newLayerRequestId();
    layers.confirm(c);
    present(confirmOf(c));
    layers.switcher(s);
    present(null);
    expect(layers.dropped).toEqual(['confirm']);
    present(switcherOf(s));
    expect(layers.shown()?.id).toBe(s);
  });

  // The previous round: show(A), present(confirm), show(B), present(null), present(confirm).
  it('keeps a newer request for the same layer that the previous hide does not retire', async () => {
    const layers = await load();
    const a = newLayerRequestId();
    const b = newLayerRequestId();
    layers.confirm(a, 'A');
    present(confirmOf(a));
    layers.confirm(b, 'B');
    expect(layers.shown()?.payload).toMatchObject({ title: 'A' });
    present(null);
    present(confirmOf(b));
    expect(layers.shown()?.payload).toMatchObject({ title: 'B' });
  });

  it.each([
    ['before', true],
    ['after', false],
  ])(
    'reopens the switcher at the end of its fade, with the payload %s the old hide',
    async (_order, payloadFirst) => {
      const layers = await load();
      const s1 = newLayerRequestId();
      const s2 = newLayerRequestId();
      layers.switcher(s1);
      present(switcherOf(s1));
      // The menu closes itself; chrome fades the host out.
      layers.clearWorkspaceLayer(s1);
      if (payloadFirst) layers.switcher(s2, 9);
      present(null);
      if (!payloadFirst) layers.switcher(s2, 9);
      // Chrome gets the new open title and presents the host again.
      present(switcherOf(s2));
      expect(layers.shown()?.payload).toMatchObject({ sidebarScreenX: 9 });
    },
  );
});
