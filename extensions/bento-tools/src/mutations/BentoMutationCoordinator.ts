export type MutationKind =
  | 'settings'
  | 'privacy'
  | 'search'
  | 'backup-read'
  | 'backup-write'
  | 'graph-additive'
  | 'graph-replacement'
  | 'recovery';

export interface MutationContext {
  readonly id: string;
  readonly kind: MutationKind;
  readonly graphEpochAtStart: number;
  readonly startedAt: number;
  markGraphChanged(): number;
}

/**
 * The one serialization boundary for native settings, backup and graph work.
 *
 * Browser events may still arrive while an operation awaits Firefox APIs, so
 * callers that construct an immutable graph snapshot also compare the epoch
 * recorded here before committing the result.
 */
export class BentoMutationCoordinator {
  #tail: Promise<void> = Promise.resolve();
  #graphEpoch = 0;
  #active: { id: string; kind: MutationKind; startedAt: number } | null = null;

  get graphEpoch(): number {
    return this.#graphEpoch;
  }

  get active(): Readonly<{ id: string; kind: MutationKind; startedAt: number }> | null {
    return this.#active;
  }

  noteExternalGraphChange(): number {
    this.#graphEpoch += 1;
    return this.#graphEpoch;
  }

  runExclusive<T>(kind: MutationKind, task: (context: MutationContext) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const id = crypto.randomUUID();
      const startedAt = Date.now();
      this.#active = { id, kind, startedAt };
      const context: MutationContext = {
        id,
        kind,
        startedAt,
        graphEpochAtStart: this.#graphEpoch,
        markGraphChanged: () => this.noteExternalGraphChange(),
      };
      try {
        return await task(context);
      } finally {
        if (this.#active?.id === id) this.#active = null;
      }
    };

    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async readStableSnapshot<T>(reader: () => Promise<T>, maxAttempts = 2): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const before = this.#graphEpoch;
      const result = await reader();
      if (before === this.#graphEpoch) return result;
    }
    throw new Error('snapshot_changed');
  }
}
