// Normalizers for the text fields the Bookmarks store keeps. Each one applies the field's cap
// from `BOOKMARK_LIMITS` and is idempotent (normalizing a stored value returns it unchanged), so
// delete + undo, which sends a stored item back through create, reproduces it exactly.
import { BOOKMARK_LIMITS } from '@shared/protocol';

const capped = (value: string, limit: number) => value.trim().slice(0, limit).trimEnd();

/** A space or group name: trimmed and capped, `fallback` when blank. */
export const normalizeName = (raw: string, fallback: string) =>
  capped(raw, BOOKMARK_LIMITS.name) || fallback;

/** A link title: trimmed and capped, the URL (also capped) when blank. */
export const normalizeTitle = (raw: string, url: string) =>
  capped(raw, BOOKMARK_LIMITS.linkTitle) || capped(url, BOOKMARK_LIMITS.linkTitle);

/** A note's or to-do's text: kept as typed, capped. */
export const normalizeText = (raw: string) => raw.slice(0, BOOKMARK_LIMITS.text);
