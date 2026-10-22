// Settings palette stories, one per step of the chosen mock (plans/settings-palette/mocks/
// a-quickpick.html). Each starts on its stage and edits a local copy of the fixture, so
// toggles, editors and stages work in the story. `useFakeSettingsPalette` stands in for the
// tools connection; nothing here touches the relay.

import { useEffect, type ComponentProps } from 'react';
import {
  IMPORT_PREVIEW_MODEL,
  PRIVATE_MODEL,
  REGULAR_MODEL,
  useFakeSettingsPalette,
} from '../../state/__fixtures__/settingsPalette';
import type { SettingsPaletteModel } from './types';
import SettingsPalette from './SettingsPalette';
import type { Stage } from './stageStack';
import './SettingsPalette.stories.css';

/** The story has no host to hide it; a close request is counted on <body> for inspection. */
const onClose = () => {
  document.body.dataset.closeRequests = String(
    Number(document.body.dataset.closeRequests ?? 0) + 1,
  );
};

function Story({
  model = REGULAR_MODEL,
  stages,
  view,
}: {
  model?: SettingsPaletteModel;
  stages?: readonly Stage[];
  view?: ComponentProps<typeof SettingsPalette>['view'];
}) {
  const fake = useFakeSettingsPalette(model);
  return (
    <SettingsPalette
      view={view ?? fake.view}
      actions={fake.actions}
      onClose={onClose}
      initialStages={stages}
    />
  );
}

const at = (...stages: Stage[]) => [{ kind: 'root' } as const, ...stages];

/** Step 1: the root, grouped. */
export const Root = () => <Story />;
Root.storyName = '1 Root';

/** Step 2: a number stage with presets. */
export const NumberStage = () => (
  <Story stages={at({ kind: 'number', key: 'panelCornerRadiusPx' })} />
);
NumberStage.storyName = '2 Number (panel corner radius)';

/** Step 3: protection level with the focused level's benefits and caveats. */
export const ProtectionLevel = () => <Story stages={at({ kind: 'protection' })} />;
ProtectionLevel.storyName = '3 Protection level';

/** Step 3 in a short window: the longest level (Standard, 312 px of rows) does not fit, so
 * the list scrolls and its rows keep their height instead of drawing over each other. */
export const ProtectionLevelShortWindow = () => {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-settings-story-short-window', '');
    return () => root.removeAttribute('data-settings-story-short-window');
  }, []);
  return <Story stages={at({ kind: 'protection' })} />;
};
ProtectionLevelShortWindow.storyName = '3 Protection level (short window)';

/** Step 3b: search engines with a link to Firefox's search settings. */
export const SearchEngine = () => <Story stages={at({ kind: 'search' })} />;
SearchEngine.storyName = '3b Default search engine';

/** Step 4: the custom panel sizes. */
export const CustomSizes = () => <Story stages={at({ kind: 'sizes' })} />;
CustomSizes.storyName = '4 Custom panel sizes';

/** Step 4b: actions of one size. */
export const SizeActions = () => (
  <Story stages={at({ kind: 'sizes' }, { kind: 'sizeActions', index: 2 })} />
);
SizeActions.storyName = '4b Size actions';

/** Step 5: backups with an import waiting for confirmation. */
export const BackupsImportPreview = () => (
  <Story model={IMPORT_PREVIEW_MODEL} stages={at({ kind: 'backups' })} />
);
BackupsImportPreview.storyName = '5 Backups (import preview)';

export const BackupsStored = () => <Story stages={at({ kind: 'backups' })} />;
BackupsStored.storyName = '5 Backups (stored)';

export const RestoreConfirmation = () => (
  <Story
    stages={at(
      { kind: 'backups' },
      { kind: 'backupRow', backupId: 'b2', label: '22 Oct 2026, 14:00' },
      {
        kind: 'confirm',
        action: { kind: 'restore', backupId: 'b2', label: '22 Oct 2026, 14:00' },
      },
    )}
  />
);
RestoreConfirmation.storyName = '5 Restore confirmation';

/** Step 6: advanced privacy. */
export const AdvancedPrivacy = () => <Story stages={at({ kind: 'advanced' })} />;
AdvancedPrivacy.storyName = '6 Advanced privacy';

/** Step 7: a private window: no backup rows, one footer line. */
export const PrivateWindow = () => <Story model={PRIVATE_MODEL} />;
PrivateWindow.storyName = '7 Private window';

/** Step 8: the reset confirmation. */
export const ResetConfirmation = () => (
  <Story stages={at({ kind: 'confirm', action: { kind: 'reset' } })} />
);
ResetConfirmation.storyName = '8 Reset confirmation';

export const EnumStage = () => <Story stages={at({ kind: 'enum', key: 'uiColorMode' })} />;
EnumStage.storyName = 'Choice (color mode)';

export const TextStage = () => <Story stages={at({ kind: 'text', key: 'defaultWorkspaceName' })} />;
TextStage.storyName = 'Name (default workspace)';

export const SizeEdit = () => (
  <Story
    stages={at(
      { kind: 'sizes' },
      { kind: 'sizeActions', index: 2 },
      { kind: 'sizeEdit', index: 2 },
    )}
  />
);
SizeEdit.storyName = 'Edit one panel size';

export const Shortcuts = () => <Story stages={at({ kind: 'shortcuts' })} />;
Shortcuts.storyName = 'Keyboard shortcuts';

export const Loading = () => <Story view={{ kind: 'loading' }} />;
export const LoadFailed = () => (
  <Story view={{ kind: 'error', message: 'Bento did not answer in time. Try again.' }} />
);
LoadFailed.storyName = 'Load failed';

export const FailedWrite = () => (
  <Story
    model={{
      ...REGULAR_MODEL,
      notice: 'Bento is busy with another change. Try again in a moment.',
    }}
  />
);
FailedWrite.storyName = 'Failed write notice';

export const PendingWrite = () => (
  <Story
    model={{ ...REGULAR_MODEL, pending: new Set(['panelShadowsEnabled', 'tabSleepAfterMinutes']) }}
  />
);
PendingWrite.storyName = 'Writes in flight';
