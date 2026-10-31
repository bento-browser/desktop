// CSS structure of the light/dark flip fade beyond the layer and list checks in mount-motion.test.mjs:
// the merged twins that keep non-colour transitions, the placeholder carrier's inheritance, and the
// Mux gradient rules whose tint would snap in the flip.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { splitTopLevelBlocks } from '../extensions/bento-shell/css-blocks.mjs';
import { generatedRegion, TARGETS, withRegion } from './fade-twins.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (path) => readFileSync(resolve(REPO, path), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function* rules(css, context = []) {
  for (const { prelude, body } of splitTopLevelBlocks(strip(css))) {
    if (/^@(layer|media|supports|container)\b/.test(prelude)) yield* rules(body, [...context, prelude]);
    else if (!prelude.startsWith('@')) yield { context, selector: prelude.replace(/\s+/g, ' '), body };
  }
}

test('the fade twins in both stylesheets are current', () => {
  // The catch-all replaces an element's whole transition list, which cancelled a workspace switch's
  // running opacity transitions when a flip landed in it. Each rule with a non-colour transition has a
  // generated twin that keeps those entries; a stale region means a transition gained or lost its twin.
  // Regenerate with `node scripts/fade-twins.mjs`.
  for (const target of TARGETS) {
    assert.equal(
      readRepo(target.sheet),
      withRegion(target, generatedRegion(target)),
      `${target.sheet}: run node scripts/fade-twins.mjs`,
    );
  }
});

test('the generator finds the transitions that matter and leaves the delay on colours only', () => {
  const chrome = generatedRegion(TARGETS[0]);
  // The workspace switch: the three opacity transitions the validator saw cancelled.
  assert.match(
    chrome,
    /\[data-bento-mode-fade\] #tabbrowser-tabpanels,\s*\[data-bento-mode-fade\] #bento-strip-container,\s*\[data-bento-mode-fade\] #bento-panel-nav \{\s*transition:\s*opacity var\(--muxui-semantic-motion-state-transition\),\s*var\(--bento-mode-fade-colours\) !important;/,
  );
  // The sidebar collapse keeps its spring transform.
  assert.match(
    chrome,
    /#bento-shell-host\.bento-sidebar-hidden \{\s*transition:\s*transform var\(--muxui-semantic-motion-reveal-transition-spring-duration\)/,
  );
  const shell = generatedRegion(TARGETS[1]);
  assert.match(shell, /\.bento-tab-row \{\s*transition:[^}]*transform var\(--muxui-semantic-motion-reveal-transition\)/);
  for (const region of [chrome, shell]) {
    // Only the shared colour list carries the delay: an own entry stays undelayed.
    const withoutColours = region.replace(/--bento-mode-fade-colours(?:-inherited)?:[^;]*;/g, '');
    assert.ok(!withoutColours.includes('--bento-mode-fade-delay'), 'a twin repeats the colour list, never the delay');
  }
});

test('split-view containers and panel headers take their text colour from their parent', () => {
  // Their own `color` transition is redundant (`color` is inherited and follows the parent's transition),
  // is cancelled when Firefox rewrites the panels' classes in the reconcile, and a restart after that lags
  // the parent's fade. Their rules list the colours without `color`; nothing else drops it.
  const chrome = generatedRegion(TARGETS[0]);
  const all = /--bento-mode-fade-colours:([^;]*);/.exec(chrome)[1];
  const inherited = /--bento-mode-fade-colours-inherited:([^;]*);/.exec(chrome)[1];
  const entries = (list) => list.split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.deepEqual(
    entries(inherited),
    entries(all).filter((entry) => !entry.startsWith('color ')),
  );
  for (const selector of ['.browserSidebarContainer', '.bento-panel-header']) {
    const rule = new RegExp(`\\[data-bento-mode-fade\\] ${selector.replace('.', '\\.')} \\{[^}]*var\\(--bento-mode-fade-colours-inherited\\) !important;`);
    assert.match(chrome, rule, selector);
  }
  assert.equal(chrome.split('var(--bento-mode-fade-colours-inherited) !important').length - 1, 2);
});

