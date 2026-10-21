import { useCurrentWindowId } from '../bridge/useToolsPort';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { getThemeScopeAttributes, useResolvedColorScheme } from './themeScope';
import type { ThemeScopeAttributes } from './themeScope';
import { useThemeSheet } from './themeSheets';

/**
 * Theme scope attributes for an element that shows the sidebar's theme in the opposite
 * colour scheme (the floating sidebar cards: a dark card on a light sidebar, a light card
 * on a dark one). Spread them on the element: its Mux semantic tokens then resolve in the
 * opposite scheme, and everything inside follows. The scheme tracks the document's
 * resolved mode, so it flips live, Auto included; the theme is the active workspace's,
 * which is what the document root shows.
 *
 * Only Mux semantic tokens (or a `--bento-*` colour declared on the scoped element
 * itself) follow the scope. A token declared on `:root` is resolved there and inherited
 * as that value, so it keeps the page's mode inside the scope.
 */
export function useInvertedThemeScope(): ThemeScopeAttributes {
  const windowId = useCurrentWindowId();
  const workspaceId = useActiveWorkspaceIdForWindow(windowId);
  const themeId = useWorkspacesStore((s) =>
    workspaceId ? s.byId[workspaceId]?.themeId : undefined,
  );
  const colorScheme = useResolvedColorScheme();
  // The scope renders the theme on its own, so its sheet must stay attached.
  useThemeSheet(themeId);
  return getThemeScopeAttributes(themeId, colorScheme === 'dark' ? 'light' : 'dark');
}
