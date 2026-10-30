import { resolveThemeId } from './presets';
import { useSyncExternalStore } from 'react';

export type ThemeColorScheme = 'light' | 'dark';

export interface ThemeScopeAttributes {
  'data-bento-theme': string;
  'data-muxui-theme': string;
  'data-muxui-color-scheme': ThemeColorScheme;
  'data-muxui-contrast': 'standard';
}

export function readDocumentColorScheme(): ThemeColorScheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
}

const colorSchemeListeners = new Set<() => void>();
let colorSchemeObserver: MutationObserver | null = null;
let observedColorScheme: ThemeColorScheme = 'light';

/**
 * One shared observer of the root's mode attributes; it runs while any scope subscribes.
 * Listeners hear only a change of the resolved scheme: a listener that writes the same
 * attribute again (applyRootTheme does) would otherwise call itself through the observer.
 */
export function subscribeColorScheme(notify: () => void): () => void {
  colorSchemeListeners.add(notify);
  if (!colorSchemeObserver && typeof MutationObserver !== 'undefined') {
    observedColorScheme = readDocumentColorScheme();
    colorSchemeObserver = new MutationObserver(() => {
      const next = readDocumentColorScheme();
      if (next === observedColorScheme) return;
      observedColorScheme = next;
      for (const listener of colorSchemeListeners) listener();
    });
    colorSchemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-mode', 'data-muxui-color-scheme'],
    });
  }
  return () => {
    colorSchemeListeners.delete(notify);
    if (colorSchemeListeners.size === 0) {
      colorSchemeObserver?.disconnect();
      colorSchemeObserver = null;
    }
  };
}

/**
 * Keep nested themed elements in sync when the mode changes (a flip, or Auto resolving to a
 * new mode). A store subscription, not state set from an effect: React renders the change
 * synchronously in the same microtask checkpoint as the root attribute, so the scoped
 * `data-muxui-color-scheme` attributes flip in the same style recalculation as the root and
 * their colours fade with the rest of the document (a state update was rendered a frame or
 * more later and started those fades up to 90 ms behind).
 */
export function useResolvedColorScheme(): ThemeColorScheme {
  return useSyncExternalStore(subscribeColorScheme, readDocumentColorScheme, () => 'light');
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
