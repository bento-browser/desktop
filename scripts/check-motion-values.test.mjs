import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  cssViolations,
  findViolations,
  motionValueProblem,
  scannedFiles,
  scriptViolations,
} from './check-motion-values.mjs';

const TOKEN = 'var(--muxui-semantic-motion-state-transition)';

test('shorthand values pass with Mux motion tokens, property names, keywords and resets', () => {
  for (const value of [
    'none',
    'initial',
    'inherit',
    'unset',
    TOKEN,
    `opacity ${TOKEN}, transform ${TOKEN}`,
    `all ${TOKEN} !important`,
    'bento-spin var(--muxui-semantic-motion-progress-spin-duration) var(--muxui-semantic-motion-constant-easing) infinite',
    'x var(--muxui-semantic-motion-progress-sweep-duration) var(--muxui-semantic-motion-progress-easing) 2 both',
    'x calc(var(--muxui-semantic-motion-progress-sweep-duration) / 12)',
  ]) {
    assert.equal(motionValueProblem('animation', value), null, value);
    assert.equal(motionValueProblem('transition', value), null, value);
  }
});

test('the mode flip fade delay carrier is accepted as a transition delay and nowhere else', () => {
  const delay = 'var(--bento-mode-fade-delay)';
  // The delay position of a transition item that already has its Mux duration, and the longhand.
  assert.equal(motionValueProblem('transition', `color ${TOKEN} ${delay}`), null);
  assert.equal(
    motionValueProblem('transition', `color ${TOKEN} ${delay}, fill ${TOKEN} ${delay} !important`),
    null,
  );
  assert.equal(motionValueProblem('transition-delay', delay), null);
  // As a duration, an easing or an animation time it would stand in for a Mux motion token.
  for (const [property, value] of [
    ['transition-duration', delay],
    ['transition-timing-function', delay],
    ['animation-duration', delay],
    ['animation-delay', delay],
    ['animation', `x ${delay}`],
    ['animation', `x ${TOKEN} ${delay}`],
    ['transition', `color ${delay}`],
    ['transition', `color var(--muxui-semantic-motion-state-transition-easing) ${delay}`],
  ]) {
    assert.match(motionValueProblem(property, value) ?? '', /only a transition delay/, `${property}: ${value}`);
  }
});

test('the fade twins may repeat the shared colour list as a whole transition item only', () => {
  const colours = 'var(--bento-mode-fade-colours)';
  assert.equal(motionValueProblem('transition', `opacity ${TOKEN}, ${colours}`), null);
  assert.equal(motionValueProblem('transition', `${colours} !important`), null);
  // As a longhand, a duration or inside an animation it would stand in for a Mux motion token.
  for (const [property, value] of [
    ['transition-duration', colours],
    ['transition-delay', colours],
    ['animation', colours],
    ['transition', `color ${colours}`],
  ]) {
    assert.notEqual(motionValueProblem(property, value), null, `${property}: ${value}`);
  }
});

test('raw times, easing keywords and functions, and other var() reads fail', () => {
  const cases = {
    'opacity 200ms': /raw time 200ms/,
    'opacity 0.2s': /raw time 0.2s/,
    'opacity 0s': /raw time 0s/,
    [`opacity ${TOKEN} ease`]: /raw easing ease/,
    'opacity var(--muxui-semantic-motion-state-duration) ease-in-out': /raw easing ease-in-out/,
    'opacity var(--muxui-semantic-motion-state-duration) linear': /raw easing linear/,
    'opacity var(--muxui-semantic-motion-state-duration) cubic-bezier(0, 0, 1, 1)':
      /cubic-bezier\(\) is not a Mux motion token/,
    'opacity var(--muxui-semantic-motion-state-duration) steps(4)': /steps\(\)/,
    'opacity var(--bento-duration-fast) var(--bento-easing-standard)': /var\(\) must name/,
    [`opacity ${TOKEN} var(--bento-mode-fade-delay, 0s)`]: /no fallback/,
    'opacity var(--muxui-semantic-motion-state-transition, 200ms ease)': /no fallback/,
    'opacity var(--muxui-semantic-color-neutral-5)': /var\(\) must name/,
    'opacity calc(var(--muxui-semantic-motion-state-duration) + 50ms)': /raw time 50ms in calc/,
    'opacity calc(var(--other) / 2)': /calc\(\) may only combine/,
  };
  for (const [value, problem] of Object.entries(cases)) {
    assert.match(motionValueProblem('transition', value) ?? '', problem, value);
  }
});

