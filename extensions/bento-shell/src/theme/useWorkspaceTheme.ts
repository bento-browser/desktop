// Drives the resolved presentation scope on the shell document's `<html>`
// from the active workspace's raw `themeId`. The persisted id remains
// untouched while undefined, aliases, unknown, and deleted ids resolve to an
// explicit Default presentation. Mode mutations update the scope closure
// atomically.
//
// Chrome receives the active workspace theme through the BENTO_PANELS
// payload. Do not write a separate BENTO_THEME title sentinel here: title
// IPC is last-write-wins, and a standalone theme write can overwrite the
// first panel sync before chrome polls it, dropping uiColorMode and leaving
// chrome in a mixed light/dark state.

import { useEffect } from 'react';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useCurrentWindowId } from '../bridge/useToolsPort';
import { getThemeScopeAttributes, useResolvedColorScheme } from './themeScope';

export function useWorkspaceTheme(): void {
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const themeId = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.byId[activeWorkspaceId]?.themeId : undefined,
  );
  const colorScheme = useResolvedColorScheme();

  useEffect(() => {
    const html = document.documentElement;
    const attributes = getThemeScopeAttributes(themeId, colorScheme);
    for (const [name, value] of Object.entries(attributes)) {
      html.setAttribute(name, value);
    }
  }, [colorScheme, themeId]);
}
