import type { SearchEngineId } from '@shared/protocol';
import type { SettingsStore } from '../settings/SettingsStore';
import { setDefaultSearchEngine } from './ProtectionLevels';

type BootSettings = Pick<SettingsStore, 'hasOverride' | 'snapshot'>;

/**
 * The engine tools asks Firefox to use at boot, or null to leave Firefox's own default.
 *
 * SettingsStore keeps only deltas from its defaults, so a profile that never chose an engine
 * has no `defaultSearchEngine` override and its snapshot value is the Bento default (ddg).
 * That default never reaches Firefox by itself, whose own default is Google. Until onboarding
 * finishes, the Bento default is therefore applied explicitly. Afterwards Firefox's saved
 * default stands, including Google on a profile that kept it through onboarding.
 */
export function bootDefaultSearchEngine(settings: BootSettings): SearchEngineId | null {
  const { defaultSearchEngine, welcomeSeen } = settings.snapshot();
  if (settings.hasOverride('defaultSearchEngine')) return defaultSearchEngine;
  return welcomeSeen ? null : defaultSearchEngine;
}

/**
 * Applies the boot default once the search service is ready. Never throws: when the engine is
 * missing (for example not offered in the user's region) Firefox keeps its own default.
 *
 * A pick made later in the session cannot be overwritten: this call is issued at boot, before
 * the shell can connect, and both calls wait on the same search-service initialisation in
 * order, so the pick is applied last.
 */
export async function applyBootDefaultSearchEngine(settings: BootSettings): Promise<void> {
  const id = bootDefaultSearchEngine(settings);
  if (id === null) return;
  if (!settings.hasOverride('defaultSearchEngine')) {
    console.info(`[bento-tools] onboarding unfinished, seeding default search engine: ${id}`);
  }
  try {
    await setDefaultSearchEngine(id);
  } catch (err) {
    console.warn(`[bento-tools] boot default search '${id}' not applied; keeping Firefox's:`, err);
  }
}