test('a placeholder pseudo-element that reads the carrier takes it with an explicit inherit', () => {
  // A pseudo-element does not inherit a non-inherited property from its originating element by
  // itself: --bento-placeholder-fg is registered with inherits: false, so without `inherit` on the
  // pseudo-element rule it resolves to the initial value, transparent, and the placeholder vanishes.
  const sheets = [
    'extensions/bento-shell/src/theme/document-base.css',
    'src/browser/base/content/bento-shell-mount.css',
  ];
  let readers = 0;
  for (const sheet of sheets) {
    for (const { selector, body } of rules(readRepo(sheet))) {
      if (!/var\(--bento-placeholder-fg\)/.test(body) || !selector.includes('::placeholder')) continue;
      readers += 1;
      assert.match(body, /--bento-placeholder-fg:\s*inherit\s*;/, `${sheet}: ${selector}`);
    }
  }
  assert.equal(readers, 2, 'the shell inputs and the chrome panel URL field');
});

test('no shell rule sets a placeholder colour directly', () => {
  // A `color` on ::placeholder switches at the prepare, up to the lead before the fade (the anchored
  // address bar did this). A field with its own placeholder colour sets --bento-placeholder-fg instead.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(REPO, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.css') && !path.includes('/theme/presets/')) {
        for (const { selector, body } of rules(readRepo(path))) {
          if (selector.includes('::placeholder') && /(?:^|[;{\s])color\s*:(?!\s*var\(--bento-placeholder-fg\))/.test(body)) {
            offenders.push(`${path}: ${selector}`);
          }
        }
      }
    }
  };
  walk('extensions/bento-shell/src');
  assert.deepEqual(offenders, []);
});

test('the native tab strip arrows take their icon fill from the registered carrier', () => {
  // The arrows live in #tabbrowser-arrowscrollbox's shadow tree, which the catch-all does not reach.
  // They read the inherited --toolbarbutton-icon-fill, so the strip must set it from the carrier the
  // fade transitions; otherwise the arrows change at prepare, up to the lead before the fade.
  const rule = rules(readRepo('src/browser/base/content/bento-chrome-theme.css')).find(
    ({ selector }) => selector === '#tabbrowser-arrowscrollbox',
  );
  assert.ok(rule, 'the arrowscrollbox rule is missing');
  assert.match(rule.body, /--bento-arrow-fill:\s*var\(--neutral-80\)\s*;/);
  assert.match(rule.body, /--toolbarbutton-icon-fill:\s*var\(--bento-arrow-fill\)\s*;/);
});

test('the Settings pending dim is not drawn while the flip fade is present', () => {
  // Choosing the colour mode is a write that settles inside the lead or the fade, so a dim that
  // applied under the fade would change the value colour twice around the flip and the second change
  // would restart against the fade's transition.
  const css = strip(readRepo('extensions/bento-shell/src/components/SettingsPalette/SettingsPalette.css'));
  const dims = [...css.matchAll(/([^{}]*\.bento-settings-palette__value)\s*\{([^}]*neutral-50[^}]*)\}/g)].filter(
    ([, selector]) => selector.includes('[data-muxui-state-pending]'),
  );
  assert.equal(dims.length, 1, 'one pending dim rule');
  assert.match(dims[0][1].replace(/\s+/g, ' ').trim(), /^:root:not\(\[data-bento-mode-fade\]\) /);
});

