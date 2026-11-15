// Readers shared by the JSON session parsers (Firefox and Zen).

import type { NormalizedExternalTab, NormalizedExternalTabGroup } from '../sourceTypes';

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function selectedEntry(tab: JsonRecord): JsonRecord | null {
  const entries = asArray(tab.entries);
  if (entries.length === 0) return null;
  const index = asNumber(tab.index);
  const selected =
    index && index > 0 && index <= entries.length ? Math.floor(index) - 1 : entries.length - 1;
  return asRecord(entries[selected]);
}

export function normalizeGroups(
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
