import type { SelectablePrivacyProtectionLevel } from '@shared/protocol';
import type { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import type { SettingsStore } from '../settings/SettingsStore';
import { applyPrivacyLevel } from './ProtectionLevels';

type BootSettings = Pick<SettingsStore, 'hasOverride' | 'snapshot'>;

/**
 * The level tools applies at boot for a profile with no stored choice, or null for none.
 *
 * SettingsStore keeps only deltas from its defaults, so a profile that never chose a level has no
 * `privacyProtectionLevel` override and its snapshot value is the Bento default (standard).
 * That default never reaches Firefox by itself: Firefox's own prefs are not Standard (tracking
 * protection only in private windows, Discovery Stream on, letterboxing unset). Until onboarding
 * finishes the default is therefore applied explicitly. A stored choice is applied by the boot
 * apply of the override, and a profile that finished onboarding is left as it is (a level is not
 * re-applied on every boot).
 */
export function bootPrivacyLevel(settings: BootSettings): SelectablePrivacyProtectionLevel | null {
  if (settings.hasOverride('privacyProtectionLevel')) return null;
  const { privacyProtectionLevel, welcomeSeen } = settings.snapshot();
  return welcomeSeen ? null : privacyProtectionLevel;
}

/**
 * Seeds the boot default through the same lane a pick in onboarding uses, so the pick queues
 * behind the seed and is applied last, and the choice is read again when the lane reaches it, so
 * a pick that was already stored wins. Never rejects: a failed seed leaves Firefox's own prefs.
 */
export async function seedBootPrivacyLevel(
  settings: BootSettings,
  coordinator: Pick<BentoMutationCoordinator, 'runExclusive'>,
): Promise<void> {
  try {
    await coordinator.runExclusive('privacy', async () => {
      const level = bootPrivacyLevel(settings);
      if (level === null) return;
      console.info(`[bento-tools] onboarding unfinished, seeding protection level: ${level}`);
      await applyPrivacyLevel(level);
    });
  } catch (err) {
    console.warn('[bento-tools] boot protection level seed failed:', err);
  }
}
