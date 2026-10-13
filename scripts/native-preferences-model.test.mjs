// The native Settings page talks to the tools service through BentoNativeModel, which lives in
// patch 15 (browser/components/preferences/config/bento.mjs). The service binds each session to
// the window that said hello, and a Settings tab can move to another window at any time. These
// tests run the real class, extracted from the patch, against a fake service with that binding.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PATCH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../patches/core-ui/15-bento-native-preferences.patch',
);

/** Content of a file the patch adds, with the diff's `+` markers removed. */
function addedFile(patch, path) {
  const header = `diff --git a/${path} b/${path}\n`;
  const start = patch.indexOf(header);
  assert.notEqual(start, -1, `${path} is missing from the patch`);
  const section = patch.slice(start + header.length).split('\ndiff --git ')[0];
  const hunk = section.slice(section.indexOf('\n@@ ') + 1).split('\n');
  return hunk
    .slice(1)
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1))
    .join('\n');
}

const settingsPage = addedFile(
  readFileSync(PATCH, 'utf8'),
  'browser/components/preferences/config/bento.mjs',
);
// Everything between the constants and the module's `model` instance has no Firefox imports.
const modelSource = settingsPage.slice(
  settingsPage.indexOf('const REQUEST_TOPIC'),
  settingsPage.indexOf('const model = new BentoNativeModel();'),
);
assert.match(modelSource, /class BentoNativeModel/, 'BentoNativeModel is missing from the patch');

const REQUEST_TOPIC = 'bento-native-preferences-request';
const RESPONSE_TOPIC = 'bento-native-preferences-response';
const CONTRACT = { contractHash: 'contract', protocolVersion: 1 };

const settle = () => new Promise((resolveSettled) => setImmediate(resolveSettled));

/**
 * One Settings document hosted by `host.id`, and a fake service that, like
 * NativePreferencesService, issues a session per hello for the window the hello came from and
 * refuses an authenticated request whose session belongs to another window.
 */
function createHarness() {
  const host = { id: 1 };
  const observers = new Map();
  const unanswered = [];
  const sessions = new Map();
  const sent = { hellos: [], authenticated: [] };
  let tokens = 0;
  let ids = 0;
  const hooks = { afterHello: () => {} };

  const sandbox = {
    CONTRACT_SHA256: CONTRACT.contractHash,
    PROTOCOL_VERSION: CONTRACT.protocolVersion,
    console,
    document: {},
    crypto: { randomUUID: () => `id-${++ids}` },
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    window: {
      addEventListener() {},
      browsingContext: {
        get topChromeWindow() {
          return { browsingContext: { id: host.id } };
        },
      },
    },
    Services: {
      obs: {
        addObserver: (observer, topic) => observers.set(topic, observer),
        removeObserver() {},
        notifyObservers(subject, topic) {
          assert.equal(topic, REQUEST_TOPIC);
          const { request, chromeWindow } = subject.wrappedJSObject;
          unanswered.push({ request, windowId: chromeWindow.browsingContext.id });
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${modelSource}\nglobalThis.BentoNativeModel = BentoNativeModel;\nglobalThis.MAX_HELLO_ATTEMPTS = MAX_HELLO_ATTEMPTS;`,
    sandbox,
  );
  const model = new sandbox.BentoNativeModel();

  const respond = ({ request }, body) =>
    observers.get(RESPONSE_TOPIC).observe(
      null,
      RESPONSE_TOPIC,
      JSON.stringify({
        ...CONTRACT,
        clientInstanceId: request.clientInstanceId,
        requestId: request.requestId,
        backendInstanceId: 'backend',
        revision: 1,
        ...body,
      }),
    );

  function answer(entry) {
    if (entry.request.operation === 'session/hello') {
      sent.hellos.push(entry.windowId);
      const resumeToken = `token-${++tokens}`;
      sessions.set(resumeToken, entry.windowId);
      respond(entry, {
        ok: true,
        result: { resumeToken, sessionGeneration: 1, isPrivate: false, revision: 1 },
      });
      hooks.afterHello();
      return;
    }
    const accepted = sessions.get(entry.request.resumeToken) === entry.windowId;
    sent.authenticated.push({ windowId: entry.windowId, accepted });
    respond(
      entry,
      accepted ? { ok: true, result: {} } : { ok: false, error: { code: 'invalid_session' } },
    );
  }

  return {
    host,
    model,
    sent,
    hooks,
    maxHelloAttempts: sandbox.MAX_HELLO_ATTEMPTS,
    /** Requests the service has received and not answered yet. */
    unanswered: () => unanswered.map(({ request, windowId }) => [request.operation, windowId]),
    /** Answers requests in arrival order until none are left. */
    async drain() {
      for (;;) {
        await settle();
        const entry = unanswered.shift();
        if (!entry) return;
        answer(entry);
      }
    },
  };
}

const outcome = (promise) =>
  promise.then(
    () => 'ok',
    (error) => error.message,
  );

test('a request waiting on a hello that was sent from the old window says hello again', async () => {
  const h = createHarness();
  const first = outcome(h.model.request('snapshot/get'));
  await settle();
  assert.deepEqual(h.unanswered(), [['session/hello', 1]]);

  h.host.id = 2; // the Settings tab moves while the hello is in flight
  const second = outcome(h.model.request('settings/update', { changes: {} }));
  await h.drain();

  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  assert.deepEqual(h.sent.hellos, [1, 2]);
  assert.deepEqual(h.sent.authenticated, [
    { windowId: 2, accepted: true },
    { windowId: 2, accepted: true },
  ]);
});

test('a tab that moves after its session was issued says hello once for the new window', async () => {
  const h = createHarness();
  const run = async () => {
    const result = outcome(h.model.request('snapshot/get'));
    await h.drain();
    return result;
  };
  assert.equal(await run(), 'ok');
  assert.equal(await run(), 'ok');
  assert.deepEqual(h.sent.hellos, [1]);

  h.host.id = 2;
  assert.equal(await run(), 'ok');
  assert.equal(await run(), 'ok');
  assert.deepEqual(h.sent.hellos, [1, 2]);
  assert.ok(h.sent.authenticated.every(({ accepted }) => accepted));
});

test('a tab that keeps changing windows stops after a bounded number of hellos', async () => {
  const h = createHarness();
  h.hooks.afterHello = () => {
    h.host.id += 1; // the tab has moved again before the hello's answer is used
  };
  const request = outcome(h.model.request('snapshot/get'));
  await h.drain();

  assert.equal(await request, 'invalid_session');
  assert.equal(h.sent.hellos.length, h.maxHelloAttempts);
  assert.deepEqual(h.sent.authenticated, []);
});
