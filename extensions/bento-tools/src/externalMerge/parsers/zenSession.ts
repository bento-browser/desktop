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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function parseGroups(root: JsonRecord): NormalizedExternalTabGroup[] {
  const groups: NormalizedExternalTabGroup[] = [];
  const seen = new Set<string>();
  asArray(root.groups).forEach((rawGroup, index) => {
    const record = asRecord(rawGroup);
    if (!record) return;
    const id = asString(record.id) ?? asString(record.groupId) ?? String(index + 1);
    if (seen.has(id)) return;
    seen.add(id);
    const group: NormalizedExternalTabGroup = {
      id,
      name: asString(record.name) ?? asString(record.title) ?? `Group ${index + 1}`,
      index: asNumber(record.index) ?? index,
    };
    if (typeof record.collapsed === 'boolean') group.collapsed = record.collapsed;
    groups.push(group);
  });
  return groups;
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
  asArray(root.spaces).forEach((rawSpace, index) => {
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
  const groups = parseGroups(root);

  asArray(root.tabs).forEach((rawTab, tabIndex) => {
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
    const normalizedTab: NormalizedExternalTab = {
      id: `zen-tab-${tabIndex + 1}`,
      url,
      title: asString(entry.title) ?? asString(tab.title) ?? url,
      index: asNumber(tab.index) ?? tabIndex,
      active: tab.active === true || tab._zenIsActiveTab === true,
      pinned: tab.pinned === true || tab.zenEssential === true,
    };
    const groupId = asString(tab.groupId) ?? asString(tab.group);
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
      groups: normalizeGroups(groups, tabs),
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
