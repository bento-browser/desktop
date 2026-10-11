// Workspace theme sheets. The shared stylesheet carries the Default theme; every other
// theme is its own sheet (public/themes/<id>.css, written by scripts/sync-theme-presets.mjs)
// that a document attaches only while it shows that theme. Plain <link> elements keep the
// extension CSP contract: no inline style or script.
//
// Owners name the themes they need. 'root' is the document's own <html> scope
// (applyRootTheme). Every component that renders another theme scope (pinned panels,
// avatars, the theme picker) registers its theme with useThemeSheet(s) for as long as it
// renders it. A sheet stays attached while any owner needs it. An owner's displayed sheets
// are kept until its latest request has loaded, so a switch never shows an unthemed frame,
// and a request that a newer one replaced neither applies nor prunes anything.
//
// Early request: the workspace snapshot reaches a new window tens of milliseconds after
// the sheet could have loaded, so waiting for the sheet only once the snapshot arrives
// delays the first themed paint. useWorkspaceTheme therefore mirrors the theme it applied
// to localStorage (THEME_HINT_KEY), and public/boot.js inserts that theme's <link> before
// React mounts. The first setThemeSheets call adopts that link: it joins the same
// bookkeeping as a link created here, and a synthetic 'boot' owner keeps it until the
// document knows its workspace (BOOT_THEME_OWNER is then released), so a snapshot that
// names another theme prunes it like any other unreferenced sheet.

import { useEffect, useId } from 'react';
import { BENTO_THEMES, DEFAULT_THEME_ID, resolveThemeId } from './presets';

export const ROOT_THEME_OWNER = 'root';

/** Holds the sheet public/boot.js requested early until the workspace's own theme is known. */
export const BOOT_THEME_OWNER = 'boot';

/**
 * localStorage key mirroring the resolved theme id the shell last applied. Presentation
 * hint only (bento-tools owns the workspace theme); public/boot.js reads the same key.
 */
export const THEME_HINT_KEY = 'workspace-theme';

/** Every registered theme, for documents that preview them all (the theme picker). */
export const ALL_THEME_IDS: readonly string[] = BENTO_THEMES.map((theme) => theme.id);

interface AttachedSheet {
  link: HTMLLinkElement;
  loaded: Promise<boolean>;
  /** Resolve `loaded` without a load event (the link was removed first). */
  abandon: () => void;
}

/** What an owner needs: `shown` is on screen now, `pending` belongs to its latest request. */
interface OwnerSheets {
  request: object;
  shown: ReadonlySet<string>;
  pending: ReadonlySet<string>;
}

/**
 * - loaded: every sheet loaded, so the caller can show the theme.
 * - failed: a sheet could not load, so the caller falls back to Default.
 * - superseded: a newer request or a release replaced this one; the caller does nothing.
 */
export type ThemeSheetResult = 'loaded' | 'failed' | 'superseded';

const owners = new Map<string, OwnerSheets>();
const attached = new Map<string, AttachedSheet>();
let bootSheetChecked = false;

function detach(themeId: string, sheet: AttachedSheet): void {
  sheet.link.remove();
  sheet.abandon();
  if (attached.get(themeId) === sheet) attached.delete(themeId);
}

/** Watch `link` for `themeId` and register it. `loaded` skips the wait for a finished sheet. */
function track(themeId: string, link: HTMLLinkElement, loaded: boolean): AttachedSheet {
  let abandon = () => {};
  const result = new Promise<boolean>((resolve) => {
    abandon = () => resolve(false);
    if (loaded) {
      resolve(true);
      return;
    }
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener('error', () => detach(themeId, sheet), { once: true });
  });
  const sheet: AttachedSheet = { link, loaded: result, abandon };
  attached.set(themeId, sheet);
  return sheet;
}

function attach(themeId: string): Promise<boolean> {
  const existing = attached.get(themeId);
  if (existing) return existing.loaded;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.dataset.bentoThemeSheet = themeId;
  const sheet = track(themeId, link, false);
  link.href = `./themes/${themeId}.css`;
  document.head.append(link);
  return sheet.loaded;
}

