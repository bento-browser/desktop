import { describe, expect, it } from 'vitest';
import { planPanelRestore, type PanelRestoreLayoutTab, type PanelRestoreTab } from './PanelRestore';

const entries = (...urls: string[]) => urls.map((url, i) => ({ panelKey: `panel-${i}`, url }));
const tab = (id: number, url?: string): PanelRestoreTab => ({ id, url });
/** A tab already in the layout; `key` is the layout key its session marker carried. */
const panel = (tabId: number, key?: string): PanelRestoreLayoutTab => ({ tabId, panelKey: key });
const tabIds = (plan: ReturnType<typeof planPanelRestore>) => plan.map((step) => step.tabId);

describe('planPanelRestore', () => {
  it('binds each entry to the tab that shows its address and opens nothing', () => {
    const plan = planPanelRestore(
      entries('https://a/', 'https://b/'),
      [tab(1, 'https://b/'), tab(2, 'https://a/'), tab(3, 'https://other/')],
      [],
    );

    expect(tabIds(plan)).toEqual([2, 1]);
  });

  it('never reopens a panel whose tab came back through its marker, even with no readable address', () => {
    // The second panel is a pinned panel: Firefox restores it with a real browser that reports
    // about:blank until it loads, so no address can match it.
    const plan = planPanelRestore(
      entries('https://a/', 'https://pinned/'),
      [tab(1, 'https://a/'), tab(2)],
      [panel(1, 'panel-0'), panel(2, 'panel-1')],
    );

    expect(tabIds(plan)).toEqual([1, 2]);
  });

  it('reopens only the panels that have no restored tab', () => {
    const plan = planPanelRestore(
      entries('https://a/', 'https://pinned/', 'https://gone/'),
      [tab(1, 'https://a/'), tab(2)],
      [panel(1, 'panel-0'), panel(2, 'panel-1')],
    );

    expect(tabIds(plan)).toEqual([1, 2, null]);
  });

  it('binds panels by key when two of them share one marker slot and come back reversed', () => {
    // Two subdivision leaves share a marker's rootIndex and containing root node, so the restored
    // layout can list them in either order. Neither address is readable yet.
    const plan = planPanelRestore(
      entries('https://top/', 'https://bottom/'),
      [tab(7), tab(4)],
      [panel(7, 'panel-1'), panel(4, 'panel-0')],
    );

    expect(tabIds(plan)).toEqual([4, 7]);
  });

  it('binds a panel that navigated away by key, and opens no duplicate', () => {
    // Tab 1 was entry 0's page and now shows another address, so no address matches entry 0.
    const plan = planPanelRestore(
      entries('https://first/', 'https://second/'),
      [tab(1, 'https://navigated/'), tab(2, 'https://second/')],
      [panel(1, 'panel-0'), panel(2, 'panel-1')],
    );

    expect(tabIds(plan)).toEqual([1, 2]);
  });

  it('keeps a sidebar tab at a pending panel address from taking the panel entry', () => {
    // The panel (tab 9) is still restoring and reports no address; sidebar tab 1 shows the same page.
    const plan = planPanelRestore(
      entries('https://a/'),
      [tab(1, 'https://a/'), tab(9)],
      [panel(9, 'panel-0')],
    );

    expect(tabIds(plan)).toEqual([9]);
  });

  it('prefers a panel at the address over a sidebar tab when the marker has no key', () => {
    const plan = planPanelRestore(
      entries('https://a/'),
      [tab(1, 'https://a/'), tab(9, 'https://a/')],
      [panel(9)],
    );

    expect(tabIds(plan)).toEqual([9]);
  });

  it('binds a marker without a key only by exact address, never by position', () => {
    // Markers written before keys existed. The second panel is unreadable, and its slot is not
    // guessed from where it sits in the layout: its entry is opened again.
    const plan = planPanelRestore(
      entries('https://a/', 'https://pinned/'),
      [tab(1, 'https://a/'), tab(2)],
      [panel(1), panel(2)],
    );

    expect(tabIds(plan)).toEqual([1, null]);
  });

  it('binds a panel whose key matches no entry by address, and leaves one with neither unbound', () => {
    const plan = planPanelRestore(
      entries('https://a/', 'https://b/'),
      [tab(1, 'https://a/'), tab(2)],
      [panel(1, 'panel-9'), panel(2, 'panel-8')],
    );

    expect(tabIds(plan)).toEqual([1, null]);
  });

  it('does not take a sidebar tab for a panel slot, however little it reports', () => {
    expect(tabIds(planPanelRestore(entries('https://a/'), [tab(1)], []))).toEqual([null]);
  });

  it('uses each tab once', () => {
    const two = planPanelRestore(
      entries('https://a/', 'https://a/'),
      [tab(1, 'https://a/'), tab(2, 'https://a/')],
      [],
    );
    const one = planPanelRestore(entries('https://a/', 'https://a/'), [tab(1, 'https://a/')], []);
    const sameKey = planPanelRestore(
      entries('https://a/', 'https://b/'),
      [tab(1), tab(2)],
      [panel(1, 'panel-0'), panel(2, 'panel-0')],
    );

    expect(tabIds(two)).toEqual([1, 2]);
    expect(tabIds(one)).toEqual([1, null]);
    expect(tabIds(sameKey)).toEqual([1, null]);
  });
});
