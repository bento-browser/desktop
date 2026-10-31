import { describe, expect, it } from 'vitest';
import { tabStateOf, TAB_STATES } from './tabState';

const INFO = 'chrome://global/skin/icons/info.svg';
const WARNING = 'chrome://global/skin/icons/warning.svg';
const BLOCKED = 'chrome://global/skin/icons/blocked.svg';
const SITE = 'https://example.org/';
const SITE_ICON = 'https://example.org/favicon.svg';

describe('tabStateOf precedence', () => {
  it('lets a crash outrank loading, sleeping and every other signal', () => {
    expect(
      tabStateOf({ crashed: true, loading: true, discarded: true, url: SITE, favIconUrl: INFO }),
    ).toBe('crashed');
    expect(tabStateOf({ crashed: true, url: 'about:preferences' })).toBe('crashed');
    expect(tabStateOf({ crashed: false, url: SITE, favIconUrl: SITE_ICON })).toBeNull();
  });

  it('leaves a loading tab to the native loading cue', () => {
    for (const tab of [
      { url: SITE },
      { url: SITE, favIconUrl: INFO },
      { url: 'about:config', favIconUrl: SITE_ICON },
      { url: SITE, discarded: true },
    ]) {
      expect(tabStateOf({ ...tab, loading: true }), JSON.stringify(tab)).toBeNull();
    }
  });

  it('shows a discarded tab as sleeping before page-specific states', () => {
    expect(tabStateOf({ discarded: true })).toBe('sleeping');
    expect(tabStateOf({ discarded: true, url: SITE, favIconUrl: WARNING })).toBe('sleeping');
    expect(tabStateOf({ discarded: true, url: 'about:config' })).toBe('sleeping');
  });
});

describe('error page stand-in icons', () => {
  it.each([
    [INFO, 'unavailable'],
    [WARNING, 'certificate-warning'],
    [BLOCKED, 'blocked'],
  ] as const)('maps %s on a failed website address to %s', (favIconUrl, state) => {
    for (const url of ['https://example.org/page?x=1', 'http://example.org', 'file:///missing']) {
      expect(tabStateOf({ url, favIconUrl }), url).toBe(state);
    }
  });

  // Each of these pages sets one of the three icons; none is a failed website load.
  it.each([
    ['about:sessionrestore', INFO],
    ['about:restartrequired', INFO],
    ['about:restricted?e=x', WARNING],
    ['about:neterror?e=dnsNotFound', INFO],
    ['about:certerror?e=x', WARNING],
    ['about:blocked?e=malwareBlocked', BLOCKED],
    ['about:httpsonlyerror?e=x', INFO],
    ['chrome://browser/content/blockedSite.xhtml', BLOCKED],
    ['moz-extension://abc/page.html', INFO],
    ['resource://app/page.html', WARNING],
    ['view-source:https://example.org/', INFO],
    [undefined, INFO],
    ['not a url', WARNING],
  ])('keeps %s with %s as an ordinary page', (url, favIconUrl) => {
    expect(tabStateOf({ url, favIconUrl })).toBeNull();
  });

  it('matches the icon URL exactly', () => {
    for (const favIconUrl of [`${INFO}?x`, `${INFO}#x`, 'https://example.org/info.svg', '']) {
      expect(tabStateOf({ url: SITE, favIconUrl }), favIconUrl).toBe(favIconUrl ? null : 'default');
    }
  });
});

describe('internal settings pages', () => {
  it.each([
    'about:config',
    'about:config?filter=sleep',
    'about:preferences',
    'about:preferences#privacy',
    'about:preferences?x=1#search',
    'about:Preferences#General',
    'about:preferences#experimental',
  ])('recognises %s', (url) => {
    expect(tabStateOf({ url, favIconUrl: 'chrome://branding/content/icon32.png' })).toBe(
      'internal-settings',
    );
    expect(tabStateOf({ url })).toBe('internal-settings');
  });

  it.each([
    'about:addons',
    'about:configuration',
    'about:preferencesx',
    'https://example.org/about:config',
    'https://about.config/',
    'moz-extension://abc/about:config',
  ])('does not recognise %s', (url) => {
    expect(tabStateOf({ url, favIconUrl: SITE_ICON })).toBeNull();
  });
});

describe('default and website favicons', () => {
  it('shows the default icon when there is no favicon', () => {
    expect(tabStateOf({ url: SITE })).toBe('default');
    expect(tabStateOf({ url: 'about:blank' })).toBe('default');
    expect(tabStateOf({})).toBe('default');
  });

  it('keeps the website favicon otherwise', () => {
    expect(tabStateOf({ url: SITE, favIconUrl: SITE_ICON })).toBeNull();
    expect(tabStateOf({ url: 'about:addons', favIconUrl: 'chrome://x/icon.svg' })).toBeNull();
  });
});

describe('TAB_STATES', () => {
  it('tints the failure and settings states only', () => {
    expect(
      Object.entries(TAB_STATES)
        .filter(([, { tinted }]) => tinted)
        .map(([state]) => state),
    ).toEqual(['unavailable', 'certificate-warning', 'blocked', 'crashed', 'internal-settings']);
  });
});
