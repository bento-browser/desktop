import type { SearchEngineId } from '@shared/protocol';

declare global {
  namespace browser {
    const bentoPrivacy: {
      getPrefs(names: string[]): Promise<Record<string, boolean | number | string>>;
      setPrefs(values: Record<string, boolean | number | string>): Promise<void>;
      clearPrefs(names: string[]): Promise<void>;
      getSearchEngines(): Promise<
        Array<{ id: SearchEngineId; name: string; isDefault: boolean; iconUrl?: string }>
      >;
      getDefaultSearchEngine(): Promise<SearchEngineId>;
      setDefaultSearchEngine(id: SearchEngineId): Promise<void>;
    };
  }
}

export {};
