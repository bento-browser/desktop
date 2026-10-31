// Shows a workspace theme on the document's own <html> scope. Split from useWorkspaceTheme
// so the sequencing around the early sheet request (themeSheets.ts) can be tested without
// React or the tools port.

import { DEFAULT_THEME_ID, resolveThemeId } from './presets';
import { getThemeScopeAttributes, readDocumentColorScheme, type ThemeColorScheme } from './themeScope';
import {
  BOOT_THEME_OWNER,
  releaseThemeSheets,
  ROOT_THEME_OWNER,
  setThemeSheets,
  writeThemeHint,
} from './themeSheets';

/**
 * Apply `themeId` once its sheet has loaded (a failed sheet falls back to Default; a request
 * a newer one replaced does nothing).
 *
 * `workspaceKnown` is false until the active workspace has reached this document. Before that
 * `themeId` is only a placeholder, so the boot request keeps its sheet and the hint is left
 * alone. Once the workspace is known, the boot request is released (the root request has
 * already adopted its sheet if it is the same theme, otherwise it is pruned) and the applied
 * theme becomes the next launch's hint.
 */
export async function applyRootTheme(
  themeId: string | null | undefined,
  colorScheme: ThemeColorScheme,
  workspaceKnown: boolean,
): Promise<void> {
  const resolvedThemeId = resolveThemeId(themeId);
  const request = setThemeSheets(ROOT_THEME_OWNER, [resolvedThemeId]);
  if (workspaceKnown) releaseThemeSheets(BOOT_THEME_OWNER);

  const result = await request;
  if (result === 'superseded') return;

  const appliedThemeId = result === 'loaded' ? resolvedThemeId : DEFAULT_THEME_ID;
  const html = document.documentElement;
  // A sheet may finish after a native grant. Its old closure must never write
  // the earlier scheme back after the commit/submission acknowledgement.
  const currentScheme = html.hasAttribute('data-bento-mode-writer')
    ? readDocumentColorScheme() : colorScheme;
  for (const [name, value] of Object.entries(
    getThemeScopeAttributes(appliedThemeId, currentScheme),
  )) {
    html.setAttribute(name, value);
  }
  if (workspaceKnown) writeThemeHint(appliedThemeId);
}
