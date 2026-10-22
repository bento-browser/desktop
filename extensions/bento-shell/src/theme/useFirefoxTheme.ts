// Drives <html data-color-mode> (+ data-theme for existing chrome consumers)
// from uiColorMode in BentoSettings. 'system' stores the user's Auto choice
// but resolves to 'light' or 'dark' on the DOM so token selectors have an
// explicit mode.
//
// boot.js sets the initial attribute before any CSS loads using
// localStorage as a hint; this hook keeps things in sync once React is
// up and the SettingsStore mirror has hydrated.
//
// localStorage 'color-mode' mirrors the persisted choice so the next
// launch's boot.js can paint the right resolved shape pre-React.
// localStorage 'resolved-color-mode' caches the chrome/sidebar-resolved
// light/dark value for Auto. Regular extension tabs can have their
// matchMedia result skewed by Bento's content color-scheme override, so
// pages like Settings should prefer this cached value.
// All private windows share one localStorage and one BroadcastChannel partition,
// yet each keeps its own colour mode, so in a private window the resolved value
// is stored under a per-window key and the broadcast names its window.
// localStorage 'workspace-theme' (written by applyRootTheme.ts, not here) is the matching
// hint for the workspace theme's stylesheet; boot.js requests that sheet pre-React.

import { useEffect } from 'react';
import type { UiColorModePref } from '@shared/protocol';
import { useSettingsStore } from '../state/settings';
import { isForThisWindow, readPrivateFromHash, thisWindowId } from '../bridge/windowId';

const STORAGE_KEY = 'color-mode';
const RESOLVED_STORAGE_KEY = 'resolved-color-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const CHANNEL_NAME = 'bento-shell-bus';
const RESOLVED_MODE_KIND = 'resolved-color-mode';

/** The key this document reads the resolved mode from: window-specific in a private
 * window, which shares the unscoped key with every other private window. */
const RESOLVED_READ_KEY =
  readPrivateFromHash() && thisWindowId !== null
    ? `${RESOLVED_STORAGE_KEY}@${thisWindowId}`
    : RESOLVED_STORAGE_KEY;

interface FirefoxThemeOptions {
  preferStoredSystemResolution?: boolean;
}

function readStoredResolvedMode(): 'light' | 'dark' | null {
  const stored = localStorage.getItem(RESOLVED_READ_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

function resolveMode(mode: UiColorModePref, options: FirefoxThemeOptions = {}): 'light' | 'dark' {
  if (mode === 'system') {
    if (options.preferStoredSystemResolution) {
      const stored = readStoredResolvedMode();
      if (stored) return stored;
    }
    return matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  }
  return mode;
}

function applyMode(mode: UiColorModePref, options: FirefoxThemeOptions = {}): 'light' | 'dark' {
  const resolved = resolveMode(mode, options);
  const html = document.documentElement;
  html.setAttribute('data-color-mode', resolved);
  html.setAttribute('data-theme', resolved);
  html.setAttribute('data-bento-color-mode-pref', mode);
  // Mux requires an explicit scheme/contrast on the same themed element.
  // Bento currently exposes only the standard contrast mode.
  html.setAttribute('data-muxui-color-scheme', resolved);
  html.setAttribute('data-muxui-contrast', 'standard');
  return resolved;
}

/** Stores the resolved mode for this window's overlays. The unscoped key stays the
 * first-paint hint boot.js reads. */
function storeResolvedMode(resolved: 'light' | 'dark'): void {
  localStorage.setItem(RESOLVED_STORAGE_KEY, resolved);
  if (RESOLVED_READ_KEY !== RESOLVED_STORAGE_KEY) localStorage.setItem(RESOLVED_READ_KEY, resolved);
}

function publishResolvedMode(mode: UiColorModePref, resolved: 'light' | 'dark'): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage({ kind: RESOLVED_MODE_KIND, mode, resolved, windowId: thisWindowId });
  channel.close();
}

export function useFirefoxTheme(options: FirefoxThemeOptions = {}): void {
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode);
  const preferStoredSystemResolution = options.preferStoredSystemResolution === true;

  useEffect(() => {
    // settings/snapshot hasn't arrived yet — boot.js's localStorage-based
    // initial paint stays. Once it lands the effect re-runs with a real
    // value.
    if (!uiColorMode) return;
    const resolved = applyMode(uiColorMode, { preferStoredSystemResolution });
    localStorage.setItem(STORAGE_KEY, uiColorMode);
    if (!preferStoredSystemResolution || uiColorMode !== 'system') {
      storeResolvedMode(resolved);
      publishResolvedMode(uiColorMode, resolved);
    }

    if (uiColorMode !== 'system') return;
    const media = matchMedia(DARK_QUERY);
    const onChange = () => {
      const nextResolved = applyMode('system', { preferStoredSystemResolution });
      if (!preferStoredSystemResolution) {
        storeResolvedMode(nextResolved);
        publishResolvedMode('system', nextResolved);
      }
    };
    media.addEventListener('change', onChange);

    let channel: BroadcastChannel | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { kind?: unknown; resolved?: unknown; windowId?: unknown } | null;
      if (
        !preferStoredSystemResolution ||
        !data ||
        data.kind !== RESOLVED_MODE_KIND ||
        (data.resolved !== 'light' && data.resolved !== 'dark') ||
        !isForThisWindow(data.windowId)
      ) {
        return;
      }
      storeResolvedMode(data.resolved);
      applyMode('system', { preferStoredSystemResolution: true });
    };
    if (preferStoredSystemResolution && typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', onMessage);
    }

    const onStorage = (event: StorageEvent) => {
      if (
        !preferStoredSystemResolution ||
        event.key !== RESOLVED_READ_KEY ||
        (event.newValue !== 'light' && event.newValue !== 'dark')
      ) {
        return;
      }
      applyMode('system', { preferStoredSystemResolution: true });
    };
    if (preferStoredSystemResolution) window.addEventListener('storage', onStorage);

    return () => {
      media.removeEventListener('change', onChange);
      if (channel) {
        channel.removeEventListener('message', onMessage);
        channel.close();
      }
      if (preferStoredSystemResolution) window.removeEventListener('storage', onStorage);
    };
  }, [preferStoredSystemResolution, uiColorMode]);
}