test('duration, delay and timing-function longhands accept only Mux motion tokens', () => {
  const ok = 'var(--muxui-semantic-motion-reveal-transition-duration)';
  assert.equal(motionValueProblem('transition-duration', ok), null);
  assert.equal(
    motionValueProblem(
      'animation-delay',
      'calc(var(--muxui-semantic-motion-progress-sweep-duration) / 12)',
    ),
    null,
  );
  assert.equal(motionValueProblem('animation-timing-function', 'initial'), null);
  assert.match(motionValueProblem('transition-duration', '0.3s') ?? '', /raw time/);
  assert.match(motionValueProblem('transition-timing-function', 'ease') ?? '', /raw easing/);
  assert.match(motionValueProblem('animation-duration', '.my-name') ?? '', /not a --muxui/);
});

test('cssViolations reads declarations only: not comments, selectors, other properties or custom properties', () => {
  const css = `
    /* transition: opacity 200ms ease; */
    .a { transition: opacity 0.2s ease; }
    .b { content: "transition: 1s"; animation-name: spin; --duration: 200ms; transition-property: opacity; }
    .c:hover { transition: ${TOKEN} }
    .d { background: url("x;transition: 1s.png"); animation: none !important; transition: none }
    @media (prefers-reduced-motion: reduce) { .e { animation-duration: 1100ms } }
  `;
  assert.deepEqual(
    cssViolations(css).map(({ line, property }) => [line, property]),
    [
      [3, 'transition'],
      [7, 'animation-duration'],
    ],
  );
});

test('cssViolations follows declarations in nested rules and multi-line values', () => {
  const css = `.a {
    .b {
      transition:
        opacity ${TOKEN},
        width 120ms;
    }
  }`;
  const [violation] = cssViolations(css);
  assert.equal(violation?.line, 3);
  assert.match(violation?.problem ?? '', /raw time 120ms/);
});

