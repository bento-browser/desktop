import { describe, expect, it } from 'vitest';
import { tabStateOf, TAB_STATES } from './tabState';

const INFO = 'chrome://global/skin/icons/info.svg';
const WARNING = 'chrome://global/skin/icons/warning.svg';
const BLOCKED = 'chrome://global/skin/icons/blocked.svg';
const SITE = 'https://example.org/';
const SITE_ICON = 'https://example.org/favicon.svg';

describe('tabStateOf precedence', () => {
  it('lets a crash outrank loading, sleeping and every other signal', () => {
    expect(tabStateOf({ pageError: 'crashed', loading: true, discarded: true, url: SITE })).toBe(
      'crashed',
    );
    expect(tabStateOf({ pageError: 'crashed', url: 'about:preferences' })).toBe('crashed');
    expect(tabStateOf({ url: SITE, favIconUrl: SITE_ICON })).toBeNull();
  });

  it('leaves a loading tab to the native loading cue', () => {
    for (const tab of [
      { url: SITE },
      { url: SITE, pageError: 'unavailable' as const },
      { url: 'about:config', favIconUrl: SITE_ICON },
      { url: SITE, discarded: true },
    ]) {
      expect(tabStateOf({ ...tab, loading: true }), JSON.stringify(tab)).toBeNull();
    }
  });

  it('shows a discarded tab as sleeping before page-specific states', () => {
    expect(tabStateOf({ discarded: true })).toBe('sleeping');
    expect(tabStateOf({ discarded: true, url: SITE, pageError: 'certificate-warning' })).toBe(
      'sleeping',
    );
    expect(tabStateOf({ discarded: true, url: 'about:config' })).toBe('sleeping');
  });
});

describe('error pages', () => {
  it.each(['unavailable', 'certificate-warning', 'blocked'] as const)(
    'presents pageError %s as that state, whatever the favicon and URL',
    (pageError) => {
      for (const tab of [
        { url: 'https://example.org/page?x=1', favIconUrl: INFO },
        { url: 'http://example.org' },
        { url: 'file:///missing', favIconUrl: SITE_ICON },
        { url: 'about:config' },
        { url: undefined },
      ]) {
        expect(tabStateOf({ ...tab, pageError }), JSON.stringify(tab)).toBe(pageError);
      }
    },
  );

  // A website can declare any content-accessible chrome favicon, so none of these says anything
  // about the page; only `pageError`, read from the browser's document, does.
  it.each([INFO, WARNING, BLOCKED])('shows a website favicon of %s as an ordinary page', (icon) => {
    for (const url of [SITE, 'http://example.org', 'file:///page.html', undefined]) {
      expect(tabStateOf({ url, favIconUrl: icon }), String(url)).toBeNull();
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
