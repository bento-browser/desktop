// Drives `data-bento-theme` on the shell document's `<html>` from the
// active workspace's `themeId`. The theme presets at
// theme/presets/<id>.css are scoped by `[data-bento-theme="<id>"]`, so
// flipping the attribute swaps the entire palette atomically — no
// runtime CSS construction, no `<style>` element churn.
//
// Chrome receives the active workspace theme through the BENTO_PANELS
// payload. Do not write a separate BENTO_THEME title sentinel here: title
// IPC is last-write-wins, and a standalone theme write can overwrite the
// first panel sync before chrome polls it, dropping uiColorMode and leaving
// chrome in a mixed light/dark state.

import { useEffect } from 'react';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useCurrentWindowId } from '../bridge/useToolsPort';
import { DEFAULT_THEME_ID } from './presets';

export function useWorkspaceTheme(): void {
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const themeId = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.byId[activeWorkspaceId]?.themeId : undefined,
  );

  useEffect(() => {
    const resolved = themeId ?? DEFAULT_THEME_ID;
    document.documentElement.setAttribute('data-bento-theme', resolved);
  }, [themeId]);
}