test('the theme cards reproduce Mux\'s outlined hover and pressed tint over a carrier', () => {
  // Mux paints a hovered or pressed Card.Button with a gradient over --muxui-semantic-surface-strong,
  // an unregistered custom property. The picker renders the default (outlined) variant, so the local
  // carrier must use the same percentages as Mux's outlined rules.
  const mux = readRepo('node_modules/@muxui/react/generated/styles.css');
  const percent = (state) => {
    const rule = [...rules(mux)].find(
      ({ selector }) => selector.includes('.muxui-card--button.muxui-card--outlined') && selector.includes(`[data-muxui-state-${state}]`),
    );
    return /surface-strong\) (\d+)%/.exec(rule.body)[1];
  };
  const picker = readRepo('extensions/bento-shell/src/components/WorkspaceThemePicker/WorkspaceThemePicker.css');
  for (const state of ['hovered', 'pressed']) {
    const ours = [...rules(picker)].find(({ selector }) => selector.includes(`[data-muxui-state-${state}]`));
    assert.ok(ours, `the picker styles the ${state} card`);
    assert.equal(/surface-strong\) (\d+)%/.exec(ours.body)[1], percent(state));
    assert.match(ours.body, /background-image:\s*linear-gradient\(var\(--bento-card-tint\), var\(--bento-card-tint\)\)/);
  }
});

// Mux components whose hover or pressed tint is a gradient over an unregistered custom property take the
// new mode at once while their fill fades. Bento renders some of them; each is carried or recorded here.
const MUX_GRADIENT_HANDLED = {
  card: '--bento-card-tint (WorkspaceThemePicker.css)',
  'switch-field': '--bento-switch-hover-tint (SettingsPalette.css)',
};
// Rendered, not carried: a hover or pressed tint for one pointer state. Welcome shows once per profile;
// the icon picker's tabs only show these edge buttons when their row overflows.
const MUX_GRADIENT_RESIDUAL = {
  'toggle-button': 'Welcome only, a selected standalone toggle under the pointer',
  tabs: 'WorkspaceIconPicker only, the tabs__motion-edge overflow buttons under the pointer',
  'color-swatch': 'two-tone swatches take fixed theme metadata colours, which do not depend on the mode',
};

test('every Mux gradient tint on a component the shell renders is carried or recorded', () => {
  const mux = readRepo('node_modules/@muxui/react/generated/styles.css');
  const registered = new Set(Array.from(mux.matchAll(/@property\s+(--[\w-]+)/g), (match) => match[1]));
  const rendered = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(REPO, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx$/.test(path) && !/\.(stories|test)\.tsx$/.test(path)) {
        for (const match of readRepo(path).matchAll(/import\s*\{([^}]*)\}\s*from\s*'@muxui\/react[^']*'/g)) {
          for (const name of match[1].split(',')) rendered.add(name.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''));
        }
      }
    }
  };
  walk('extensions/bento-shell/src');
  const exportName = (component) =>
    component.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  const found = new Set();
  for (const { selector, body } of rules(mux)) {
    for (const match of body.matchAll(/(?:linear|radial|conic)-gradient\(/g)) {
      let depth = 1;
      let end = match.index + match[0].length;
      while (depth > 0 && end < body.length) {
        if (body[end] === '(') depth += 1;
        else if (body[end] === ')') depth -= 1;
        end += 1;
      }
      const reads = [...body.slice(match.index, end).matchAll(/var\((--[\w-]+)/g)].map((read) => read[1]);
      if (!reads.some((name) => !registered.has(name))) continue;
      // The component is the first .muxui-<name> class, minus a --variant or __part suffix.
      const component = /\.muxui-([a-z-]+?)(?:--|__|[^a-z-])/.exec(`${selector} `)?.[1];
      if (component) found.add(component);
    }
  }
  const unaccounted = [...found].filter(
    (component) =>
      rendered.has(exportName(component)) &&
      !(component in MUX_GRADIENT_HANDLED) &&
      !(component in MUX_GRADIENT_RESIDUAL),
  );
  assert.deepEqual(unaccounted, [], 'give each a carrier like --bento-card-tint, or record it in MUX_GRADIENT_RESIDUAL');
  for (const component of Object.keys(MUX_GRADIENT_HANDLED)) assert.ok(found.has(component), component);
});
