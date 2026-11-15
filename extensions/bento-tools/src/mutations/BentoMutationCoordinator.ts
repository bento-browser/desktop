export interface MutationContext {
  markGraphChanged(): number;
}

/**
 * The one serialization boundary for settings, backup and graph work.
 *
 * Browser events may still arrive while an operation awaits Firefox APIs, so
 * callers that construct an immutable graph snapshot also compare the epoch
 * recorded here before committing the result.
 */
export class BentoMutationCoordinator {
  #tail: Promise<void> = Promise.resolve();
  #graphEpoch = 0;

  noteExternalGraphChange(): number {
    this.#graphEpoch += 1;
    return this.#graphEpoch;
  }

  runExclusive<T>(task: (context: MutationContext) => Promise<T>): Promise<T> {
    const context: MutationContext = { markGraphChanged: () => this.noteExternalGraphChange() };
    const run = () => task(context);

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
