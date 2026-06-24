// Cross-process bridge for the workspace-only command palette.
//
// The palette is hosted in its own chrome-mounted <browser>
// (workspace-palette.html) so it can cover the full browser window and stay
// separate from the regular app-wide command palette.
//
// No payload is needed: the palette reads the live workspace mirror store
// through the normal bento-shell bus. document.title is only the chrome
// visibility signal.

export const WORKSPACE_PALETTE_OPEN_PREFIX = 'BENTO_OPEN_WORKSPACE_PALETTE';
export const WORKSPACE_PALETTE_CLOSE_PREFIX = 'BENTO_CLOSE_WORKSPACE_PALETTE';

export function requestWorkspacePalette(): void {
  document.title = `${WORKSPACE_PALETTE_OPEN_PREFIX}_${Date.now()}`;
}
