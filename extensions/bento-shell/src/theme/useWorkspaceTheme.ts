// Drives the resolved presentation scope on the shell document's `<html>`
// from the active workspace's raw `themeId`. The persisted id remains
// untouched while undefined, aliases, unknown, and deleted ids resolve to an
// explicit Default presentation. Mode mutations update the scope closure
// atomically.
//
// Default's rules ship in the shared stylesheet; any other theme is applied once its sheet
// (themeSheets.ts) has loaded, so the previous theme stays on screen until the new one can
// paint and a sheet that fails to load falls back to Default.
//
// Chrome receives the active workspace theme through the BENTO_PANELS
// payload. Do not write a separate BENTO_THEME title sentinel here: title
// IPC is last-write-wins, and a standalone theme write can overwrite the
// first panel sync before chrome polls it, dropping uiColorMode and leaving
// chrome in a mixed light/dark state.

import { useEffect } from 'react';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useCurrentWindowId } from '../bridge/useToolsPort';
import { DEFAULT_THEME_ID, resolveThemeId } from './presets';
import { getThemeScopeAttributes, useResolvedColorScheme } from './themeScope';
import { releaseThemeSheets, ROOT_THEME_OWNER, setThemeSheets } from './themeSheets';

export function useWorkspaceTheme(): void {
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const themeId = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.byId[activeWorkspaceId]?.themeId : undefined,
  );
  const colorScheme = useResolvedColorScheme();

  useEffect(() => {
    let current = true;
    const resolvedThemeId = resolveThemeId(themeId);
    void setThemeSheets(ROOT_THEME_OWNER, [resolvedThemeId]).then((loaded) => {
      if (!current) return;
      const html = document.documentElement;
      const attributes = getThemeScopeAttributes(
        loaded ? resolvedThemeId : DEFAULT_THEME_ID,
        colorScheme,
      );
      for (const [name, value] of Object.entries(attributes)) {
        html.setAttribute(name, value);
      }
    });
    return () => {
      current = false;
    };
  }, [colorScheme, themeId]);

  useEffect(() => () => releaseThemeSheets(ROOT_THEME_OWNER), []);
}
