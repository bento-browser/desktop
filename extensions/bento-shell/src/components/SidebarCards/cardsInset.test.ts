import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeCardsInset } from './cardsInset';

/** Stands in for ResizeObserver: tests call `fire` to deliver an observation. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;

  constructor(private callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }

  fire() {
    this.callback();
  }
}

describe('observeCardsInset', () => {
  let height = 0;
  let hasCard = false;
  const container = {
    querySelector: (selector: string) =>
      selector === '.bento-sidebar-card' && hasCard ? {} : null,
    getBoundingClientRect: () => ({ height }),
  } as unknown as Element;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    height = 0;
    hasCard = false;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports 0 while no card is in the container, whatever its padding measures', () => {
    height = 20;
    const onInset = vi.fn();
    observeCardsInset(container, onInset);
    expect(onInset).toHaveBeenLastCalledWith(0);
  });

  it('reports the container height, rounded up, once a card is in it', () => {
    const onInset = vi.fn();
    observeCardsInset(container, onInset);
    const observer = FakeResizeObserver.instances[0]!;

    hasCard = true;
    height = 91.2;
    observer.fire();
    expect(onInset).toHaveBeenLastCalledWith(92);

    // A taller card (a third line of text): the list's end padding follows.
    height = 110;
    observer.fire();
    expect(onInset).toHaveBeenLastCalledWith(110);

    hasCard = false;
    height = 20;
    observer.fire();
    expect(onInset).toHaveBeenLastCalledWith(0);
  });

  it('stops observing', () => {
    const stop = observeCardsInset(container, vi.fn());
    stop();
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
  });
});
