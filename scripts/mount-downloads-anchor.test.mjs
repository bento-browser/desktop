// The anchor Firefox's own downloads opens attach to (DownloadsButton.getAnchor in the
// sidebar-addressbar mode). The real functions of bento-shell-mount.js run against a fake
// shell frame: the shell reports where its Downloads button is as distances from its
// viewport's right and bottom edges (BENTO_DOWNLOADS_ANCHOR), and chrome builds the anchor
// from those and the frame's rect when the panel opens.
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

function setup(shellRect) {
  const elements = new Map();
  const frame = { getBoundingClientRect: () => shellRect };
  const document = {
    documentElement: { appendChild: (el) => elements.set(el.id, el) },
    getElementById: (id) => (id === 'bento-shell-frame' ? frame : (elements.get(id) ?? null)),
    createElementNS: () => ({ style: {}, setAttribute() {} }),
  };
  const api = vm.runInNewContext(
    `"use strict";
    ${mountConst('HTML_NS')}
    ${mountConst('DOWNLOADS_ANCHOR_PREFIX')}
    ${mountConst('DOWNLOADS_BUTTON_EDGES_DEFAULT')}
    let downloadsButtonEdges = DOWNLOADS_BUTTON_EDGES_DEFAULT;
    ${mountFunction('ensureSidebarFooterAnchor')}
    ${mountFunction('parseSidebarTitlePayload')}
    ${mountFunction('parseSidebarAnchorPayload')}
    ${mountFunction('handleDownloadsAnchorTitle')}
    ${mountFunction('ensureSidebarDownloadsFallbackAnchor')}
    ({ handleDownloadsAnchorTitle, ensureSidebarDownloadsFallbackAnchor, DOWNLOADS_ANCHOR_PREFIX });`,
    { document, atob, escape, JSON, Math, Number, console: { warn() {} } },
    { filename: 'bento-shell-mount.js#downloads-anchor' },
  );
  const report = (anchor) => {
    // The shell writes btoa(unescape(encodeURIComponent(json))), which is base64 of UTF-8.
    const b64 = Buffer.from(JSON.stringify({ anchor }), 'utf8').toString('base64');
    api.handleDownloadsAnchorTitle(`${api.DOWNLOADS_ANCHOR_PREFIX}1:${b64}`);
  };
  const box = () => {
    const style = api.ensureSidebarDownloadsFallbackAnchor().style.cssText;
    const read = (prop) => Number(new RegExp(`${prop}: (-?\\d+)px`).exec(style)[1]);
    return { left: read('left'), top: read('top'), width: read('width'), height: read('height') };
  };
  return { api, report, box };
}

// The shell frame sits 36 px below the window top, as in the expanded layout.
const EXPANDED = { left: 0, top: 36, width: 300, height: 1004 };
const RAIL = { left: 0, top: 36, width: 52, height: 1004 };

test('before any report the anchor covers the expanded footer Downloads button', () => {
  const { box } = setup(EXPANDED);
  // The button measured at x 257, y 962 inside the frame, 32 px square.
  assert.deepEqual(box(), { left: 257, top: 36 + 962, width: 32, height: 32 });
});

test('a report places the anchor over the button wherever the footer stacked it', () => {
  const { report, box } = setup(RAIL);
  // The rail: centered in 52 px, Downloads at the top of the column-reverse stack
  // (one merge ring below the idle position).
  report({ right: 10, bottom: 233, width: 32, height: 32 });
  assert.deepEqual(box(), { left: 10, top: 36 + 1004 - 233 - 32, width: 32, height: 32 });
});

test('the anchor follows a resize of the frame without a new report', () => {
  const rect = { ...EXPANDED };
  const { report, box } = setup(rect);
  report({ right: 11, bottom: 10, width: 32, height: 32 });
  assert.equal(box().left, 257);
  rect.width = 420;
  rect.height = 800;
  assert.deepEqual(box(), { left: 377, top: 36 + 800 - 10 - 32, width: 32, height: 32 });
});

test('a malformed report keeps the last good one', () => {
  const { api, report, box } = setup(EXPANDED);
  report({ right: 20, bottom: 50, width: 32, height: 32 });
  const good = box();
  report({ right: 'x', bottom: 50, width: 32, height: 32 });
  report({ right: 20, bottom: 50, width: 0, height: 32 });
  api.handleDownloadsAnchorTitle(`${api.DOWNLOADS_ANCHOR_PREFIX}1:not base64 !`);
  api.handleDownloadsAnchorTitle(`${api.DOWNLOADS_ANCHOR_PREFIX}garbled`);
  assert.deepEqual(box(), good);
});

test('there is no anchor while the shell frame is missing', () => {
  const { api } = setup(EXPANDED);
  assert.ok(api.ensureSidebarDownloadsFallbackAnchor());
  const none = vm.runInNewContext(
    `"use strict"; ${mountConst('HTML_NS')}
    const DOWNLOADS_BUTTON_EDGES_DEFAULT = { right: 11, bottom: 10, width: 32, height: 32 };
    let downloadsButtonEdges = DOWNLOADS_BUTTON_EDGES_DEFAULT;
    ${mountFunction('ensureSidebarFooterAnchor')}
    ${mountFunction('ensureSidebarDownloadsFallbackAnchor')}
    ensureSidebarDownloadsFallbackAnchor();`,
    { document: { getElementById: () => null } },
  );
  assert.equal(none, null);
});
