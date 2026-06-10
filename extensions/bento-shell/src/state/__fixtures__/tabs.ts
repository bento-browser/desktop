// Fake tab data for Ladle stories — seeds useTabsStore so layer-2
// components can be exercised in isolation without needing the real
// browser.tabs.* API.

import type { TabSnapshot } from '@shared/protocol';
import { useTabsStore } from '../tabs';

const SAMPLE_TITLES = [
  'GitHub — andrewtran/bento-browser',
  'Google',
  'OzBargain: Deals, Coupons, Vouchers, Discounts and Freebies',
  'A Very Long Tab Title That Should Definitely Get Truncated With An Ellipsis When It Runs Out Of Space',
  'Tale UI Documentation',
  'Mozilla Developer Network',
  'Hacker News',
  'Stack Overflow — How do I…',
  'YouTube',
  'Twitter / X',
  'Discord — #bento-dev',
  'Linear — Bento M1 backlog',
  'Notion — Engineering wiki',
  'Figma — Bento UI',
  'Slack — bento-team',
];

const FAVICON_URLS: Record<number, string | undefined> = {
  0: 'https://github.githubassets.com/favicons/favicon.svg',
  1: 'https://www.google.com/favicon.ico',
  2: 'https://files.ozbargain.com.au/favicon.ico',
  // 3 has no favicon to test the placeholder
  4: 'https://tale.dev/favicon.ico',
  5: 'https://developer.mozilla.org/favicon.ico',
};

export function makeTab(overrides: Partial<TabSnapshot> & { id: number }): TabSnapshot {
  const { id, ...rest } = overrides;
  return {
    id,
    windowId: 1,
    index: id,
    title: SAMPLE_TITLES[id % SAMPLE_TITLES.length] ?? `Tab ${id}`,
    favIconUrl: FAVICON_URLS[id % SAMPLE_TITLES.length],
    active: false,
    pinned: false,
    audible: false,
    muted: false,
    ...rest,
  };
}

export function seedTabs(count: number, activeIndex = 0): TabSnapshot[] {
  const tabs = Array.from({ length: count }, (_, i) =>
    makeTab({ id: i + 1, active: i === activeIndex }),
  );
  useTabsStore.getState().applySnapshot(tabs);
  return tabs;
}

export function seedEmpty(): void {
  useTabsStore.getState().applySnapshot([]);
}

export function seedSingle(snapshot: TabSnapshot): void {
  useTabsStore.getState().applySnapshot([snapshot]);
}

/** Seed tabs spread across multiple workspaces. `perWorkspace[i]` tabs are
 * assigned to `workspaceIds[i]`. The first tab of `activeWorkspaceId` is
 * marked active so the sidebar has a current selection to render. Used by
 * the App-level Ladle demo to populate the full shell layout (sidebar + tab
 * list + workspace switcher) without needing the real bento-tools port.
 */
export function seedTabsAcrossWorkspaces(
  spec: { workspaceId: string; count: number }[],
  activeWorkspaceId: string,
): TabSnapshot[] {
  const tabs: TabSnapshot[] = [];
  let nextId = 1;
  for (const { workspaceId, count } of spec) {
    for (let i = 0; i < count; i++) {
      const isActive = workspaceId === activeWorkspaceId && i === 0;
      tabs.push(makeTab({ id: nextId++, workspaceId, active: isActive }));
    }
  }
  useTabsStore.getState().applySnapshot(tabs);
  return tabs;
}
