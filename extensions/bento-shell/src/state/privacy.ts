// Downstream mirror of bento-tools' read of browser.privacy.*. Snapshots
// arrive on Privacy Dashboard mount (privacy/requestSnapshot) and after
// every privacy/set* action — there's no streaming privacy/changed event
// because privacy settings rarely change without explicit user action.

import { create } from 'zustand';
import type { PrivacySettings } from '@shared/protocol';

interface PrivacyState {
  /** null until the first privacy/snapshot arrives. The dashboard renders
   * a skeleton/spinner until then. */
  settings: PrivacySettings | null;
  apply: (settings: PrivacySettings) => void;
}

export const usePrivacyStore = create<PrivacyState>((set) => ({
  settings: null,
  apply: (settings) => set({ settings }),
}));
