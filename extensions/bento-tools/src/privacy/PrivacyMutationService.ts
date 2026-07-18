import type {
  PrivacyAdvancedKey,
  SearchEngineId,
  SelectablePrivacyProtectionLevel,
} from '@shared/protocol';
import type { SettingsStore } from '../settings/SettingsStore';
import {
  applyAdvancedSetting,
  applyPrivacyLevel,
  readPrivacySnapshot,
  readSearchEnginesSnapshot,
  setDefaultSearchEngine,
} from './ProtectionLevels';

export interface LiveMutationOutcome<T> {
  state: 'succeeded' | 'partial';
  value: T;
  component: {
    component: 'privacy' | 'search';
    state: 'succeeded' | 'failed';
    retryable: boolean;
    errorCode?: 'live_effect_failed';
  };
}

/** Applies semantic privacy/search changes with authoritative read-back. */
export class PrivacyMutationService {
  #settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.#settings = settings;
  }

  async setProtectionLevel(
    level: SelectablePrivacyProtectionLevel,
  ): Promise<LiveMutationOutcome<Awaited<ReturnType<typeof readPrivacySnapshot>>>> {
    const before = await readPrivacySnapshot();
    try {
      await applyPrivacyLevel(level);
      const after = await readPrivacySnapshot();
      if (after.protectionLevel !== level) throw new Error('live read-back mismatch');
      await this.#settings.update({ privacyProtectionLevel: level });
      return {
        state: 'succeeded',
        value: after,
        component: { component: 'privacy', state: 'succeeded', retryable: false },
      };
    } catch {
      if (before.protectionLevel !== 'custom') {
        await applyPrivacyLevel(before.protectionLevel).catch(() => undefined);
      }
      return {
        state: 'partial',
        value: await readPrivacySnapshot(),
        component: {
          component: 'privacy',
          state: 'failed',
          retryable: true,
          errorCode: 'live_effect_failed',
        },
      };
    }
  }

  async setAdvanced(
    key: PrivacyAdvancedKey,
    value: boolean | string,
  ): Promise<LiveMutationOutcome<Awaited<ReturnType<typeof readPrivacySnapshot>>>> {
    const before = await readPrivacySnapshot();
    try {
      await applyAdvancedSetting(key, value);
      const after = await readPrivacySnapshot();
      if ((after as unknown as Record<string, unknown>)[key] !== value) {
        throw new Error('live read-back mismatch');
      }
      return {
        state: 'succeeded',
        value: after,
        component: { component: 'privacy', state: 'succeeded', retryable: false },
      };
    } catch {
      const previous = (before as unknown as Record<string, unknown>)[key];
      if (typeof previous === 'boolean' || typeof previous === 'string') {
        await applyAdvancedSetting(key, previous).catch(() => undefined);
      }
      return {
        state: 'partial',
        value: await readPrivacySnapshot(),
        component: {
          component: 'privacy',
          state: 'failed',
          retryable: true,
          errorCode: 'live_effect_failed',
        },
      };
    }
  }

  async setSearchEngine(
    id: SearchEngineId,
  ): Promise<LiveMutationOutcome<Awaited<ReturnType<typeof readSearchEnginesSnapshot>>>> {
    const before = await readSearchEnginesSnapshot();
    try {
      await setDefaultSearchEngine(id);
      const after = await readSearchEnginesSnapshot();
      if (after.defaultSearchEngine !== id) throw new Error('live read-back mismatch');
      await this.#settings.update({ defaultSearchEngine: id });
      return {
        state: 'succeeded',
        value: after,
        component: { component: 'search', state: 'succeeded', retryable: false },
      };
    } catch {
      await setDefaultSearchEngine(before.defaultSearchEngine).catch(() => undefined);
      return {
        state: 'partial',
        value: await readSearchEnginesSnapshot(),
        component: {
          component: 'search',
          state: 'failed',
          retryable: true,
          errorCode: 'live_effect_failed',
        },
      };
    }
  }
}
