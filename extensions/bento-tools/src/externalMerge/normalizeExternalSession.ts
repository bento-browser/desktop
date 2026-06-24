import type { ExternalMergeImportTarget, ExternalMergeSource } from '@shared/protocol';
import type {
  ExternalSessionSnapshot,
  NormalizedExternalSession,
  NormalizedExternalTab,
  NormalizedExternalWindow,
} from './sourceTypes';
import {
  ExternalMergeError,
  externalWindowTargetId,
  externalWorkspaceTargetId,
} from './sourceTypes';
import { normalizeExternalUrl } from './urlNormalization';
import { parseChromiumSession } from './parsers/chromiumSession';
import { parseFirefoxSession } from './parsers/firefoxSession';
import { parseZenSession } from './parsers/zenSession';

const TARGET_TAB_PREVIEW_LIMIT = 10;

export function normalizeExternalSession(
  snapshot: ExternalSessionSnapshot,
): NormalizedExternalSession {
  let session: NormalizedExternalSession;
  switch (snapshot.format) {
    case 'firefox-json':
      session = parseFirefoxSession(snapshot);
      break;
    case 'zen-json':
      session = parseZenSession(snapshot);
      break;
    case 'chromium-session-files':
      session = parseChromiumSession(snapshot);
      break;
    default: {
      const _exhaustive: never = snapshot;
      throw new ExternalMergeError('unsupported-session', `Unsupported snapshot: ${_exhaustive}`);
    }
  }

  return {
    ...session,
    windows: pruneUnimportableWindows(session),
  };
}

function pruneUnimportableWindows(session: NormalizedExternalSession): NormalizedExternalWindow[] {
  return session.windows
    .map((window) => {
      const tabs = window.tabs.filter(
        (tab) => normalizeExternalUrl(tab.url, session.kind) !== null,
      );
      const usedGroupIds = new Set(
        tabs.map((tab) => tab.groupId).filter((id): id is string => !!id),
      );
      return {
        ...window,
        tabs,
        groups: window.groups.filter((group) => usedGroupIds.has(group.id)),
      };
    })
    .filter((window) => window.tabs.length > 0);
}

export function externalMergeSourceFromSession(
  session: NormalizedExternalSession,
): ExternalMergeSource | null {
  const windows = session.windows.filter((window) => window.tabs.length > 0);
  if (windows.length === 0) return null;
  return {
    id: session.sourceId,
    kind: session.kind,
    browserName: session.browserName,
    profileName: session.profileName,
    lastModified: session.lastModified,
    windowCount: windows.length,
    tabCount: windows.reduce((sum, window) => sum + window.tabs.length, 0),
    groupCount: windows.reduce((sum, window) => sum + window.groups.length, 0),
    targets: externalMergeTargetsFromSession(session),
  };
}

export function externalMergeTargetsFromSession(
  session: NormalizedExternalSession,
): ExternalMergeImportTarget[] {
  const nativeWorkspaces = new Map(
    (session.workspaces ?? []).map((workspace) => [workspace.id, workspace]),
  );
  const nativeWorkspaceWindows = new Map<string, NormalizedExternalWindow[]>();

  if (nativeWorkspaces.size > 0) {
    for (const window of session.windows) {
      if (!window.workspaceId || !nativeWorkspaces.has(window.workspaceId)) continue;
      const list = nativeWorkspaceWindows.get(window.workspaceId) ?? [];
      list.push(window);
      nativeWorkspaceWindows.set(window.workspaceId, list);
    }
  }

  if (nativeWorkspaceWindows.size > 0) {
    return (session.workspaces ?? []).flatMap((workspace) => {
      const windows = nativeWorkspaceWindows.get(workspace.id) ?? [];
      if (windows.length === 0) return [];
      return [
        {
          id: externalWorkspaceTargetId(workspace.id),
          kind: 'workspace' as const,
          name: workspace.name || 'Space',
          windowCount: windows.length,
          tabCount: countTabs(windows),
          groupCount: countGroups(windows),
          previewTabs: previewTabs(windows.flatMap((window) => window.tabs)),
        },
      ];
    });
  }

  return session.windows.map((window, index) => ({
    id: externalWindowTargetId(window.id),
    kind: 'window' as const,
    name: window.title?.trim() || `Window ${index + 1}`,
    windowCount: 1,
    tabCount: window.tabs.length,
    groupCount: window.groups.length,
    previewTabs: previewTabs(window.tabs),
  }));
}

function countTabs(windows: NormalizedExternalWindow[]): number {
  return windows.reduce((sum, window) => sum + window.tabs.length, 0);
}

function countGroups(windows: NormalizedExternalWindow[]): number {
  return windows.reduce((sum, window) => sum + window.groups.length, 0);
}

function previewTabs(tabs: NormalizedExternalTab[]) {
  return tabs.slice(0, TARGET_TAB_PREVIEW_LIMIT).map((tab) => ({
    title: tab.title || tab.url,
    url: tab.url,
    ...(tab.pinned ? { pinned: true } : {}),
    ...(tab.active ? { active: true } : {}),
  }));
}
