// The one source for Bento's about: page theming (look A, Neutral: neutral surfaces, brand
// colour on accents only). scripts/generate-chrome-tokens.mjs turns it into
// src/browser/base/content/bento-about-themes.css, a USER sheet that bento-shell-mount.js
// registers once per process. The BentoAboutTheme actor (and, for the Passwords sidebar, the
// mount script) puts data-bento-theme and data-color-mode on each in-scope document's root.
//
// Values are written in Mux token terms (var(--neutral-5), var(--muxui-semantic-...)). The
// generator resolves every token they reference to a literal for each workspace theme and UI
// mode, so the pages need no Bento token sheet for colour. Text on a fill uses that fill's Mux
// `*-fg` or action-foreground token.
//
// Repo tooling: never shipped. The mount script mirrors ABOUT_THEME_ACTOR_MATCHES and
// ABOUT_THEME_CHROME_DOCUMENTS (scripts/theme-sheets.test.mjs keeps them equal), and
// checkFirefoxTokens() checks every Firefox token below against a Firefox source tree.

// Pages matched by exact URL plus their `?` and `#` forms: url() compares the full spec, and
// url-prefix("about:") would match about:blank. Settings (about:preferences, about:settings)
// is deliberately absent: patch core-ui/12 themes it.
export const ABOUT_THEME_PAGES = [
  'logins',
  'loginsimportreport',
  'addons',
  'privatebrowsing',
  'downloads',
  'config',
  'support',
  'profiles',
  'processes',
  'policies',
];

// Error pages are documents like about:neterror?e=..., so they match by prefix.
export const ABOUT_THEME_ERROR_PAGES = ['neterror', 'certerror', 'httpsonlyerror'];

// Chrome documents in the sheet's scope. The actor does not reach the sidebar's chrome
// browser, so bento-shell-mount.js sets their root attributes from the window.
export const ABOUT_THEME_CHROME_DOCUMENTS = ['chrome://global/content/megalist/megalist.html'];

/** The @-moz-document conditions for `pages` (default: every in-scope document). */
export function documentConditions({
  pages = ABOUT_THEME_PAGES,
  errorPages = ABOUT_THEME_ERROR_PAGES,
  chrome = ABOUT_THEME_CHROME_DOCUMENTS,
} = {}) {
  return [
    ...pages.flatMap((page) => [
      `url("about:${page}")`,
      `url-prefix("about:${page}?")`,
      `url-prefix("about:${page}#")`,
    ]),
    ...errorPages.map((page) => `url-prefix("about:${page}?")`),
    ...chrome.map((url) => `url("${url}")`),
  ];
}

// The BentoAboutTheme actor's `matches`, the same documents as the sheet minus the chrome ones.
export const ABOUT_THEME_ACTOR_MATCHES = [
  ...ABOUT_THEME_PAGES.flatMap((page) => [`about:${page}`, `about:${page}?*`, `about:${page}#*`]),
  ...ABOUT_THEME_ERROR_PAGES.map((page) => `about:${page}?*`),
];

const DESIGN_SYSTEM = 'toolkit/themes/shared/design-system/dist';

