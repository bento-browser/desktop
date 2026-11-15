import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findClosingBrace,
  splitTopLevelBlocks,
  themeIdsInSelector,
  unwrapTopLevelLayers,
} from '../extensions/bento-shell/css-blocks.mjs';
import {
  ABOUT_THEME_ACTOR_MATCHES,
  ABOUT_THEME_CHROME_DOCUMENTS,
  checkFirefoxTokens,
  documentConditions,
  FIREFOX_TOKEN_MAP,
  referencedTokens,
} from './about-page-themes.mjs';
import { MUX_THEMES_CSS, parseDeclarations } from './mux-css.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = resolve(REPO_ROOT, 'scripts/generate-chrome-tokens.mjs');
const SHELL_SHEETS = resolve(REPO_ROOT, 'extensions/bento-shell/public/themes');

test('findClosingBrace skips braces in comments and strings', () => {
  const css = `a { content: "}"; /* } */ b: c; } d {}`;
  assert.equal(findClosingBrace(css, css.indexOf('{')), css.indexOf('} d'));
});

test('splitTopLevelBlocks returns preludes without comments and skips block-less statements', () => {
  const blocks = splitTopLevelBlocks(`
    /* header */
    @layer muxui, bento;
    [data-x='1'] /* note */ { --a: 1; }
    @media (x) { .y { --b: 2; } }
  `);
  assert.deepEqual(
    blocks.map(({ prelude }) => prelude),
    ["@layer muxui, bento;\n    [data-x='1']", '@media (x)'],
  );
});

test('top-level scanning skips braces in comments between blocks', () => {
  const css = `/* license { text */ .a { --x: 1; } /* } */ @layer m { .b { --y: 2; } }`;
  assert.deepEqual(
    splitTopLevelBlocks(css).map(({ prelude }) => prelude),
    ['.a', '@layer m'],
  );
  assert.equal(
    unwrapTopLevelLayers(css).replace(/\s+/g, ' ').trim(),
    '/* license { text */ .a { --x: 1; } .b { --y: 2; }',
  );
});

test('unwrapTopLevelLayers removes layer wrappers and keeps other blocks', () => {
  const squash = (css) => css.replace(/\s+/g, ' ').trim();
  assert.equal(
    squash(
      unwrapTopLevelLayers('/* c */ @layer muxui { .a { --x: 1; } .b { --y: 2; } } .c { --z: 3; }'),
    ),
    '.a { --x: 1; } .b { --y: 2; } .c { --z: 3; }',
  );
  assert.equal(
    unwrapTopLevelLayers('@media (x) { .a { --x: 1; } }'),
    '@media (x) { .a { --x: 1; } }',
  );
});

test('themeIdsInSelector reads quoted and bare theme attribute tests', () => {
  assert.deepEqual(
    themeIdsInSelector(
      `[data-muxui-theme='standard-harbour']:not([data-muxui-color-scheme='dark']), [data-bento-theme="x"], [data-bento-theme=y]`,
    ),
    ['standard-harbour', 'x', 'y'],
  );
  assert.deepEqual(themeIdsInSelector(':root'), []);
});

function generate() {
  const directory = mkdtempSync(join(tmpdir(), 'bento-chrome-tokens-'));
  const output = join(directory, 'bento-chrome-tokens.css');
  execFileSync(process.execPath, [GENERATOR, '--output', output], { stdio: 'pipe' });
  return {
    directory,
    base: readFileSync(output, 'utf8'),
    about: readFileSync(join(directory, 'bento-about-themes.css'), 'utf8'),
    themesDir: join(directory, 'bento-chrome-themes'),
  };
}

const shellThemeIds = readdirSync(SHELL_SHEETS)
  .filter((name) => name.endsWith('.css'))
  .map((name) => name.slice(0, -'.css'.length));

