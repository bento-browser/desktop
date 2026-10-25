import type { ColorStamp, SearchEngineId } from '@shared/protocol';

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
      /**
       * Atomically checks the chrome-issued add-panel grant on the native tab
       * (tabId, token), deletes it, and returns its metadata; null when there
       * is no live matching grant. Validate the result with readAddPanelGrant.
       */
      consumeAddPanelGrant(tabId: number, token: string): Promise<unknown>;
      /**
       * Tells every browser window's mount script the new UI colour mode pref at once
       * (a `bento-ui-color-mode-set` window event, detail `{ mode, stamp }`); private windows
       * ignore it. `stamp` is SettingsStore.colorStamp(): it orders the change against the panels
       * payload and says when it should show (`flipAt`).
       */
      notifyUiColorMode(mode: 'light' | 'dark' | 'system', stamp: ColorStamp): Promise<void>;
    };
  }
}

export {};
