// The shared colour scheme subscription behind useResolvedColorScheme and useWorkspaceTheme:
// scoped themes must hear a flip from the root attribute without waiting for a React state
// update, and must not hear their own attribute writes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Subscribe = (notify: () => void) => () => void;

let colorMode: string | null;
let observers: FakeObserver[];
/** The subscriptions the hook asked React for during the render in progress. */
let hookSubscriptions: Subscribe[];
const root = {
  getAttribute: (name: string) => (name === 'data-color-mode' ? colorMode : null),
};

// React's useSyncExternalStore as a harness: the snapshot is read during render, and the
// subscription is made after it (mount() below), like a commit.
vi.mock('react', () => ({
  useSyncExternalStore: (subscribe: Subscribe, getSnapshot: () => unknown) => {
    hookSubscriptions.push(subscribe);
    return getSnapshot();
  },
}));

/** Records what was observed; delivers only what a real observer would. */
class FakeObserver {
  disconnected = false;
  target: unknown = null;
  filter: string[] | undefined;
  constructor(private callback: () => void) {
    observers.push(this);
  }
  observe(target: unknown, options?: { attributes?: boolean; attributeFilter?: string[] }) {
    if (options?.attributes) {
      this.target = target;
      this.filter = options.attributeFilter;
    }
  }
  disconnect() {
    this.disconnected = true;
  }
  /** The browser delivers a batch of attribute records after a write to an observed attribute. */
  deliver(target: unknown, attributeName: string) {
    if (this.disconnected || this.target !== target) return;
    if (this.filter && !this.filter.includes(attributeName)) return;
    this.callback();
  }
}

/** A write to an attribute of the root, as the browser reports it to the observers on it. */
function writeAttribute(attributeName: string) {
  for (const observer of observers) observer.deliver(root, attributeName);
}

function writeColorMode(value: string) {
  colorMode = value;
  writeAttribute('data-color-mode');
}

/** Renders a component that calls `use` and subscribes after rendering, as React does. */
function mount<T>(use: () => T) {
  const result = { value: undefined as T, renders: 0, stop: () => {} };
  const stops: Array<() => void> = [];
  const render = () => {
    hookSubscriptions = [];
    result.value = use();
    result.renders += 1;
    return hookSubscriptions;
  };
  for (const subscribe of render()) stops.push(subscribe(render));
  result.stop = () => stops.forEach((stop) => stop());
  return result;
}

function loadScope() {
  vi.resetModules();
  return import('./themeScope');
}

beforeEach(() => {
  colorMode = 'light';
  observers = [];
  hookSubscriptions = [];
  vi.stubGlobal('MutationObserver', FakeObserver);
  vi.stubGlobal('document', { documentElement: root });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeColorScheme', () => {
  it('observes the root mode attributes', async () => {
    const { subscribeColorScheme } = await loadScope();
    subscribeColorScheme(vi.fn());

    expect(observers).toHaveLength(1);
    expect(observers[0]?.target).toBe(root);
    expect(observers[0]?.filter).toEqual(['data-color-mode', 'data-muxui-color-scheme']);
  });

  it('notifies when the resolved scheme changes, in the same task as the attribute write', async () => {
    const { subscribeColorScheme } = await loadScope();
    const notify = vi.fn();
    subscribeColorScheme(notify);

    writeColorMode('dark');

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('ignores writes to attributes it does not observe', async () => {
    const { subscribeColorScheme } = await loadScope();
    const notify = vi.fn();
    subscribeColorScheme(notify);

    colorMode = 'dark';
    writeAttribute('class');

    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores attribute writes that leave the scheme unchanged', async () => {
    const { subscribeColorScheme } = await loadScope();
    const notify = vi.fn();
    subscribeColorScheme(notify);

    // applyRootTheme rewrites data-muxui-color-scheme on every apply, which the observer sees too.
    writeAttribute('data-muxui-color-scheme');
    writeAttribute('data-muxui-color-scheme');

    expect(notify).not.toHaveBeenCalled();
  });

  it('shares one observer between subscribers and drops it with the last one', async () => {
    const { subscribeColorScheme } = await loadScope();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeColorScheme(first);
    const stopSecond = subscribeColorScheme(second);
    expect(observers).toHaveLength(1);

    writeColorMode('dark');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    writeColorMode('light');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    stopSecond();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it('starts a fresh observer from the current scheme after everyone unsubscribed', async () => {
    const { subscribeColorScheme } = await loadScope();
    subscribeColorScheme(vi.fn())();
    colorMode = 'dark';

    const notify = vi.fn();
    subscribeColorScheme(notify);
    writeAttribute('data-color-mode');

    expect(observers).toHaveLength(2);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('useResolvedColorScheme', () => {
  it('re-renders a mounted consumer when the root mode changes, and stops when it unmounts', async () => {
    const { useResolvedColorScheme } = await loadScope();
    const consumer = mount(useResolvedColorScheme);
    expect(consumer.value).toBe('light');
    expect(consumer.renders).toBe(1);

    writeColorMode('dark');
    expect(consumer.value).toBe('dark');
    expect(consumer.renders).toBe(2);

    // A write that leaves the scheme alone does not render it again.
    writeAttribute('data-muxui-color-scheme');
    expect(consumer.renders).toBe(2);

    consumer.stop();
    writeColorMode('light');
    expect(consumer.renders).toBe(2);
    expect(observers.at(-1)?.disconnected).toBe(true);
  });
});
