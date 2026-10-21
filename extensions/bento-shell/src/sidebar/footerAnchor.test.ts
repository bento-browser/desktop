import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureFooterButtonEdges, observeFooterButtonEdges } from './footerAnchor';

const button = (rect: { right: number; bottom: number; width: number; height: number }) =>
  ({ getBoundingClientRect: () => rect }) as unknown as Element;

describe('measureFooterButtonEdges', () => {
  it('measures the distance from the right and bottom edges of the viewport', () => {
    // The expanded footer: Downloads is the last button of the row.
    expect(
      measureFooterButtonEdges(
        button({ right: 289, bottom: 994, width: 32, height: 32 }),
        300,
        1004,
      ),
    ).toEqual({ right: 11, bottom: 10, width: 32, height: 32 });
  });

  it('keeps the same edges when the viewport grows, which is why resizes send nothing', () => {
    const at = (width: number, height: number) =>
      measureFooterButtonEdges(
        button({ right: width - 11, bottom: height - 10, width: 32, height: 32 }),
        width,
        height,
      );
    expect(at(300, 1004)).toEqual(at(420, 1300));
  });

  it('rounds to half a pixel', () => {
    expect(
      measureFooterButtonEdges(
        button({ right: 288.7, bottom: 993.9, width: 32, height: 32 }),
        300,
        1004,
      ),
    ).toEqual({ right: 11.5, bottom: 10, width: 32, height: 32 });
  });

  it('is null while the button or the viewport has no box', () => {
    expect(
      measureFooterButtonEdges(button({ right: 0, bottom: 0, width: 0, height: 0 }), 300, 1004),
    ).toBeNull();
    expect(
      measureFooterButtonEdges(button({ right: 289, bottom: 994, width: 32, height: 32 }), 0, 0),
    ).toBeNull();
  });
});

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

describe('observeFooterButtonEdges', () => {
  let rect = { right: 289, bottom: 994, width: 32, height: 32 };

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    rect = { right: 289, bottom: 994, width: 32, height: 32 };
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('window', { innerWidth: 300, innerHeight: 1004 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const start = () => {
    const onChange = vi.fn();
    const live = { getBoundingClientRect: () => rect } as unknown as Element;
    let current: Element | null = live;
    const stop = observeFooterButtonEdges({} as Element, () => current, onChange);
    return {
      onChange,
      stop,
      observer: FakeResizeObserver.instances[0]!,
      remount: (next: Element | null) => (current = next),
    };
  };

  it('reports the first measurement, then only changes', () => {
    const { onChange, observer } = start();
    observer.fire();
    observer.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ right: 11, bottom: 10, width: 32, height: 32 });

    // The rail restacks the footer: Downloads is centered and sits higher.
    rect = { right: 42, bottom: 808, width: 32, height: 32 };
    vi.stubGlobal('window', { innerWidth: 52, innerHeight: 1004 });
    observer.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ right: 10, bottom: 196, width: 32, height: 32 });
  });

  it('sends nothing while the footer resizes around a button that did not move', () => {
    const { onChange, observer } = start();
    observer.fire();
    for (const width of [310, 340, 380]) {
      rect = { ...rect, right: width - 11 };
      vi.stubGlobal('window', { innerWidth: width, innerHeight: 1004 });
      observer.fire();
    }
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('skips an observation with no box and keeps the last report', () => {
    const { onChange, observer } = start();
    observer.fire();
    rect = { right: 0, bottom: 0, width: 0, height: 0 };
    observer.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('measures the button mounted now, not the one mounted first', () => {
    const { onChange, observer, remount } = start();
    observer.fire();

    // Switching the rail mounts a new button element; the first one is detached.
    remount(button({ right: 42, bottom: 808, width: 32, height: 32 }));
    vi.stubGlobal('window', { innerWidth: 52, innerHeight: 1004 });
    observer.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ right: 10, bottom: 196, width: 32, height: 32 });

    remount(null);
    observer.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('disconnects', () => {
    const { stop, observer } = start();
    stop();
    expect(observer.disconnected).toBe(true);
  });
});
