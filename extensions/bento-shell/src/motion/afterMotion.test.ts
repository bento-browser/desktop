import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterMotion,
  MOTION_SLACK_MS,
  MOTION_UNAVAILABLE_CEILING_MS,
  measureMotion,
} from './afterMotion';

type Computed = Partial<{
  transitionProperty: string;
  transitionDuration: string;
  transitionDelay: string;
  animationName: string;
  animationDuration: string;
  animationDelay: string;
  animationIterationCount: string;
}>;

/** An element with just what measureMotion and afterMotion read. */
class FakeElement {
  private listeners = new Map<string, Set<(event: Event) => void>>();
  private style: Required<Computed>;
  ownerDocument: { defaultView: { getComputedStyle: () => unknown } };

  constructor(
    computed: Computed | null,
    readonly isConnected = true,
  ) {
    this.style = {
      transitionProperty: 'all',
      transitionDuration: '0s',
      transitionDelay: '0s',
      animationName: 'none',
      animationDuration: '0s',
      animationDelay: '0s',
      animationIterationCount: '1',
      ...computed,
    };
    this.ownerDocument = {
      defaultView: { getComputedStyle: () => (computed ? this.style : null) },
    };
  }

  addEventListener(type: string, handler: (event: Event) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(handler));
  }

  removeEventListener(type: string, handler: (event: Event) => void) {
    this.listeners.get(type)?.delete(handler);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  dispatch(type: string, init: object = {}, target: unknown = this) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ type, target, ...init } as unknown as Event);
    }
  }
}
const fakeElement = (computed: Computed | null, { connected = true } = {}) =>
  new FakeElement(computed, connected);
const asElement = (el: FakeElement) => el as unknown as Element;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('measureMotion', () => {
  it('reads seconds and milliseconds, adds the delay, and filters by property', () => {
    const el = fakeElement({
      transitionProperty: 'opacity, transform, color',
      transitionDuration: '0.2s, 150ms, 1s',
      transitionDelay: '0s, 50ms, 0s',
    });
    expect(measureMotion(asElement(el))?.ms).toBe(1000);
    expect(measureMotion(asElement(el), { properties: ['opacity', 'transform'] })?.ms).toBe(200);
    expect(measureMotion(asElement(el), { properties: ['transform'] })?.ms).toBe(200);
    expect(measureMotion(asElement(el), { properties: ['width'] })?.ms).toBe(0);
  });

  it('expands a short duration list over every property', () => {
    const el = fakeElement({
      transitionProperty: 'width, min-width, max-width',
      transitionDuration: '0.12s',
    });
    expect(measureMotion(asElement(el))).toMatchObject({
      ms: 120,
      ending: new Set(['t:width', 't:min-width', 't:max-width']),
    });
  });

  it('counts a transition on all for every filtered property', () => {
    const el = fakeElement({ transitionProperty: 'all', transitionDuration: '0.2s' });
    expect(measureMotion(asElement(el), { properties: ['opacity'] })?.ms).toBe(200);
  });

  it('takes the last transition-property entry that names a property, all included', () => {
    const allThenOpacity = fakeElement({
      transitionProperty: 'all, opacity',
      transitionDuration: '0.2s, 0s',
    });
    expect(measureMotion(asElement(allThenOpacity), { properties: ['opacity'] })?.ms).toBe(0);
    expect(measureMotion(asElement(allThenOpacity), { properties: ['color'] })?.ms).toBe(200);
    expect(
      measureMotion(asElement(allThenOpacity), { properties: ['opacity', 'color'] })?.ending,
    ).toEqual(new Set(['t:color']));

    const opacityThenAll = fakeElement({
      transitionProperty: 'opacity, all',
      transitionDuration: '0s, 0.2s',
    });
    expect(measureMotion(asElement(opacityThenAll), { properties: ['opacity'] })?.ms).toBe(200);

    // Without a filter an entry that a later entry overrides does not count.
    expect(measureMotion(asElement(allThenOpacity))?.ms).toBe(200);
    const overridden = fakeElement({
      transitionProperty: 'opacity, all',
      transitionDuration: '1s, 0.2s',
    });
    expect(measureMotion(asElement(overridden))?.ms).toBe(200);
  });

  it('multiplies an animation by its finite iteration count and skips infinite ones', () => {
    const el = fakeElement({
      animationName: 'fade, spin, pulse',
      animationDuration: '0.5s, 1s, 1.2s',
      animationDelay: '0.1s',
      animationIterationCount: '2, 1, infinite',
    });
    expect(measureMotion(asElement(el), { animations: ['fade'] })?.ms).toBe(1100);
    expect(measureMotion(asElement(el), { animations: ['spin'] })?.ms).toBe(1100);
    expect(measureMotion(asElement(el), { animations: ['pulse'] })?.ms).toBe(0);
  });

  it('reports zero for none and for zero durations, which is a valid answer', () => {
    expect(measureMotion(asElement(fakeElement({ transitionProperty: 'none' })))?.ms).toBe(0);
    expect(measureMotion(asElement(fakeElement({})))?.ms).toBe(0);
  });

  it('is unavailable for a disconnected element or one without computed style', () => {
    expect(
      measureMotion(asElement(fakeElement({ transitionDuration: '1s' }, { connected: false }))),
    ).toBeNull();
    expect(measureMotion(asElement(fakeElement(null)))).toBeNull();
  });
});

