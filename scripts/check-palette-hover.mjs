// Manual browser regression for the palettes' hover rules (`useRowHighlight.ts`), which no unit
// test can reach: a list that appears under a stationary pointer must not take the hover, the
// first real movement hands it back (also a one-pixel move inside the row under the pointer),
// and entering the list from outside after keyboard input takes the focus at once.
//
// Not part of CI. Needs the Ladle server and a Chromium with remote debugging:
//   pnpm --filter @bento/shell exec ladle serve --port 5291
//   chrome --headless=new --remote-debugging-port=9477 --user-data-dir=<tmp dir>
//   node scripts/check-palette-hover.mjs [ladle base url] [debugging port]
// Prints one PASS or FAIL line per case and exits 1 on a failure.

import process from 'node:process';

const BASE = process.argv[2] ?? 'http://localhost:5291';
const PORT = process.argv[3] ?? '9477';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => (socket.onopen = resolve));
let nextId = 0;
const pending = new Map();
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  // Only answers to our own numbered requests resolve a waiting call; events carry no id.
  if (typeof data.id !== 'number' || !pending.has(data.id)) return;
  const resolve = pending.get(data.id);
  pending.delete(data.id);
  if (typeof resolve === 'function') resolve(data);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.result?.value;

const KEY_CODES = { Enter: 13, Escape: 27, ArrowDown: 40, Tab: 9 };
const press = async (key) => {
  const keyEvent = { key, code: key, windowsVirtualKeyCode: KEY_CODES[key] };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent });
  await sleep(400);
};
const move = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(200);
};
const click = async (x, y) => {
  await move(x, y);
  const button = { x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button });
  await sleep(900);
};
const open = async (story, pointerAt) => {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  // A pointer that is already in place when the page loads is a stationary one.
  if (pointerAt) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointerAt });
  await send('Page.navigate', { url: `${BASE}/?story=${story}&theme=light&mode=preview` });
  await sleep(2800);
};

const FOCUSED = `(() => {
  const row = document.querySelector('[role=option][data-focused]');
  return row ? row.textContent.trim() : null;
})()`;
const rowCentre = (prefix) => `(() => {
  const row = [...document.querySelectorAll('[role=option]')].find((option) =>
    option.textContent.trim().startsWith(${JSON.stringify(prefix)}));
  if (!row) return null;
  const box = row.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
})()`;
const BUTTON_CENTRE = (label) => `(() => {
  const button = document.querySelector('[aria-label^=${JSON.stringify(label)}]');
  const box = button.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
})()`;

let failed = false;
const check = (name, actual, expected) => {
  const ok =
    typeof actual === 'string' && typeof expected === 'string'
      ? actual.startsWith(expected)
      : actual === expected;
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)} (want ${expected})`);
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1100,
  height: 760,
  deviceScaleFactor: 1,
  mobile: false,
});

// Settings palette: enter Appearance, then park the pointer over Light and reopen the
// choice list by keyboard. Follow system is current and must keep focus under that pointer.
await open('settings-palette--1-root');
const category = await evaluate(rowCentre('Appearance'));
await click(category.x, category.y);
const opener = await evaluate(rowCentre('Bento color mode'));
await click(opener.x, opener.y);
const light = await evaluate(rowCentre('Light'));
await move(light.x, light.y);
await press('Escape');
await press('Enter');
check(
  'forward, stationary pointer: current option focused',
  await evaluate(FOCUSED),
  'Follow system',
);
// One pixel inside the row under the pointer is a real movement: the hover is handed back.
await move(light.x, light.y + 1);
check('one-pixel move inside the row: that row takes the focus', await evaluate(FOCUSED), 'Light');
const dark = await evaluate(rowCentre('Dark'));
await move(dark.x - 30, dark.y);
check('a real move onto another row: it takes the focus', await evaluate(FOCUSED), 'Dark');

// Back by Esc with the pointer parked over a row other than the opener.
await press('Escape');
check('back, stationary pointer: opener row focused', await evaluate(FOCUSED), 'Bento color mode');
await press('Escape');
check(
  'category back, stationary pointer: category opener focused',
  await evaluate(FOCUSED),
  'Appearance',
);
const performance = await evaluate(rowCentre('Performance'));
await click(performance.x, performance.y);
const third = await evaluate(rowCentre('Keep alive'));
await move(third.x - 20, third.y);
check('back list, after a real move: hover follows', await evaluate(FOCUSED), 'Keep alive');

// Entering the list from outside it just after keyboard input (the Close button is not in the
// list): the last input before the move is a key press, so the pointer must be made the input
// before React handles the out event of Close, which comes first.
const close = await evaluate(BUTTON_CENTRE('Close'));
await move(close.x, close.y);
await press('ArrowDown');
await press('ArrowDown');
// Two rows down from the opener holds the keyboard focus; the pointer enters the one above it.
const entry = await evaluate(rowCentre('Sleep idle tabs'));
const rowAt = (x, y) =>
  `document.elementFromPoint(${x}, ${y})?.closest('[role=option]')?.textContent.trim() ?? null`;
const entered = await evaluate(rowAt(entry.x, entry.y));
await move(entry.x, entry.y);
check(
  'entering from Close after keys: the row entered takes the focus',
  await evaluate(FOCUSED),
  entered,
);

// Command palette (shares the primitive): a pointer already in place does not take the focus,
// and the first movement, even one pixel inside the row under it, does.
const results = { x: 550, y: 330 };
await open('command-palette--default-3-workspaces-8-tabs-', results);
const under = await evaluate(rowAt(results.x, results.y));
check('command palette, stationary pointer: no row takes the focus', await evaluate(FOCUSED), null);
await move(results.x, results.y + 1);
check(
  'command palette, one-pixel move: the row under the pointer takes the focus',
  await evaluate(FOCUSED),
  under,
);
const next = await evaluate(rowCentre('Open Bento Privacy'));
await move(next.x, next.y);
check(
  'command palette, real move onto another row: it takes the focus',
  await evaluate(FOCUSED),
  'Open Bento Privacy',
);

await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
socket.close();
process.exit(failed ? 1 : 0);
