import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Runs the BentoShellBus actor modules (src/browser/actors) against stubs of the Firefox globals
// they use. They are system modules that need a running Firefox, so the source is evaluated in a
// vm context with its `export` keywords removed.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actorSource = (name) =>
  fs.readFileSync(path.join(ROOT, 'src/browser/actors', name), 'utf8').replaceAll(/^export /gm, '');

const MiB = 1024 * 1024;

function loadChild() {
  const sandbox = { JSWindowActorChild: class {} };
  const Child = vm.runInNewContext(
    `${actorSource('BentoShellBusChild.sys.mjs')}\n;BentoShellBusChild`,
    sandbox,
  );
  const actor = new Child();
  const sent = [];
  actor.sendAsyncMessage = (name, data) => sent.push({ name, data });
  return { actor, sent };
}

test('the child actor forwards what the largest backup import becomes once escaped into a message', () => {
  const { actor, sent } = loadChild();
  // 10 MiB of text that is all quotes and newlines: JSON escaping makes the message twice as long.
  const json = '"\n'.repeat(5 * MiB);
  const detail = JSON.stringify({
    kind: 'settings-request',
    request: { requestId: 'r', operation: 'backup/validateImport', payload: { json } },
  });
  assert.ok(detail.length > 19 * MiB, 'the message is about twice the file');
  actor.handleEvent({ type: 'bento-bus-up', detail });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, 'BentoShellBus:Up');
  assert.equal(sent[0].data, detail);
});

test('the child actor drops a message past its limit, and anything that is not a string', () => {
  const { actor, sent } = loadChild();
  actor.handleEvent({ type: 'bento-bus-up', detail: 'x'.repeat(23 * MiB) });
  actor.handleEvent({ type: 'bento-bus-up', detail: { not: 'a string' } });
  actor.handleEvent({ type: 'other', detail: '{}' });
  assert.deepEqual(sent, []);
});

// Shared, so two module loads mint different ids like two browser runs would.
let uuids = 0;

function loadParent({ listen = true } = {}) {
  const window = {
    closed: false,
    document: { documentElement: { getAttribute: () => 'navigator:browser' } },
  };
  const sandbox = {
    JSWindowActorParent: class {},
    ChromeUtils: {
      defineESModuleGetters: (target) => {
        target.PrivateBrowsingUtils = { isWindowPrivate: (win) => win.private === true };
      },
      importESModule: () => ({
        Management: { global: { windowTracker: { getId: (win) => win.id } } },
      }),
    },
    Services: { uuid: { generateUUID: () => ({ toString: () => `{uuid-${++uuids}}` }) } },
    WebExtensionPolicy: { getByID: () => ({ mozExtensionHostname: 'shell-host' }) },
    console,
  };
  const { Hub, Parent } = vm.runInNewContext(
    `${actorSource('BentoShellBusParent.sys.mjs')}\n;({ Hub: BentoShellBusHub, Parent: BentoShellBusParent })`,
    sandbox,
  );
  const win = Object.assign(window, { id: 4, private: false });
  const records = [];
  const attach = () => Hub.onUp((record) => records.push(record));
  if (listen) attach();
  const actorFor = (chromeWindow) => {
    const actor = new Parent();
    actor.manager = { documentURI: { scheme: 'moz-extension', host: 'shell-host' } };
    actor.browsingContext = { top: { topChromeWindow: chromeWindow } };
    actor.sendAsyncMessage = () => {};
    return actor;
  };
  return { Hub, win, records, actorFor, attach };
}

