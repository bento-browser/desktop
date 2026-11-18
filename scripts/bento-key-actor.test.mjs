// The BentoKey content-key bridge: the registration in bento-shell-mount.js and the
// BentoKeyParent message checks, run against a stub JSWindowActorParent. The child runs in
// untrusted web content processes, so the parent must drop malformed messages. Key routing
// itself is proven in a built browser (docs/technical/panel-traversal-focus.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadParent() {
  const source = readFileSync(resolve(ROOT, 'src/browser/actors/BentoKeyParent.sys.mjs'), 'utf8').replaceAll(
    /^export /gm,
    '',
  );
  const events = [];
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  const win = { CustomEvent, dispatchEvent: (e) => events.push([e.type, JSON.parse(JSON.stringify(e.detail))]) };
  const warnings = [];
  const context = vm.createContext({
    JSWindowActorParent: class {
      browsingContext = { topChromeWindow: win };
    },
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(source + '\nthis.BentoKeyParent = BentoKeyParent;', context);
  return { actor: new context.BentoKeyParent(), events, warnings };
}

test('BentoKey is registered for untrusted web and file processes', () => {
  const mount = readFileSync(resolve(ROOT, 'src/browser/base/content/bento-shell-mount.js'), 'utf8');
  const block = /registerWindowActor\('BentoKey', \{[\s\S]*?\n {6}\}\);/.exec(mount)?.[0];
  assert.ok(block, 'registerContentKeyActor registers BentoKey');
  assert.match(block, /^\s*safeForUntrustedWebProcess: true,$/m);
  assert.match(block, /'\*:\/\/\*\/\*', 'file:\/\/\/\*'/);
});

test('BentoKeyParent forwards only a direction of 1 or -1 and a normalised address mode', () => {
  const { actor, events, warnings } = loadParent();
  actor.receiveMessage({ name: 'BentoKey:Cycle', data: { direction: 1 } });
  actor.receiveMessage({ name: 'BentoKey:PanelHistory', data: { direction: -1 } });
  actor.receiveMessage({ name: 'BentoKey:AddrbarOpen', data: { mode: 'newTab' } });
  actor.receiveMessage({ name: 'BentoKey:AddrbarOpen', data: { mode: 'other' } });
  actor.receiveMessage({ name: 'BentoKey:AddrbarOpen' });
  for (const data of [undefined, null, {}, { direction: 2 }, { direction: '1' }, { direction: 0 }, { direction: NaN }]) {
    actor.receiveMessage({ name: 'BentoKey:Cycle', data });
    actor.receiveMessage({ name: 'BentoKey:PanelHistory', data });
  }
  actor.receiveMessage({ name: 'BentoKey:Other', data: { direction: 1 } });
  assert.deepEqual(events, [
    ['BentoKey:Cycle', { direction: 1 }],
    ['BentoKey:PanelHistory', { direction: -1 }],
    ['BentoKey:AddrbarOpen', { mode: 'newTab' }],
    ['BentoKey:AddrbarOpen', { mode: 'current' }],
    ['BentoKey:AddrbarOpen', { mode: 'current' }],
  ]);
  assert.deepEqual(warnings, []);
});
