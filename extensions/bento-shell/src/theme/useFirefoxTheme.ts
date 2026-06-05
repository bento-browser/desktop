// Drives <html data-color-mode> (+ data-theme for Tale UI compat) from
// uiColorMode in BentoSettings. 'system' stores the user's Auto choice but
// resolves to 'light' or 'dark' on the DOM because Tale UI token selectors
// key off the resolved mode.
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

import { useEffect } from 'react';
import type { UiColorModePref } from '@shared/protocol';
import { useSettingsStore } from '../state/settings';

const STORAGE_KEY = 'color-mode';
const RESOLVED_STORAGE_KEY = 'resolved-color-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';

interface FirefoxThemeOptions {
  preferStoredSystemResolution?: boolean;
}

function readStoredResolvedMode(): 'light' | 'dark' | null {
  const stored = localStorage.getItem(RESOLVED_STORAGE_KEY);
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
  return resolved;
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
      localStorage.setItem(RESOLVED_STORAGE_KEY, resolved);
    }

    if (uiColorMode !== 'system') return;
    const media = matchMedia(DARK_QUERY);
    const onChange = () => {
      const nextResolved = applyMode('system', { preferStoredSystemResolution });
      if (!preferStoredSystemResolution) {
        localStorage.setItem(RESOLVED_STORAGE_KEY, nextResolved);
      }
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferStoredSystemResolution, uiColorMode]);
}