test('scriptViolations flags raw times and easings in strings, templates, cssText and style writes', () => {
  const source = `
    el.style.cssText = 'position: absolute;' + ' transition: opacity 0.18s ease;';
    el.style.transition = \`opacity \${FADE_MS}ms ease\`;
    el.style.transition = 'transform var(--bento-duration-base) var(--bento-easing-standard)';
    el.style.transitionTimingFunction = 'ease-out';
    el.style.animation = 'spin 1s linear infinite';
    const a = { transition: 'width var(--muxui-semantic-motion-reveal-transition), height 150ms' };
    const b = 'cubic-bezier(0.32, 0.72, 0, 1)';
    const c = ['opacity 140ms var(--muxui-semantic-motion-state-transition)'];
  `;
  assert.deepEqual(
    scriptViolations(source).map(({ line }) => line),
    [2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('scriptViolations accepts token-based styles, resets, URLs, comments and regular expressions', () => {
  const source = `
    // el.style.transition = 'opacity 200ms ease';
    /* animation: spin 1s linear; */
    el.style.cssText = ' transition: opacity var(--muxui-semantic-motion-modal-transition);';
    el.style.transition = 'none';
    el.style.transition = '';
    el.style.transition = 'opacity ' + reveal;
    el.style.transition = 'transform var(--muxui-semantic-motion-reveal-transition)';
    const reveal = 'var(--muxui-semantic-motion-reveal-transition)';
    const a = { transition: 'width var(--muxui-semantic-motion-reveal-transition)' };
    const link = 'https://linear.app/inbox';
    const time = /^(-?\\d+)(ms|s)$/i.exec(value);
    const split = a / 2 + "s";
    transitions.push('width ' + reveal);
    const ids = ['transition-delay', 'transitionend'];
    el.addEventListener('transitionend', done);
  `;
  assert.deepEqual(scriptViolations(source), []);
});

test('scriptViolations ignores time-like text that is not a motion value', () => {
  const source = `
    const label = "Retry in 30s";
    const hint = 'Takes about 200ms, or 1.5s on a slow disk';
    toast(\`Saved \${count} files, 5s ago\`);
    const timeout = '30s';
    const note = { label: 'Cancel in 10s' };
  `;
  assert.deepEqual(scriptViolations(source), []);
});

test('scriptViolations still flags a raw time in a motion declaration or style value', () => {
  const source = `
    const label = "Retry in 30s";
    el.style.cssText = 'transition: opacity 30s';
    el.style.transition = 'opacity 30s';
    el.style.animationDuration = '30s';
    const a = { animation: 'spin 30s linear' };
    const b = 'opacity 30s var(--muxui-semantic-motion-state-transition)';
    const c = \`.x { transition: opacity \${ms}s; }\`;
  `;
  assert.deepEqual(
    scriptViolations(source).map(({ line }) => line),
    [3, 4, 5, 6, 7, 8],
  );
});

test('scriptViolations flags a raw motion value in either branch of a conditional style assignment', () => {
  const source = `
    el.style.transition = enabled ? 'opacity 200ms ease-out' : 'none';
    el.style.transition = reduced ? 'none' : 'opacity 200ms';
    el.style.animationDuration = (override ?? fallback) || '250ms';
    el.style.transition = enabled
      ? \`opacity \${ms}ms\`
      : 'none';
    const style = { transition: enabled ? 'opacity 200ms' : 'none' };
  `;
  assert.deepEqual(
    scriptViolations(source).map(({ line }) => line),
    [2, 3, 4, 6, 8],
  );
  assert.deepEqual(
    scriptViolations(`
      el.style.transition = enabled ? 'opacity var(--muxui-semantic-motion-state-transition)' : 'none';
      el.style.transition = reduced ? 'none' : '';
    `),
    [],
  );
});

test('scriptViolations flags a raw value under a quoted transition or animation key', () => {
  const source = `
    const style = { 'transitionDuration': '250ms' };
    const kebab = { "transition-duration": "250ms", 'animation-timing-function': 'ease-out' };
    const rest = { opacity: 1, 'animation': 'spin 1s linear infinite' };
  `;
  assert.deepEqual(
    scriptViolations(source).map(({ line }) => line),
    [2, 3, 3, 4],
  );
  assert.deepEqual(
    scriptViolations(`
      const style = { 'transitionDuration': 'var(--muxui-semantic-motion-reveal-transition-duration)' };
    `),
    [],
  );
});

test('scriptViolations flags a raw value passed to style.setProperty for a motion property', () => {
  const source = `
    el.style.setProperty('transition-duration', '250ms');
    el.style.setProperty("animation-timing-function", enabled ? 'ease-out' : 'initial');
    el.style.setProperty('transition', 'opacity 200ms', 'important');
  `;
  assert.deepEqual(
    scriptViolations(source).map(({ line }) => line),
    [2, 3, 4],
  );
  assert.deepEqual(
    scriptViolations(`
      el.style.setProperty('transition-duration', 'var(--muxui-semantic-motion-reveal-transition-duration)');
      el.style.setProperty('transition-property', 'opacity');
    `),
    [],
  );
});

test('scriptViolations keeps ignoring time-like copy next to conditionals, keys and setProperty', () => {
  const source = `
    const label = enabled ? 'Retry in 30s' : 'Done in 5s';
    const info = { 'label': 'Retry in 30s', 'transitionName': 'Fade in 2s' };
    el.style.setProperty('--timeout-label', '30s');
    el.style.setProperty('width', enabled ? '30s' : '5s');
    const duration = style.getPropertyValue('transition-duration') || '250ms ago';
    el.style.transition = 'none';
    const next = enabled ? 'Retry in 30s' : '';
    const entry = { transition: 'none', label: 'Retry in 30s' };
    el.style.transition = pick('Retry in 30s');
    switch (kind) { case 'animation': return 'Takes 30s'; }
    // el.style.transition = flag ? 'opacity 200ms' : 'none';
    const re = /transition = /; const text = 'Takes 30s';
  `;
  assert.deepEqual(scriptViolations(source), []);
});

test('scriptViolations reads strings after a template literal with nested expressions', () => {
  const source = 'const x = `a ${fn("b") + `${c}`} d`; el.style.transition = \'opacity 1s\';';
  assert.deepEqual(
    scriptViolations(source).map(({ problem }) => problem),
    ['raw time 1s'],
  );
});

test('scannedFiles covers shell and chrome and skips generated CSS', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-motion-values-'));
  try {
    const bad = '.a { transition: opacity 200ms ease; }\n';
    const files = {
      'extensions/bento-shell/src/a.css': true,
      'extensions/bento-shell/src/theme/presets/index.css': false,
      'extensions/bento-shell/public/themes/x.css': false,
      'src/browser/base/content/bento-shell-mount.css': true,
      'src/browser/base/content/bento-chrome-theme.css': true,
      'src/browser/base/content/bento-chrome-tokens.css': false,
      'src/browser/base/content/bento-chrome-themes/dark.css': false,
    };
    for (const file of Object.keys(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), bad);
    }
    for (const [file, text] of Object.entries({
      'extensions/bento-shell/src/App.tsx': "el.style.transition = 'opacity 500ms ease';\n",
      'extensions/bento-shell/src/App.test.tsx': "el.style.transition = 'opacity 500ms ease';\n",
      'src/browser/base/content/bento-shell-mount.js':
        "x.style.transition = 'opacity 0.18s ease';\n",
    })) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }

    const expected = [
      ...Object.entries(files)
        .filter(([, scanned]) => scanned)
        .map(([file]) => file),
      'extensions/bento-shell/src/App.tsx',
      'src/browser/base/content/bento-shell-mount.js',
    ].sort();
    assert.deepEqual(
      scannedFiles(root)
        .map(({ file }) => file)
        .sort(),
      expected,
    );
    assert.deepEqual(
      findViolations(root)
        .map(({ file }) => file)
        .sort(),
      expected,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
