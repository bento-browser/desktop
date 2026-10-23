// Settings palette stories, one per step of the chosen mock (plans/settings-palette/mocks/
// a-quickpick.html), plus the nav row's states: opened from the command palette, a deep path,
// and light mode. Each starts on its stage and edits a local copy of the fixture, so toggles,
// editors and stages work in the story. `useFakeSettingsPalette` stands in for the tools
// connection; nothing here touches the relay.

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

/** What Back to the command palette did, counted on <body> like the close requests. */
const onBackToPalette = () => {
  document.body.dataset.backToPaletteRequests = String(
    Number(document.body.dataset.backToPaletteRequests ?? 0) + 1,
  );
};

/** Shows the story in one colour mode whatever Ladle's own toggle says, and puts it back. */
function useForcedColorMode(mode: 'light' | 'dark' | null) {
  useEffect(() => {
    if (!mode) return;
    const root = document.documentElement;
    const names = ['data-color-mode', 'data-theme', 'data-muxui-color-scheme'];
    const before = names.map((name) => root.getAttribute(name));
    for (const name of names) root.setAttribute(name, mode);
    return () => {
      names.forEach((name, index) => {
        const value = before[index];
        if (value === null || value === undefined) root.removeAttribute(name);
        else root.setAttribute(name, value);
      });
    };
  }, [mode]);
}

/** Types `text` into the field once the stage has mounted, as a user would. */
function useTypedValue(text: string | null) {
  useEffect(() => {
    if (text === null) return;
    const input = document.querySelector<HTMLInputElement>('.bento-settings-palette__input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!input || !setValue) return;
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, [text]);
}

function Story({
  model = REGULAR_MODEL,
  stages,
  view,
  fromPalette = false,
  mode = null,
  typed = null,
}: {
  model?: SettingsPaletteModel;
  stages?: readonly Stage[];
  view?: ComponentProps<typeof SettingsPalette>['view'];
  /** Opened from the command palette: the path starts there and Back at the root returns. */
  fromPalette?: boolean;
  mode?: 'light' | 'dark' | null;
  /** A value typed into the field after the stage opens. */
  typed?: string | null;
}) {
  const fake = useFakeSettingsPalette(model);
  useForcedColorMode(mode);
  useTypedValue(typed);
  return (
    <SettingsPalette
      view={view ?? fake.view}
      actions={fake.actions}
      onClose={onClose}
      onBackToPalette={fromPalette ? onBackToPalette : undefined}
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

/** The input keeps one width: a long, out-of-range value scrolls inside it. */
export const NumberStageLongValue = () => (
  <Story
    stages={at({ kind: 'number', key: 'tabSleepKeepAlivePerWorkspace' })}
    typed="3321213123123123"
  />
);
NumberStageLongValue.storyName = 'Number (long invalid value, fixed width)';

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
    model={{
      ...REGULAR_MODEL,
      pending: new Set(['panelShadowsEnabled', 'tabSleepAfterMinutes']),
      pendingTargets: new Map([
        ['panelShadowsEnabled', !REGULAR_MODEL.settings.panelShadowsEnabled],
      ]),
    }}
  />
);
PendingWrite.storyName = 'Writes in flight';

/** Opened from a command palette result or its Open Settings command. */
export const FromCommandPalette = () => <Story fromPalette />;
FromCommandPalette.storyName = 'From command palette (root)';

export const FromCommandPaletteNumber = () => (
  <Story fromPalette stages={at({ kind: 'number', key: 'tabSleepKeepAlivePerWorkspace' })} />
);
FromCommandPaletteNumber.storyName = 'From command palette (number editor)';

/** Three levels down: every ancestor is a button, the current page is not. */
export const DeepPath = () => (
  <Story
    fromPalette
    stages={at(
      { kind: 'sizes' },
      { kind: 'sizeActions', index: 2 },
      { kind: 'sizeEdit', index: 2 },
    )}
  />
);
DeepPath.storyName = 'Deep path (from command palette, size editor)';

/** Choice stages open on the current option, not the first row. */
export const HttpsOnly = () => (
  <Story stages={at({ kind: 'advanced' }, { kind: 'enum', key: 'httpsOnlyMode' })} />
);
HttpsOnly.storyName = 'Choice opens on the current option (HTTPS-only)';

export const LightRoot = () => <Story mode="light" />;
LightRoot.storyName = 'Light mode (root)';

export const LightNumber = () => (
  <Story mode="light" stages={at({ kind: 'number', key: 'panelCornerRadiusPx' })} />
);
LightNumber.storyName = 'Light mode (number editor)';

export const LightDeepPath = () => (
  <Story
    mode="light"
    fromPalette
    stages={at({ kind: 'sizes' }, { kind: 'sizeActions', index: 2 })}
  />
);
LightDeepPath.storyName = 'Light mode (deep path)';

/** Page descriptions and option lines in light mode (the dark ones are the stories above). */
export const LightEnum = () => (
  <Story mode="light" stages={at({ kind: 'enum', key: 'sidebarShortcutBehavior' })} />
);
LightEnum.storyName = 'Light mode (choice with option lines)';

export const LightProtection = () => <Story mode="light" stages={at({ kind: 'protection' })} />;
LightProtection.storyName = 'Light mode (protection level)';

export const LightAdvanced = () => <Story mode="light" stages={at({ kind: 'advanced' })} />;
LightAdvanced.storyName = 'Light mode (advanced privacy)';

/** A choice with two-line options, opened from Advanced privacy. */
export const WebRtcChoice = () => (
  <Story stages={at({ kind: 'advanced' }, { kind: 'enum', key: 'webRTCIPHandlingPolicy' })} />
);
WebRtcChoice.storyName = 'Choice (WebRTC IP handling, long option lines)';

export const BackupRowActions = () => (
  <Story
    stages={at(
      { kind: 'backups' },
      { kind: 'backupRow', backupId: 'b2', label: '22 Oct 2026, 14:00' },
    )}
  />
);
BackupRowActions.storyName = 'A stored backup (actions with lines)';
