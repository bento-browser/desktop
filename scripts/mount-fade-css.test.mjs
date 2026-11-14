// CSS structure of the light/dark flip fade beyond the layer and list checks in mount-motion.test.mjs:
// the merged twins that keep non-colour transitions, the placeholder carrier's inheritance, and the
// Mux gradient rules whose tint would snap in the flip.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { splitTopLevelBlocks } from '../extensions/bento-shell/css-blocks.mjs';
import { generatedRegion, splitTop, TARGETS, twinRules, twinText, withRegion } from './fade-twins.mjs';

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

test('the Bookmarks view host fades in on modal and out on modal-dismiss, and keeps both through a flip', () => {
  // The host takes no inline transition (it would lose to the fade's catch-all, which is !important),
  // so the fade lives in the mount stylesheet: the exit role on the host, the enter role while the
  // root attribute is set. Each rule has a generated twin in the chrome theme's fade layer.
  const mount = readRepo('src/browser/base/content/bento-shell-mount.js');
  assert.match(mount, /hostId: 'bento-bookmarks-host',\s*zIndex: \d+,\s*inlineFade: false,/);

  const transition = (path, selector) => {
    const rule = [...rules(readRepo(path))].find((candidate) => candidate.selector === selector);
    assert.ok(rule, `${path}: no rule for ${selector}`);
    return /transition:\s*([^;]*)/.exec(rule.body)[1].replace(/\s+/g, ' ').trim();
  };
  const exit = 'opacity var(--muxui-semantic-motion-modal-dismiss-transition)';
  const enter = 'opacity var(--muxui-semantic-motion-modal-transition)';
  const mountSheet = 'src/browser/base/content/bento-shell-mount.css';
  assert.equal(transition(mountSheet, '#bento-bookmarks-host'), exit);
  assert.equal(transition(mountSheet, ':root[bento-bookmarks-view] #bento-bookmarks-host'), enter);

  const chrome = 'src/browser/base/content/bento-chrome-theme.css';
  const colours = 'var(--bento-mode-fade-colours) !important';
  assert.equal(transition(chrome, '[data-bento-mode-fade] #bento-bookmarks-host'), `${exit}, ${colours}`);
  // The enter twin is more specific than the exit twin, as the sources are.
  assert.equal(
    transition(chrome, ':root[data-bento-mode-fade][bento-bookmarks-view] #bento-bookmarks-host'),
    `${enter}, ${colours}`,
  );
});

