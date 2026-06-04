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

import { useEffect } from 'react';
import type { UiColorModePref } from '@shared/protocol';
import { useSettingsStore } from '../state/settings';

const STORAGE_KEY = 'color-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function resolveMode(mode: UiColorModePref): 'light' | 'dark' {
  if (mode === 'system') {
    return matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  }
  return mode;
}

function applyMode(mode: UiColorModePref): void {
  const resolved = resolveMode(mode);
  const html = document.documentElement;
  html.setAttribute('data-color-mode', resolved);
  html.setAttribute('data-theme', resolved);
  html.setAttribute('data-bento-color-mode-pref', mode);
}

export function useFirefoxTheme(): void {
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode);

  useEffect(() => {
    // settings/snapshot hasn't arrived yet — boot.js's localStorage-based
    // initial paint stays. Once it lands the effect re-runs with a real
    // value.
    if (!uiColorMode) return;
    applyMode(uiColorMode);
    localStorage.setItem(STORAGE_KEY, uiColorMode);

    if (uiColorMode !== 'system') return;
    const media = matchMedia(DARK_QUERY);
    const onChange = () => applyMode('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [uiColorMode]);
}
