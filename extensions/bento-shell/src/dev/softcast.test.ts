import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabSnapshot } from '@shared/protocol';
import {
  SOFTCAST_STATES,
  softcastFixture,
  softcastFixtureUrl,
  softcastPresentation,
} from './softcast';
import { softcastDemoEnabled } from './softcastBuild';

const shellUrl = 'moz-extension://bento-shell-test/dist/index.html?bentoWindowId=7';
const icon = (tab: Parameters<typeof softcastPresentation>[0], enabled = true) =>
  softcastPresentation(tab, shellUrl, enabled);

vi.mock('../bridge/useToolsPort', () => ({ dispatch: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Softcast demo boundary', () => {
  it('defaults off and rejects every release selection using the shared resolver', () => {
    const root = mkdtempSync(join(tmpdir(), 'bento-softcast-gate-'));
    try {
      writeFileSync(join(root, 'bento.json'), JSON.stringify({ build: { mode: 'dev' } }));
      expect(softcastDemoEnabled({}, root)).toBe(false);
      expect(softcastDemoEnabled({ BENTO_SOFTCAST_DEMO: 'true' }, root)).toBe(false);
      expect(softcastDemoEnabled({ BENTO_SOFTCAST_DEMO: '1' }, root)).toBe(true);
      for (const env of [
        { BENTO_BUILD_MODE: 'release' },
        { BENTO_RELEASE: '1', BENTO_BUILD_MODE: 'dev' },
      ]) {
        expect(() => softcastDemoEnabled({ ...env, BENTO_SOFTCAST_DEMO: '1' }, root)).toThrow(
          'forbidden in a release build',
        );
      }
      writeFileSync(join(root, 'bento.json'), JSON.stringify({ build: { mode: 'release' } }));
      expect(() => softcastDemoEnabled({ BENTO_SOFTCAST_DEMO: '1' }, root)).toThrow('release');
      expect(softcastDemoEnabled({ BENTO_SOFTCAST_DEMO: '1', BENTO_BUILD_MODE: 'dev' }, root)).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows only the eight exact fixture URLs and the explicit loading motion variant', () => {
    for (const state of SOFTCAST_STATES) {
      const url = softcastFixtureUrl(shellUrl, state);
      expect(softcastFixture(shellUrl, url)).toEqual({ state, spin: false });
      // Fixtures win even while their real page is briefly loading or discarded.
      expect(
        icon({ url, loading: true, discarded: true, favIconUrl: 'https://example.org/icon' }),
      ).toMatchObject({ state, fixture: true, spin: false });
      expect(icon({ url }, false)).toBeNull();
    }
    expect(icon({ url: softcastFixtureUrl(shellUrl, 'loading', true) })).toMatchObject({
      state: 'loading',
      spin: true,
      fixture: true,
    });
    const exact = softcastFixtureUrl(shellUrl, 'blocked');
    for (const url of [
      exact.replace('bento-shell-test', 'bento-shell-test.evil'),
      exact.replace('moz-extension:', 'https:'),
      exact.replace('bento-shell-test', 'other-extension'),
      exact.replace('/blocked.html', '/sub/blocked.html'),
      exact.replace('/blocked.html', '/sub/../blocked.html'),
      exact.replace('blocked.html', '%62locked.html'),
      `${exact}/child`,
      `${exact}?motion=spin`,
      `${exact}#blocked`,
      'about:neterror?e=connectionFailure',
      'about:certerror',
      'https://example.org/dist/dev/softcast/blocked.html',
      softcastFixtureUrl(shellUrl, 'loading', true) + '&extra=1',
      softcastFixtureUrl(shellUrl, 'loading') + '?motion=spin&motion=spin',
    ]) {
      expect(softcastFixture(shellUrl, url), url).toBeNull();
      expect(icon({ url })?.fixture, url).toBe(false);
      expect(icon({ url })?.state, url).toBe('default');
    }
  });

  it('maps only supported live states, preserving precedence and real site favicons', () => {
    const favIconUrl = 'https://example.org/favicon.svg';
    expect(icon({ url: 'https://example.org', favIconUrl })).toBeNull();
    expect(icon({ loading: true, discarded: true, favIconUrl })).toMatchObject({
      state: 'loading',
      spin: true,
    });
    expect(icon({ discarded: true, url: 'about:preferences', favIconUrl })).toMatchObject({
      state: 'sleeping',
    });
    for (const url of ['about:preferences', 'about:preferences#privacy', 'about:config']) {
      expect(icon({ url, favIconUrl })).toMatchObject({ state: 'internal-settings' });
    }
    expect(icon({ url: 'about:preferences-lookalike', favIconUrl })).toBeNull();
    expect(icon({})).toMatchObject({ state: 'default', fixture: false, spin: false });
    expect(icon({ loading: true, discarded: true }, false)).toBeNull();
    expect(softcastPresentation({}, 'https://example.org/dist/index.html', true)).toBeNull();
  });

  it('opens real tabs sequentially once, skips restored fixtures, and leaves snapshots untouched', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal('location', { href: shellUrl });
    vi.stubGlobal('window', new EventTarget());
    const { dispatch } = await import('../bridge/useToolsPort');
    const { useTabsStore } = await import('../state/tabs');
    const { useWorkspacesStore } = await import('../state/workspaces');
    const { startSoftcastDemo } = await import('./initSoftcastDemo');
    useWorkspacesStore
      .getState()
      .applySnapshot([{ id: 'demo', name: 'Demo', createdAt: 0 }], 'demo', { 7: 'demo' });
    const tab = (id: number, url: string): TabSnapshot => ({
      id,
      url,
      title: 'Real tab',
      windowId: 7,
      index: id,
      workspaceId: 'demo',
      active: false,
      pinned: false,
      audible: false,
      muted: false,
    });
    const restored = tab(1, softcastFixtureUrl(shellUrl, 'loading', true));
    useTabsStore.getState().applySnapshot([restored]);
    startSoftcastDemo(7, 'demo');
    startSoftcastDemo(7, 'demo');
    const states = SOFTCAST_STATES.filter((state) => state !== 'loading');
    for (const [index, state] of states.entries()) {
      const url = softcastFixtureUrl(shellUrl, state);
      expect(dispatch).toHaveBeenCalledTimes(index + 1);
      expect(dispatch).toHaveBeenLastCalledWith({
        type: 'tab/openUrl',
        url,
        active: false,
        focusExisting: false,
      });
      // A normal unrelated update cannot release the next fixture.
      useTabsStore
        .getState()
        .applyDeltas([{ kind: 'updated', id: 1, changes: { title: 'Still real' } }]);
      expect(dispatch).toHaveBeenCalledTimes(index + 1);
      useTabsStore.getState().applyDeltas([{ kind: 'created', tab: tab(index + 2, url) }]);
    }
    expect(dispatch).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
    expect(useTabsStore.getState().byId[1]).toEqual({ ...restored, title: 'Still real' });
    startSoftcastDemo(7, 'demo');
    expect(dispatch).toHaveBeenCalledTimes(7);
  });
});
