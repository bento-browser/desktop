import type { TabSnapshot } from '@shared/protocol';

declare global {
  namespace browser {
    /** Chrome-side tab state the WebExtension tabs API does not expose (experiments/bento-tab-state). */
    const bentoTabState: {
      /**
       * The tabs whose top-level document is one of Firefox's failure pages right now. Tabs that
       * show anything else are not listed.
       */
      getPageErrors(): Promise<
        { tabId: number; pageError: NonNullable<TabSnapshot['pageError']> }[]
      >;
      /**
       * Fires when a tab starts showing a failure page, changes to another, or (`null`) stops. It
       * reports changes only; read the starting state with getPageErrors.
       */
      onPageErrorChanged: WebExtEvent<
        (tabId: number, pageError: TabSnapshot['pageError'] | null) => void
      >;
    };
  }
}

export {};
