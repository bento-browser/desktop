// The WebExtension windowId of the chrome window hosting this document.
//
// bento-shell-mount.js stamps it on every frame URL as `#bentoWindowId=<N>`
// (a hash, not a query string: a query changes the BrowsingContextGroup and
// breaks the cross-process BroadcastChannel). Null outside Bento's chrome
// (Ladle, standalone preview) and when the chrome-side lookup failed.

export function readWindowIdFromHash(): number | null {
  try {
    // location.hash includes the leading "#" — strip it before parsing.
    // URLSearchParams tolerates extra keys, so more flags can share the hash.
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const raw = new URLSearchParams(hash).get('bentoWindowId');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Whether the hosting chrome window is private. The mount stamps `#bentoPrivate=1`
 * on every frame of a private window. BroadcastChannel is partitioned by
 * privateBrowsingId, so such a document cannot reach the shell background over it
 * and talks to it through the BentoShellBus relay instead (see shellBus.ts).
 */
export function readPrivateFromHash(): boolean {
  try {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    return new URLSearchParams(hash).get('bentoPrivate') === '1';
  } catch {
    return false;
  }
}

/** This document's window id, fixed for the document's life (the frame URL hash). */
export const thisWindowId = readWindowIdFromHash();

/**
 * Whether a message addressed to window `target` is for the window hosting this
 * document.
 *
 * One extension origin serves every Bento window, and a BroadcastChannel reaches
 * every document of that origin, so each message on an overlay bus names its
 * window and receivers ignore other windows'. An unknown id on either side (Ladle,
 * the standalone preview, a failed chrome-side lookup) accepts the message, as an
 * unscoped bus always did.
 */
export function isForThisWindow(target: unknown): boolean {
  return thisWindowId === null || typeof target !== 'number' || thisWindowId === target;
}