test('the Bookmarks view top-bar controls slide out on dismiss and back on reveal, staggered from the outer edge', () => {
  // Back, Forward, Reload and the panel navigator (left, by id) and the right-hand controls (counted
  // from the last child) are children of #nav-bar-customization-target, a sibling of the window
  // button box. Each step starts 0.08 of the role's duration after the one before; the way out
  // hides them (visibility) after the last step, the way back has no visibility entry. Delays are
  // literal fractions because lint:motion allows only plain numbers in a calc().
  const mountSheet = 'src/browser/base/content/bento-shell-mount.css';
  const chrome = 'src/browser/base/content/bento-chrome-theme.css';
  const fractions = ['0', '0.08', '0.16', '0.24'];
  const left = ['#back-button', '#forward-button', '#stop-reload-button', '#bento-panel-nav'];
  const others = ':not(#back-button, #forward-button, #stop-reload-button, #bento-panel-nav)';
  const fromEnd = ['nth-last-child(1)', 'nth-last-child(2)', 'nth-last-child(3)', 'nth-last-child(n + 4)'];
  const selectorOf = (prefix, step, first = left[step]) =>
    `${prefix}#nav-bar-customization-target > :is( ${first}, ${others}:${fromEnd[step]} )`;
  const entries = (rule) =>
    splitTop(/transition:\s*([^;]*)/.exec(rule.body)[1].replace(/\s*!important\s*$/, ''), /,/).map(
      (entry) => entry.replace(/\s+/g, ' ').trim(),
    );
  const find = (path, selector, context = (c) => !c.some((at) => at.includes('reduced-motion'))) => {
    const rule = [...rules(readRepo(path))].find(
      (candidate) => candidate.selector === selector && context(candidate.context),
    );
    assert.ok(rule, `${path}: no rule for ${selector}`);
    return rule;
  };
  const motion = (role, delay) =>
    `var(--muxui-semantic-motion-${role}-transition) calc(var(--muxui-semantic-motion-${role}-transition-duration) * ${delay})`;
  const colours = 'var(--bento-mode-fade-colours)';
  const resting = [];
  const dismissing = [];

  for (let step = 0; step < 4; step += 1) {
    const out = [
      `translate ${motion('dismiss', fractions[step])}`,
      `opacity ${motion('dismiss', fractions[step])}`,
      // Hidden after the slowest control has arrived: the dismiss duration plus the last delay.
      `visibility ${motion('dismiss', fractions[3])}`,
    ];
    const back = [
      `translate ${motion('reveal', fractions[step])}`,
      `opacity ${motion('reveal', fractions[step])}`,
    ];
    // The panel navigator hands its opacity fade to the workspace switch while it is stabilizing.
    const restingFirst = step === 3 ? '#bento-panel-nav:not(.bento-workspace-stabilizing)' : left[step];
    const view = ':root[bento-bookmarks-view] ';
    const viewFade = ':root[data-bento-mode-fade][bento-bookmarks-view] ';
    const fade = '[data-bento-mode-fade] ';
    assert.deepEqual(entries(find(mountSheet, selectorOf(view, step))), out);
    assert.deepEqual(entries(find(mountSheet, selectorOf('', step, restingFirst))), back);
    // Twins keep the slide through a colour-mode flip and add the shared colour list.
    assert.deepEqual(entries(find(chrome, selectorOf(viewFade, step))), [...out, colours]);
    assert.deepEqual(entries(find(chrome, selectorOf(fade, step, restingFirst))), [...back, colours]);
    dismissing.push(out);
    resting.push(back);
  }
  // No step lets a control wait longer than the visibility flip, and the return never hides one.
  for (const out of dismissing) assert.ok(out.at(-1).endsWith(`* ${fractions[3]})`));
  for (const back of resting) assert.ok(back.every((entry) => !entry.startsWith('visibility')));

  // Opening slides each control up by its own height plus twice the toolbar's top inset, fades it
  // and takes away its pointer events at once; reduced motion keeps the controls in place and the
  // change instant.
  const open = find(mountSheet, ':root[bento-bookmarks-view] #nav-bar-customization-target > *');
  assert.match(open.body, /translate:\s*0 calc\(-100% - 2 \* var\(--bento-toolbar-top-inset\)\)/);
  assert.match(open.body, /opacity:\s*0/);
  assert.match(open.body, /pointer-events:\s*none/);
  const reduced = (context) => context.some((at) => at.includes('prefers-reduced-motion: reduce'));
  assert.match(
    find(mountSheet, ':root[bento-bookmarks-view] #nav-bar-customization-target > *', reduced).body,
    /translate:\s*none/,
  );
  assert.match(
    find(mountSheet, '#nav-bar-customization-target > *', reduced).body,
    /transition:\s*none !important/,
  );
});