test('chrome base sheet carries the shared tokens and the Default theme only', () => {
  const { directory, base } = generate();
  try {
    assert.match(base, /--shadow-l:/);
    assert.match(base, /--font-size-root:/);
    assert.match(base, /\[data-bento-theme='default'\]/);
    for (const id of shellThemeIds) {
      assert.ok(!base.includes(`data-bento-theme='${id}'`), `base sheet must not carry ${id}`);
    }
    // bento-tokens.css brings its own `bento.tokens` layer; no Mux layer or import.
    assert.doesNotMatch(base, /data-muxui-|@import|@layer muxui/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Chrome's rem is the system UI font (11px on macOS) but the shell's is --font-size-root.
// Chrome sizes #bento-shell-host (collapsed rail) and #bento-add-panel-trailer from these
// tokens while the shell lays itself out inside them, and sets the panel header URL text and
// the panel navigator menu at Mux's text-s, so each must be the same length in
// both documents: the shell reads the rem form at its root size, chrome reads the pinned px.
const CHROME_ROOT_PX = 11;
const SHELL_LAID_OUT_TOKENS = [
  '--bento-tab-strip-width-collapsed',
  '--bento-panel-trailer-button-size',
  '--bento-panel-trailer-grid-gap',
  '--bento-panel-trailer-inline-padding',
  '--bento-panel-trailer-grid-width',
  '--bento-panel-trailer-wide-width',
  '--bento-panel-trailer-base-width',
  '--bento-panel-url-font-size',
  '--bento-panel-nav-menu-font-size',
];

// Evaluates a token the way a document with this root font size would: var() followed,
// rem at `rootPx`, calc() and max() reduced to a number. `pinned` overrides declarations.
function createLengthEvaluator(css, rootPx, pinned = new Map()) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const evaluate = (name) => {
    const declared =
      pinned.get(name) ?? bare.match(new RegExp(`(?<![\\w-])${name}:\\s*([^;{}]+);`))?.[1];
    assert.ok(declared, `${name} is declared`);
    const expression = declared
      .replace(/var\(\s*(--[\w-]+)\s*\)/g, (_match, ref) => `(${evaluate(ref)})`)
      .replace(/(\d*\.?\d+)rem\b/g, (_match, rem) => rem * rootPx)
      .replace(/(\d*\.?\d+)px\b/g, '$1')
      .replace(/calc\(/g, '(')
      .replace(/max\(/g, 'Math.max(');
    assert.match(
      expression,
      /^[\d.\s()+*/,-]*(Math\.max[\d.\s()+*/,-]*)*$/,
      `${name}: ${declared}`,
    );
    return Function(`return (${expression});`)();
  };
  return evaluate;
}

test('chrome reads shell-sized lengths at the shell root font size', () => {
  const { directory, base } = generate();
  try {
    const marker = base.indexOf('Shell-sized lengths');
    assert.ok(marker > 0, 'the base sheet carries the pinned block');
    const pinned = new Map(
      Array.from(base.slice(marker).matchAll(/^\s+(--[\w-]+): ([^;]+);/gm), (m) => [m[1], m[2]]),
    );
    for (const [name, value] of pinned) assert.doesNotMatch(value, /rem|var\(/, name);
    const rootPx = Number.parseFloat(base.match(/--font-size-root:\s*([\d.]+)px/)[1]);
    const shell = createLengthEvaluator(base, rootPx);
    const chrome = createLengthEvaluator(base, CHROME_ROOT_PX, pinned);
    for (const name of SHELL_LAID_OUT_TOKENS) {
      assert.ok(
        Math.abs(chrome(name) - shell(name)) < 1e-6,
        `${name}: chrome ${chrome(name)}px, shell ${shell(name)}px`,
      );
    }
    // Unpinned, chrome's rem makes the trailer's select width shorter, so this fails if the
    // comparison above goes vacuous.
    const unpinned = createLengthEvaluator(base, CHROME_ROOT_PX);
    assert.ok(
      unpinned('--bento-panel-trailer-wide-width') < shell('--bento-panel-trailer-wide-width'),
    );
    // Mux's text-s is 0.83125rem: 13.3px in the shell, so the URL text is 13.3px in chrome too.
    assert.ok(Math.abs(chrome('--bento-panel-url-font-size') - 13.3) < 1e-6);
    assert.ok(unpinned('--bento-panel-url-font-size') < 13.3);
    // Mux's text-s is 0.83125rem: 13.3px in the shell, 9.1px from chrome's own rem.
    assert.ok(Math.abs(chrome('--bento-panel-nav-menu-font-size') - 13.3) < 1e-6);
    assert.ok(unpinned('--bento-panel-nav-menu-font-size') < 13.3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chrome theme sheets are native, unlayered, and scoped to one theme each', () => {
  const { directory, themesDir } = generate();
  try {
    const files = readdirSync(themesDir).sort();
    assert.deepEqual(files, shellThemeIds.map((id) => `${id}.css`).sort());
    assert.ok(files.length >= 15);
    for (const id of shellThemeIds) {
      const sheet = readFileSync(join(themesDir, `${id}.css`), 'utf8');
      assert.match(
        sheet,
        /^\/\* This Source Code Form is subject to the terms of the Mozilla Public/,
      );
      assert.doesNotMatch(sheet, /data-muxui-|@layer|@import|html\[/);
      const ids = new Set(themeIdsInSelector(sheet.replace(/\/\*[\s\S]*?\*\//g, '')));
      assert.deepEqual([...ids], [id]);
      assert.match(sheet, /--muxui-/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('regenerating prunes sheets for removed themes', () => {
  const { directory, themesDir } = generate();
  try {
    writeFileSync(join(themesDir, 'removed-theme.css'), '/* stale */');
    writeFileSync(join(themesDir, 'notes.txt'), 'kept');
    execFileSync(
      process.execPath,
      [GENERATOR, '--output', join(directory, 'bento-chrome-tokens.css')],
      {
        stdio: 'pipe',
      },
    );
    const files = readdirSync(themesDir);
    assert.ok(!files.includes('removed-theme.css'));
    assert.ok(files.includes('notes.txt'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A checkout with this repository's scripts and config, and its extensions/ (theme sheets) and
// hoisted node_modules/ (Mux) linked in, so the generator runs with its default output path inside the copy.
function generatorCheckout() {
  const directory = mkdtempSync(join(tmpdir(), 'bento-token-copy-'));
  const root = join(directory, 'checkout');
  mkdirSync(root);
  cpSync(resolve(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(resolve(REPO_ROOT, 'configs'), join(root, 'configs'), { recursive: true });
  cpSync(resolve(REPO_ROOT, 'bento.json'), join(root, 'bento.json'));
  symlinkSync(resolve(REPO_ROOT, 'extensions'), join(root, 'extensions'), 'dir');
  symlinkSync(resolve(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  const run = () =>
    spawnSync(process.execPath, [join(root, 'scripts', 'generate-chrome-tokens.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, BENTO_OBJDIR: '' },
    });
  const sheet = join(root, 'src/browser/base/content/bento-chrome-tokens.css');
  const appChrome = (engine) =>
    join(engine, 'obj-bento/dist/Bento.app/Contents/Resources/browser/chrome/browser/content/browser');
  return { directory, root, run, sheet, appChrome };
}

test('the generator writes its sheet but skips the app copy when engine/ is borrowed', () => {
  const { directory, root, run, sheet, appChrome } = generatorCheckout();
  try {
    const foreign = join(directory, 'other-engine');
    mkdirSync(appChrome(foreign), { recursive: true });
    symlinkSync(foreign, join(root, 'engine'), 'dir');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(sheet, 'utf8').includes('AUTO-GENERATED'));
    const skipped = result.stdout.match(/^generate-chrome-tokens: content copy skipped: .*$/gm) ?? [];
    assert.equal(skipped.length, 1, result.stdout);
    assert.match(skipped[0], /build outputs are borrowed \(.*engine -> .*other-engine\)/);
    assert.equal(existsSync(join(appChrome(foreign), 'bento-chrome-tokens.css')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the generator copies into its own objdir and fails when that copy fails', () => {
  const { directory, root, run, sheet, appChrome } = generatorCheckout();
  const target = appChrome(join(root, 'engine'));
  try {
    mkdirSync(target, { recursive: true });
    const copied = run();
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(readFileSync(join(target, 'bento-chrome-tokens.css'), 'utf8'), readFileSync(sheet, 'utf8'));

    rmSync(join(target, 'bento-chrome-tokens.css'));
    chmodSync(target, 0o555);
    const failed = run();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /refreshing the built app copy failed/);
  } finally {
    chmodSync(target, 0o755);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--themes-dir overrides the sibling directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bento-chrome-tokens-'));
  try {
    const themesDir = join(directory, 'elsewhere');
    mkdirSync(directory, { recursive: true });
    execFileSync(
      process.execPath,
      [GENERATOR, '--output', join(directory, 'tokens.css'), '--themes-dir', themesDir],
      { stdio: 'pipe' },
    );
    assert.ok(readdirSync(themesDir).includes('standard-harbour.css'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Bento projects Mux's APCA preset stylesheet. These pairs are where it chooses a different text
// colour from the WCAG 2 themes.css, so each must reach the shell sheet and the chrome sheet as
// Mux wrote it.
const muxRequire = createRequire(resolve(REPO_ROOT, 'extensions/bento-shell/package.json'));
const readMux = (name) => readFileSync(muxRequire.resolve(name), 'utf8');
const APCA_SAMPLES = [
  ['standard-harbour', 'light', '--muxui-semantic-color-color-40-fg'],
  ['standard-harbour', 'dark', '--muxui-semantic-action-foreground'],
  ['standard-lagoon', 'dark', '--muxui-semantic-color-color-60-fg'],
  ['standard-violet-dusk', 'light', '--muxui-semantic-color-neutral-50-fg'],
  ['monochrome-teal', 'dark', '--muxui-semantic-color-color-50-fg'],
];
const CHROME_ATTRIBUTES = {
  theme: 'data-bento-theme',
  scheme: 'data-color-mode',
  contrast: 'data-bento-contrast',
};
const MUX_ATTRIBUTES = {
  theme: 'data-muxui-theme',
  scheme: 'data-muxui-color-scheme',
  contrast: 'data-muxui-contrast',
};

// The selector Mux writes for one theme's contrast 'standard' rule in one color scheme.
function standardSelector(id, scheme, { theme, scheme: mode, contrast } = MUX_ATTRIBUTES) {
  const dark = `[${mode}='dark']`;
  return `[${theme}='${id}']${scheme === 'dark' ? dark : `:not(${dark})`}:not([${contrast}='more'])`;
}

const squashSelector = (selector) =>
  selector.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

// Top-level rules of a sheet with its layer statement and wrappers removed, selectors
// whitespace-normalised.
const sheetRules = (css) =>
  splitTopLevelBlocks(unwrapTopLevelLayers(css.replace(/@layer[^{};]*;/g, ''))).map(
    ({ prelude, body }) => ({
      selector: squashSelector(prelude),
      declarations: parseDeclarations(body),
    }),
  );

function declaredValue(css, selector, token) {
  const rules = sheetRules(css).filter((rule) => rule.selector === selector);
  assert.equal(rules.length, 1, `one rule for ${selector}`);
  const value = rules[0].declarations.get(token);
  assert.ok(value, `${selector} declares ${token}`);
  return value.replace(/\s+/g, ' ');
}

// A selector that matches only under contrast 'more': a positive test outside :not().
const requiresContrastMore = (selector) =>
  /contrast='more'\]/.test(selector.replace(/:not\([^()]*\)/g, ''));

test('the APCA preset stylesheet is the source the generated headers name', () => {
  assert.equal(MUX_THEMES_CSS, '@muxui/react/themes-apca.css');
  const digest = createHash('sha256').update(readMux(MUX_THEMES_CSS)).digest('hex');
  const presetsIndex = readFileSync(
    resolve(REPO_ROOT, 'extensions/bento-shell/src/theme/presets/index.css'),
    'utf8',
  );
  assert.ok(presetsIndex.includes(`${MUX_THEMES_CSS} sha256:${digest}`), 'presets index header');
  const { directory, base } = generate();
  try {
    assert.ok(base.includes(`${MUX_THEMES_CSS} sha256:${digest}`), 'chrome base header');
    for (const sheet of [presetsIndex, base]) {
      assert.doesNotMatch(sheet, /@muxui\/react\/themes\.css/);
    }
    for (const [id] of APCA_SAMPLES) {
      const shell = readFileSync(join(SHELL_SHEETS, `${id}.css`), 'utf8');
      assert.ok(shell.includes(`Source: public ${MUX_THEMES_CSS}, contrast standard.`), id);
      assert.doesNotMatch(shell, /@muxui\/react\/themes\.css/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('APCA text colours survive shell splitting and chrome conversion', () => {
  const apca = readMux(MUX_THEMES_CSS);
  const wcag = readMux('@muxui/react/themes.css');
  const { directory, themesDir } = generate();
  try {
    for (const [id, scheme, token] of APCA_SAMPLES) {
      const label = `${id} ${scheme} ${token}`;
      const muxSelector = standardSelector(id, scheme);
      const expected = declaredValue(apca, muxSelector, token);
      // Fails if the two Mux files agree here, which would make this sample prove nothing.
      assert.notEqual(declaredValue(wcag, muxSelector, token), expected, `${label} differs`);
      const shell = readFileSync(join(SHELL_SHEETS, `${id}.css`), 'utf8');
      assert.equal(declaredValue(shell, muxSelector, token), expected, `shell ${label}`);
      const chrome = readFileSync(join(themesDir, `${id}.css`), 'utf8');
      const chromeSelector = standardSelector(id, scheme, CHROME_ATTRIBUTES);
      assert.equal(declaredValue(chrome, chromeSelector, token), expected, `chrome ${label}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('contrast more rules stay absent from shell and chrome theme sheets', () => {
  // Mux ships them, so an absent rule below is Bento's projection, not the input.
  assert.ok(
    sheetRules(readMux(MUX_THEMES_CSS)).some((rule) => requiresContrastMore(rule.selector)),
  );
  const { directory, themesDir } = generate();
  try {
    for (const id of shellThemeIds) {
      for (const sheet of [join(SHELL_SHEETS, `${id}.css`), join(themesDir, `${id}.css`)]) {
        const rules = sheetRules(readFileSync(sheet, 'utf8'));
        assert.ok(rules.length > 0, sheet);
        for (const { selector } of rules) {
          assert.ok(!requiresContrastMore(selector), `${sheet}: ${selector}`);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Bento's Default theme is Harbour under Bento's id: sync-theme-presets.mjs requires Harbour's
// ladders in default.css and copies Harbour's text colours (the `*-fg` endpoint choices, which
// every other foreground role aliases) from the APCA preset stylesheet into Default's rules.
const DEFAULT_SOURCE = 'standard-harbour';
const TEXT_COLOUR = /^--muxui-semantic-color-[a-z-]+-\d+-fg$/;
const squashValue = (value) =>
  value.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim().toLowerCase();

// The declarations of every rule with exactly this selector, later rules winning.
function ruleDeclarations(css, selector) {
  const rules = sheetRules(css).filter((rule) => rule.selector === selector);
  assert.ok(rules.length > 0, `a rule for ${selector}`);
  return new Map(rules.flatMap((rule) => [...rule.declarations]));
}

test('Default carries Harbour ladders and APCA text colours through shell and chrome', () => {
  const apca = readMux(MUX_THEMES_CSS);
  const wcag = readMux('@muxui/react/themes.css');
  const shell = readFileSync(
    resolve(REPO_ROOT, 'extensions/bento-shell/src/theme/presets/index.css'),
    'utf8',
  );
  const { directory, base: chrome } = generate();
  try {
    const projections = [
      [
        'shell',
        shell,
        (scheme) => `[data-muxui-theme='default'][data-muxui-color-scheme='${scheme}']`,
      ],
      ['chrome', chrome, (scheme) => `[data-bento-theme='default'][data-color-mode='${scheme}']`],
    ];
    let apcaChoices = 0;
    for (const scheme of ['light', 'dark']) {
      const harbourSelector = standardSelector(DEFAULT_SOURCE, scheme);
      const harbour = ruleDeclarations(apca, harbourSelector);
      const harbourWcag = ruleDeclarations(wcag, harbourSelector);
      const textColours = [...harbour].filter(([token]) => TEXT_COLOUR.test(token));
      assert.ok(textColours.length >= 30, `${scheme}: Harbour declares its text colours`);
      for (const [label, css, selector] of projections) {
        const defaults = ruleDeclarations(css, selector(scheme));
        for (const [token, value] of textColours) {
          assert.equal(
            squashValue(defaults.get(token) ?? 'missing'),
            squashValue(value),
            `${label} ${scheme} ${token}`,
          );
        }
      }
      // Fails if Harbour's APCA and WCAG 2 text colours agree, which would make this prove nothing.
      apcaChoices += textColours.filter(
        ([token, value]) => harbourWcag.get(token) !== value,
      ).length;
    }
    assert.ok(apcaChoices > 0, 'APCA chooses some Harbour text colour differently from WCAG 2');

    // Harbour's text colours fit only Harbour's backgrounds, so the ladders must match too.
    const harbourLight = ruleDeclarations(apca, standardSelector(DEFAULT_SOURCE, 'light'));
    const ladder = [...harbourLight].flatMap(([token, value]) => {
      const match = token.match(/^--muxui-reference-color-(brand|neutral)-(\d+)$/);
      if (!match) return [];
      return [
        [match[1] === 'brand' ? `--brand-${match[2]}` : `--neutral-default-${match[2]}`, value],
      ];
    });
    assert.ok(ladder.length >= 30, 'Harbour declares its ladders');
    for (const [label, css] of projections) {
      const defaults = ruleDeclarations(css, "[data-bento-theme='default']");
      for (const [token, value] of ladder) {
        assert.equal(defaults.get(token)?.toLowerCase(), value.toLowerCase(), `${label} ${token}`);
      }
      // No hand-set legacy text colour: each one only aliases the Mux role above.
      for (const { selector, declarations } of sheetRules(css)) {
        for (const [token, value] of declarations) {
          if (!/^--(?:color|neutral)-\d+-fg$/.test(token)) continue;
          assert.match(
            value,
            /^var\(--muxui-semantic-color-[a-z-]+-\d+-fg\)$/,
            `${label} ${selector} ${token}`,
          );
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The base sheet's Default theme rules and alias bridge select on the root's Bento attributes,
// so a native document that links it statically gets Mux's unscoped values without them.
// Each HTML document a patch or source overlay gives the token sheet must carry
// data-bento-theme="default" and data-color-mode on its root.
const TOKEN_SHEET_HREF = 'chrome://browser/content/bento-chrome-tokens.css';

// The patched files of a patch, each as the lines of its hunks after the patch applies.
function patchedFiles(patch) {
  return patch
    .split(/^diff --git /m)
    .slice(1)
    .map((section) => ({
      path: section.match(/^\+\+\+ b\/(.+)$/m)?.[1],
      after: section
        .split('\n')
        .filter((line) => /^[ +]/.test(line) && !line.startsWith('+++'))
        .map((line) => line.slice(1))
        .join('\n'),
    }));
}

function tokenSheetDocuments() {
  const documents = [];
  const patchDirectory = resolve(REPO_ROOT, 'patches');
  const patches = readdirSync(patchDirectory, { recursive: true }).filter((name) =>
    name.endsWith('.patch'),
  );
  for (const name of patches) {
    for (const { path, after } of patchedFiles(readFileSync(join(patchDirectory, name), 'utf8'))) {
      if (/\.x?html$/.test(path ?? '')) documents.push({ label: `${name}: ${path}`, text: after });
    }
  }
  const overlayDirectory = resolve(REPO_ROOT, 'src/browser');
  for (const name of readdirSync(overlayDirectory, { recursive: true })) {
    if (/\.x?html$/.test(name)) {
      const text = readFileSync(join(overlayDirectory, name), 'utf8');
      documents.push({ label: `src/browser/${name}`, text });
    }
  }
  return documents.filter(({ text }) => text.includes(TOKEN_SHEET_HREF));
}

// Documents in the about: page sheet's scope get both attributes at runtime, from the
// BentoAboutTheme actor or (megalist) the mount script, so a static attribute there would only
// force a theme or mode.
const THEMED_AT_RUNTIME = ['/aboutLogins.html', '/aboutLoginsImportReport.html', '/megalist.html'];

test('native documents that link the chrome token sheet carry the Default theme and a mode', () => {
  const documents = tokenSheetDocuments();
  for (const page of [
    '/preferences.xhtml',
    '/aboutLogins.html',
    '/aboutLoginsImportReport.html',
    '/megalist.html',
    '/bento-migration-host.html',
  ]) {
    assert.ok(
      documents.some(({ label }) => label.endsWith(page)),
      `${page} links the token sheet`,
    );
  }
  for (const { label, text } of documents) {
    if (THEMED_AT_RUNTIME.some((page) => label.endsWith(page))) {
      assert.doesNotMatch(text, /\sdata-(?:bento-theme|color-mode|theme)=/, label);
      assert.doesNotMatch(text, /<meta name="color-scheme" content="light"\s*\/?>/, label);
      continue;
    }
    const root = text.match(/<html\b[^>]*>/)?.[0];
    assert.ok(root, `${label} has its <html> root in view`);
    assert.match(root, /\sdata-bento-theme="default"/, `${label} root theme`);
    assert.match(root, /\sdata-color-mode="(?:light|dark)"/, `${label} root mode`);
  }
});

// ─── About: page sheet ───────────────────────────────────────────────

/** The top-level @-moz-document blocks of the about: page sheet. */
const documentBlocks = (css) =>
  splitTopLevelBlocks(css).map(({ prelude, body }) => {
    assert.match(prelude, /^@-moz-document /);
    return {
      conditions: prelude
        .slice('@-moz-document '.length)
        .split(/,\s*/)
        .map((condition) => condition.trim()),
      body,
    };
  });

// Firefox keeps its own high-contrast styling under forced colours and under macOS Increase
// Contrast, which sets prefers-contrast: more without forced colours.
const ABOUT_MEDIA = '@media not ((forced-colors) or (prefers-contrast: more))';

/** The style rules inside one @-moz-document block, after its high-contrast wrapper. */
function aboutRules(body) {
  const inner = splitTopLevelBlocks(body);
  assert.equal(inner.length, 1, 'one block inside @-moz-document');
  assert.equal(inner[0].prelude, ABOUT_MEDIA);
  return splitTopLevelBlocks(inner[0].body).map(({ prelude, body: rule }) => ({
    selector: squashSelector(prelude),
    declarations: parseDeclarations(rule),
    body: rule,
  }));
}

test('the about: page sheet is scoped to exact in-scope URLs and never to Settings', () => {
  const { directory, about } = generate();
  try {
    const blocks = documentBlocks(about.replace(/\/\*[\s\S]*?\*\//g, ''));
    assert.deepEqual(blocks[0].conditions, documentConditions());
    for (const page of ['logins', 'loginsimportreport', 'addons', 'privatebrowsing', 'downloads']) {
      for (const condition of [
        `url("about:${page}")`,
        `url-prefix("about:${page}?")`,
        `url-prefix("about:${page}#")`,
      ]) {
        assert.ok(blocks[0].conditions.includes(condition), condition);
      }
    }
    for (const page of ['config', 'support', 'profiles', 'processes', 'policies']) {
      assert.ok(blocks[0].conditions.includes(`url("about:${page}")`), page);
    }
    for (const page of ['neterror', 'certerror', 'httpsonlyerror']) {
      assert.ok(blocks[0].conditions.includes(`url-prefix("about:${page}?")`), page);
    }
    assert.ok(blocks[0].conditions.includes('url("chrome://global/content/megalist/megalist.html")'));
    for (const { conditions } of blocks) {
      for (const condition of conditions) {
        // A bare about: prefix would also match about:blank in web processes.
        assert.match(
          condition,
          /^(?:url\("(?:about:[a-z]+|chrome:\/\/[^"]+)"\)|url-prefix\("about:[a-z]+[?#]"\))$/,
          condition,
        );
        assert.ok(blocks[0].conditions.includes(condition), `${condition} is in scope`);
      }
    }
    assert.doesNotMatch(about, /about:(?:preferences|settings|blank|newtab|home)\b/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the about: page sheet has a literal block for every theme and mode', () => {
  const { directory, base, about } = generate();
  try {
    const rules = documentBlocks(about).flatMap(({ body }) => aboutRules(body));
    const aliases = referencedTokens().map((token) => `--bento-about-${token.slice(2)}`);
    const themeBlock = (id, mode) =>
      rules.find(
        ({ selector }) =>
          selector ===
          `:root[data-bento-theme${id === 'default' ? '' : `='${id}'`}][data-color-mode='${mode}']`,
      );
    const actions = new Set();
    for (const id of ['default', ...shellThemeIds]) {
      const values = {};
      for (const mode of ['light', 'dark']) {
        const block = themeBlock(id, mode);
        assert.ok(block, `${id} ${mode}`);
        assert.deepEqual([...block.declarations.keys()].sort(), [...aliases].sort(), `${id} ${mode}`);
        for (const [alias, value] of block.declarations) {
          assert.doesNotMatch(value, /var\(|rem\b/, `${id} ${mode} ${alias}`);
        }
        values[mode] = block.declarations;
        actions.add(block.declarations.get('--bento-about-muxui-semantic-action-background'));
      }
      assert.notEqual(
        values.light.get('--bento-about-neutral-5'),
        values.dark.get('--bento-about-neutral-5'),
        `${id}: light and dark canvases differ`,
      );
    }
    assert.ok(actions.size >= shellThemeIds.length, 'the themes have their own accents');
    // Default comes first: its blocks also select a theme id that has no block of its own.
    assert.equal(rules.indexOf(themeBlock('default', 'light')), 0);
    // Default's canvas is the Harbour ladder the base sheet declares for Default.
    assert.equal(
      themeBlock('default', 'light').declarations.get('--bento-about-neutral-5').toLowerCase(),
      ruleDeclarations(base, "[data-bento-theme='default']").get('--neutral-default-5').toLowerCase(),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the about: page sheet leaves no var() unresolved and steps aside for high contrast', () => {
  const { directory, about } = generate();
  try {
    const bare = about.replace(/\/\*[\s\S]*?\*\//g, '');
    const declared = new Set(Array.from(bare.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]));
    const referenced = new Set(Array.from(bare.matchAll(/var\(\s*(--[\w-]+)/g), (match) => match[1]));
    assert.ok(referenced.size > 20);
    for (const name of referenced) {
      assert.ok(declared.has(name), `${name} is declared in the sheet`);
      assert.match(name, /^--bento-about-/, `${name} is one of the sheet's own aliases`);
    }
    assert.doesNotMatch(bare, /var\([^)]*,/, 'no var() fallback');
    // Every rule sits inside @-moz-document and the high-contrast wrapper (aboutRules asserts
    // it), and outside the literal blocks every declaration is !important.
    assert.equal(
      bare.match(/@media [^{]*/g).length,
      documentBlocks(bare).length,
      'no other @media rule, so nothing applies under forced colours or prefers-contrast: more',
    );
    for (const { body } of documentBlocks(bare)) {
      for (const { selector, body: rule } of aboutRules(body)) {
        if (/^:root\[data-bento-theme[^\]]*\]\[data-color-mode='(?:light|dark)'\]$/.test(selector) &&
          /--bento-about-/.test(rule.split(':')[0])) {
          continue;
        }
        for (const declaration of rule.split(';').map((part) => part.trim()).filter(Boolean)) {
          assert.match(declaration, /!important$/, `${selector}: ${declaration}`);
        }
      }
    }
    // Every mapped Firefox token is set in the map block.
    const map = documentBlocks(bare)
      .flatMap(({ body }) => aboutRules(body))
      .find(({ selector }) => selector === ':root[data-bento-theme][data-color-mode]');
    for (const { tokens } of FIREFOX_TOKEN_MAP) {
      for (const token of Object.keys(tokens)) assert.ok(map.declarations.has(token), token);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The map names Firefox tokens; a Firefox upgrade that renames one would silently drop it.
// BENTO_FIREFOX_SOURCE (or this checkout's engine/) points at a Firefox tree; without one
// the engine check is skipped and only the fixture runs.
const fileReader = (root) => ({
  readFile: (relative) => {
    try {
      return readFileSync(join(root, relative), 'utf8');
    } catch {
      return null;
    }
  },
  listCss: (relative) => {
    try {
      return readdirSync(join(root, relative))
        .filter((name) => name.endsWith('.css'))
        .map((name) => `${relative}/${name}`);
    } catch {
      return [];
    }
  },
});

test('the Firefox token check reports a token its owner no longer declares', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bento-about-tokens-'));
  try {
    const owners = new Set(
      FIREFOX_TOKEN_MAP.map(({ owner }) => owner).filter((owner) => owner.endsWith('.css')),
    );
    const write = (relative, text) => {
      mkdirSync(dirname(join(directory, relative)), { recursive: true });
      writeFileSync(join(directory, relative), text);
    };
    for (const { owner, tokens } of FIREFOX_TOKEN_MAP) {
      const text = Object.keys(tokens)
        .map((token) => `${token}: red;`)
        .join('\n');
      write(owner.endsWith('.css') ? owner : `${owner}/tokens-shared.css`, text);
    }
    assert.ok(owners.size > 0);
    const problems = checkFirefoxTokens(fileReader(directory));
    // The page rules' owner files are absent from the fixture.
    assert.ok(problems.every((problem) => / missing$/.test(problem)), problems.join('\n'));
    const designSystem = join(directory, FIREFOX_TOKEN_MAP[0].owner, 'tokens-shared.css');
    writeFileSync(designSystem, readFileSync(designSystem, 'utf8').replace('--text-color:', '--text-colour:'));
    assert.ok(
      checkFirefoxTokens(fileReader(directory)).includes(
        `${FIREFOX_TOKEN_MAP[0].owner}: --text-color is not declared`,
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every Firefox token the about: page map sets still exists in the Firefox tree', (t) => {
  const engine = process.env.BENTO_FIREFOX_SOURCE || join(REPO_ROOT, 'engine');
  if (!existsSync(join(engine, 'toolkit/themes/shared/design-system'))) {
    t.skip(`no Firefox tree at ${engine}; set BENTO_FIREFOX_SOURCE`);
    return;
  }
  assert.deepEqual(checkFirefoxTokens(fileReader(engine)), []);
});

// bento-shell-mount.js registers the actor with these and syncs these chrome documents.
const MOUNT_SOURCE = readFileSync(
  resolve(REPO_ROOT, 'src/browser/base/content/bento-shell-mount.js'),
  'utf8',
);
const mountStrings = (name) => {
  const body = MOUNT_SOURCE.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1];
  assert.ok(body, `${name} is in the mount script`);
  return Array.from(body.matchAll(/'([^']*)'/g), (match) => match[1]);
};

test('the mount script mirrors the about: page scope', () => {
  assert.deepEqual(mountStrings('BENTO_ABOUT_THEME_MATCHES'), ABOUT_THEME_ACTOR_MATCHES);
  assert.deepEqual(mountStrings('BENTO_ABOUT_THEME_CHROME_DOCUMENTS'), ABOUT_THEME_CHROME_DOCUMENTS);
  // The actor matches what the sheet scopes to, minus the chrome documents.
  const sheetPages = documentConditions({ chrome: [] }).map((condition) =>
    condition.replace(/^url\("(.*)"\)$/, '$1').replace(/^url-prefix\("(.*)"\)$/, '$1*'),
  );
  assert.deepEqual(sheetPages, ABOUT_THEME_ACTOR_MATCHES);
});

test('the build ships the about: page sheet and actor', () => {
  const patch = (name) => readFileSync(resolve(REPO_ROOT, 'patches', name), 'utf8');
  assert.match(
    patch('chrome-layout/01-bento-shell-mount.patch'),
    /^\+ +content\/browser\/bento-about-themes\.css +\(content\/bento-about-themes\.css\)$/m,
  );
  assert.match(
    patch('chrome-layout/04-bento-key-actors.patch'),
    /^\+ +"BentoAboutThemeChild\.sys\.mjs",$/m,
  );
  assert.ok(MOUNT_SOURCE.includes("'chrome://browser/content/bento-about-themes.css'"));
  assert.ok(MOUNT_SOURCE.includes("'resource:///actors/BentoAboutThemeChild.sys.mjs'"));
  assert.ok(existsSync(resolve(REPO_ROOT, 'src/browser/actors/BentoAboutThemeChild.sys.mjs')));
});