// Firefox token -> value, grouped by the Firefox file that declares the tokens. `hosts` names
// the elements whose shadow stylesheet re-declares the group on :host (a component token
// file), so the values are set on those hosts too: a value on :root alone would be replaced
// there instead of inherited.
export const FIREFOX_TOKEN_MAP = [
  {
    owner: DESIGN_SYSTEM,
    tokens: {
      '--background-color-canvas': 'var(--neutral-5)',
      '--background-color-box': 'var(--neutral-10)',
      '--background-color-box-info': 'var(--neutral-12)',
      '--background-color-information': 'var(--neutral-12)',
      '--background-color-list-item-hover': 'color-mix(in srgb, var(--neutral-90) 8%, transparent)',
      '--background-color-critical': 'color-mix(in srgb, var(--error-60) 12%, var(--neutral-10))',
      '--background-color-warning': 'color-mix(in srgb, var(--warning-60) 16%, var(--neutral-10))',
      '--background-color-success': 'color-mix(in srgb, var(--success-60) 12%, var(--neutral-10))',
      '--background-color-overlay': 'var(--muxui-semantic-overlay-scrim)',
      '--text-color': 'var(--muxui-semantic-content-default)',
      '--text-color-deemphasized': 'var(--muxui-semantic-content-muted)',
      '--text-color-disabled': 'var(--neutral-50)',
      '--text-color-list-item-hover': 'var(--muxui-semantic-content-default)',
      '--text-color-error': 'var(--muxui-semantic-feedback-invalid-content)',
      '--icon-color': 'var(--muxui-semantic-content-muted)',
      '--icon-color-information': 'var(--color-60)',
      '--icon-color-success': 'var(--success-60)',
      '--icon-color-warning': 'var(--warning-60)',
      '--icon-color-critical': 'var(--error-60)',
      '--border-color': 'var(--neutral-20)',
      '--border-color-deemphasized': 'var(--neutral-16)',
      '--border-color-interactive': 'var(--neutral-30)',
      '--border-color-interactive-hover': 'var(--neutral-40)',
      '--border-color-interactive-active': 'var(--neutral-50)',
      '--border-color-interactive-disabled': 'var(--neutral-20)',
      '--border-color-selected': 'var(--muxui-semantic-action-background)',
      '--border-color-error': 'var(--muxui-semantic-feedback-invalid-border)',
      '--card-background-color': 'var(--neutral-10)',
      '--card-border-color': 'var(--neutral-20)',
      '--card-box-shadow': 'none',
      // Secondary buttons: neutral fills with their own foregrounds.
      '--button-background-color': 'var(--neutral-12)',
      '--button-background-color-hover': 'var(--neutral-16)',
      '--button-background-color-active': 'var(--neutral-20)',
      '--button-background-color-disabled': 'var(--neutral-12)',
      '--button-text-color': 'var(--muxui-semantic-color-neutral-12-fg)',
      '--button-text-color-hover': 'var(--muxui-semantic-color-neutral-16-fg)',
      '--button-text-color-active': 'var(--muxui-semantic-color-neutral-20-fg)',
      '--button-border-color': 'var(--neutral-20)',
      '--button-border-color-hover': 'var(--neutral-20)',
      '--button-border-color-active': 'var(--neutral-20)',
      '--button-background-color-ghost-hover':
        'color-mix(in srgb, var(--neutral-90) 8%, transparent)',
      '--button-background-color-ghost-active': 'var(--neutral-20)',
      '--button-text-color-ghost': 'var(--muxui-semantic-content-default)',
      // Primary buttons, accents and selection: the Mux action roles.
      '--color-accent-primary': 'var(--muxui-semantic-action-background)',
      '--color-accent-primary-hover': 'var(--muxui-semantic-action-background-hover)',
      '--color-accent-primary-active': 'var(--muxui-semantic-action-background-pressed)',
      '--color-accent-primary-selected': 'var(--muxui-semantic-action-background)',
      '--text-color-accent-primary-selected': 'var(--muxui-semantic-action-foreground)',
      '--button-background-color-primary': 'var(--muxui-semantic-action-background)',
      '--button-background-color-primary-hover': 'var(--muxui-semantic-action-background-hover)',
      '--button-background-color-primary-active': 'var(--muxui-semantic-action-background-pressed)',
      '--button-background-color-primary-selected': 'var(--muxui-semantic-action-background)',
      '--button-background-color-primary-disabled': 'var(--muxui-semantic-action-background)',
      '--button-text-color-primary': 'var(--muxui-semantic-action-foreground)',
      '--button-text-color-primary-hover': 'var(--muxui-semantic-action-foreground-hover)',
      '--button-text-color-primary-active': 'var(--muxui-semantic-action-foreground-pressed)',
      '--button-text-color-primary-selected': 'var(--muxui-semantic-action-foreground)',
      '--button-text-color-primary-disabled': 'var(--muxui-semantic-action-foreground)',
      '--button-border-color-primary': 'transparent',
      '--button-border-color-primary-hover': 'transparent',
      '--button-border-color-primary-active': 'transparent',
      '--button-border-color-primary-disabled': 'transparent',
      '--button-background-color-destructive': 'var(--muxui-semantic-action-danger-background)',
      '--button-background-color-destructive-hover':
        'var(--muxui-semantic-action-danger-background-hover)',
      '--button-background-color-destructive-active':
        'var(--muxui-semantic-action-danger-background-pressed)',
      // The danger fills are the error ladder's 60, 70 and 80 steps.
      '--button-text-color-destructive': 'var(--muxui-semantic-color-error-60-fg)',
      '--button-text-color-destructive-hover': 'var(--muxui-semantic-color-error-70-fg)',
      '--button-text-color-destructive-active': 'var(--muxui-semantic-color-error-80-fg)',
      '--link-color': 'var(--muxui-semantic-content-link)',
      '--link-color-hover': 'var(--muxui-semantic-content-link-hover)',
      '--link-color-active': 'var(--muxui-semantic-content-link-pressed)',
      '--link-color-visited': 'var(--muxui-semantic-content-link)',
      '--focus-outline-color': 'var(--muxui-semantic-focus-ring)',
      '--input-border-color': 'var(--neutral-24)',
      '--input-text-color': 'var(--muxui-semantic-content-default)',
      '--table-background-color': 'var(--neutral-10)',
      '--table-row-background-color': 'var(--neutral-10)',
      '--table-row-background-color-alternate': 'var(--neutral-12)',
      '--table-border-color': 'var(--neutral-20)',
      '--table-header-background-color': 'var(--muxui-semantic-action-background)',
      '--table-header-text-color': 'var(--muxui-semantic-action-foreground)',
      // The Passwords sidebar (megalist) reads these.
      '--sidebar-background-color': 'var(--neutral-5)',
      '--sidebar-text-color': 'var(--muxui-semantic-content-default)',
    },
  },
  {
    owner: 'browser/components/sidebar/sidebar.css',
    tokens: {
      '--sidebar-box-background': 'var(--neutral-10)',
      '--sidebar-box-border-color': 'var(--neutral-20)',
      '--sidebar-box-color': 'var(--muxui-semantic-content-default)',
    },
  },
  {
    owner: 'toolkit/themes/shared/aboutSupport.css',
    // about:support redeclares it under prefers-color-scheme: dark.
    tokens: { '--codec-bg-header': 'var(--neutral-20)' },
  },
  {
    owner: 'toolkit/content/widgets/moz-page-nav/moz-page-nav.tokens.css',
    hosts: ['moz-page-nav'],
    tokens: {
      '--page-nav-border-color': 'transparent',
      '--page-nav-hr-background-color': 'var(--neutral-20)',
      '--page-nav-button-background-color-hover': 'var(--neutral-16)',
      '--page-nav-button-background-color-active': 'var(--neutral-20)',
      '--page-nav-button-background-color-selected':
        'color-mix(in srgb, var(--muxui-semantic-action-background) 14%, var(--neutral-12))',
      '--page-nav-button-text-color': 'var(--muxui-semantic-content-default)',
      '--page-nav-button-text-color-hover': 'var(--muxui-semantic-content-default)',
      '--page-nav-button-text-color-active': 'var(--muxui-semantic-content-default)',
      '--page-nav-button-text-color-selected': 'var(--color-90)',
      '--page-nav-button-indicator-background-color': 'var(--muxui-semantic-action-background)',
    },
  },
  {
    owner: 'toolkit/content/widgets/moz-toggle/moz-toggle.tokens.css',
    hosts: ['moz-toggle'],
    tokens: {
      '--toggle-border-color': 'var(--neutral-50)',
      '--toggle-dot-background-color': 'var(--neutral-60)',
      '--toggle-background-color-pressed': 'var(--muxui-semantic-action-background)',
      '--toggle-background-color-pressed-hover': 'var(--muxui-semantic-action-background-hover)',
      '--toggle-background-color-pressed-active': 'var(--muxui-semantic-action-background-pressed)',
      '--toggle-dot-background-color-on-pressed': 'var(--muxui-semantic-action-foreground)',
    },
  },
];

