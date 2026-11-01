import { describe, expect, it } from 'vitest';

import { makeTab } from '../state/__fixtures__/tabs';
import { isSavableUrl, openTabsFor } from './useOpenTabs';

describe('isSavableUrl', () => {
  it('accepts web and file pages and refuses Firefox pages and privileged schemes', () => {
    expect(isSavableUrl('https://example.com/')).toBe(true);
    expect(isSavableUrl('file:///tmp/a.html')).toBe(true);
    expect(isSavableUrl('about:blank')).toBe(false);
    expect(isSavableUrl('moz-extension://abc/page.html')).toBe(false);
    expect(isSavableUrl('view-source:https://example.com')).toBe(false);
    expect(isSavableUrl(undefined)).toBe(false);
  });
});

describe('openTabsFor', () => {
  const tabs = [
    makeTab({
      id: 1,
      index: 0,
      workspaceId: 'w1',
      windowId: 1,
      url: 'https://a.example/',
      title: 'A',
    }),
    makeTab({
      id: 2,
      index: 1,
      workspaceId: 'w2',
      windowId: 1,
      url: 'https://b.example/',
      title: 'B',
    }),
    makeTab({
      id: 3,
      index: 2,
      workspaceId: 'w1',
      windowId: 2,
      url: 'https://c.example/',
      title: 'C',
    }),
    makeTab({ id: 4, index: 3, workspaceId: 'w1', windowId: 1, url: 'about:newtab', title: 'New' }),
    makeTab({
      id: 5,
      index: 4,
      workspaceId: 'w1',
      windowId: 1,
      url: 'https://d.example/',
      title: 'Raw',
      customTitle: 'Named',
    }),
  ];
  const byId = Object.fromEntries(tabs.map((tab) => [tab.id, tab]));
  const ordered = tabs.map((tab) => tab.id);

  it("lists the active workspace's savable tabs of this window, by their custom title, in order", () => {
    expect(openTabsFor(byId, ordered, 'w1', 1).map((tab) => [tab.id, tab.title])).toEqual([
      [1, 'A'],
      [5, 'Named'],
    ]);
  });

  it('lists nothing without an active workspace and does not filter windows when it has none', () => {
    expect(openTabsFor(byId, ordered, null, 1)).toEqual([]);
    expect(openTabsFor(byId, ordered, 'w1', null).map((tab) => tab.id)).toEqual([1, 3, 5]);
  });
});
