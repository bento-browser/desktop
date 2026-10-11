// Workspace theme sheets. The shared stylesheet carries the Default theme; every other
// theme is its own sheet (public/themes/<id>.css, written by scripts/sync-theme-presets.mjs)
// that a document attaches only while it shows that theme. Plain <link> elements keep the
// extension CSP contract: no inline style or script.
//
// Owners name the themes they need. 'root' is the document's own <html> scope
// (useWorkspaceTheme); useThemeSheets owners cover nested scopes such as workspace avatars
// and the theme picker. A sheet stays attached while any owner needs it, and an owner's old
// sheet is removed only after its new one has loaded, so a switch never shows an unthemed
// frame.

import { useEffect, useId } from 'react';
import { BENTO_THEMES, DEFAULT_THEME_ID, resolveThemeId } from './presets';

export const ROOT_THEME_OWNER = 'root';

/** Every registered theme, for documents that preview them all (the theme picker). */
export const ALL_THEME_IDS: readonly string[] = BENTO_THEMES.map((theme) => theme.id);

interface AttachedSheet {
  link: HTMLLinkElement;
  loaded: Promise<boolean>;
}

const wanted = new Map<string, ReadonlySet<string>>();
const attached = new Map<string, AttachedSheet>();

function detach(themeId: string, link: HTMLLinkElement): void {
  link.remove();
  if (attached.get(themeId)?.link === link) attached.delete(themeId);
}

function attach(themeId: string): Promise<boolean> {
  const existing = attached.get(themeId);
  if (existing) return existing.loaded;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.dataset.bentoThemeSheet = themeId;
  const loaded = new Promise<boolean>((resolve) => {
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener(
      'error',
      () => {
        detach(themeId, link);
        resolve(false);
      },
      { once: true },
    );
  });
  link.href = `./themes/${themeId}.css`;
  document.head.append(link);
  attached.set(themeId, { link, loaded });
  return loaded;
}

function prune(): void {
  const needed = new Set<string>();
  for (const ids of wanted.values()) for (const id of ids) needed.add(id);
  for (const [themeId, { link }] of [...attached]) {
    if (!needed.has(themeId)) detach(themeId, link);
  }
}

/** Ids with a sheet to load: resolved through aliases, with Default (inline) left out. */
function sheetIds(themeIds: Iterable<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const themeId of themeIds) {
    const resolved = resolveThemeId(themeId);
    if (resolved !== DEFAULT_THEME_ID) ids.add(resolved);
  }
  return [...ids].sort();
}

/**
 * Make `owner`'s themes the sheets it needs. Resolves once they have loaded: true when all
 * did, false when any failed to load (callers fall back to Default).
 */
export async function setThemeSheets(
  owner: string,
  themeIds: Iterable<string | null | undefined>,
): Promise<boolean> {
  const ids = sheetIds(themeIds);
  wanted.set(owner, new Set(ids));
  const results = await Promise.all(ids.map(attach));
  prune();
  return results.every(Boolean);
}

export function releaseThemeSheets(owner: string): void {
  wanted.delete(owner);
  prune();
}

/**
 * Keep the sheets for nested theme scopes attached (workspace avatars, the theme picker).
 * The document's own theme is handled by useWorkspaceTheme.
 */
export function useThemeSheets(themeIds: readonly (string | null | undefined)[]): void {
  const owner = useId();
  const key = sheetIds(themeIds).join(',');

  useEffect(() => {
    void setThemeSheets(owner, key ? key.split(',') : []);
  }, [owner, key]);
  useEffect(() => () => releaseThemeSheets(owner), [owner]);
}
