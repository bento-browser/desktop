import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRowHighlight } from './useRowHighlight';

vi.mock('react', () => ({
  useRef: () => ({ current: undefined }),
  useCallback: (callback: unknown) => callback,
}));

/** Delivers only subscribed attributes, like the browser's MutationObserver. */
class ObservedAttributes {
  static instances: ObservedAttributes[] = [];
  private filter: string[] = [];
  disconnected = false;
  constructor(private callback: () => void) {
    ObservedAttributes.instances.push(this);
  }
  observe(_target: unknown, options: MutationObserverInit) {
    this.filter = options.attributeFilter ?? [];
  }
  deliver(name: string) {
    if (!this.disconnected && this.filter.includes(name)) this.callback();
  }
  disconnect() {
    this.disconnected = true;
  }
}

function measuredList() {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const rows = [
    {
      attributes: new Map([['role', 'option']]),
      offsetLeft: 8,
      offsetTop: 12,
      offsetWidth: 280,
      offsetHeight: 32,
    },
    {
      attributes: new Map([['role', 'option']]),
      offsetLeft: 8,
      offsetTop: 44,
      offsetWidth: 280,
      offsetHeight: 64,
    },
  ];
  const list = {
    ownerDocument: new EventTarget(),
    offsetHeight: 120,
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    // The hook uses compound attribute selectors; this fixture models presence and equality.
    querySelector: (selector: string) => {
      const row = rows.find((row) =>
        [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(
          ([, name, value]) =>
            row.attributes.has(name!) &&
            (value === undefined || row.attributes.get(name!) === value),
        ),
      );
      return row ? { ...row, offsetParent: list } : null;
    },
  };
  return {
    list: list as unknown as HTMLElement,
    rows: rows.map((row) => ({ ...row, offsetParent: list })),
    attributes,
    properties,
  };
}

beforeEach(() => {
  ObservedAttributes.instances = [];
  vi.stubGlobal('MutationObserver', ObservedAttributes);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('useRowHighlight', () => {
  it('follows RC4 focus mutations and measures the next row, including its different height', () => {
    const fixture = measuredList();
    const ref = useRowHighlight();
    ref(fixture.list);
    expect(fixture.attributes.has('data-highlight')).toBe(false);
    fixture.rows[0]!.attributes.set('data-muxui-state-focused', '');
    ObservedAttributes.instances[0]!.deliver('data-muxui-state-focused');
    expect(fixture.properties.get('--bento-row-highlight-y')).toBe('12px');
    expect(fixture.attributes.has('data-highlight')).toBe(true);
    fixture.rows[0]!.attributes.delete('data-muxui-state-focused');
    fixture.rows[1]!.attributes.set('data-muxui-state-focused', '');
    ObservedAttributes.instances[0]!.deliver('data-muxui-state-focused');
    expect(Object.fromEntries(fixture.properties)).toEqual({
      '--bento-row-highlight-x': '8px',
      '--bento-row-highlight-y': '44px',
      '--bento-row-highlight-width': '280px',
      '--bento-row-highlight-height': '64px',
    });
    expect(fixture.attributes.has('data-highlight-motion')).toBe(true);
    fixture.rows[1]!.attributes.delete('data-muxui-state-focused');
    ObservedAttributes.instances[0]!.deliver('data-muxui-state-focused');
    expect(fixture.attributes.has('data-highlight')).toBe(false);
    ref(null);
    expect(ObservedAttributes.instances[0]!.disconnected).toBe(true);
  });

  it('tracks the number editor current row after Mux renames its supplied state attribute', () => {
    const fixture = measuredList();
    const ref = useRowHighlight('[role="option"][data-muxui-state-current]');
    ref(fixture.list);
    fixture.rows[1]!.attributes.set('data-muxui-state-current', '');
    ObservedAttributes.instances[0]!.deliver('data-muxui-state-current');
    expect(fixture.properties.get('--bento-row-highlight-y')).toBe('44px');
    expect(fixture.properties.get('--bento-row-highlight-height')).toBe('64px');
    ref(null);
  });
});

describe('RowHighlight.css', () => {
  it('anchors the slab at the physical left edge, where the hook measures from', () => {
    // useRowHighlight writes physical offsets (offsetLeft), so a logical inline-start anchor
    // would put the slab at the right edge in RTL, shifted by the row's offset.
    const css = readFileSync(new URL('./RowHighlight.css', import.meta.url), 'utf8');
    const slab = /\.bento-row-highlight::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(slab).toMatch(/\bleft:\s*0\b/);
    expect(slab).not.toMatch(/inset-inline-start/);
    expect(slab).toMatch(/translate\(var\(--bento-row-highlight-x/);
  });
});
