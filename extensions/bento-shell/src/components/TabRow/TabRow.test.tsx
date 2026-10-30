import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BentoSettings, TabSnapshot } from '@shared/protocol';
import { DEFAULT_FIXTURE } from '../../state/__fixtures__/settings';
import { softcastFixtureUrl } from '../../dev/softcast';
import { TabRow } from './TabRow';

const state = vi.hoisted(() => ({
  tab: undefined as TabSnapshot | undefined,
  settings: null as BentoSettings | null,
}));
vi.mock('../../bridge/useToolsPort', () => ({ dispatch: vi.fn() }));
vi.mock('../../state/tabs', () => ({ useTab: () => state.tab }));
vi.mock('../../state/settings', () => ({
  useSettingsStore: (selector: (value: { current: BentoSettings | null }) => unknown) =>
    selector({ current: state.settings }),
}));

const shellUrl = 'moz-extension://bento-shell-test/dist/index.html';
const favicon = 'https://example.org/favicon.svg';
const render = () =>
  renderToStaticMarkup(
    <TabRow
      id={1}
      active={false}
      onActivate={() => {}}
      onClose={() => {}}
      onOpenInSidePanel={() => {}}
    />,
  );
const rowTag = (markup: string) => markup.match(/<div[^>]*data-bento-tab-id="1"[^>]*>/)?.[0];

beforeEach(() => {
  vi.stubGlobal('location', { href: shellUrl });
  state.settings = { ...DEFAULT_FIXTURE };
  state.tab = {
    id: 1,
    windowId: 1,
    index: 0,
    title: 'Example',
    active: false,
    pinned: false,
    audible: false,
    muted: false,
    url: softcastFixtureUrl(shellUrl, 'blocked'),
    favIconUrl: favicon,
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('tab appearance preferences', () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('renders tints %s and custom icons %s independently', (tints, icons) => {
    state.settings = {
      ...DEFAULT_FIXTURE,
      tabStateTintsEnabled: tints,
      customTabStateIconsEnabled: icons,
    };
    const markup = render();
    expect(rowTag(markup)?.includes('data-softcast-state="blocked"')).toBe(
      __BENTO_SOFTCAST_DEMO__ && tints,
    );
    expect(markup.includes('bento-tab-row__softcast')).toBe(__BENTO_SOFTCAST_DEMO__ && icons);
    expect(markup.includes(`src="${favicon}"`)).toBe(!__BENTO_SOFTCAST_DEMO__ || !icons);
  });

  it('uses enabled defaults before settings hydrate and keeps missing rows empty', () => {
    state.settings = null;
    expect(render().includes('bento-tab-row__softcast')).toBe(__BENTO_SOFTCAST_DEMO__);
    state.tab = undefined;
    expect(render()).toBe('');
  });

  it('keeps real website favicons with both controls On', () => {
    state.tab = { ...state.tab!, url: 'https://example.org' };
    const markup = render();
    expect(markup).toContain(`src="${favicon}"`);
    expect(markup).not.toContain('bento-tab-row__softcast');
    expect(rowTag(markup)).not.toContain('data-softcast-state');
  });

  it('retains native loading, discarded styling, and titles with custom icons Off', () => {
    state.settings = { ...DEFAULT_FIXTURE, customTabStateIconsEnabled: false };
    state.tab = { ...state.tab!, url: 'https://example.org', loading: true, discarded: true };
    const loading = render();
    expect(loading).toContain('bento-tab-row__favicon--loading');
    expect(loading).toContain('aria-label="Loading"');
    expect(loading).toContain('title="Loading — Example"');
    expect(loading).toContain('bento-tab-row--discarded');
    expect(loading).not.toContain(`src="${favicon}"`);
    state.tab.loading = false;
    const sleeping = render();
    expect(sleeping).toContain(`src="${favicon}"`);
    expect(sleeping).toContain('title="Sleeping — Example"');
    expect(sleeping).toContain('bento-tab-row--discarded');
    state.tab.favIconUrl = undefined;
    expect(render()).toContain('bento-tab-row__favicon--placeholder');
  });
});