// Root properties the map block also sets.
export const ROOT_DECLARATIONS = {
  'accent-color': 'var(--muxui-semantic-action-background)',
};

// about:privatebrowsing in a private window. With Nova off (prefs/bento.js), Firefox paints a
// purple gradient, purple panels and a purple search field there; these put neutral surfaces in
// their place, with each fill's own foreground.
const PRIVATE_BROWSING = {
  pages: { pages: ['privatebrowsing'], errorPages: [], chrome: [] },
  owner: 'browser/themes/shared/privatebrowsing/aboutPrivateBrowsing.css',
};
const PANEL = {
  background: 'var(--neutral-12)',
  color: 'var(--muxui-semantic-color-neutral-12-fg)',
  'border-color': 'var(--neutral-20)',
  'box-shadow': 'none',
};

// Rules for page elements, scoped to the pages that have them. `owner` is the Firefox file
// whose rule each one replaces. `light` and `dark` declarations apply only in that UI mode:
// they stand in for a page rule under prefers-color-scheme, which follows the content
// colour mode rather than the UI mode.
//
// A rule is written under the themed root (`:root[data-bento-theme][data-color-mode] X`),
// except a `shadow` rule, whose element sits in a shadow tree that a selector from the root
// cannot reach. Its selector stands alone and its values are the sheet's aliases, which exist
// only below a themed root: on an unthemed page they are invalid, so the property falls back
// to what it inherits.
export const PAGE_RULES = [
  {
    pages: 'all',
    selector: 'html, body',
    declarations: {
      'background-color': 'var(--neutral-5)',
      color: 'var(--muxui-semantic-content-default)',
    },
  },
  {
    pages: { pages: ['logins'], errorPages: [], chrome: [] },
    owner: 'browser/components/aboutlogins/content/aboutLogins.css',
    selector: 'login-list',
    // The list column is the sidebar surface; its sort bar and section headers paint
    // --background-color-box. --background-color-canvas stays the page's, because the
    // selected row paints it and stands out on the lighter canvas.
    declarations: {
      'background-color': 'var(--neutral-12)',
      'border-inline-end': '1px solid var(--neutral-20)',
      '--background-color-box': 'var(--neutral-12)',
    },
  },
  {
    // The list's search field, inside login-list's shadow tree, paints
    // --background-color-box; it keeps the page's box value rather than the list's.
    pages: { pages: ['logins'], errorPages: [], chrome: [] },
    owner: 'browser/components/aboutlogins/content/aboutLogins.css',
    selector: 'login-filter',
    shadow: true,
    declarations: { '--background-color-box': 'var(--neutral-10)' },
  },
  {
    // login-item.css redeclares these on :host under prefers-color-scheme.
    pages: { pages: ['logins'], errorPages: [], chrome: [] },
    owner: 'browser/components/aboutlogins/content/components/login-item.css',
    selector: 'login-item',
    declarations: { '--text-color-deemphasized': 'var(--muxui-semantic-content-muted)' },
    light: {
      '--reveal-checkbox-opacity': '0.8',
      '--reveal-checkbox-opacity-hover': '0.6',
      '--reveal-checkbox-opacity-active': '1',
    },
    dark: {
      '--reveal-checkbox-opacity': '0.8',
      '--reveal-checkbox-opacity-hover': '1',
      '--reveal-checkbox-opacity-active': '0.6',
    },
  },
  {
    pages: { pages: ['addons'], errorPages: [], chrome: [] },
    owner: 'toolkit/mozapps/extensions/content/aboutaddons.css',
    selector: '#full > #sidebar',
    declarations: {
      'background-color': 'var(--neutral-12)',
      'border-inline-end': '1px solid var(--neutral-20)',
    },
  },
  {
    pages: { pages: ['addons'], errorPages: [], chrome: [] },
    owner: 'toolkit/mozapps/extensions/content/aboutaddons.css',
    selector: '.sticky-container',
    declarations: { 'background-color': 'var(--neutral-5)' },
  },
  {
    // aboutaddons.css darkens the badge border under prefers-color-scheme: dark.
    pages: { pages: ['addons'], errorPages: [], chrome: [] },
    owner: 'toolkit/mozapps/extensions/content/aboutaddons.css',
    selector: '.addon-badge-recommended, .addon-badge-line',
    declarations: { 'border-color': 'var(--neutral-20)' },
  },
  {
    // aboutNetError.css redeclares it under prefers-color-scheme: dark.
    pages: { pages: [], errorPages: ABOUT_THEME_ERROR_PAGES, chrome: [] },
    owner: 'toolkit/themes/shared/aboutNetError.css',
    selector: 'body',
    declarations: { '--warning-color': 'var(--warning-60)' },
  },
  {
    // progressmeter.css switches the fill under prefers-color-scheme: dark.
    pages: { pages: ['downloads'], errorPages: [], chrome: [] },
    owner: 'browser/themes/shared/downloads/progressmeter.css',
    selector: '#contentAreaDownloadsView',
    declarations: { '--download-progress-fill-color': 'var(--muxui-semantic-action-background)' },
  },
  { ...PRIVATE_BROWSING, selector: 'html', declarations: { 'background-image': 'none' } },
  {
    ...PRIVATE_BROWSING,
    selector: '.info-border',
    declarations: { background: 'none', 'box-shadow': 'none' },
  },
  { ...PRIVATE_BROWSING, selector: '.info, .promo-visible, .promo.top', declarations: PANEL },
  {
    ...PRIVATE_BROWSING,
    selector: '.promo-cta .primary',
    declarations: {
      'background-color': 'var(--muxui-semantic-action-background)',
      color: 'var(--muxui-semantic-action-foreground)',
    },
  },
  {
    ...PRIVATE_BROWSING,
    selector: '.promo-cta .primary:hover',
    declarations: {
      'background-color': 'var(--muxui-semantic-action-background-hover)',
      color: 'var(--muxui-semantic-action-foreground-hover)',
    },
  },
  {
    ...PRIVATE_BROWSING,
    selector: '.promo-cta .primary:hover:active',
    declarations: {
      'background-color': 'var(--muxui-semantic-action-background-pressed)',
      color: 'var(--muxui-semantic-action-foreground-pressed)',
    },
  },
  {
    ...PRIVATE_BROWSING,
    selector: '.promo-cta .primary:focus-visible',
    declarations: { 'outline-color': 'var(--muxui-semantic-focus-ring)' },
  },
  {
    // The search field: an input's neutral fill and border, the focus ring when focused.
    ...PRIVATE_BROWSING,
    selector: 'content-search-handoff-ui',
    declarations: {
      '--content-search-handoff-ui-background-color': 'var(--neutral-10)',
      '--content-search-handoff-ui-color': 'var(--muxui-semantic-color-neutral-10-fg)',
      '--content-search-handoff-ui-fill': 'var(--muxui-semantic-color-neutral-10-fg)',
      '--content-search-handoff-ui-caret-color': 'var(--muxui-semantic-color-neutral-10-fg)',
      '--content-search-handoff-ui-unfocused-border-color': 'var(--neutral-24)',
      '--content-search-handoff-ui-fakefocus-border-color': 'var(--muxui-semantic-focus-ring)',
      '--content-search-handoff-ui-fakefocus-box-shadow-inner': 'var(--muxui-semantic-focus-ring)',
      '--content-search-handoff-ui-fakefocus-box-shadow-outer':
        'color-mix(in srgb, var(--muxui-semantic-focus-ring) 30%, transparent)',
    },
  },
];

