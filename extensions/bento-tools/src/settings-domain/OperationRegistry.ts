const STORAGE_KEY = 'bento.nativeOperations.v1';
const STORAGE_VERSION = 1;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type DurableOperationKind =
  'settings/reset' | 'backup/importValidated' | 'backup/restore' | 'backup/delete';

export type DurableOperationState =
  'reserved' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled';

export interface DurableOperationComponent {
  component: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  retryable: boolean;
  errorCode?: string;
}

export interface DurableOperationRecord {
  operationId: string;
  kind: DurableOperationKind;
  ownerClientInstanceId: string;
  targetWindowId: number;
  isPrivate: boolean;
  payloadHash: string;
  state: DurableOperationState;
  phase: string;
  components: DurableOperationComponent[];
  reconcileComponents: string[];
  result?: unknown;
  errorCode?: string;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  noticeAcknowledged?: boolean;
  /** Set when startup recovery, not the running operation, settled the record. */
  recovered?: boolean;
}

interface StoredOperations {
  version: 1;
  records: DurableOperationRecord[];
}

function isRecord(value: unknown): value is DurableOperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<DurableOperationRecord>;
  return (
    typeof record.operationId === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.ownerClientInstanceId === 'string' &&
    Number.isInteger(record.targetWindowId) &&
    typeof record.payloadHash === 'string' &&
    typeof record.state === 'string' &&
    typeof record.phase === 'string' &&
    Array.isArray(record.components) &&
    Array.isArray(record.reconcileComponents) &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Final component states of an operation that ran to completion: reported failures as given,
 * skipped components marked, the rest succeeded.
 */
export function finishComponents(
  components: readonly DurableOperationComponent[],
  failed: readonly DurableOperationComponent[] = [],
  skipped: ReadonlySet<string> = new Set(),
): DurableOperationComponent[] {
  const failures = new Map(failed.map((entry) => [entry.component, entry]));
  return components.map((entry) => {
    const failure = failures.get(entry.component);
    if (failure) return { ...entry, ...failure };
    return { ...entry, state: skipped.has(entry.component) ? 'skipped' : 'succeeded' };
  });
}

/**
 * Component states of an operation that stopped on an error: whatever is not known to have
 * finished (or been skipped) counts as failed. `only` limits that to the named components.
 */
export function failComponents(
  components: readonly DurableOperationComponent[],
  errorCode: string,
  retryable: boolean,
  only?: readonly string[],
): DurableOperationComponent[] {
  return components.map((entry) =>
    entry.state === 'succeeded' ||
    entry.state === 'skipped' ||
    (only !== undefined && !only.includes(entry.component))
      ? entry
      : { ...entry, state: 'failed', retryable, errorCode },
  );
}

export class OperationConflictError extends Error {}
export class OperationOwnershipError extends Error {}

/** Durable exactly-once registry of the Settings palette's destructive operations. */
export class OperationRegistry {
  #records = new Map<string, DurableOperationRecord>();
  #writeQueue: Promise<void> = Promise.resolve();
  #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[STORAGE_KEY] as Partial<StoredOperations> | undefined;
    if (stored?.version === STORAGE_VERSION && Array.isArray(stored.records)) {
      for (const candidate of stored.records) {
        if (isRecord(candidate)) this.#records.set(candidate.operationId, clone(candidate));
      }
    }
    await this.prune();
  }

  async reserve(input: {
    operationId: string;
    kind: DurableOperationKind;
    ownerClientInstanceId: string;
    targetWindowId: number;
    isPrivate: boolean;
    payloadHash: string;
    components?: string[];
  }): Promise<{ record: DurableOperationRecord; existing: boolean }> {
    const existing = this.#records.get(input.operationId);
    if (existing) {
      if (existing.ownerClientInstanceId !== input.ownerClientInstanceId) {
        throw new OperationOwnershipError('operation_not_owned');
      }
      if (existing.kind !== input.kind || existing.payloadHash !== input.payloadHash) {
        throw new OperationConflictError('conflict');
      }
      return { record: clone(existing), existing: true };
    }
    const now = this.#now();
    const record: DurableOperationRecord = {
      operationId: input.operationId,
      kind: input.kind,
      ownerClientInstanceId: input.ownerClientInstanceId,
      targetWindowId: input.targetWindowId,
      isPrivate: input.isPrivate,
      payloadHash: input.payloadHash,
      state: 'reserved',
      phase: 'reserved',
      components: (input.components ?? []).map((component) => ({
        component,
        state: 'pending',
        retryable: false,
      })),
      reconcileComponents: [],
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.#records.set(record.operationId, record);
    await this.#persist();
    return { record: clone(record), existing: false };
  }

  getOwned(operationId: string, clientInstanceId: string): DurableOperationRecord | null {
    const record = this.#records.get(operationId);
    if (!record) return null;
    if (record.ownerClientInstanceId !== clientInstanceId) {
      throw new OperationOwnershipError('operation_not_owned');
    }
    return clone(record);
  }

  /** Record lookup for tools-internal callers (recovery); no ownership check. */
  peek(operationId: string): DurableOperationRecord | null {
    const record = this.#records.get(operationId);
    return record ? clone(record) : null;
  }

  /** An owner's records that are still running or finished within `recentMs`. */
  listOwned(ownerClientInstanceId: string, recentMs: number): DurableOperationRecord[] {
    const now = this.#now();
    return Array.from(this.#records.values())
      .filter(
        (record) =>
          record.ownerClientInstanceId === ownerClientInstanceId &&
          (record.terminalAt === undefined || now - record.terminalAt <= recentMs),
      )
      .map(clone);
  }

  /**
   * Startup settlement: a record still `reserved` or `running` was cut off by a restart (a
   * reservation is persisted before the effect starts, so even a graph operation that never
   * reached its journal is left behind). Fails them as `backend_restarted`, except the one the
   * graph journal still covers, which `GraphOperationRecovery` settles itself.
   */
  async settleInterrupted(coveredOperationId?: string | null): Promise<number> {
    const now = this.#now();
    let settled = 0;
    for (const record of this.#records.values()) {
      if (
        record.operationId === coveredOperationId ||
        (record.state !== 'reserved' && record.state !== 'running')
      ) {
        continue;
      }
      record.state = 'failed';
      record.phase = 'terminal';
      record.errorCode = 'backend_restarted';
      record.components = failComponents(record.components, 'backend_restarted', true);
      record.reconcileComponents = [];
      record.recovered = true;
      record.updatedAt = now;
      record.terminalAt ??= now;
      settled += 1;
    }
    if (settled > 0) await this.#persist();
    return settled;
  }

  async update(
    operationId: string,
    changes: Partial<
      Pick<
        DurableOperationRecord,
        | 'state'
        | 'phase'
        | 'components'
        | 'reconcileComponents'
        | 'result'
        | 'errorCode'
        | 'noticeAcknowledged'
        | 'recovered'
      >
    >,
  ): Promise<DurableOperationRecord> {
    const record = this.#records.get(operationId);
    if (!record) throw new Error('operation_unknown');
    Object.assign(record, clone(changes), { updatedAt: this.#now() });
    if (['partial', 'succeeded', 'failed', 'cancelled'].includes(record.state)) {
      record.terminalAt ??= record.updatedAt;
    }
    await this.#persist();
    return clone(record);
  }

  async requestCancel(
    operationId: string,
    clientInstanceId: string,
  ): Promise<DurableOperationRecord> {
    const record = this.#records.get(operationId);
    if (!record) throw new Error('operation_unknown');
    if (record.ownerClientInstanceId !== clientInstanceId) {
      throw new OperationOwnershipError('operation_not_owned');
    }
    if (record.state === 'reserved') {
      record.state = 'cancelled';
      record.phase = 'terminal';
      record.terminalAt = this.#now();
    } else if (record.state === 'running') {
      record.cancelRequested = true;
    }
    record.updatedAt = this.#now();
    await this.#persist();
    return clone(record);
  }

  /** Finished records the owner could not have seen settle: those recovery settled. */
  recoveredNotices(clientInstanceId: string, isPrivate: boolean): DurableOperationRecord[] {
    if (isPrivate) return [];
    return Array.from(this.#records.values())
      .filter(
        (record) =>
          record.ownerClientInstanceId === clientInstanceId &&
          record.recovered === true &&
          record.terminalAt !== undefined &&
          record.noticeAcknowledged !== true,
      )
      .map(clone);
  }

  async acknowledgeNotice(operationId: string, clientInstanceId: string): Promise<void> {
    const record = this.#records.get(operationId);
    if (!record) throw new Error('operation_unknown');
    if (record.ownerClientInstanceId !== clientInstanceId) {
      throw new OperationOwnershipError('operation_not_owned');
    }
    record.noticeAcknowledged = true;
    record.updatedAt = this.#now();
    await this.#persist();
  }

  async prune(): Promise<void> {
    const now = this.#now();
    let changed = false;
    for (const [id, record] of this.#records) {
      if (!record.terminalAt) continue;
      if (record.result !== undefined && now - record.terminalAt > RESULT_RETENTION_MS) {
        delete record.result;
        changed = true;
      }
      if (now - record.terminalAt > TOMBSTONE_RETENTION_MS) {
        this.#records.delete(id);
        changed = true;
      }
    }
    if (changed) await this.#persist();
  }

  #persist(): Promise<void> {
    const payload: StoredOperations = {
      version: STORAGE_VERSION,
      records: Array.from(this.#records.values()).map(clone),
    };
    const write = () => browser.storage.local.set({ [STORAGE_KEY]: payload });
    const result = this.#writeQueue.then(write, write);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