test('settle zeros explicit colour/carrier duration and delay without replacing retained motion', () => {
  const zero = 'calc(var(--muxui-semantic-motion-state-transition-duration) * 0)';
  for (const target of TARGETS) {
    const css = readRepo(target.sheet);
    const blocks = [...rules(css)];
    const normal = blocks.find(({ selector }) => selector === ':root[data-bento-mode-fade]');
    const settled = blocks.find(({ selector }) => selector === ":root[data-bento-mode-fade='settle']");
    const list = (block) => splitTop(/--bento-mode-fade-colours:\s*([^;]+);/.exec(block.body)[1], /,/);
    const ordinary = list(normal);
    const instant = list(settled);
    const property = (entry) => splitTop(entry, /\s/)[0];
    assert.deepEqual(instant.map(property), [...ordinary.map(property), ...(target.settleCarriers ?? [])]);
    for (const entry of ordinary) assert.ok(entry.includes('var(--bento-mode-fade-delay)'));
    for (const entry of instant) {
      const [, duration, easing, delay] = splitTop(entry, /\s/);
      assert.equal(duration, zero);
      assert.equal(delay, zero);
      assert.equal(easing, 'var(--muxui-semantic-motion-state-transition-easing)');
    }
    if (target.inheritColour?.length) {
      assert.match(settled.body, /--bento-mode-fade-colours-inherited:\s*(?:[^;]*,\s*)?color calc\(var\(--muxui-semantic-motion-state-transition-duration\) \* 0\)/);
    }
    assert.ok(!instant.some((entry) => /^(all|opacity|transform|clip-path|block-size|inline-size)\s/.test(entry)));
    const catchAll = blocks.findIndex(({ selector, body }) =>
      selector.includes(":root[data-bento-mode-fade='settle'] *::after") && body.includes('transition:'));
    const firstTwin = blocks.findIndex(({ selector }) => selector.startsWith('[data-bento-mode-fade] '));
    assert.ok(catchAll >= 0 && catchAll < firstTwin, 'settle catch-all precedes equally specific retained-motion twins');
    assert.match(blocks[catchAll].body, /transition:\s*var\(--bento-mode-fade-colours\) !important/);
    assert.ok(!/transition-(?:duration|delay):/.test(settled.body), 'no global longhand reset can zero geometry');
  }
});

test('explicit colours remain after a retained all and footer fill is instant only in settle', () => {
  const target = TARGETS[1];
  const css = readRepo(target.sheet);
  const properties = new Set(['color', 'background-color']);
  const generated = twinText(twinRules('.fixture { transition: all var(--muxui-semantic-motion-state-transition); }', properties));
  assert.match(generated, /transition:\s*all var\(--muxui-semantic-motion-state-transition\),\s*var\(--bento-mode-fade-colours\) !important;/);
  const blocks = [...rules(css)];
  const normal = blocks.find(({ selector }) => selector === ':root[data-bento-mode-fade]');
  const settle = blocks.find(({ selector }) => selector === ":root[data-bento-mode-fade='settle']");
  assert.ok(!normal.body.includes('--bento-footer-fill'));
  assert.match(settle.body, /--bento-footer-fill calc\(var\(--muxui-semantic-motion-state-transition-duration\) \* 0\)/);
  const footer = blocks.find(({ selector }) => selector.includes('html[data-bento-mode-fade][data-bento-rail-transition] .bento-shell-app__footer'));
  assert.match(footer.body, /transition:\s*--bento-footer-fill var\(--muxui-semantic-motion-reveal-transition-spring-duration\) var\(--muxui-semantic-motion-reveal-transition-spring-easing\),\s*var\(--bento-mode-fade-colours\) !important;/);
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
  // SwitchField's Button carries Switch's .muxui-switch class, so its tint is Switch's rule.
  switch: '--bento-switch-hover-tint (SettingsPalette.css, SwitchField)',
};
// Rendered, not carried: a hover or pressed tint for one pointer state. Welcome shows once per profile;
// the icon picker's tabs only show these edge buttons when their row overflows.
const MUX_GRADIENT_RESIDUAL = {
  'toggle-button': 'Welcome only, a selected standalone toggle under the pointer',
  tabs: 'WorkspaceIconPicker only, the tabs__motion-edge overflow buttons under the pointer',
  'color-swatch': 'two-tone swatches take fixed theme metadata colours, which do not depend on the mode',
  checkbox: 'Bookmarks view only, a hovered or pressed to-do checkbox',
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
