import { describe, expect, it } from 'vitest';
import { planPanelRestore, type PanelRestoreTab } from './PanelRestore';

const entries = (...urls: string[]) => urls.map((url, i) => ({ panelKey: `panel-${i}`, url }));
const tab = (id: number, url?: string): PanelRestoreTab => ({ id, url });
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
      [1, 2],
    );

    expect(tabIds(plan)).toEqual([1, 2]);
  });

  it('reopens only the panels that have no restored tab', () => {
    const plan = planPanelRestore(
      entries('https://a/', 'https://pinned/', 'https://gone/'),
      [tab(1, 'https://a/'), tab(2)],
      [1, 2],
    );

    expect(tabIds(plan)).toEqual([1, 2, null]);
  });

  it('fills the unresolved slots in layout order', () => {
    const plan = planPanelRestore(
      entries('https://first/', 'https://second/'),
      [tab(7), tab(4)],
      [4, 7],
    );

    expect(tabIds(plan)).toEqual([4, 7]);
  });

  it('keeps a sidebar tab with the same address from taking a panel entry', () => {
    const plan = planPanelRestore(
      entries('https://a/'),
      [tab(1, 'https://a/'), tab(9, 'https://a/')],
      [9],
    );

    expect(tabIds(plan)).toEqual([9]);
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

    expect(tabIds(two)).toEqual([1, 2]);
    expect(tabIds(one)).toEqual([1, null]);
  });
});
