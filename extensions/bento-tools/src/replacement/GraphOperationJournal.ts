import type {
  NativeOperationKind,
  OperationRegistry,
} from '../native-preferences/OperationRegistry';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import type { PrivacyMutationService } from '../privacy/PrivacyMutationService';
import { validateExportSchema } from '../backup/ExportSchema';

const JOURNAL_KEY = 'bento.graphOperation.v1';
const SOURCE_KEY = 'bento.graphOperation.sources.v1';
const SESSION_MARKER_KEY = 'bento.graphOperation.v1';

export type GraphOperationPhase =
  | 'prepared'
  | 'creating-workspaces'
  | 'creating-tabs'
  | 'staged'
  | 'graph-subcommitted'
  | 'relocating'
  | 'proving'
  | 'cleaning-old'
  | 'publishing'
  | 'awaiting-acks'
  | 'graph-published'
  | 'applying-saved-panels'
  | 'applying-settings'
  | 'applying-privacy'
  | 'applying-search'
  | 'terminal';

export interface GraphOperationJournalRecord {
  version: 1;
  operationId: string;
  kind: Extract<NativeOperationKind, 'backup/importValidated' | 'backup/restore'>;
  mode: 'additive' | 'replace';
  applySettings: boolean;
  applySavedPanels: boolean;
  ownerClientInstanceId: string;
  targetWindowId: number;
  acceptedParentSessionId: string;
  acceptedParentBootId: string;
  sourceHash: string;
  sourceCacheId: string;
  phase: GraphOperationPhase;
  createdWorkspaceIds: string[];
  createdTabIds: number[];
  oldWorkspaceIds: string[];
  removedOldTabIds: number[];
  postReplacementWindowMap: Record<string, string>;
  componentCursor: number;
  createdAt: number;
  updatedAt: number;
}

interface SourceCacheEntry {
  id: string;
  operationId: string;
  hash: string;
  json: string;
  createdAt: number;
}

interface StoredSources {
  version: 1;
  entries: SourceCacheEntry[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isJournal(value: unknown): value is GraphOperationJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<GraphOperationJournalRecord>;
  return (
    record.version === 1 &&
    typeof record.operationId === 'string' &&
    (record.kind === 'backup/importValidated' || record.kind === 'backup/restore') &&
    (record.mode === 'additive' || record.mode === 'replace') &&
    typeof record.applySettings === 'boolean' &&
    typeof record.applySavedPanels === 'boolean' &&
    typeof record.ownerClientInstanceId === 'string' &&
    Number.isInteger(record.targetWindowId) &&
    typeof record.sourceHash === 'string' &&
    typeof record.sourceCacheId === 'string' &&
    typeof record.phase === 'string' &&
    Array.isArray(record.createdWorkspaceIds) &&
    Array.isArray(record.createdTabIds) &&
    Array.isArray(record.oldWorkspaceIds) &&
    Array.isArray(record.removedOldTabIds)
  );
}

export class GraphOperationJournal {
  #record: GraphOperationJournalRecord | null = null;
  #queue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    const raw = (await browser.storage.local.get([JOURNAL_KEY, SOURCE_KEY])) as Record<
      string,
      unknown
    >;
    this.#record = isJournal(raw[JOURNAL_KEY]) ? clone(raw[JOURNAL_KEY]) : null;
  }

  current(): GraphOperationJournalRecord | null {
    return this.#record ? clone(this.#record) : null;
  }

