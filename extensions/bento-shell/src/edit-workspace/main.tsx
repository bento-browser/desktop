// Edit-workspace overlay entry. Mirrors src/confirm/main.tsx — its own
// Vite chunk + chrome <browser> frame so the form modal covers the entire
// browser window rather than being clipped to the sidebar.
//
// Lifecycle:
//   - Sidebar calls requestEditWorkspace({...}) when user clicks Edit.
//   - That helper (a) broadcasts the workspace snapshot on the
//     'bento-edit-workspace-bus' BroadcastChannel and (b) sets
//     document.title = BENTO_OPEN_EDIT_WORKSPACE_<ts>, which chrome's
//     bento-shell-mount.js poll picks up and reveals this overlay.
//   - This page's BroadcastChannel listener stores the payload in state;
//     the form re-renders with the live values.
//   - Cancel: set document.title = BENTO_CLOSE_EDIT_WORKSPACE_<ts>.
//   - Save: dispatch workspace/update through the existing tools port,
//     then close.
// Dialog stays mounted with isOpen=true permanently — visibility is
// purely a chrome concern via the host overlay (same pattern as palette
// and confirm).

import { StrictMode, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '@tale-ui/react/dialog';
import { Button } from '@tale-ui/react/button';
import { TextField } from '@tale-ui/react/text-field';
import { Text } from '@tale-ui/react/text';
import { Column } from '@tale-ui/react/column';
import { ColorSwatchPicker } from '@tale-ui/react/color-swatch-picker';
import { ColorSwatch } from '@tale-ui/react/color-swatch';
// Type-only — react-aria's ColorSwatchPicker accepts `string | Color` for
// `value`/`defaultValue` and emits `Color` from `onChange`. We pass plain
// brand-60 hex strings in (no parseColor needed) and call `.toString('hex')`
// on the emitted Color to look up the matching theme. Keeping this as a
// type-only import avoids pulling the (~30 KB gz) parseColor + Color
// implementation into the bundle.
import type { Color } from 'react-aria-components';

import '@tale-ui/core';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/dialog';
import '@tale-ui/react-styles/text-field';
import '@tale-ui/react-styles/color-swatch-picker';
import '@tale-ui/react-styles/color-swatch';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import {
  EDIT_WORKSPACE_CLOSE_PREFIX,
  subscribeToEditWorkspaceRequests,
  type EditWorkspacePayload,
} from '../bridge/useEditWorkspace';
import { BENTO_THEMES, DEFAULT_THEME_ID, getThemeMeta } from '../theme/presets';
import './edit-workspace.css';

initToolsPort();

function EditWorkspaceApp() {
  useFirefoxTheme();
  useWorkspaceTheme();
  const [payload, setPayload] = useState<EditWorkspacePayload | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftThemeId, setDraftThemeId] = useState<string>(DEFAULT_THEME_ID);
  const [draftIcon, setDraftIcon] = useState('');

  useEffect(() => {
    return subscribeToEditWorkspaceRequests((next) => {
      // Reset form to the snapshot every time a new request arrives so
      // reopening the dialog after a cancel shows the live workspace
      // values, not the abandoned draft.
      setPayload(next);
      setDraftName(next.name);
      setDraftThemeId(next.themeId ?? DEFAULT_THEME_ID);
      setDraftIcon(next.icon ?? '');
    });
  }, []);

  // Reverse lookup: normalized brand-60 hex → themeId. Built once from
  // BENTO_THEMES so onChange can resolve the picker's emitted Color
  // back to a stable theme id without depending on object identity.
  const themeIdByBrandHex = useMemo(() => {
    const out: Record<string, string> = {};
    for (const theme of BENTO_THEMES) out[theme.brand60.toLowerCase()] = theme.id;
    return out;
  }, []);

  // Picker value tracks the workspace's current theme. react-aria's
  // ColorSwatchPicker.Root accepts `string | Color` for value, so we
  // pass the brand-60 hex straight in — no parseColor needed.
  const pickerValue = getThemeMeta(draftThemeId).brand60;

  function onPickerChange(color: Color) {
    const hex = color.toString('hex').toLowerCase();
    const matchedId = themeIdByBrandHex[hex];
    if (matchedId) setDraftThemeId(matchedId);
  }

  function close() {
    document.title = `${EDIT_WORKSPACE_CLOSE_PREFIX}_${Date.now()}`;
  }

  function onSave() {
    if (!payload) {
      close();
      return;
    }
    const trimmedName = draftName.trim();
    const trimmedIcon = draftIcon.trim();
    dispatch({
      type: 'workspace/update',
      id: payload.workspaceId,
      changes: {
        // Empty name falls back to the snapshot — workspaces with empty
        // names render as "?" and become hard to identify.
        name: trimmedName || payload.name,
        themeId: draftThemeId,
        icon: trimmedIcon || undefined,
      },
    });
    close();
  }

  return (
    <Dialog.Root
      isOpen={true}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Backdrop isDismissable>
        <Dialog.Popup>
          <Dialog.Title>Edit workspace</Dialog.Title>
          <Dialog.Description>
            Rename, pick a theme, or set a one-character icon for this workspace.
          </Dialog.Description>
          <Column gap="m" className="bento-edit-workspace__form">
            <TextField.Root value={draftName} onChange={setDraftName}>
              <TextField.Label>Name</TextField.Label>
              <TextField.Input autoFocus />
            </TextField.Root>
            <Column gap="2xs">
              <Text variant="label" size="s">
                Theme
              </Text>
              <ColorSwatchPicker.Root
                value={pickerValue}
                onChange={onPickerChange}
                aria-label="Workspace theme"
                className="bento-edit-workspace__theme-picker tale-color-swatch-picker--circle"
              >
                {BENTO_THEMES.map((theme) => (
                  <ColorSwatchPicker.Item
                    key={theme.id}
                    color={theme.brand60}
                    aria-label={theme.name}
                  >
                    <ColorSwatch
                      className="tale-color-swatch--split"
                      style={
                        {
                          '--tale-color-swatch-secondary': theme.neutral20,
                        } as CSSProperties
                      }
                    />
                  </ColorSwatchPicker.Item>
                ))}
              </ColorSwatchPicker.Root>
            </Column>
            <TextField.Root value={draftIcon} onChange={setDraftIcon}>
              <TextField.Label>Icon</TextField.Label>
              <TextField.Input placeholder="Single character or emoji (optional)" maxLength={2} />
              <TextField.Description>
                Shown in the workspace avatar. Leave blank to use the first letter of the name.
              </TextField.Description>
            </TextField.Root>
          </Column>
          <Dialog.Actions>
            <Button variant="neutral" onPress={close}>
              Cancel
            </Button>
            <Button variant="primary" onPress={onSave}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell edit-workspace: #root not found');

createRoot(container).render(
  <StrictMode>
    <EditWorkspaceApp />
  </StrictMode>,
);
