declare global {
  namespace browser {
    const bentoNativePreferences: {
      onRequest: {
        addListener(
          listener: (message: {
            request: Record<string, unknown>;
            targetWindowId: number;
            isPrivate: boolean;
          }) => void,
        ): void;
        removeListener(listener: (...args: unknown[]) => void): void;
      };
      respond(response: Record<string, unknown>): Promise<boolean>;
      publish(publication: Record<string, unknown>): Promise<void>;
      getCurrentBootAttestation(): Promise<{
        currentParentSessionId: string;
        currentBootId: string;
        singletonInitializedAt: number;
        registryEpoch: number;
      }>;
    };
  }
}

export {};
