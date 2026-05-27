import type { BentoExportSchema } from '@shared/protocol';

const BLOCKED_URL_SCHEMES = new Set(['javascript:', 'data:']);

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !BLOCKED_URL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function validateExportSchema(raw: unknown): BentoExportSchema | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== 1) return null;
  if (typeof obj.bentoVersion !== 'string') return null;
  if (typeof obj.exportedAt !== 'number') return null;

  if (!Array.isArray(obj.workspaces)) return null;
  for (const ws of obj.workspaces) {
    if (!ws || typeof ws !== 'object') return null;
    if (typeof ws.id !== 'string') return null;
    if (typeof ws.name !== 'string') return null;
    if (typeof ws.createdAt !== 'number') return null;

    if (!Array.isArray(ws.tabs)) return null;
    for (const tab of ws.tabs) {
      if (!tab || typeof tab !== 'object') return null;
      if (typeof tab.url !== 'string' || !isSafeUrl(tab.url)) return null;
      if (typeof tab.title !== 'string') return null;
      if (typeof tab.pinned !== 'boolean') return null;
    }

    if (!Array.isArray(ws.panels)) return null;
    for (const panel of ws.panels) {
      if (!panel || typeof panel !== 'object') return null;
      if (typeof panel.url !== 'string' || !isSafeUrl(panel.url)) return null;
    }

    if (!Array.isArray(ws.pinnedPanels)) return null;
    for (const pp of ws.pinnedPanels) {
      if (!pp || typeof pp !== 'object') return null;
      if (typeof pp.url !== 'string' || !isSafeUrl(pp.url)) return null;
      if (typeof pp.order !== 'number') return null;
    }
  }

  if (obj.settings !== undefined && (typeof obj.settings !== 'object' || obj.settings === null)) {
    return null;
  }

  if (!Array.isArray(obj.savedPanels)) return null;
  for (const sp of obj.savedPanels) {
    if (!sp || typeof sp !== 'object') return null;
    if (typeof sp.title !== 'string') return null;
    if (typeof sp.url !== 'string' || !isSafeUrl(sp.url)) return null;
  }

  return raw as BentoExportSchema;
}
