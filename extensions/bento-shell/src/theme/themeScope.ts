import { resolveThemeId } from './presets';
import { useEffect, useState } from 'react';

export type ThemeColorScheme = 'light' | 'dark';

export interface ThemeScopeAttributes {
  'data-bento-theme': string;
  'data-muxui-theme': string;
  'data-muxui-color-scheme': ThemeColorScheme;
  'data-muxui-contrast': 'standard';
}

function readDocumentColorScheme(): ThemeColorScheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
}

/** Keep nested themed elements in sync when Auto resolves to a new mode. */
export function useResolvedColorScheme(): ThemeColorScheme {
  const [colorScheme, setColorScheme] = useState<ThemeColorScheme>(readDocumentColorScheme);

  useEffect(() => {
    const html = document.documentElement;
    const update = () => setColorScheme(readDocumentColorScheme());
    update();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(update);
    observer.observe(html, {
      attributes: true,
      attributeFilter: ['data-color-mode', 'data-muxui-color-scheme'],
    });
    return () => observer.disconnect();
  }, []);

  return colorScheme;
}

/**
 * Resolve presentation attributes without changing the stored workspace id.
 * The same scope is applied to the document root and nested workspace avatars
 * so an avatar cannot inherit the active workspace's palette by accident.
 */
export function getThemeScopeAttributes(
  themeId: string | undefined | null,
  colorScheme: string | null | undefined,
): ThemeScopeAttributes {
  const resolvedThemeId = resolveThemeId(themeId);
  return {
    'data-bento-theme': resolvedThemeId,
    'data-muxui-theme': resolvedThemeId,
    'data-muxui-color-scheme': colorScheme === 'dark' ? 'dark' : 'light',
    'data-muxui-contrast': 'standard',
  };
}
