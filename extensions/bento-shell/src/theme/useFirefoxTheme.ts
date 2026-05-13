// Drives <html data-color-mode> (+ data-theme for Tale UI compat) from
// uiColorMode in BentoSettings. Two-state ('light' | 'dark') only — the
// previous follow-OS 'system' option was removed in favour of explicit
// user choice.
//
// boot.js sets the initial attribute before any CSS loads using
// localStorage as a hint; this hook keeps things in sync once React is
// up and the SettingsStore mirror has hydrated.
//
// localStorage 'color-mode' mirrors the resolved mode so the next
// launch's boot.js can paint the right shape pre-React.

import { useEffect } from 'react';
import { useSettingsStore } from '../state/settings';

const STORAGE_KEY = 'color-mode';

function applyMode(mode: 'light' | 'dark'): void {
  const html = document.documentElement;
  html.setAttribute('data-color-mode', mode);
  html.setAttribute('data-theme', mode);
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
  }, [uiColorMode]);
}
