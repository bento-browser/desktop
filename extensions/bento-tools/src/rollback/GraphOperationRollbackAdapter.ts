const TRANSITION_KEY = 'bento.rollbackTransition.v1';
const JOURNAL_KEY = 'bento.graphOperation.v1';
const SOURCE_KEY = 'bento.graphOperation.sources.v1';
const PUBLICATION_KEY = 'bento.graphPublication.v1';
const SESSION_KEY = 'bento.nativeSessions.v1';
const OPERATION_KEY = 'bento.nativeOperations.v1';

export type RollbackTransitionState =
  | 'blocking'
  | 'recovering'
  | 'verifying'
  | 'blocked-corrupt'
  | 'legacy-running'
  | 'preparing-final'
  | 'ready-for-final';

export interface RollbackTransitionRecord {
  version: 1;
  release: 'rollback-transition-r1';
  transitionId: string;
  state: RollbackTransitionState;
  revision: number;
  startedAt: number;
  updatedAt: number;
  sanitizedErrorCode?: string;
}

export class GraphOperationRollbackAdapter {
  #record!: RollbackTransitionRecord;

  getRecord(): RollbackTransitionRecord {
    return structuredClone(this.#record);
  }

  async run(): Promise<{ ready: boolean; record: RollbackTransitionRecord }> {
    const raw = (await browser.storage.local.get(TRANSITION_KEY)) as Record<string, unknown>;
    const existing = raw[TRANSITION_KEY] as Partial<RollbackTransitionRecord> | undefined;
    const now = Date.now();
    this.#record =
      existing?.version === 1 && existing.release === 'rollback-transition-r1'
        ? (existing as RollbackTransitionRecord)
        : {
            version: 1,
            release: 'rollback-transition-r1',
            transitionId: crypto.randomUUID(),
            state: 'blocking',
            revision: 0,
            startedAt: now,
            updatedAt: now,
          };
    await this.#commit('recovering');

    const state = (await browser.storage.local.get([
      JOURNAL_KEY,
      SOURCE_KEY,
      PUBLICATION_KEY,
      OPERATION_KEY,
    ])) as Record<string, unknown>;
    const journal = state[JOURNAL_KEY] as { phase?: unknown } | undefined;
    const publication = state[PUBLICATION_KEY] as { phase?: unknown } | undefined;
    const operations = state[OPERATION_KEY] as { records?: unknown } | undefined;
    const hasNonterminalOperation = Array.isArray(operations?.records)
      ? operations.records.some((candidate) => {
          const status = (candidate as { state?: unknown } | null)?.state;
          return !['partial', 'succeeded', 'failed', 'cancelled'].includes(String(status));
        })
      : false;
    const journalTerminal = !journal || journal.phase === 'terminal';
    const publicationTerminal = !publication || publication.phase === 'graph-published';
    if (!journalTerminal || !publicationTerminal || hasNonterminalOperation) {
      await this.#commit('blocked-corrupt', 'nonterminal-native-operation');
      return { ready: false, record: structuredClone(this.#record) };
    }

    await this.#commit('verifying');
    await browser.storage.local.remove([
      JOURNAL_KEY,
      SOURCE_KEY,
      PUBLICATION_KEY,
      SESSION_KEY,
      OPERATION_KEY,
    ]);
    const verify = (await browser.storage.local.get([
      JOURNAL_KEY,
      SOURCE_KEY,
      PUBLICATION_KEY,
      SESSION_KEY,
      OPERATION_KEY,
    ])) as Record<string, unknown>;
    if (Object.values(verify).some((value) => value !== undefined)) {
      await this.#commit('blocked-corrupt', 'native-artifact-removal-failed');
      return { ready: false, record: structuredClone(this.#record) };
    }
    return { ready: true, record: structuredClone(this.#record) };
  }

  async markLegacyRunning(): Promise<void> {
    await this.#commit('legacy-running');
  }

  async markReadyForFinal(): Promise<void> {
    await this.#commit('ready-for-final');
  }

  async prepareFinal(): Promise<void> {
    if (this.#record.state !== 'ready-for-final') throw new Error('transition-not-ready');
    await this.#commit('preparing-final');
    const zero = (await browser.storage.local.get([
      JOURNAL_KEY,
      SOURCE_KEY,
      PUBLICATION_KEY,
      SESSION_KEY,
      OPERATION_KEY,
    ])) as Record<string, unknown>;
    if (Object.values(zero).some((value) => value !== undefined)) {
      await this.#commit('blocked-corrupt', 'final-zero-check-failed');
      throw new Error('final-zero-check-failed');
    }
    await browser.storage.local.remove(TRANSITION_KEY);
    const readBack = (await browser.storage.local.get(TRANSITION_KEY)) as Record<string, unknown>;
    if (readBack[TRANSITION_KEY] !== undefined) throw new Error('transition-marker-removal-failed');
  }

  async #commit(state: RollbackTransitionState, sanitizedErrorCode?: string): Promise<void> {
    this.#record = {
      ...this.#record,
      state,
      revision: this.#record.revision + 1,
      updatedAt: Date.now(),
      ...(sanitizedErrorCode ? { sanitizedErrorCode } : {}),
    };
    await browser.storage.local.set({ [TRANSITION_KEY]: this.#record });
    const raw = (await browser.storage.local.get(TRANSITION_KEY)) as Record<string, unknown>;
    const readBack = raw[TRANSITION_KEY] as RollbackTransitionRecord | undefined;
    if (
      !readBack ||
      readBack.transitionId !== this.#record.transitionId ||
      readBack.revision !== this.#record.revision ||
      readBack.state !== state
    ) {
      throw new Error('transition-readback-failed');
    }
  }
}
