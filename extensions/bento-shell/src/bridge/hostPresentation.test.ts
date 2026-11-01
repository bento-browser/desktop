import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPresentationLog, subscribeToHostHidden } from './hostPresentation';

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

describe('createPresentationLog', () => {
  // Chrome presents the host, then the open message is accepted, then the popup mounts.
  it('is not hidden before anything was presented', () => {
    const log = createPresentationLog();
    log.openAccepted();
    expect(log.hiddenSinceOpen()).toBe(false);
  });

  it('ignores the hide of an earlier popup, before the new open is presented', () => {
    const log = createPresentationLog();
    log.presented(true);
    log.openAccepted();
    log.presented(false);
    log.openAccepted();
    expect(log.hiddenSinceOpen()).toBe(false);
    // The new open's own show and a later hide still count.
    log.presented(true);
    expect(log.hiddenSinceOpen()).toBe(false);
    log.presented(false);
    expect(log.hiddenSinceOpen()).toBe(true);
  });

  it('is hidden when chrome hid the host after its show but before the open was accepted', () => {
    const log = createPresentationLog();
    log.presented(true);
    log.presented(false);
    log.openAccepted();
    expect(log.hiddenSinceOpen()).toBe(true);
  });

  it('is hidden when the hide came after the open was accepted and before the popup mounted', () => {
    const log = createPresentationLog();
    log.presented(true);
    log.openAccepted();
    expect(log.hiddenSinceOpen()).toBe(false);
    log.presented(false);
    expect(log.hiddenSinceOpen()).toBe(true);
  });

  it('is cancelled by a show after the hide', () => {
    const log = createPresentationLog();
    log.presented(true);
    log.openAccepted();
    log.presented(false);
    log.presented(true);
    expect(log.hiddenSinceOpen()).toBe(false);
  });

  it('follows a popup that replaces another while the host stays shown', () => {
    const log = createPresentationLog();
    log.presented(true);
    log.openAccepted();
    log.presented(true);
    log.openAccepted();
    expect(log.hiddenSinceOpen()).toBe(false);
    log.presented(false);
    expect(log.hiddenSinceOpen()).toBe(true);
  });
});

describe('observeHostPresentation', () => {
  it('feeds the document presentations to hostHiddenSinceOpen for the life of the document', async () => {
    vi.resetModules();
    const { hostHiddenSinceOpen, markOpenAccepted, observeHostPresentation } = await import(
      './hostPresentation'
    );
    observeHostPresentation();

    present(true);
    present(false);
    markOpenAccepted();
    expect(hostHiddenSinceOpen()).toBe(true);
    present(true);
    expect(hostHiddenSinceOpen()).toBe(false);
  });
});
