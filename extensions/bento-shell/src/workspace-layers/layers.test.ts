import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmPayload } from '../bridge/useConfirm';

// A hosted document with just the parts the presentation follows. Like the actor, `present`
// writes the root attributes first and then fires the event, synchronously.
let attributes: Map<string, string>;
let listeners: Set<() => void>;

function present(layer: string | null) {
  attributes.set('data-bento-host-presented', String(layer !== null));
  if (layer) attributes.set('data-bento-host-layer', layer);
  else attributes.delete('data-bento-host-layer');
  for (const listener of listeners) listener();
}

const CONFIRM: ConfirmPayload = {
  title: 'Delete?',
  description: '',
  confirmLabel: 'Delete',
  variant: 'danger',
  action: { type: 'workspace/delete', id: 'w1', closeTabs: true },
};
const SWITCHER = { triggerRect: { x: 0, y: 0, width: 1, height: 1 }, sidebarScreenX: 0, sidebarScreenY: 0 };

async function load() {
  vi.resetModules();
  const layers = await import('./layers');
  const dropped: string[] = [];
  layers.observeWorkspaceLayersPresentation((layer) => dropped.push(layer));
  const visible = () => {
    const { request, presented } = layers.useWorkspaceLayers.getState();
    return request && (presented === 'any' || presented === request.layer) ? request.layer : null;
  };
  return { ...layers, dropped, visible };
}

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
  it('renders a request only once chrome presents its layer, in either order', async () => {
    const early = await load();
    early.showWorkspaceLayer({ layer: 'confirm', payload: CONFIRM });
    expect(early.visible()).toBeNull();
    present('confirm');
    expect(early.visible()).toBe('confirm');

    const late = await load();
    present('confirm');
    expect(late.visible()).toBeNull();
    late.showWorkspaceLayer({ layer: 'confirm', payload: CONFIRM });
    expect(late.visible()).toBe('confirm');
  });

  it('hands the host from the switcher to the layer it opens, then drops it on the hide', async () => {
    const layers = await load();
    layers.showWorkspaceLayer({ layer: 'workspace-switcher', payload: SWITCHER });
    present('workspace-switcher');
    layers.showWorkspaceLayer({ layer: 'confirm', payload: CONFIRM });
    // The switcher's close after its item action leaves the layer that replaced it.
    layers.clearWorkspaceLayer('workspace-switcher');
    expect(layers.visible()).toBeNull();
    present('confirm');
    expect(layers.visible()).toBe('confirm');

    present(null);
    expect(layers.useWorkspaceLayers.getState().request).toBeNull();
    expect(layers.dropped).toEqual(['confirm']);
  });

  it('keeps a request for another layer that arrives during the fade-out', async () => {
    const layers = await load();
    layers.showWorkspaceLayer({ layer: 'confirm', payload: CONFIRM });
    present('confirm');
    layers.showWorkspaceLayer({ layer: 'workspace-switcher', payload: SWITCHER });
    present(null);
    expect(layers.dropped).toEqual([]);
    present('workspace-switcher');
    expect(layers.visible()).toBe('workspace-switcher');
  });
});
