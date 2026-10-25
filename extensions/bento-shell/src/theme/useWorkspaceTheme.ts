// Drives the resolved presentation scope on the shell document's `<html>`
// from the active workspace's raw `themeId`. The persisted id remains
// untouched while undefined, aliases, unknown, and deleted ids resolve to an
// explicit Default presentation. Mode mutations update the scope closure
// atomically.
//
// Default's rules ship in the shared stylesheet; any other theme is applied once its sheet
// (themeSheets.ts) has loaded, so the previous theme stays on screen until the new one can
// paint and a sheet that fails to load falls back to Default. The applied theme is mirrored
// to localStorage so the next document's boot.js can request its sheet before React mounts
// (applyRootTheme.ts).
//
// Chrome receives the active workspace theme through the BENTO_PANELS
// payload. Do not write a separate BENTO_THEME title sentinel here: title
// IPC is last-write-wins, and a standalone theme write can overwrite the
// first panel sync before chrome polls it, dropping uiColorMode and leaving
// chrome in a mixed light/dark state.

import { useEffect } from 'react';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useCurrentWindowId } from '../bridge/useToolsPort';
import { applyRootTheme } from './applyRootTheme';
import { readDocumentColorScheme, subscribeColorScheme } from './themeScope';
import { releaseThemeSheets, ROOT_THEME_OWNER } from './themeSheets';

export function useWorkspaceTheme(): void {
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const themeId = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.byId[activeWorkspaceId]?.themeId : undefined,
  );
  // False until the workspace snapshot reaches this document: `themeId` is then a placeholder.
  const workspaceKnown = useWorkspacesStore(
    (s) => activeWorkspaceId !== null && activeWorkspaceId in s.byId,
  );

  // The scheme is read from the document and followed by subscription, not held in state: this
  // hook sits at the root of every document, and a root that re-renders on every flip
  // re-renders its whole tree (the sidebar's tab rows) in the middle of the fade's first frame.
  useEffect(() => {
    const apply = () => void applyRootTheme(themeId, readDocumentColorScheme(), workspaceKnown);
    apply();
    return subscribeColorScheme(apply);
  }, [themeId, workspaceKnown]);

  useEffect(() => () => releaseThemeSheets(ROOT_THEME_OWNER), []);
}