test('the hub stamps every upward record with one session id for the browser run', () => {
  const { Hub, win, records, actorFor } = loadParent();
  Hub.postFromChrome(win, { type: 'menu/open' });
  const actor = actorFor(win);
  actor.receiveMessage({
    name: 'BentoShellBus:Up',
    data: JSON.stringify({ kind: 'settings-hello' }),
  });
  actor.receiveMessage({
    name: 'BentoShellBus:Up',
    data: JSON.stringify({ kind: 'settings-request' }),
  });
  actor.didDestroy();

  assert.equal(records.length, 4);
  const [sessionId] = new Set(records.map((record) => record.sessionId));
  assert.equal(typeof sessionId, 'string');
  assert.ok(sessionId.length > 0);
  assert.deepEqual(new Set(records.map((record) => record.sessionId)), new Set([sessionId]));
  assert.deepEqual(
    records.map((record) => record.windowId),
    [4, 4, 4, 4],
  );
});

test('a page cannot supply the session id, and a restarted browser has a new one', () => {
  const first = loadParent();
  first.actorFor(first.win).receiveMessage({
    name: 'BentoShellBus:Up',
    data: JSON.stringify({ kind: 'settings-hello', sessionId: 'forged' }),
  });
  assert.notEqual(first.records[0].sessionId, 'forged');
  assert.equal(first.records[0].message.sessionId, 'forged', 'the page text stays inside message');

  // A fresh module load stands for a new browser run: the id is minted at load.
  const second = loadParent();
  second.Hub.postFromChrome(second.win, { type: 'menu/open' });
  assert.notEqual(second.records[0].sessionId, first.records[0].sessionId);
});

// A document message the child actor would forward: a settings request carrying `chars` of text.
const requestOf = (chars, id = 'r') =>
  JSON.stringify({
    kind: 'settings-request',
    request: { requestId: id, payload: { json: 'x'.repeat(chars) } },
  });

test('the backlog keeps one maximal Settings import while nothing listens', () => {
  const { win, records, actorFor, attach } = loadParent({ listen: false });
  const actor = actorFor(win);
  // The largest message the child actor forwards: 22 Mi characters.
  const biggest = requestOf(22 * MiB - 200, 'big');
  assert.ok(biggest.length <= 22 * MiB);
  actor.receiveMessage({ name: 'BentoShellBus:Up', data: biggest });
  attach();
  assert.deepEqual(
    records.map((record) => record.message.request.requestId),
    ['big'],
  );
});

test('many large queued messages cannot accumulate: the oldest give way to the newest', () => {
  const { win, records, actorFor, attach } = loadParent({ listen: false });
  const actor = actorFor(win);
  for (let i = 0; i < 8; i += 1) {
    actor.receiveMessage({ name: 'BentoShellBus:Up', data: requestOf(10 * MiB, `m${i}`) });
  }
  attach();
  // 24 Mi of budget holds two 10 Mi messages.
  assert.deepEqual(
    records.map((record) => record.message.request.requestId),
    ['m6', 'm7'],
  );
});

test('the count limit of 128 still holds, newest first, with a large message queued', () => {
  const { Hub, win, records, actorFor, attach } = loadParent({ listen: false });
  const actor = actorFor(win);
  actor.receiveMessage({ name: 'BentoShellBus:Up', data: requestOf(5 * MiB, 'large') });
  for (let i = 0; i < 200; i += 1) Hub.postFromChrome(win, { type: 'menu/open', n: i });
  attach();
  // 128 records at most, the newest ones: the large message was the oldest.
  assert.equal(records.length, 128);
  assert.equal(records.at(-1).message.n, 199);
  assert.ok(records.every((record) => record.message.request === undefined));
});

test('the budget starts over once a listener took the backlog', () => {
  const { win, records, actorFor, attach } = loadParent({ listen: false });
  const actor = actorFor(win);
  actor.receiveMessage({ name: 'BentoShellBus:Up', data: requestOf(20 * MiB, 'first') });
  attach();
  // Listening now: records are delivered directly and never counted.
  actor.receiveMessage({ name: 'BentoShellBus:Up', data: requestOf(20 * MiB, 'second') });
  assert.deepEqual(
    records.map((record) => record.message.request.requestId),
    ['first', 'second'],
  );
});
