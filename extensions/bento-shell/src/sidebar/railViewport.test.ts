import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRailWidth, observeRailViewport } from './railViewport';

describe('isRailWidth', () => {
  it('is the rail at the rail width and at the rounding slack above it', () => {
    expect(isRailWidth(64, 64)).toBe(true);
    expect(isRailWidth(65, 64)).toBe(true);
    expect(isRailWidth(40, 64)).toBe(true);
  });

  it('is expanded from the first pixel past the slack', () => {
    expect(isRailWidth(65.5, 64)).toBe(false);
    expect(isRailWidth(300, 64)).toBe(false);
  });

  it('reads an unmeasured width or token as not the rail', () => {
    expect(isRailWidth(0, 64)).toBe(false);
    expect(isRailWidth(64, 0)).toBe(false);
  });
});

/** Stands in for ResizeObserver: tests push entries through `emit`. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;

  constructor(private callback: (entries: unknown[]) => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }

  emit(width: number) {
    this.callback([{ borderBoxSize: [{ inlineSize: width }], contentRect: { width: 0 } }]);
  }
}

describe('observeRailViewport', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const start = (measure: () => number) => {
    const onRail = vi.fn();
    const stop = observeRailViewport({} as Element, onRail, measure);
    return { onRail, stop, observer: FakeResizeObserver.instances[0]! };
  };

  it('follows the observed width, not any setting', () => {
    const { onRail, observer } = start(() => 64);
    observer.emit(300);
    observer.emit(64);
    observer.emit(300);
    expect(onRail.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('measures the rail once it can, and keeps the reading', () => {
    const measure = vi.fn().mockReturnValueOnce(0).mockReturnValue(64);
    const { onRail, observer } = start(measure);
    observer.emit(64);
    expect(onRail).not.toHaveBeenCalled();
    observer.emit(64);
    observer.emit(300);
    expect(onRail.mock.calls).toEqual([[true], [false]]);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('stops observing on cleanup', () => {
    const { stop, observer } = start(() => 64);
    stop();
    expect(observer.disconnected).toBe(true);
  });
});
