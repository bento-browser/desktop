import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const attrs = new Map<string, string>();
const commands: Array<Record<string, unknown>> = [];
let doc: EventTarget;
let win: EventTarget;
let nestedScheme = 'light';
let flushes = 0;
let observers: Observer[];
const root = {
  getAttribute: (key: string) => attrs.get(key) ?? null,
  hasAttribute: (key: string) => attrs.has(key),
  setAttribute: (key: string, value: string) => attrs.set(key, value),
  removeAttribute: (key: string) => attrs.delete(key),
  style: { removeProperty: vi.fn() },
};
class Observer {
  constructor(readonly callback: MutationCallback) { observers.push(this); }
  observe() {} disconnect() {}
}
const target = (resolved = 'dark', pref = 'system') => ({ pref, resolved, stamp: { run: 'owner', seq: 2 } });
function command(kind: string, generation = 1, granted = target()) {
  doc.dispatchEvent(new CustomEvent('bento-mode-command', {
    detail: JSON.stringify({ command: kind, generation, queryId: `q-${generation}`, target: granted }),
  }));
}
beforeEach(() => {
  vi.resetModules(); attrs.clear(); commands.length = 0; flushes = 0; nestedScheme = 'light'; observers = [];
  attrs.set('data-color-mode', 'light');
  doc = Object.assign(new EventTarget(), { documentElement: root, hidden: false });
  win = new EventTarget();
  doc.addEventListener('bento-mode-up', (event) => commands.push(JSON.parse((event as CustomEvent<string>).detail)));
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
  vi.stubGlobal('location', { hash: '#bentoNativeMode=1&bentoHostedOverlay=1' });
  vi.stubGlobal('MutationObserver', Observer);
  vi.stubGlobal('Element', class {});
  vi.stubGlobal('getComputedStyle', () => {
    expect(attrs.get('data-bento-mode-fade')).toBe('settle');
    expect(nestedScheme).toBe(attrs.get('data-color-mode'));
    ++flushes; return { color: 'rgb(0, 0, 0)' };
  });
});
afterEach(() => { win.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); });

it('holds every request before writes, commits the granted Auto resolution and nested scheme before style ACK, even when hidden', async () => {
  const scope = await import('./themeScope');
  const stop = scope.subscribeColorScheme(() => { nestedScheme = scope.readDocumentColorScheme(); });
  const bridge = await import('./modePresentation');
  const publish = vi.fn(); bridge.onModeGranted(publish);
  expect(commands[0]?.kind).toBe('register');
  expect(bridge.requestModePresentation('dark', 'settings')).toBe(true);
  bridge.requestModePresentation('light', 'media');
  bridge.requestModePresentation('light', 'storage');
  expect(attrs.get('data-color-mode')).toBe('light');
  expect(publish).not.toHaveBeenCalled();
  command('prepare');
  expect(attrs.get('data-bento-mode-state')).toBe('held');
  command('commit');
  await bridge.whenModePresentationReady();
  expect(attrs.get('data-color-mode')).toBe('dark');
  expect(attrs.get('data-bento-color-mode-pref')).toBe('system');
  expect(nestedScheme).toBe('dark');
  expect(flushes).toBe(1);
  expect(attrs.has('data-bento-mode-fade')).toBe(false);
  expect(JSON.parse(attrs.get('data-bento-mode-response')!)).toMatchObject({ applied: true, styles: true, generation: 1 });
  expect(publish).toHaveBeenCalledWith(target());
  command('commit', 0, target('light', 'light'));
  expect(attrs.get('data-color-mode')).toBe('dark');
  stop();
});

it('same-mode requests stay held; ordinary activity is bounded to the transaction and stale cleanup cannot end a newer hold', async () => {
  const bridge = await import('./modePresentation');
  command('commit', 1, target('light', 'light'));
  bridge.requestModePresentation('light');
  expect(flushes).toBe(1);
  command('prepare', 3);
  command('abort', 2);
  expect(attrs.get('data-bento-mode-state')).toBe('held');
  doc.dispatchEvent(new Event('pointerdown'));
  doc.dispatchEvent(new Event('pointerdown'));
  expect(commands.filter(({ kind }) => kind === 'activity')).toHaveLength(1);
  command('abort', 3);
  expect(attrs.get('data-bento-mode-state')).toBe('idle');
});

it('standalone pages keep their existing local writer path', async () => {
  vi.stubGlobal('location', { hash: '' });
  const bridge = await import('./modePresentation');
  expect(bridge.nativeModeHosted).toBe(false);
  expect(bridge.requestModePresentation('dark')).toBe(false);
  expect(attrs.has('data-bento-mode-writer')).toBe(false);
  await bridge.whenModePresentationReady();
});

it('a same-theme async sheet rewrite does not settle the mode image, but a real theme change does', async () => {
  await import('./modePresentation');
  attrs.set('data-bento-theme', 'default');
  command('prepare', 1);
  const observer = observers.at(-1)!;
  const deliver = (oldValue: string) => observer.callback([{ oldValue } as MutationRecord], observer as unknown as MutationObserver);
  deliver('default');
  expect(commands.filter(({ kind }) => kind === 'activity')).toHaveLength(0);
  attrs.set('data-bento-theme', 'standard-harbour');
  deliver('default');
  expect(commands.filter(({ kind }) => kind === 'activity')).toHaveLength(1);
});
