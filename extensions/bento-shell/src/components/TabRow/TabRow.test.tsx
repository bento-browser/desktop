import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BentoSettings, TabSnapshot } from '@shared/protocol';
import { DEFAULT_FIXTURE } from '../../state/__fixtures__/settings';
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

const failedUrl = 'https://example.org/';
const blockedIcon = 'chrome://global/skin/icons/blocked.svg';
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
const stateIcon = (markup: string) => markup.match(/<img[^>]*bento-tab-row__state-icon[^>]*>/)?.[0];

beforeEach(() => {
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
    url: failedUrl,
    favIconUrl: blockedIcon,
  };
});

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
    expect(rowTag(markup)?.includes('data-tab-state="blocked"')).toBe(tints);
    expect(stateIcon(markup)?.includes('data-tab-state="blocked"') ?? false).toBe(icons);
    expect(stateIcon(markup)?.includes('alt="Blocked"') ?? false).toBe(icons);
    expect(markup.includes(`src="${blockedIcon}"`)).toBe(!icons);
  });

  it('uses enabled defaults before settings hydrate and keeps missing rows empty', () => {
    state.settings = null;
    const markup = render();
    expect(rowTag(markup)).toContain('data-tab-state="blocked"');
    expect(stateIcon(markup)).toBeDefined();
    state.tab = undefined;
    expect(render()).toBe('');
  });

  it('keeps real website favicons with both controls On', () => {
    state.tab = { ...state.tab!, favIconUrl: favicon };
    const markup = render();
    expect(markup).toContain(`src="${favicon}"`);
    expect(stateIcon(markup)).toBeUndefined();
    expect(rowTag(markup)).not.toContain('data-tab-state');
  });

  it('shows the state icon from the real tab fields, tinting only failure states', () => {
    const cases = [
      [{ favIconUrl: undefined }, 'default', false],
      [{ discarded: true }, 'sleeping', false],
      [{ crashed: true }, 'crashed', true],
      [{ crashed: true, loading: true }, 'crashed', true],
      [{ url: 'about:preferences#privacy', favIconUrl: favicon }, 'internal-settings', true],
      [{ favIconUrl: 'chrome://global/skin/icons/info.svg' }, 'unavailable', true],
      [{ favIconUrl: 'chrome://global/skin/icons/warning.svg' }, 'certificate-warning', true],
    ] as const;
    const base = state.tab!;
    for (const [changes, expected, tinted] of cases) {
      state.tab = { ...base, ...changes };
      const markup = render();
      expect(stateIcon(markup), expected).toContain(`data-tab-state="${expected}"`);
      expect(stateIcon(markup), expected).toMatch(/src="[^"]*tab-state-[^"]*\.svg/);
      expect(rowTag(markup)?.includes(`data-tab-state="${expected}"`), expected).toBe(tinted);
    }
  });

  it('keeps the Mux progress circle for a loading tab with both controls On', () => {
    state.tab = { ...state.tab!, loading: true };
    const markup = render();
    expect(markup).toContain('bento-tab-row__favicon--loading');
    expect(markup).toContain('aria-label="Loading"');
    expect(markup).toContain('title="Loading — Example"');
    expect(stateIcon(markup)).toBeUndefined();
    expect(rowTag(markup)).not.toContain('data-tab-state');
    expect(markup).not.toContain('<img');
  });

  it('retains native loading, discarded styling, and titles with custom icons Off', () => {
    state.settings = { ...DEFAULT_FIXTURE, customTabStateIconsEnabled: false };
    state.tab = {
      ...state.tab!,
      url: failedUrl,
      favIconUrl: favicon,
      loading: true,
      discarded: true,
    };
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
