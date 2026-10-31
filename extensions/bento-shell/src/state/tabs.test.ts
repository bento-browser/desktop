import { beforeEach, describe, expect, it } from 'vitest';
import type { TabDelta, TabSnapshot } from '@shared/protocol';
import { tabStateOf } from '../components/TabRow/tabState';
import { useTabsStore } from './tabs';

const tab = (id: number, overrides: Partial<TabSnapshot> = {}): TabSnapshot => ({
  id,
  windowId: 1,
  index: id,
  title: `Tab ${id}`,
  url: 'https://example.org/',
  favIconUrl: 'https://example.org/favicon.svg',
  active: false,
  pinned: false,
  audible: false,
  muted: false,
  ...overrides,
});

/** What a private window's relay does to a message on its way to the shell. */
const relay = (deltas: TabDelta[]): TabDelta[] => JSON.parse(JSON.stringify(deltas));

const stateOfTab1 = () => tabStateOf(useTabsStore.getState().byId[1]!);

beforeEach(() => {
  useTabsStore.getState().applySnapshot([tab(1), tab(2)]);
});

describe('tabs store page errors', () => {
  it('clears the row state when the clear delta has been through the private relay', () => {
    const { applyDeltas } = useTabsStore.getState();

    applyDeltas(relay([{ kind: 'updated', id: 1, changes: { pageError: 'crashed' } }]));
    expect(stateOfTab1()).toBe('crashed');

    applyDeltas(relay([{ kind: 'updated', id: 1, changes: { pageError: null } }]));
    expect(stateOfTab1()).toBeNull();
    expect(useTabsStore.getState().byId[1]).not.toHaveProperty('pageError');
  });

  it('deletes a favicon, URL and custom title that arrive as null, and keeps other fields', () => {
    useTabsStore.getState().applySnapshot([
      tab(1, {
        favIconUrl: 'chrome://global/skin/icons/info.svg',
        url: 'https://nope.invalid/',
        customTitle: 'Mine',
      }),
    ]);

    useTabsStore.getState().applyDeltas(
      relay([
        {
          kind: 'updated',
          id: 1,
          changes: { favIconUrl: null, url: null, customTitle: null, title: 'New' },
        },
      ]),
    );

    const updated = useTabsStore.getState().byId[1]!;
    expect(updated).not.toHaveProperty('favIconUrl');
    expect(updated).not.toHaveProperty('url');
    expect(updated).not.toHaveProperty('customTitle');
    expect(updated).toMatchObject({ id: 1, title: 'New', index: 1 });
    // A field absent from the change is not touched.
    expect(tabStateOf(updated)).toBe('default');
  });

  it('shows the site favicon again after an error page was left, in a private window', () => {
    const { applyDeltas } = useTabsStore.getState();
    useTabsStore
      .getState()
      .applySnapshot([
        tab(1, { favIconUrl: 'chrome://global/skin/icons/info.svg', pageError: 'unavailable' }),
      ]);

    applyDeltas(
      relay([
        {
          kind: 'updated',
          id: 1,
          changes: { pageError: null, favIconUrl: 'https://example.org/favicon.svg' },
        },
      ]),
    );

    expect(useTabsStore.getState().byId[1]?.favIconUrl).toBe('https://example.org/favicon.svg');
    expect(stateOfTab1()).toBeNull();
  });

  it('changes from one page error to another, and leaves other tabs alone', () => {
    const { applyDeltas } = useTabsStore.getState();

    applyDeltas(relay([{ kind: 'updated', id: 1, changes: { pageError: 'unavailable' } }]));
    applyDeltas(relay([{ kind: 'updated', id: 1, changes: { pageError: 'blocked' } }]));

    expect(stateOfTab1()).toBe('blocked');
    expect(tabStateOf(useTabsStore.getState().byId[2]!)).toBeNull();
  });
});
