// How computePanelLayoutGeometry of bento-shell-mount.js reads a side panel's width while a
// live layout refresh (the tabpanels ResizeObserver, a splitter drag) runs. The refresh prefers
// each panel's rendered width over the width the last panels/sync carried, so a drag does not
// snap its neighbours. A panel that is still in its enter animation (animatePanelEnter grows it
// from 0) renders a width that is mid-animation, and the refresh used to write that width back
// as the panel's size: a panel opened while the panel column was resizing (the bookmarks toolbar
// sliding in, a window resize) stayed a few dozen pixels wide. The real functions run against
// fake elements here; the enter animation is modelled by the test setting the rendered width.
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

const CONSTANTS = ['MOTION_SLACK_MS', 'MOTION_UNAVAILABLE_CEILING_MS', 'motionWaits'];
const FUNCTIONS = [
  'motionList',
  'motionTimeMs',
  'measureMotion',
  'cancelMotion',
  'afterMotion',
  'animatePanelEnter',
  'cssLengthToPx',
  'tokenPx',
  'panelSplitterSizePx',
  'clampLayoutRatio',
  'getTrailerLayoutWidth',
  'computePanelLayoutGeometry',
];

const PANEL_TAB_ID = 7;
const PAYLOAD_WIDTH = 640;
const REVEAL_MS = 400;

function makeWorld() {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const frames = [];
  const world = { renderedWidth: PAYLOAD_WIDTH };

  const panel = {
    isConnected: true,
    style: {
      removeProperty(name) {
        delete this[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())];
      },
    },
    getBoundingClientRect: () => ({ width: world.renderedWidth }),
    addEventListener() {},
    removeEventListener() {},
  };
  const tabpanels = { clientWidth: 1352, clientHeight: 800 };
  const computedStyle = (el) => {
    if (el === tabpanels) {
      return {
        paddingLeft: '7px',
        paddingRight: '7px',
        paddingTop: '5px',
        paddingBottom: '5px',
        columnGap: '14px',
        gap: '14px',
      };
    }
    // The enter animation's inline transition, once it is set; nothing runs before that.
    const running = typeof panel.style.transition === 'string';
    return {
      transitionProperty: running ? 'opacity, width, min-width' : 'all',
      transitionDuration: running ? `${REVEAL_MS}ms` : '0s',
      transitionDelay: '0s',
      animationName: 'none',
      animationDuration: '0s',
      animationDelay: '0s',
      animationIterationCount: '1',
      fontSize: '16px',
    };
  };
  panel.ownerDocument = { defaultView: { getComputedStyle: computedStyle } };

  const sandbox = {
    setTimeout: (callback, ms = 0) => {
      timers.set(nextTimer, { callback, due: clock + ms });
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => frames.push(callback),
    getComputedStyle: computedStyle,
    resolveChromeToken: () => '',
    document: {
      documentElement: {},
      getElementById: () => null,
      querySelector: (selector) =>
        selector === `[data-bento-panel-tab-id="${PANEL_TAB_ID}"]` ? panel : null,
    },
  };
  const api = vm.runInNewContext(
    `"use strict";
    let mainPanelWidth = null;
    let currentPanelLayoutGeometry = null;
    ${CONSTANTS.map(mountConst).join('\n')}
    ${FUNCTIONS.map(mountFunction).join('\n')}
    ({ ${FUNCTIONS.join(', ')} });`,
    sandbox,
    { filename: 'bento-shell-mount.js#panel-live-width' },
  );

  return {
    ...api,
    world,
    panel,
    /** The width computePanelLayoutGeometry gives the panel in a live refresh. */
    liveRefreshWidth() {
      const geometry = api.computePanelLayoutGeometry(
        { root: [{ kind: 'panel', tabId: PANEL_TAB_ID }] },
        [{ tabId: PANEL_TAB_ID, widthPx: PAYLOAD_WIDTH }],
        tabpanels,
        { preferLivePanelWidths: true },
      );
      return geometry.panelRects.get(PANEL_TAB_ID).width;
    },
    runFrames() {
      frames.splice(0).forEach((callback) => callback());
    },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due > clock) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test('a live refresh keeps the width the panel enters at, not its mid-animation width', () => {
  const m = makeWorld();
  m.animatePanelEnter(m.panel);
  m.runFrames();
  // The tabpanels height changes a frame later (the toolbar slides in): the panel is 34px wide
  // on its way from 0 to PAYLOAD_WIDTH.
  m.world.renderedWidth = 34;
  assert.equal(m.liveRefreshWidth(), PAYLOAD_WIDTH);
});

test('a live refresh keeps the rendered width of a panel that is not entering', () => {
  const m = makeWorld();
  m.animatePanelEnter(m.panel);
  m.runFrames();
  m.advance(REVEAL_MS + 100);
  // The user dragged the panel wider after it settled; the payload still carries the old width.
  m.world.renderedWidth = 700;
  assert.equal(m.liveRefreshWidth(), 700);
});
