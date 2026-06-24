import type { ExternalSessionCandidate, ExternalSessionSnapshot } from './sourceTypes';

declare global {
  namespace browser {
    const bentoExternalSessions: {
      listCandidates(): Promise<ExternalSessionCandidate[]>;
      readSnapshot(sourceId: string): Promise<ExternalSessionSnapshot>;
    };
  }
}

export {};
