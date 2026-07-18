const STORAGE_KEY = 'bento.nativeOperations.v1';
const STORAGE_VERSION = 1;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type NativeOperationKind =
  | 'settings/reset'
  | 'backup/importValidated'
  | 'backup/restore'
  | 'backup/delete';

export type NativeOperationState =
  | 'reserved'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface NativeOperationComponent {
  component: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  retryable: boolean;
  errorCode?: string;
}

export interface NativeOperationRecord {
  operationId: string;
  kind: NativeOperationKind;
  ownerClientInstanceId: string;
  targetWindowId: number;
  isPrivate: boolean;
  payloadHash: string;
  state: NativeOperationState;
  phase: string;
  components: NativeOperationComponent[];
  reconcileComponents: string[];
  result?: unknown;
  errorCode?: string;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  noticeAcknowledged?: boolean;
}

interface StoredOperations {
  version: 1;
  records: NativeOperationRecord[];
}

function isRecord(value: unknown): value is NativeOperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<NativeOperationRecord>;
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

export class OperationConflictError extends Error {}
export class OperationOwnershipError extends Error {}

/** Durable exactly-once registry shared by native destructive operations. */
export class OperationRegistry {
  #records = new Map<string, NativeOperationRecord>();
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
    kind: NativeOperationKind;
    ownerClientInstanceId: string;
    targetWindowId: number;
    isPrivate: boolean;
    payloadHash: string;
    components?: string[];
  }): Promise<{ record: NativeOperationRecord; existing: boolean }> {
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
    const record: NativeOperationRecord = {
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

  getOwned(operationId: string, clientInstanceId: string): NativeOperationRecord | null {
    const record = this.#records.get(operationId);
    if (!record) return null;
    if (record.ownerClientInstanceId !== clientInstanceId) {
      throw new OperationOwnershipError('operation_not_owned');
    }
    return clone(record);
  }

  async update(
    operationId: string,
    changes: Partial<
      Pick<
        NativeOperationRecord,
        | 'state'
        | 'phase'
        | 'components'
        | 'reconcileComponents'
        | 'result'
        | 'errorCode'
        | 'noticeAcknowledged'
      >
    >,
  ): Promise<NativeOperationRecord> {
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
  ): Promise<NativeOperationRecord> {
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

  recoveredNotices(clientInstanceId: string, isPrivate: boolean): NativeOperationRecord[] {
    if (isPrivate) return [];
    return Array.from(this.#records.values())
      .filter(
        (record) =>
          record.ownerClientInstanceId === clientInstanceId &&
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
