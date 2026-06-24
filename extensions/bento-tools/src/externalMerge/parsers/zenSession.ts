import type {
  NormalizedExternalSession,
  NormalizedExternalTab,
  NormalizedExternalTabGroup,
  NormalizedExternalWindow,
  NormalizedExternalWorkspace,
  ZenExternalSessionSnapshot,
} from '../sourceTypes';
import { ExternalMergeError } from '../sourceTypes';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).map(([key, raw]) => {
    const child = asRecord(raw);
    if (!child) return { id: key, value: raw };
    if (
      child.id !== undefined ||
      child.uuid !== undefined ||
      child.groupId !== undefined ||
      child.tabGroupId !== undefined ||
      child.folderId !== undefined
    ) {
      return child;
    }
    return { id: key, ...child };
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asId(value: unknown): string | undefined {
  const text = asString(value);
  if (text) return text;
  const numeric = asNumber(value);
  return numeric !== undefined ? String(numeric) : undefined;
}

function asMaybeJsonRecord(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (record) return record;
  const text = asString(value);
  if (!text || !text.trim().startsWith('{')) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function selectedEntry(tab: JsonRecord): JsonRecord | null {
  const entries = asArray(tab.entries);
  if (entries.length === 0) return null;
  const index = asNumber(tab.index);
  const selected =
    index && index > 0 && index <= entries.length ? Math.floor(index) - 1 : entries.length - 1;
  return asRecord(entries[selected]);
}

function isPrivateLike(record: JsonRecord | null): boolean {
  if (!record) return false;
  return record.private === true || record.isPrivate === true || record.incognito === true;
}

function groupIdFromRecord(record: JsonRecord | null): string | undefined {
  if (!record) return undefined;
  return (
    asId(record.id) ??
    asId(record.groupId) ??
    asId(record.tabGroupId) ??
    asId(record.folderId) ??
    asId(record.folderUUID) ??
    asId(record.folderUuid) ??
    asId(record.tabFolderId) ??
    asId(record.zenFolderId) ??
    asId(record.zenFolderUUID) ??
    asId(record.zenFolderUuid) ??
    asId(record.zenTabFolderId) ??
    asId(record.uuid)
  );
}

function memberIdFromRecord(record: JsonRecord | null): string | undefined {
  if (!record) return undefined;
  return (
    asId(record.id) ??
    asId(record.uuid) ??
    asId(record.tabId) ??
    asId(record.tabID) ??
    asId(record.tabUuid) ??
    asId(record.tabUUID) ??
    asId(record.zenTabId) ??
    asId(record.zenTabID)
  );
}

function tabIdentityCandidates(tab: JsonRecord, tabIndex: number): string[] {
  const candidates = [
    asId(tab.id),
    asId(tab.uuid),
    asId(tab.tabId),
    asId(tab.tabID),
    asId(tab.tabUuid),
    asId(tab.tabUUID),
    asId(tab.zenTabId),
    asId(tab.zenTabID),
    String(tabIndex),
    String(tabIndex + 1),
  ].filter((id): id is string => !!id);
  return Array.from(new Set(candidates));
}

function memberIdsFromRecord(record: JsonRecord): string[] {
  const keys = [
    'tabs',
    'tabIds',
    'tabIDs',
    'tabUuids',
    'tabUUIDs',
    'children',
    'childIds',
    'items',
  ];
  const ids: string[] = [];
  for (const key of keys) {
    for (const rawMember of asCollection(record[key])) {
      const memberRecord = asRecord(rawMember);
      const id = memberRecord ? memberIdFromRecord(memberRecord) : asId(rawMember);
      if (id) ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

function groupIdForTab(
  tab: JsonRecord,
  tabIndex: number,
  groupIdByTabId: Map<string, string>,
): string | undefined {
  const extData = asMaybeJsonRecord(tab.extData);
  const direct =
    asId(tab.groupId) ??
    asId(tab.tabGroupId) ??
    asId(tab.group) ??
    groupIdFromRecord(asMaybeJsonRecord(tab.group)) ??
    asId(extData?.tabGroupId) ??
    asId(extData?.groupId) ??
    asId(tab.folderId) ??
    asId(tab.folder) ??
    groupIdFromRecord(asMaybeJsonRecord(tab.folder)) ??
    asId(extData?.folderId) ??
    asId(extData?.folder) ??
    groupIdFromRecord(asMaybeJsonRecord(extData?.folder)) ??
    asId(tab.folderUUID) ??
    asId(tab.folderUuid) ??
    asId(extData?.folderUUID) ??
    asId(extData?.folderUuid) ??
    asId(tab.tabFolderId) ??
    asId(tab.tabFolder) ??
    groupIdFromRecord(asMaybeJsonRecord(tab.tabFolder)) ??
    asId(extData?.tabFolderId) ??
    asId(extData?.tabFolder) ??
    groupIdFromRecord(asMaybeJsonRecord(extData?.tabFolder)) ??
    asId(tab.zenFolderId) ??
    asId(tab.zenFolder) ??
    groupIdFromRecord(asMaybeJsonRecord(tab.zenFolder)) ??
    asId(extData?.zenFolderId) ??
    asId(extData?.zenFolder) ??
    groupIdFromRecord(asMaybeJsonRecord(extData?.zenFolder)) ??
    asId(tab.zenFolderUUID) ??
    asId(tab.zenFolderUuid) ??
    asId(extData?.zenFolderUUID) ??
    asId(extData?.zenFolderUuid) ??
    asId(tab.zenTabFolderId) ??
    asId(tab.zenTabFolder) ??
    groupIdFromRecord(asMaybeJsonRecord(tab.zenTabFolder)) ??
    asId(extData?.zenTabFolderId) ??
    asId(extData?.zenTabFolder) ??
    groupIdFromRecord(asMaybeJsonRecord(extData?.zenTabFolder));
  if (direct) return direct;
  for (const candidate of tabIdentityCandidates(tab, tabIndex)) {
    const groupId = groupIdByTabId.get(candidate);
    if (groupId) return groupId;
  }
  return undefined;
}

function groupSources(root: JsonRecord): unknown[] {
  const keys = [
    'groups',
    'tabGroups',
    'tabgroups',
    'folders',
    'tabFolders',
    'tabfolders',
    'zenFolders',
    'zenTabFolders',
  ];
  const rawGroups: unknown[] = [];
  for (const key of keys) rawGroups.push(...asCollection(root[key]));
  for (const rawWindow of asCollection(root.windows)) {
    const window = asRecord(rawWindow);
    if (!window) continue;
    for (const key of keys) rawGroups.push(...asCollection(window[key]));
  }
  for (const rawSpace of asCollection(root.spaces)) {
    const space = asRecord(rawSpace);
    if (!space) continue;
    for (const key of keys) rawGroups.push(...asCollection(space[key]));
  }
  return rawGroups;
}

function parseGroups(root: JsonRecord): {
  groups: NormalizedExternalTabGroup[];
  groupIdByTabId: Map<string, string>;
} {
  const groups: NormalizedExternalTabGroup[] = [];
  const groupIdByTabId = new Map<string, string>();
  const seen = new Set<string>();
  groupSources(root).forEach((rawGroup, index) => {
    const record = asRecord(rawGroup);
    if (!record) return;
    const id = groupIdFromRecord(record) ?? String(index + 1);
    for (const memberId of memberIdsFromRecord(record)) groupIdByTabId.set(memberId, id);
    if (!seen.has(id)) {
      seen.add(id);
      const group: NormalizedExternalTabGroup = {
        id,
        name:
          asString(record.name) ??
          asString(record.title) ??
          asString(record.label) ??
          `Group ${index + 1}`,
        index: asNumber(record.index) ?? asNumber(record.order) ?? index,
      };
      if (typeof record.collapsed === 'boolean') group.collapsed = record.collapsed;
      groups.push(group);
    }
  });
  return { groups, groupIdByTabId };
}

function normalizeGroups(
  groups: NormalizedExternalTabGroup[],
  tabs: NormalizedExternalTab[],
): NormalizedExternalTabGroup[] {
  const used = new Set(tabs.map((tab) => tab.groupId).filter((id): id is string => !!id));
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const groupId of used) {
    if (!byId.has(groupId)) {
      byId.set(groupId, {
        id: groupId,
        name: `Group ${byId.size + 1}`,
        index: byId.size,
      });
    }
  }
  return Array.from(byId.values())
    .filter((group) => used.has(group.id))
    .sort((a, b) => a.index - b.index);
}

export function parseZenSession(snapshot: ZenExternalSessionSnapshot): NormalizedExternalSession {
  let data: unknown;
  try {
    data = JSON.parse(snapshot.json);
  } catch {
    throw new ExternalMergeError('unsupported-session', 'The Zen session snapshot is corrupt.');
  }

  const root = asRecord(data);
  if (!root) {
    throw new ExternalMergeError('unsupported-session', 'The Zen session snapshot is unsupported.');
  }

  const workspaces: NormalizedExternalWorkspace[] = [];
  const workspaceByZenId = new Map<string, NormalizedExternalWorkspace>();
  asCollection(root.spaces).forEach((rawSpace, index) => {
    const space = asRecord(rawSpace);
    if (!space) return;
    const id = asString(space.uuid) ?? asString(space.id) ?? `zen-space-${index + 1}`;
    const name = asString(space.name) ?? `Space ${index + 1}`;
    const workspace: NormalizedExternalWorkspace = {
      id,
      name,
      windowIds: [`zen-window-${id}`],
    };
    workspaces.push(workspace);
    workspaceByZenId.set(id, workspace);
  });

  if (workspaces.length === 0) {
    const fallback: NormalizedExternalWorkspace = {
      id: 'zen-space-1',
      name: 'Zen',
      windowIds: ['zen-window-zen-space-1'],
    };
    workspaces.push(fallback);
    workspaceByZenId.set(fallback.id, fallback);
  }

  const tabsByWorkspaceId = new Map<string, NormalizedExternalTab[]>();
  for (const workspace of workspaces) tabsByWorkspaceId.set(workspace.id, []);
  const fallbackWorkspaceId = workspaces[0]!.id;
  const parsedGroups = parseGroups(root);

  asCollection(root.tabs).forEach((rawTab, tabIndex) => {
    const tab = asRecord(rawTab);
    if (!tab || tab.hidden === true || isPrivateLike(tab)) return;
    const entry = selectedEntry(tab);
    if (!entry || isPrivateLike(entry)) return;
    const url = asString(entry.url);
    if (!url || url === 'about:blank') return;
    const workspaceId =
      asString(tab.zenWorkspace) && workspaceByZenId.has(asString(tab.zenWorkspace)!)
        ? asString(tab.zenWorkspace)!
        : fallbackWorkspaceId;
    const groupId = groupIdForTab(tab, tabIndex, parsedGroups.groupIdByTabId);
    const isEssential = tab.zenEssential === true;
    // Zen can mark sidebar folder children as pinned; folder membership wins
    // unless the tab is explicitly a Zen Essential.
    const normalizedTab: NormalizedExternalTab = {
      id: `zen-tab-${tabIndex + 1}`,
      url,
      title: asString(entry.title) ?? asString(tab.title) ?? url,
      index: asNumber(tab.index) ?? tabIndex,
      active: tab.active === true || tab._zenIsActiveTab === true,
      pinned: isEssential || (tab.pinned === true && !groupId),
    };
    if (groupId) normalizedTab.groupId = groupId;
    tabsByWorkspaceId.get(workspaceId)?.push(normalizedTab);
  });

  const windows: NormalizedExternalWindow[] = [];
  workspaces.forEach((workspace, workspaceIndex) => {
    const tabs = (tabsByWorkspaceId.get(workspace.id) ?? []).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.index - b.index;
    });
    tabs.forEach((tab, index) => {
      tab.index = index;
      tab.active = tab.active || index === 0;
    });
    if (tabs.length === 0) return;
    windows.push({
      id: workspace.windowIds[0]!,
      workspaceId: workspace.id,
      active: workspaceIndex === 0,
      tabs,
      groups: normalizeGroups(parsedGroups.groups, tabs),
    });
  });

  return {
    sourceId: snapshot.sourceId,
    kind: snapshot.kind,
    browserName: snapshot.browserName,
    profileName: snapshot.profileName,
    capturedAt: snapshot.capturedAt,
    lastModified: snapshot.lastModified,
    workspaces: workspaces.filter((workspace) =>
      windows.some((win) => win.workspaceId === workspace.id),
    ),
    windows,
  };
}