  async begin(input: {
    operationId: string;
    kind: Extract<NativeOperationKind, 'backup/importValidated' | 'backup/restore'>;
    mode: 'additive' | 'replace';
    applySettings: boolean;
    applySavedPanels: boolean;
    ownerClientInstanceId: string;
    targetWindowId: number;
    acceptedParentSessionId: string;
    acceptedParentBootId: string;
    sourceHash: string;
    sourceJson: string;
    oldWorkspaceIds: string[];
  }): Promise<GraphOperationJournalRecord> {
    if (this.#record && this.#record.operationId !== input.operationId) {
      throw new Error('graph_reserved');
    }
    if (this.#record) return clone(this.#record);
    const now = Date.now();
    const sourceCacheId = crypto.randomUUID();
    const record: GraphOperationJournalRecord = {
      version: 1,
      operationId: input.operationId,
      kind: input.kind,
      mode: input.mode,
      applySettings: input.applySettings,
      applySavedPanels: input.applySavedPanels,
      ownerClientInstanceId: input.ownerClientInstanceId,
      targetWindowId: input.targetWindowId,
      acceptedParentSessionId: input.acceptedParentSessionId,
      acceptedParentBootId: input.acceptedParentBootId,
      sourceHash: input.sourceHash,
      sourceCacheId,
      phase: 'prepared',
      createdWorkspaceIds: [],
      createdTabIds: [],
      oldWorkspaceIds: [...input.oldWorkspaceIds],
      removedOldTabIds: [],
      postReplacementWindowMap: {},
      componentCursor: 0,
      createdAt: now,
      updatedAt: now,
    };
    const raw = (await browser.storage.local.get(SOURCE_KEY)) as Record<string, unknown>;
    const stored = raw[SOURCE_KEY] as Partial<StoredSources> | undefined;
    const entries = stored?.version === 1 && Array.isArray(stored.entries) ? stored.entries : [];
    const sources: StoredSources = {
      version: 1,
      entries: [
        ...entries.filter((entry) => entry.operationId !== input.operationId).slice(-3),
        {
          id: sourceCacheId,
          operationId: input.operationId,
          hash: input.sourceHash,
          json: input.sourceJson,
          createdAt: now,
        },
      ],
    };
    await browser.storage.local.set({ [SOURCE_KEY]: sources, [JOURNAL_KEY]: record });
    await browser.sessions
      .setWindowValue(input.targetWindowId, SESSION_MARKER_KEY, {
        operationId: input.operationId,
        sourceHash: input.sourceHash,
      })
      .catch(() => undefined);
    this.#record = record;
    return clone(record);
  }

  async update(
    operationId: string,
    changes: Partial<
      Pick<
        GraphOperationJournalRecord,
        | 'phase'
        | 'createdWorkspaceIds'
        | 'createdTabIds'
        | 'removedOldTabIds'
        | 'postReplacementWindowMap'
        | 'componentCursor'
      >
    >,
  ): Promise<GraphOperationJournalRecord> {
    if (!this.#record || this.#record.operationId !== operationId) {
      throw new Error('operation_unknown');
    }
    Object.assign(this.#record, clone(changes), { updatedAt: Date.now() });
    await this.#persist();
    return clone(this.#record);
  }

  async registerWorkspace(operationId: string, workspaceId: string): Promise<void> {
    const current = this.#require(operationId);
    if (!current.createdWorkspaceIds.includes(workspaceId)) {
      current.createdWorkspaceIds.push(workspaceId);
      current.updatedAt = Date.now();
      await this.#persist();
    }
  }

  async registerTab(operationId: string, tabId: number): Promise<void> {
    const current = this.#require(operationId);
    if (!current.createdTabIds.includes(tabId)) {
      current.createdTabIds.push(tabId);
      current.updatedAt = Date.now();
      await this.#persist();
    }
  }

  async readSource(operationId: string): Promise<string | null> {
    const record = this.#require(operationId);
    const raw = (await browser.storage.local.get(SOURCE_KEY)) as Record<string, unknown>;
    const stored = raw[SOURCE_KEY] as Partial<StoredSources> | undefined;
    if (stored?.version !== 1 || !Array.isArray(stored.entries)) return null;
    const source = stored.entries.find(
      (entry) => entry.id === record.sourceCacheId && entry.operationId === operationId,
    );
    return source?.hash === record.sourceHash ? source.json : null;
  }

  async clear(operationId: string): Promise<void> {
    const record = this.#require(operationId);
    const raw = (await browser.storage.local.get(SOURCE_KEY)) as Record<string, unknown>;
    const stored = raw[SOURCE_KEY] as Partial<StoredSources> | undefined;
    const remaining =
      stored?.version === 1 && Array.isArray(stored.entries)
        ? stored.entries.filter((entry) => entry.operationId !== operationId)
        : [];
    await browser.storage.local.set({
      [SOURCE_KEY]: { version: 1, entries: remaining } satisfies StoredSources,
    });
    await browser.storage.local.remove(JOURNAL_KEY);
    await browser.sessions
      .removeWindowValue(record.targetWindowId, SESSION_MARKER_KEY)
      .catch(() => undefined);
    this.#record = null;
  }

  #require(operationId: string): GraphOperationJournalRecord {
    if (!this.#record || this.#record.operationId !== operationId) {
      throw new Error('operation_unknown');
    }
    return this.#record;
  }

  #persist(): Promise<void> {
    const snapshot = this.#record ? clone(this.#record) : null;
    const write = async () => {
      if (snapshot) await browser.storage.local.set({ [JOURNAL_KEY]: snapshot });
    };
    const result = this.#queue.then(write, write);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const PRE_PUBLICATION_PHASES = new Set<GraphOperationPhase>([
  'prepared',
  'creating-workspaces',
  'creating-tabs',
  'staged',
  'graph-subcommitted',
  'relocating',
  'proving',
]);

/** Startup-first recovery for an operation interrupted by background restart. */
export class GraphOperationRecovery {
  #journal: GraphOperationJournal;
  #operations: OperationRegistry;
  #workspaces: WorkspaceStore;
  #tabs: TabRegistry;
  #panels: PanelStore;
  #pinnedPanels: PinnedPanelsStore;
  #settings: SettingsStore;
  #savedPanels: SavedPanelsStore;
  #privacyMutations: PrivacyMutationService;