describe('afterMotion', () => {
  it('runs now when nothing animates', () => {
    const done = vi.fn();
    afterMotion(asElement(fakeElement({})), { properties: ['opacity'] }, done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('waits for the measured time plus slack when no event arrives', () => {
    const el = fakeElement({ transitionProperty: 'opacity', transitionDuration: '0.12s' });
    const done = vi.fn();
    afterMotion(asElement(el), { properties: ['opacity'] }, done);
    vi.advanceTimersByTime(120 + MOTION_SLACK_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(el.listenerCount()).toBe(0);
  });

  it('finishes on the end event of the last transition, not an earlier one', () => {
    const el = fakeElement({
      transitionProperty: 'opacity, transform',
      transitionDuration: '0.1s, 0.2s',
    });
    const done = vi.fn();
    afterMotion(asElement(el), { properties: ['opacity', 'transform'] }, done);
    el.dispatch('transitionend', { propertyName: 'opacity' });
    expect(done).not.toHaveBeenCalled();
    el.dispatch('transitionend', { propertyName: 'transform' }, { not: 'el' });
    expect(done).not.toHaveBeenCalled();
    el.dispatch('transitionend', { propertyName: 'transform' });
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(done).toHaveBeenCalledTimes(1);
    expect(el.listenerCount()).toBe(0);
  });

  it('runs now when the last entry for the property is 0', () => {
    const el = fakeElement({ transitionProperty: 'all, opacity', transitionDuration: '0.2s, 0s' });
    const done = vi.fn();
    afterMotion(asElement(el), { properties: ['opacity'] }, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(el.listenerCount()).toBe(0);
  });

  it('ignores the end of a property that was not requested, even when all ends last', () => {
    const el = fakeElement({ transitionProperty: 'all', transitionDuration: '0.2s' });
    const done = vi.fn();
    afterMotion(asElement(el), { properties: ['opacity'] }, done);
    el.dispatch('transitionend', { propertyName: 'background-color' });
    expect(done).not.toHaveBeenCalled();
    el.dispatch('transitionend', { propertyName: 'opacity' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('ends an unfiltered wait on any property when all ends last', () => {
    const el = fakeElement({ transitionProperty: 'all', transitionDuration: '0.2s' });
    const done = vi.fn();
    afterMotion(asElement(el), {}, done);
    el.dispatch('transitionend', { propertyName: 'width' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('finishes on an animation end event by name', () => {
    const el = fakeElement({ animationName: 'slide', animationDuration: '0.2s' });
    const done = vi.fn();
    afterMotion(asElement(el), { animations: ['slide'] }, done);
    el.dispatch('animationend', { animationName: 'other' });
    expect(done).not.toHaveBeenCalled();
    el.dispatch('animationend', { animationName: 'slide' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('cancelling drops the timer and the listeners', () => {
    const el = fakeElement({ transitionProperty: 'opacity', transitionDuration: '0.2s' });
    const done = vi.fn();
    const cancel = afterMotion(asElement(el), { properties: ['opacity'] }, done);
    cancel();
    el.dispatch('transitionend', { propertyName: 'opacity' });
    vi.advanceTimersByTime(10_000);
    expect(done).not.toHaveBeenCalled();
    expect(el.listenerCount()).toBe(0);
  });

  it('uses the fallback ceiling for a disconnected element', () => {
    const el = fakeElement({ transitionDuration: '1s' }, { connected: false });
    const done = vi.fn();
    afterMotion(asElement(el), { properties: ['opacity'] }, done);
    expect(el.listenerCount()).toBe(0);
    vi.advanceTimersByTime(MOTION_UNAVAILABLE_CEILING_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
