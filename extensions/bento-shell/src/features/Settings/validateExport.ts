import type { BentoExportSchema } from '@shared/protocol';

export function validateExportSchema(raw: unknown): BentoExportSchema | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) return null;
  if (typeof obj.exportedAt !== 'number') return null;
  if (!Array.isArray(obj.workspaces)) return null;
  for (const ws of obj.workspaces) {
    if (!ws || typeof ws !== 'object') return null;
    if (typeof ws.name !== 'string') return null;
    if (!Array.isArray(ws.tabs)) return null;
    if (!Array.isArray(ws.panels)) return null;
    if (
      obj.schemaVersion === 2 &&
      'panelLayout' in ws &&
      (typeof (ws as Record<string, unknown>).panelLayout !== 'object' ||
        (ws as Record<string, unknown>).panelLayout === null)
    )
      return null;
    if (!Array.isArray(ws.pinnedPanels)) return null;
  }
  if (!Array.isArray(obj.savedPanels)) return null;
  return raw as BentoExportSchema;
}
