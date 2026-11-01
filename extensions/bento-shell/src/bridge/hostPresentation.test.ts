import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeToHostHidden } from './hostPresentation';

// A document with just the parts the subscription touches. Like the actor, `present` writes the
// root attribute first and then fires the event, synchronously.
let attributes: Map<string, string>;
let listeners: Map<string, Set<() => void>>;

function present(presented: boolean) {
  attributes.set('data-bento-host-presented', String(presented));
  for (const listener of listeners.get('bento-host-presentation') ?? []) listener();
}

beforeEach(() => {
  attributes = new Map();
  listeners = new Map();
  vi.stubGlobal('document', {
    documentElement: { getAttribute: (name: string) => attributes.get(name) ?? null },
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('subscribeToHostHidden', () => {
  it('fires when chrome hides the host, and not when it shows it', () => {
    const handler = vi.fn();
    subscribeToHostHidden(handler);

    present(true);
    expect(handler).not.toHaveBeenCalled();
    present(false);
    expect(handler).toHaveBeenCalledTimes(1);
    present(true);
    present(false);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not fire before the host was ever presented', () => {
    const handler = vi.fn();
    subscribeToHostHidden(handler);
    for (const listener of listeners.get('bento-host-presentation') ?? []) listener();
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops after the unsubscribe', () => {
    const handler = vi.fn();
    const stop = subscribeToHostHidden(handler);
    stop();
    present(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