  constructor(input: {
    journal: GraphOperationJournal;
    operations: OperationRegistry;
    workspaces: WorkspaceStore;
    tabs: TabRegistry;
    panels: PanelStore;
    pinnedPanels: PinnedPanelsStore;
    settings: SettingsStore;
    savedPanels: SavedPanelsStore;
    privacyMutations: PrivacyMutationService;
  }) {
    this.#journal = input.journal;
    this.#operations = input.operations;
    this.#workspaces = input.workspaces;
    this.#tabs = input.tabs;
    this.#panels = input.panels;
    this.#pinnedPanels = input.pinnedPanels;
    this.#settings = input.settings;
    this.#savedPanels = input.savedPanels;
    this.#privacyMutations = input.privacyMutations;
  }

  async bootstrap(): Promise<void> {
    await Promise.all([this.#journal.init(), this.#operations.init()]);
    const record = this.#journal.current();
    if (!record) return;

    if (PRE_PUBLICATION_PHASES.has(record.phase)) {
      const survivingTabs: number[] = [];
      for (const tabId of record.createdTabIds) {
        try {
          await browser.tabs.remove(tabId);
        } catch {
          try {
            await browser.tabs.get(tabId);
            survivingTabs.push(tabId);
          } catch {
            // Absence proves this staged tab was rolled back.
          }
        }
      }
      for (const workspaceId of [...record.createdWorkspaceIds].reverse()) {
        const referenced = this.#tabs.snapshot().some((tab) => tab.workspaceId === workspaceId);
        if (referenced || survivingTabs.length > 0) continue;
        this.#pinnedPanels.removeForWorkspace(workspaceId);
        this.#panels.removeWorkspace(workspaceId);
        this.#workspaces.delete(workspaceId);
      }
      if (survivingTabs.length === 0) {
        await this.#operations.update(record.operationId, {
          state: 'failed',
          phase: 'terminal',
          errorCode: 'backend_restarted',
          reconcileComponents: [],
        });
        await this.#journal.clear(record.operationId);
        return;
      }
    }

    if (
      record.phase === 'graph-published' ||
      record.phase === 'applying-saved-panels' ||
      record.phase === 'applying-settings' ||
      record.phase === 'applying-privacy' ||
      record.phase === 'applying-search'
    ) {
      const sourceJson = await this.#journal.readSource(record.operationId);
      const source = sourceJson ? validateExportSchema(JSON.parse(sourceJson)) : null;
      if (source) {
        if (record.applySavedPanels) {
          await this.#journal.update(record.operationId, { phase: 'applying-saved-panels' });
          const existing = new Set(this.#savedPanels.list().map((entry) => entry.url));
          for (const entry of source.savedPanels) {
            if (!existing.has(entry.url)) await this.#savedPanels.save(entry.url, entry.title);
          }
        }
        if (record.applySettings && source.settings) {
          const { privacyProtectionLevel, defaultSearchEngine, ...ordinary } = source.settings;
          await this.#journal.update(record.operationId, { phase: 'applying-settings' });
          if (Object.keys(ordinary).length > 0) await this.#settings.update(ordinary);
          if (privacyProtectionLevel) {
            await this.#journal.update(record.operationId, { phase: 'applying-privacy' });
            await this.#privacyMutations.setProtectionLevel(privacyProtectionLevel);
          }
          if (defaultSearchEngine) {
            await this.#journal.update(record.operationId, { phase: 'applying-search' });
            await this.#privacyMutations.setSearchEngine(defaultSearchEngine);
          }
        }
        await this.#operations.update(record.operationId, {
          state: 'succeeded',
          phase: 'terminal',
          reconcileComponents: [],
          result: { recovered: true },
        });
        await this.#journal.clear(record.operationId);
        return;
      }
    }

    await this.#operations.update(record.operationId, {
      state: 'partial',
      phase: 'terminal',
      errorCode: 'backend_restarted',
      reconcileComponents: ['graphPersistence'],
      result: {
        createdWorkspaceIds: record.createdWorkspaceIds,
        createdTabIds: record.createdTabIds,
        phase: record.phase,
      },
    });
    await this.#journal.update(record.operationId, { phase: 'terminal' });
  }
}