/** Every Mux token the map, the root declarations and the page rules reference. */
export function referencedTokens() {
  const values = [
    ...FIREFOX_TOKEN_MAP.flatMap((group) => Object.values(group.tokens)),
    ...Object.values(ROOT_DECLARATIONS),
    ...PAGE_RULES.flatMap((rule) =>
      [rule.declarations, rule.light, rule.dark].flatMap((block) => Object.values(block ?? {})),
    ),
  ];
  const names = new Set();
  for (const value of values) {
    for (const match of value.matchAll(/var\(\s*(--[\w-]+)\s*[,)]/g)) names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * Checks the Firefox side of the map against a Firefox source tree. Returns one message per
 * problem: a mapped token no longer declared in its owner, or a page rule's owner file that
 * is gone or no longer names the rule's custom property or first class or id.
 * `readFile(relativePath)` returns the file's text or null; for a directory owner,
 * `listCss(relativePath)` returns the relative paths of its .css files.
 */
export function checkFirefoxTokens({ readFile, listCss }) {
  const problems = [];
  const ownerText = (owner) => {
    const files = owner.endsWith('.css') ? [owner] : listCss(owner);
    const texts = files.map(readFile).filter((text) => text !== null);
    return texts.length ? texts.join('\n') : null;
  };
  const declares = (text, token) => new RegExp(`(?<![\\w-])${token}\\s*:`).test(text);
  for (const { owner, tokens } of FIREFOX_TOKEN_MAP) {
    const text = ownerText(owner);
    if (text === null) {
      problems.push(`${owner}: missing`);
      continue;
    }
    for (const token of Object.keys(tokens)) {
      if (!declares(text, token)) problems.push(`${owner}: ${token} is not declared`);
    }
  }
  const mapped = new Set(FIREFOX_TOKEN_MAP.flatMap((group) => Object.keys(group.tokens)));
  for (const { owner, selector, declarations, light, dark } of PAGE_RULES) {
    if (!owner) continue;
    const text = ownerText(owner);
    if (text === null) {
      problems.push(`${owner}: missing`);
      continue;
    }
    // The page's own custom properties; mapped tokens are checked above.
    const custom = Object.keys({ ...declarations, ...light, ...dark }).filter(
      (name) => name.startsWith('--') && !mapped.has(name),
    );
    for (const token of custom) {
      if (!declares(text, token)) problems.push(`${owner}: ${token} is not declared`);
    }
    const named = selector.match(/[.#]?[\w-]+/)[0];
    if (!text.includes(named)) problems.push(`${owner}: ${named} is gone`);
  }
  return problems;
}
