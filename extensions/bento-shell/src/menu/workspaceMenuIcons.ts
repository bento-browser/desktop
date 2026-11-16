// Workspace icons for the native sidebar menu's "Move to workspace" and "Move folder to
// workspace" rows: 32x32 PNG data URLs, drawn at 16x16 by macOS (2x for Retina). The
// emoji, or the initial in the workspace's avatar colour, fills the icon with no disc.
// Colour and font come from a hidden copy of the switcher's Avatar markup in that
// workspace's theme scope, so each icon matches the switcher in the current mode.

import { useEffect, useRef } from 'react';
import type { Workspace } from '@shared/protocol';
import { DEFAULT_THEME_ID } from '../theme/presets';
import { getThemeScopeAttributes, useResolvedColorScheme } from '../theme/themeScope';
import { releaseThemeSheets, setThemeSheets } from '../theme/themeSheets';
import { useWorkspacesStore } from '../state/workspaces';

/** What an icon shows; the workspace store replaces byId on every workspace update. */
function iconKey(byId: Readonly<Record<string, Workspace>>): string {
  return JSON.stringify(Object.values(byId).map((w) => [w.id, w.name, w.icon, w.themeId]));
}

const SIZE = 32;
const OWNER = 'workspace-menu-icons';
const INK_CANVAS = 200;

function drawAvatar(workspace: Workspace, colorScheme: string): string | null {
  const icon = workspace.icon?.trim();
  const text = icon || workspace.name.trim().charAt(0).toUpperCase() || '?';

  // Same classes and attributes as the switcher's Avatar.Root (WorkspaceSwitcher.css).
  const probe = document.createElement('span');
  probe.className = 'muxui-avatar muxui-avatar--sm bento-workspace-switcher__avatar';
  for (const [name, value] of Object.entries(
    getThemeScopeAttributes(workspace.themeId ?? DEFAULT_THEME_ID, colorScheme),
  )) {
    probe.setAttribute(name, value);
  }
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  // The avatar's fill colour; emoji ignore it.
  const colour = style.backgroundColor;
  // Read before remove(): a detached element's computed style is empty.
  const { fontWeight, fontFamily } = style;
  const fontFor = (px: number) => `${fontWeight} ${px}px ${fontFamily}`;
  probe.remove();

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Size and centre by the drawn pixels: font metrics miss emoji padding and
  // side bearings. Draw once at 100px, find the ink box, then redraw scaled so
  // its larger side fills the icon.
  const ink = inkBox(text, fontFor(100));
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (!ink) {
    ctx.font = fontFor(SIZE / 2);
    ctx.fillText(text, SIZE / 2, SIZE / 2);
    return canvas.toDataURL('image/png');
  }
  const scale = SIZE / Math.max(ink.width, ink.height);
  ctx.font = fontFor(100 * scale);
  ctx.fillText(text, SIZE / 2 - ink.dx * scale, SIZE / 2 - ink.dy * scale);
  return canvas.toDataURL('image/png');
}

/** Ink box of text drawn centred at 100px: size, and its centre's offset from the anchor. */
function inkBox(text: string, font: string) {
  const side = INK_CANVAS;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, side / 2, side / 2);
  const alpha = ctx.getImageData(0, 0, side, side).data;
  let minX = side,
    minY = side,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if ((alpha[(y * side + x) * 4 + 3] ?? 0) < 32) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  return {
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    dx: (minX + maxX + 1) / 2 - side / 2,
    dy: (minY + maxY + 1) / 2 - side / 2,
  };
}

/**
 * Workspace id to icon data URL, redrawn when workspaces or the colour mode change. A ref,
 * not state: the menu reads it when it opens, and a redraw has nothing to re-render. A
 * workspace has no entry until its first draw finishes, and its row then has no icon.
 */
export function useWorkspaceMenuIcons(): { readonly current: Readonly<Record<string, string>> } {
  const icons = useRef<Record<string, string>>({});
  const key = useWorkspacesStore((s) => iconKey(s.byId));
  const colorScheme = useResolvedColorScheme();

  useEffect(() => {
    let cancelled = false;
    const workspaces = Object.values(useWorkspacesStore.getState().byId);
    void (async () => {
      // A theme other than the document's own paints only once its sheet has loaded, and
      // the probes read computed style, so this waits for the sheets (setThemeSheets)
      // instead of registering them for the render (useThemeSheets).
      const result = await setThemeSheets(
        OWNER,
        workspaces.map((w) => w.themeId),
      );
      if (cancelled || result === 'superseded') return;
      await document.fonts.ready;
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const workspace of workspaces) {
        const url = drawAvatar(workspace, colorScheme);
        if (url) next[workspace.id] = url;
      }
      icons.current = next;
      releaseThemeSheets(OWNER);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, colorScheme]);

  return icons;
}
