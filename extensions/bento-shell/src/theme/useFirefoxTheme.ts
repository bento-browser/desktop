// Drives <html data-color-mode> (+ data-theme for Tale UI compat) from
// two inputs:
//   1. uiColorMode in BentoSettings — the user's explicit choice
//      ('system' | 'light' | 'dark'), source of truth across launches.
//   2. OS prefers-color-scheme — only consulted when uiColorMode is
//      'system'.
// boot.js sets the initial attribute before any CSS loads using
// localStorage as a hint; this hook keeps things in sync once React is
// up and the SettingsStore mirror has hydrated.
//
// localStorage 'color-mode' mirrors the resolved mode ('light' | 'dark')
// so the next launch's boot.js can paint the right shape pre-React.
// 'system' clears the key.

import { useEffect } from 'react';
import { useSettingsStore } from '../state/settings';

const STORAGE_KEY = 'color-mode';

function applyMode(mode: 'light' | 'dark'): void {
  const html = document.documentElement;
  html.setAttribute('data-color-mode', mode);
  html.setAttribute('data-theme', mode);
}

function persistResolved(mode: 'light' | 'dark' | null): void {
  if (mode === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, mode);
}

export function useFirefoxTheme(): void {
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode);

  useEffect(() => {
    // settings/snapshot hasn't arrived yet — boot.js's localStorage-based
    // initial paint stays. Once it lands the effect re-runs with a real
    // value.
    if (!uiColorMode) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      if (uiColorMode === 'light' || uiColorMode === 'dark') {
        applyMode(uiColorMode);
        persistResolved(uiColorMode);
      } else {
        const osMode = mq.matches ? 'dark' : 'light';
        applyMode(osMode);
        persistResolved(null);
      }
    };
    apply();
    if (uiColorMode !== 'system') return;
    // System mode: track OS changes.
    const handle = () => apply();
    mq.addEventListener('change', handle);
    return () => mq.removeEventListener('change', handle);
  }, [uiColorMode]);
}
