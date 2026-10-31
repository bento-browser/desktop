declare global {
  namespace browser {
    /** Chrome-side tab state the WebExtension tabs API does not expose (experiments/bento-tab-state). */
    const bentoTabState: {
      /** Ids of the tabs that show Firefox's crashed-tab page right now. */
      getCrashedTabIds(): Promise<number[]>;
      /**
       * Fires when a tab starts (`crashed` true) or stops (false) showing the crashed-tab page.
       * It reports changes only; read the starting state with getCrashedTabIds.
       */
      onCrashedChanged: WebExtEvent<(tabId: number, crashed: boolean) => void>;
    };
  }
}

export {};