/**
 * Whether the element's sheet has finished loading. Firefox can expose `sheet` while the
 * load is still running and throws on `cssRules` until it completes; a null sheet is not
 * loaded either.
 */
function hasLoadedSheet(link: HTMLLinkElement): boolean {
  try {
    return Boolean(link.sheet?.cssRules);
  } catch {
    return false;
  }
}

/**
 * Take over the <link> public/boot.js inserted for the hinted theme, once per document.
 * boot.js marks it 'loading' and flips the marker to 'loaded' or 'failed' from its own
 * listeners, so a load or error that fired before adoption is still known. A loaded sheet
 * on the element counts too, in case its event has not been delivered yet. A failed,
 * unregistered, or duplicate link is removed; the next request for that theme creates a
 * fresh link, which is the retry.
 */
function adoptBootSheet(): void {
  if (bootSheetChecked) return;
  bootSheetChecked = true;

  const link = document.head.querySelector<HTMLLinkElement>('link[data-bento-boot-sheet]');
  if (!link) return;
  const themeId = link.dataset.bentoThemeSheet;
  const marker = link.dataset.bentoBootSheet;
  const usable =
    themeId !== undefined &&
    themeId !== DEFAULT_THEME_ID &&
    ALL_THEME_IDS.includes(themeId) &&
    !attached.has(themeId) &&
    marker !== 'failed';
  if (!usable) {
    link.remove();
    return;
  }
  track(themeId, link, marker === 'loaded' || hasLoadedSheet(link));
  owners.set(BOOT_THEME_OWNER, {
    request: {},
    shown: new Set(),
    pending: new Set([themeId]),
  });
}

function prune(): void {
  const needed = new Set<string>();
  for (const { shown, pending } of owners.values()) {
    for (const id of shown) needed.add(id);
    for (const id of pending) needed.add(id);
  }
  for (const [themeId, sheet] of [...attached]) {
    if (!needed.has(themeId)) detach(themeId, sheet);
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
 * Make `owner`'s themes the sheets it needs. Until the request settles, the sheets the owner
 * already shows stay attached. The caller shows the theme (or falls back to Default) on
 * 'loaded' or 'failed' and ignores 'superseded'.
 */
export async function setThemeSheets(
  owner: string,
  themeIds: Iterable<string | null | undefined>,
): Promise<ThemeSheetResult> {
  adoptBootSheet();
  const ids = sheetIds(themeIds);
  const request = {};
  owners.set(owner, {
    request,
    shown: owners.get(owner)?.shown ?? new Set(),
    pending: new Set(ids),
  });
  // Drops what an earlier, unfinished request of this owner was loading.
  prune();

  const results = await Promise.all(ids.map(attach));
  if (owners.get(owner)?.request !== request) return 'superseded';

  const loaded = ids.filter((_, index) => results[index]);
  owners.set(owner, { request, shown: new Set(loaded), pending: new Set() });
  prune();
  return loaded.length === ids.length ? 'loaded' : 'failed';
}

export function releaseThemeSheets(owner: string): void {
  owners.delete(owner);
  prune();
}

/**
 * Mirror the theme the shell applied to localStorage for public/boot.js. Stores the resolved
 * id, so an alias, unknown, or deleted id never reaches the hint (Default is written as
 * 'default', which boot.js ignores).
 */
export function writeThemeHint(themeId: string | null | undefined): void {
  localStorage.setItem(THEME_HINT_KEY, resolveThemeId(themeId));
}

/**
 * Keep the sheets for the theme scopes a component renders attached (workspace avatars, the
 * theme picker) for as long as it renders them. The document's own theme is handled by
 * useWorkspaceTheme.
 */
export function useThemeSheets(themeIds: readonly (string | null | undefined)[]): void {
  const owner = useId();
  const key = sheetIds(themeIds).join(',');

  useEffect(() => {
    void setThemeSheets(owner, key ? key.split(',') : []);
  }, [owner, key]);
  useEffect(() => () => releaseThemeSheets(owner), [owner]);
}

/** useThemeSheets for a component that renders one theme scope (a pinned panel, an avatar). */
export function useThemeSheet(themeId: string | null | undefined): void {
  useThemeSheets([themeId]);
}
