import type { ColorStamp, UiColorModePref } from '@shared/protocol';
import { flushSync } from 'react-dom';
import { synchronizeDocumentColorScheme } from './themeScope';

export interface ModeGrant {
  pref: UiColorModePref;
  resolved: 'light' | 'dark';
  stamp: ColorStamp;
}

export const nativeModeHosted =
  new URLSearchParams(globalThis.location?.hash.slice(1) ?? '').get('bentoNativeMode') === '1';
let request = 0;
let generation = -1;
let granted: ModeGrant | null = null;
let ready = false;
let stopActivity: (() => void) | null = null;
const listeners = new Set<(target: ModeGrant) => void>();
let resolveReady: () => void;
const firstGrant = new Promise<void>((resolve) => { resolveReady = resolve; });

function up(kind: 'register' | 'intent' | 'activity', pref?: UiColorModePref, reason = 'settings'): void {
  if (!nativeModeHosted) return;
  document.dispatchEvent(new CustomEvent('bento-mode-up', {
    detail: JSON.stringify({ kind, request: ++request, pref, reason, generation }),
  }));
}

function watchActivity(): void {
  stopActivity?.();
  const activity = (event: Event) => {
    if (!stopActivity) return;
    if (event.target instanceof Element && event.target.closest('[data-bento-mode-control]')) return;
    stopActivity?.();
    stopActivity = null;
    up('activity', undefined, event.type);
  };
  const events = ['pointerdown', 'pointermove', 'keydown', 'focusin', 'scroll', 'bento-host-presentation'];
  for (const name of events) document.addEventListener(name, activity, true);
  window.addEventListener('resize', activity);
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.oldValue !== document.documentElement.getAttribute('data-bento-theme'))) {
      activity(new Event('workspace-theme'));
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeOldValue: true, attributeFilter: ['data-bento-theme'] });
  stopActivity = () => {
    for (const name of events) document.removeEventListener(name, activity, true);
    window.removeEventListener('resize', activity);
    observer.disconnect();
  };
}

/** All hosted routes are requests. Only the parent-granted final writer mutates mode. */
export function requestModePresentation(pref?: UiColorModePref, reason = 'settings'): boolean {
  if (!nativeModeHosted) return false;
  up('intent', pref, reason);
  return true;
}

export function whenModePresentationReady(): Promise<void> {
  return nativeModeHosted ? firstGrant : Promise.resolve();
}

export function onModeGranted(listener: (target: ModeGrant) => void): () => void {
  listeners.add(listener);
  if (granted) listener(granted);
  return () => listeners.delete(listener);
}

function validTarget(target: unknown): target is ModeGrant {
  if (!target || typeof target !== 'object') return false;
  const value = target as Partial<ModeGrant>;
  return ['light', 'dark', 'system'].includes(String(value.pref)) &&
    (value.resolved === 'light' || value.resolved === 'dark') &&
    typeof value.stamp?.run === 'string' && Number.isSafeInteger(value.stamp.seq);
}

function commit(target: ModeGrant): void {
  const root = document.documentElement;
  root.style.removeProperty('--bento-mode-fade-delay');
  root.setAttribute('data-bento-mode-fade', 'settle');
  root.setAttribute('data-color-mode', target.resolved);
  root.setAttribute('data-theme', target.resolved);
  root.setAttribute('data-bento-color-mode-pref', target.pref);
  root.setAttribute('data-muxui-color-scheme', target.resolved);
  root.setAttribute('data-muxui-contrast', 'standard');
  // Nested scopes subscribe through useSyncExternalStore. Flush that known
  // dependency now, rather than ACK before its MutationObserver/React work.
  flushSync(synchronizeDocumentColorScheme);
  // Resolve colour/carrier values while the zero-duration and zero-delay rule
  // is installed. Removing it afterwards cannot revive a local footer spring.
  void getComputedStyle(root).color;
  root.removeAttribute('data-bento-mode-fade');
  const changed = granted?.pref !== target.pref || granted.resolved !== target.resolved;
  granted = target;
  root.setAttribute('data-bento-mode-state', 'committed');
  if (!ready) { ready = true; resolveReady(); }
  if (changed) for (const listener of listeners) listener(target);
}

function command(event: Event): void {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'string') return;
  let value: { command?: string; generation?: number; queryId?: string; target?: unknown };
  try { value = JSON.parse(detail); } catch { return; }
  if (!Number.isSafeInteger(value.generation) || (value.generation ?? -1) < generation || typeof value.queryId !== 'string') return;
  const root = document.documentElement;
  if (value.command === 'commit' && !validTarget(value.target)) return;
  generation = value.generation as number;
  if (value.command === 'prepare') {
    root.setAttribute('data-bento-mode-state', 'held');
    watchActivity();
  }
  else if (value.command === 'commit' && validTarget(value.target)) commit(value.target);
  else if (value.command === 'abort') {
    stopActivity?.();
    stopActivity = null;
    root.setAttribute('data-bento-mode-state', 'idle');
  }
  else return;
  root.setAttribute('data-bento-mode-response', JSON.stringify({
    queryId: value.queryId, generation, applied: value.command === 'commit',
    styles: value.command === 'commit', documentNonce: root.getAttribute('data-bento-mode-document'),
  }));
}

if (nativeModeHosted) {
  const root = document.documentElement;
  root.setAttribute('data-bento-mode-document', crypto.randomUUID());
  root.setAttribute('data-bento-mode-writer', '1');
  root.setAttribute('data-bento-mode-state', 'waiting');
  document.addEventListener('bento-mode-command', command);
  up('register');
  window.addEventListener('pagehide', () => {
    document.removeEventListener('bento-mode-command', command);
    stopActivity?.();
    listeners.clear();
    root.removeAttribute('data-bento-mode-writer');
  }, { once: true });
}
