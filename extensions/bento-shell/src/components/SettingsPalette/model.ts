// The slice of the Settings protocol the palette renders, re-exported so the component and
// the store name the same types.
export type {
  BackupContext,
  EditableSettings,
  ImportPreview,
  SettingsPrivacy,
  SettingsSearch,
} from '@shared/settings-client-protocol';
import type { SelectablePrivacyProtectionLevel } from '@shared/protocol';
export type SelectablePrivacyLevel = SelectablePrivacyProtectionLevel;
