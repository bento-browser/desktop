import type { SelectablePrivacyProtectionLevel } from '@shared/protocol';
import type { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import type { SettingsStore } from '../settings/SettingsStore';
import { applyPrivacyLevel } from './ProtectionLevels';

type BootSettings = Pick<SettingsStore, 'hasOverride' | 'snapshot'>;

/**
 * The level tools applies on a profile's first launch, or null for none.
 *
 * SettingsStore keeps only deltas from its defaults, so a profile that never chose a level has no
 * `privacyProtectionLevel` override and its snapshot value is the Bento default (standard).
 * That default never reaches Firefox by itself: Firefox's own prefs are not Standard (tracking
 * protection only in private windows, Discovery Stream on, letterboxing unset). It is therefore
 * applied once, on the launch where `WorkspaceStore` found nothing persisted (`firstLaunch`).
 * That launch persists a workspace, so no later launch seeds again and nothing needs a flag.
 * A stored choice is applied by the boot apply of the override instead.
 */
export function bootPrivacyLevel(
  settings: BootSettings,
  firstLaunch: boolean,
): SelectablePrivacyProtectionLevel | null {
  if (!firstLaunch || settings.hasOverride('privacyProtectionLevel')) return null;
  return settings.snapshot().privacyProtectionLevel;
}

/**
 * Seeds the first-launch default through the same lane a pick in onboarding uses, so the pick
 * queues behind the seed and is applied last, and the choice is read again when the lane reaches
 * it, so a pick that was already stored is never overwritten. Never rejects: a failed seed leaves
 * Firefox's own prefs.
 */
export async function seedBootPrivacyLevel(
  settings: BootSettings,
  firstLaunch: boolean,
  coordinator: Pick<BentoMutationCoordinator, 'runExclusive'>,
): Promise<void> {
  try {
    await coordinator.runExclusive('privacy', async () => {
      const level = bootPrivacyLevel(settings, firstLaunch);
      if (level === null) return;
      console.info(`[bento-tools] first launch, seeding protection level: ${level}`);
      await applyPrivacyLevel(level);
    });
  } catch (err) {
    console.warn('[bento-tools] boot protection level seed failed:', err);
  }
}
