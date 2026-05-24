// Drives `data-bento-theme` on the shell document's `<html>` from the
// active workspace's `themeId`. The theme presets at
// theme/presets/<id>.css are scoped by `[data-bento-theme="<id>"]`, so
// flipping the attribute swaps the entire palette atomically — no
// runtime CSS construction, no `<style>` element churn.
//
// Sidebar entry (App.tsx) opts into chrome push by passing
// `pushChrome: true`; that translates each themeId change into a
// `BENTO_THEME:<ts>:<id>` title-IPC sentinel that the chrome script
// (bento-shell-mount.js) picks up via DOMTitleChanged and mirrors onto
// the chrome window's documentElement. Secondary entries (palette,
// edit-workspace, etc.) leave pushChrome off — they share
// document.title for their own sentinels and must not stomp the theme
// signal. Their `<html>` still themes locally so dialogs render
// against the same palette as the sidebar.

import { useEffect } from 'react';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useCurrentWindowId } from '../bridge/useToolsPort';
import { DEFAULT_THEME_ID } from './presets';
import { pushChromeTheme } from './themeBridge';

interface UseWorkspaceThemeOptions {
  /** Whether to push the resolved themeId to chrome via title-IPC.
   * Only the sidebar entry should pass true — every other shell
   * entry shares document.title for its own sentinels. */
  pushChrome?: boolean;
}

export function useWorkspaceTheme(options: UseWorkspaceThemeOptions = {}): void {
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const workspaceExists = useWorkspacesStore((s) =>
    activeWorkspaceId ? Boolean(s.byId[activeWorkspaceId]) : false,
  );
  const themeId = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.byId[activeWorkspaceId]?.themeId : undefined,
  );
  const pushChrome = options.pushChrome ?? false;

  useEffect(() => {
    const resolved = themeId ?? DEFAULT_THEME_ID;
    document.documentElement.setAttribute('data-bento-theme', resolved);
    const shouldPushChromeTheme =
      pushChrome && (activeWorkspaceId === null ? windowId === null : workspaceExists);
    if (shouldPushChromeTheme) pushChromeTheme(resolved);
  }, [activeWorkspaceId, themeId, pushChrome, windowId, workspaceExists]);
}
