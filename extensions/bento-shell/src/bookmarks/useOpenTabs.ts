// The drawer's rows: the tabs of this window's active workspace that can be saved. Panels are tabs
// too, so they are listed with the sidebar's tabs, in Firefox's tab order.

import { useMemo } from 'react';
import type { TabSnapshot } from '@shared/protocol';
import { ALLOWED_URL_SCHEMES } from '@shared/export-schema';

import type { OpenTab } from '../components/BookmarksView/types';
import { useTabsStore } from '../state/tabs';

/** A page worth saving: a web or file address, not one of Firefox's own about: pages (tools skips
 * those, and every privileged scheme, so the drawer does not offer them). */
export function isSavableUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol !== 'about:' && ALLOWED_URL_SCHEMES.has(protocol);
  } catch {
    return false;
  }
}

export function openTabsFor(
  byId: Readonly<Record<number, TabSnapshot>>,
  orderedIds: readonly number[],
  workspaceId: string | null,
  windowId: number | null,
): OpenTab[] {
  if (!workspaceId) return [];
  const tabs: OpenTab[] = [];
  for (const id of orderedIds) {
    const tab = byId[id];
    if (!tab || tab.workspaceId !== workspaceId) continue;
    if (typeof windowId === 'number' && tab.windowId !== windowId) continue;
    if (!isSavableUrl(tab.url)) continue;
    tabs.push({
      id: tab.id,
      title: tab.customTitle || tab.title,
      url: tab.url,
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
    });
  }
  return tabs;
}

export function useOpenTabs(workspaceId: string | null, windowId: number | null): OpenTab[] {
  const byId = useTabsStore((state) => state.byId);
  const orderedIds = useTabsStore((state) => state.orderedIds);
  return useMemo(
    () => openTabsFor(byId, orderedIds, workspaceId, windowId),
    [byId, orderedIds, workspaceId, windowId],
  );
}
