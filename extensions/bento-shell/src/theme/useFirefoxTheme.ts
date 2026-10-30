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

import { useEffect, useRef } from 'react';
import type { UiColorModePref } from '@shared/protocol';
import { useSettingsStore } from '../state/settings';
import { isForThisWindow, readPrivateFromHash, thisWindowId } from '../bridge/windowId';
import { applyModeWithFade } from './modeFade';

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

/** Resolves and applies a mode. `flipAt` (a settings change's ColorStamp.flipAt) makes the
 * change show at that time, and `onApplied` run then; the OS, storage and BroadcastChannel
 * paths pass none and apply at once. The mode is resolved when it is applied, not when it was
 * asked for, so an Auto choice that waits shows the OS appearance of that moment, and
 * `onApplied` stores and announces the mode that is on screen. */
function applyMode(
  mode: UiColorModePref,
  options: FirefoxThemeOptions = {},
  flipAt?: number,
  onApplied?: (resolved: 'light' | 'dark') => void,
): void {
  // Every mode write in this document goes through here (settings, OS change, storage and
  // BroadcastChannel), so one fade covers them all (modeFade.ts).
  applyModeWithFade(
    () => resolveMode(mode, options),
    (resolved) => {
      const html = document.documentElement;
      html.setAttribute('data-color-mode', resolved);
      html.setAttribute('data-theme', resolved);
      html.setAttribute('data-bento-color-mode-pref', mode);
      // Mux requires an explicit scheme/contrast on the same themed element.
      // Bento currently exposes only the standard contrast mode.
      html.setAttribute('data-muxui-color-scheme', resolved);
      html.setAttribute('data-muxui-contrast', 'standard');
    },
    flipAt,
    onApplied,
  );
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

/** Applies a mode pref, mirrors it to localStorage and announces the resolved mode to the
 * window's overlays. The pref a settings change names, or the one hydration found. The
 * announcement goes out when the mode is applied, not when the change was heard: an overlay in
 * Auto applies a published mode at once, which would flip it ahead of a scheduled flip. */
function applyPreference(
  mode: UiColorModePref,
  preferStoredSystemResolution: boolean,
  flipAt?: number,
): void {
  localStorage.setItem(STORAGE_KEY, mode);
  applyMode(mode, { preferStoredSystemResolution }, flipAt, (resolved) => {
    if (!preferStoredSystemResolution || mode !== 'system') {
      storeResolvedMode(resolved);
      publishResolvedMode(mode, resolved);
    }
  });
}

export function useFirefoxTheme(options: FirefoxThemeOptions = {}): void {
  // A boolean, not the pref: this hook sits at the root of every document, and a root that
  // re-renders on every flip re-renders its whole tree (the sidebar's tab rows) just when the
  // fade is about to start.
  const isAuto = useSettingsStore((s) => s.current?.uiColorMode === 'system');
  const preferStoredSystemResolution = options.preferStoredSystemResolution === true;
  const appliedPref = useRef<UiColorModePref | null>(null);

  // Applies the pref when the store changes, inside the store's own set(), not after React has
  // rendered and flushed its effects: that took a frame or more (longer in a heavy document),
  // and the mode fade of the documents of one window should start together. The first run
  // is the initial application (boot hydration); a pref that is already applied is not
  // applied, announced or faded again. settings/snapshot hasn't arrived yet when the store
  // holds no pref - boot.js's localStorage-based paint stays until it does.
  useEffect(() => {
    const sync = (state: ReturnType<typeof useSettingsStore.getState>) => {
      const pref = state.current?.uiColorMode;
      if (!pref || pref === appliedPref.current) return;
      appliedPref.current = pref;
      // A throw here would stop the store's other subscribers (React's own) and the port
      // handler that called set(), so it is contained.
      try {
        applyPreference(pref, preferStoredSystemResolution, state.colorFlipAt);
      } catch (err) {
        console.warn('[bento-shell] applying the colour mode failed', err);
      }
    };
    sync(useSettingsStore.getState());
    return useSettingsStore.subscribe(sync);
  }, [preferStoredSystemResolution]);

  // The listeners that keep an Auto choice following the OS and the window's other documents.
  useEffect(() => {
    if (!isAuto) return;
    const media = matchMedia(DARK_QUERY);
    const onChange = () => {
      applyMode('system', { preferStoredSystemResolution }, undefined, (resolved) => {
        if (!preferStoredSystemResolution) {
          storeResolvedMode(resolved);
          publishResolvedMode('system', resolved);
        }
      });
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
  }, [preferStoredSystemResolution, isAuto]);
}
