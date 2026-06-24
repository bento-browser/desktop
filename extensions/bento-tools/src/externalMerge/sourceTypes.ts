import type { ExternalMergeErrorCode, ExternalMergeSourceKind } from '@shared/protocol';

export interface ExternalSessionCandidate {
  sourceId: string;
  kind: ExternalMergeSourceKind;
  browserName: string;
  profileName: string;
  lastModified: number;
}

export interface ExternalSessionSnapshotBase extends ExternalSessionCandidate {
  capturedAt: number;
}

export interface FirefoxExternalSessionSnapshot extends ExternalSessionSnapshotBase {
  format: 'firefox-json';
  json: string;
}

export interface ZenExternalSessionSnapshot extends ExternalSessionSnapshotBase {
  format: 'zen-json';
  json: string;
}

export interface ChromiumExternalSessionSnapshot extends ExternalSessionSnapshotBase {
  format: 'chromium-session-files';
  files: Array<{
    name: string;
    payloadBase64: string;
    lastModified: number;
  }>;
}

export type ExternalSessionSnapshot =
  | FirefoxExternalSessionSnapshot
  | ZenExternalSessionSnapshot
  | ChromiumExternalSessionSnapshot;

export interface NormalizedExternalTabGroup {
  id: string;
  name: string;
  index: number;
  collapsed?: boolean;
}

export interface NormalizedExternalTab {
  id: string;
  url: string;
  title: string;
  index: number;
  active: boolean;
  pinned: boolean;
  groupId?: string;
}

export interface NormalizedExternalWindow {
  id: string;
  title?: string;
  workspaceId?: string;
  active: boolean;
  tabs: NormalizedExternalTab[];
  groups: NormalizedExternalTabGroup[];
}

export interface NormalizedExternalWorkspace {
  id: string;
  name: string;
  windowIds: string[];
}

export interface NormalizedExternalSession {
  sourceId: string;
  kind: ExternalMergeSourceKind;
  browserName: string;
  profileName: string;
  capturedAt: number;
  lastModified: number;
  workspaces?: NormalizedExternalWorkspace[];
  windows: NormalizedExternalWindow[];
}

export class ExternalMergeError extends Error {
  code: ExternalMergeErrorCode;

  constructor(code: ExternalMergeErrorCode, message: string) {
    super(message);
    this.name = 'ExternalMergeError';
    this.code = code;
  }
}

export function externalMergeErrorCode(err: unknown): ExternalMergeErrorCode | undefined {
  return err instanceof ExternalMergeError ? err.code : undefined;
}
