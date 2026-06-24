import type { ExternalMergeSource } from '@shared/protocol';
import type {
  ExternalSessionSnapshot,
  NormalizedExternalSession,
  NormalizedExternalWindow,
} from './sourceTypes';
import { ExternalMergeError } from './sourceTypes';
import { normalizeExternalUrl } from './urlNormalization';
import { parseChromiumSession } from './parsers/chromiumSession';
import { parseFirefoxSession } from './parsers/firefoxSession';
import { parseZenSession } from './parsers/zenSession';

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
  };
}
