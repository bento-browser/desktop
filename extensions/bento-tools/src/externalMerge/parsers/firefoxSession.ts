import type {
  FirefoxExternalSessionSnapshot,
  NormalizedExternalSession,
  NormalizedExternalTab,
  NormalizedExternalTabGroup,
  NormalizedExternalWindow,
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

function isPrivateRecord(record: JsonRecord | null): boolean {
  if (!record) return false;
  return (
    record.isPrivate === true ||
    record.private === true ||
    record.incognito === true ||
    asRecord(record.attributes)?.private === true ||
    asRecord(record.extData)?.private === true
  );
}

function selectedEntry(tab: JsonRecord): JsonRecord | null {
  const entries = asArray(tab.entries);
  if (entries.length === 0) return null;
  const index = asNumber(tab.index);
  const selected =
    index && index > 0 && index <= entries.length ? Math.floor(index) - 1 : entries.length - 1;
  return asRecord(entries[selected]);
}

function groupIdForTab(tab: JsonRecord): string | undefined {
  const direct =
    asString(tab.groupId) ??
    asString(tab.group) ??
    asString(asRecord(tab.group)?.id) ??
    asString(asRecord(tab.extData)?.tabGroupId);
  if (direct) return direct;
  const numeric = asNumber(tab.groupId);
  return numeric !== undefined ? String(numeric) : undefined;
}

function parseGroups(windowRecord: JsonRecord): NormalizedExternalTabGroup[] {
  const rawGroups = [
    ...asArray(windowRecord.tabGroups),
    ...asArray(windowRecord.groups),
    ...asArray(windowRecord.tabgroups),
  ];
  const groups: NormalizedExternalTabGroup[] = [];
  const seen = new Set<string>();
  rawGroups.forEach((raw, index) => {
    const record = asRecord(raw);
    if (!record) return;
    const id = asString(record.id) ?? asString(record.groupId) ?? String(index + 1);
    if (seen.has(id)) return;
    seen.add(id);
    const name =
      asString(record.name) ??
      asString(record.title) ??
      asString(record.label) ??
      `Group ${index + 1}`;
    const group: NormalizedExternalTabGroup = {
      id,
      name,
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

export function parseFirefoxSession(
  snapshot: FirefoxExternalSessionSnapshot,
): NormalizedExternalSession {
  let data: unknown;
  try {
    data = JSON.parse(snapshot.json);
  } catch {
    throw new ExternalMergeError('unsupported-session', 'The Firefox session snapshot is corrupt.');
  }

  const root = asRecord(data);
  const windows = asArray(root?.windows);
  const selectedWindowIndex = Math.max(0, (asNumber(root?.selectedWindow) ?? 1) - 1);
  const normalizedWindows: NormalizedExternalWindow[] = [];

  windows.forEach((rawWindow, windowIndex) => {
    const windowRecord = asRecord(rawWindow);
    if (!windowRecord || isPrivateRecord(windowRecord)) return;

    const selectedTabIndex = Math.max(0, (asNumber(windowRecord.selected) ?? 1) - 1);
    const tabs: NormalizedExternalTab[] = [];
    asArray(windowRecord.tabs).forEach((rawTab, tabIndex) => {
      const tab = asRecord(rawTab);
      if (!tab || tab.hidden === true || isPrivateRecord(tab)) return;
      const entry = selectedEntry(tab);
      if (!entry || isPrivateRecord(entry)) return;
      const url = asString(entry.url);
      if (!url) return;
      const title = asString(entry.title) ?? asString(tab.title) ?? url;
      const normalizedTab: NormalizedExternalTab = {
        id: `firefox-window-${windowIndex + 1}-tab-${tabIndex + 1}`,
        url,
        title,
        index: tabIndex,
        active: tabIndex === selectedTabIndex,
        pinned: tab.pinned === true,
      };
      const groupId = groupIdForTab(tab);
      if (groupId) normalizedTab.groupId = groupId;
      tabs.push(normalizedTab);
    });

    if (tabs.length === 0) return;
    normalizedWindows.push({
      id: `firefox-window-${windowIndex + 1}`,
      active: windowIndex === selectedWindowIndex,
      tabs,
      groups: normalizeGroups(parseGroups(windowRecord), tabs),
    });
  });

  return {
    sourceId: snapshot.sourceId,
    kind: snapshot.kind,
    browserName: snapshot.browserName,
    profileName: snapshot.profileName,
    capturedAt: snapshot.capturedAt,
    lastModified: snapshot.lastModified,
    windows: normalizedWindows,
  };
}
