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

import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '@tale-ui/react/dialog';
import { Button } from '@tale-ui/react/button';
import { TextField } from '@tale-ui/react/text-field';
import { Text } from '@tale-ui/react/text';
import { Column } from '@tale-ui/react/column';
import { ColorSwatchPicker } from '@tale-ui/react/color-swatch-picker';
import { ColorSwatch } from '@tale-ui/react/color-swatch';

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
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import {
  EDIT_WORKSPACE_CLOSE_PREFIX,
  subscribeToEditWorkspaceRequests,
  type EditWorkspacePayload,
} from '../bridge/useEditWorkspace';
import './edit-workspace.css';

initToolsPort();

// Order MUST match the [data-workspace-color='X'] blocks in bento-tokens.css.
const WORKSPACE_COLORS = [
  'blue',
  'emerald',
  'amber',
  'red',
  'violet',
  'pink',
  'cyan',
  'neutral',
] as const;
type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

// Resolve each workspace-color name to its actual rendered hex by probing
// the DOM with a hidden element carrying the data-workspace-color attribute
// and reading the resulting --bento-workspace-accent. Done at runtime so
// any change to bento-tokens.css OR the underlying Tale UI primitives flows
// through without a hardcoded color map drifting out of sync.
function resolveWorkspaceColors(): Record<WorkspaceColor, string> {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;pointer-events:none';
  document.body.appendChild(probe);
  const out = {} as Record<WorkspaceColor, string>;
  for (const name of WORKSPACE_COLORS) {
    probe.setAttribute('data-workspace-color', name);
    const accent = getComputedStyle(probe).getPropertyValue('--bento-workspace-accent').trim();
    out[name] = accent || '#888';
  }
  probe.remove();
  return out;
}

// Normalize any color value (CSS string from probed tokens OR a Color
// object from react-aria's onChange) to a single comparable key. We
// route everything through a hidden probe div so '#abc', '#aabbcc',
// 'rgb(...)', 'hsl(...)' all collapse to the same canonical
// 'rgb(R, G, B)' the browser computes — equality between the picker's
// emitted Color and our color-map values then always matches regardless
// of the notation each side happens to use.
interface ToCSSable {
  toString(format?: string): string;
}
function colorKey(color: string | ToCSSable): string {
  const css = typeof color === 'string' ? color : color.toString('css');
  const probe = document.createElement('div');
  probe.style.color = css;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed.toUpperCase();
}

function EditWorkspaceApp() {
  useFirefoxTheme();
  const [payload, setPayload] = useState<EditWorkspacePayload | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState<WorkspaceColor | undefined>(undefined);
  const [draftIcon, setDraftIcon] = useState('');

  // Resolve workspace color names → hex once. Tale UI tokens are loaded
  // synchronously via @tale-ui/core import above, so the values are
  // available by the time React first renders. Keeping this stable across
  // renders avoids re-probing on every Save click.
  const colorMap = useMemo(() => resolveWorkspaceColors(), []);
  // Reverse lookup: normalized color key → workspace color name. Built
  // once with the same colorKey normalization the picker's onChange uses,
  // so equality always matches even when ColorSwatchPicker re-emits a
  // color in a different CSS notation than the one we fed in.
  const nameByKey = useMemo(() => {
    const out: Record<string, WorkspaceColor> = {};
    for (const name of WORKSPACE_COLORS) {
      out[colorKey(colorMap[name])] = name;
    }
    return out;
  }, [colorMap]);

  useEffect(() => {
    return subscribeToEditWorkspaceRequests((next) => {
      // Reset form to the snapshot every time a new request arrives so
      // reopening the dialog after a cancel shows the live workspace
      // values, not the abandoned draft.
      setPayload(next);
      setDraftName(next.name);
      setDraftColor(
        next.color && (WORKSPACE_COLORS as readonly string[]).includes(next.color)
          ? (next.color as WorkspaceColor)
          : undefined,
      );
      setDraftIcon(next.icon ?? '');
    });
  }, []);

  // ColorSwatchPicker controlled-mode requires Color objects (and Tale UI's
  // `parseColor` helper isn't in the consumed build of @tale-ui/react —
  // only in source). Sidestep by using uncontrolled mode + a `key` prop
  // tied to the workspace id and current draftColor, so reopening or
  // changing the swatch via React state forces a remount with the new
  // defaultValue. onChange still fires for user clicks; we map the picked
  // Color object back to a workspace name via colorKey + nameByKey.
  const pickerKey = `${payload?.workspaceId ?? 'none'}:${draftColor ?? 'none'}`;
  const pickerDefault = colorMap[draftColor ?? WORKSPACE_COLORS[0]] || '#888888';

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
        color: draftColor,
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
            Rename, recolor, or set a one-character icon for this workspace.
          </Dialog.Description>
          <Column gap="m" className="bento-edit-workspace__form">
            <TextField.Root value={draftName} onChange={setDraftName}>
              <TextField.Label>Name</TextField.Label>
              <TextField.Input autoFocus />
            </TextField.Root>
            <Column gap="2xs">
              <Text variant="label" size="s">
                Color
              </Text>
              <ColorSwatchPicker.Root
                key={pickerKey}
                defaultValue={pickerDefault}
                onChange={(color) => {
                  const name = nameByKey[colorKey(color)];
                  if (name) setDraftColor(name);
                }}
                aria-label="Workspace color"
                className="bento-edit-workspace__picker"
              >
                {WORKSPACE_COLORS.map((name) => (
                  <ColorSwatchPicker.Item key={name} color={colorMap[name]} aria-label={name}>
                    <ColorSwatch />
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
