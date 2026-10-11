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
