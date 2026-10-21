// The tooltip the shell's rail merge card asks for (BENTO_RAIL_TOOLTIP). The real
// handler of bento-shell-mount.js runs against fakes: it turns the card's anchor
// (shell-frame coordinates) into the screen-coordinate payload the panel navigator
// tooltip overlay takes, and drives that overlay's existing arm, show and hide path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/browser/base/content/bento-shell-mount.js',
  ),
  'utf8',
);

/** Source of a top-level (2-space indented) function in the mount script. */
function mountFunction(name) {
  const start = source.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}

function mountConst(name) {
  const match = new RegExp(`^ {2}const ${name} = [^;]*;`, 'm').exec(source);
  assert.ok(match, `const ${name} is missing`);
  return match[0];
}

function setup({ shellRect = { left: 0, top: 36 } } = {}) {
  const calls = [];
  let armedShow = null;
  const window = { mozInnerScreenX: 100, mozInnerScreenY: 50 };
  const document = {
    getElementById: (id) =>
      id === 'bento-shell-frame' ? { getBoundingClientRect: () => shellRect } : null,
  };
  const api = vm.runInNewContext(
    `"use strict";
    ${mountConst('RAIL_TOOLTIP_PREFIX')}
    ${mountFunction('parseSidebarTitlePayload')}
    ${mountFunction('handleRailTooltipTitle')}
    ({ handleRailTooltipTitle, RAIL_TOOLTIP_PREFIX });`,
    {
      document,
      window,
      atob,
      escape,
      JSON,
      Number,
      console: { warn() {} },
      hidePanelNavigatorTooltip: () => calls.push(['hide']),
      armPanelNavigatorTooltip: (show) => {
        calls.push(['arm']);
        armedShow = show;
      },
      showPanelNavigatorTooltipPayload: (payload) => calls.push(['show', payload]),
    },
    { filename: 'bento-shell-mount.js#rail-tooltip' },
  );
  const send = (message) => {
    // The shell writes btoa(unescape(encodeURIComponent(json))), which is base64 of UTF-8.
    const b64 = Buffer.from(JSON.stringify(message), 'utf8').toString('base64');
    api.handleRailTooltipTitle(`${api.RAIL_TOOLTIP_PREFIX}1:${b64}`);
  };
  // Objects built inside the vm context have another realm's prototypes.
  const seen = () => JSON.parse(JSON.stringify(calls));
  return { send, calls, seen, runArmed: () => armedShow?.() };
}

const anchor = { left: 7.5, top: 754, width: 36, height: 36 };

test('keyboard focus shows the tooltip at once, beside the anchor in screen coordinates', () => {
  const { send, seen } = setup();
  send({
    action: 'focus',
    label: 'Importing from Firefox',
    detail: 'Work, 120 of 608 tabs',
    anchor,
  });
  assert.deepEqual(seen(), [
    [
      'show',
      {
        label: 'Importing from Firefox',
        detail: 'Work, 120 of 608 tabs',
        placement: 'end',
        screenX: 100 + 0 + 7.5,
        screenY: 50 + 36 + 754,
        width: 36,
        height: 36,
      },
    ],
  ]);
});

test('hover arms the shared hover delay and shows only when it runs out', () => {
  const { send, calls, seen, runArmed } = setup();
  send({ action: 'hover', label: 'Imported 608 tabs', detail: null, anchor });
  assert.deepEqual(seen(), [['arm']]);
  runArmed();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'show');
  assert.equal(calls[1][1].label, 'Imported 608 tabs');
  assert.equal(calls[1][1].detail, undefined);
});

test('hide hides, and needs no anchor', () => {
  const { send, seen } = setup();
  send({ action: 'hide' });
  assert.deepEqual(seen(), [['hide']]);
});

test('ignores a message with no label, no anchor, a non-numeric anchor or no shell frame', () => {
  const { send, seen } = setup();
  send({ action: 'focus', anchor });
  send({ action: 'focus', label: 'x' });
  send({ action: 'focus', label: 'x', anchor: { ...anchor, left: 'nope' } });
  send({ action: 'bogus', label: 'x', anchor });
  assert.deepEqual(seen(), []);
  const noFrame = setup({ shellRect: null });
  noFrame.send({ action: 'focus', label: 'x', anchor });
  assert.deepEqual(noFrame.seen(), []);
});
