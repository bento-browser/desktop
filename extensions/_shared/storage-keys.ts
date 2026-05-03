// Storage key constants used by bento-tools for storage.local persistence.
// Centralized here so both extensions agree on the schema.

export const STORAGE_KEYS = {
  workspaces: 'bento.workspaces.v1',
  panels: 'bento.panels.v1',
  session: 'bento.session.v1',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
