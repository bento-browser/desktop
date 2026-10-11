import assert from 'node:assert/strict';
import test from 'node:test';

import { createRegenerator } from './muxui-regenerator.mjs';

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** A generate stub whose runs finish only when the test releases them. */
function controlledGenerate() {
  const reasons = [];
  const releases = [];
  const generate = (reason) => {
    reasons.push(reason);
    return new Promise((resolve) => releases.push(resolve));
  };
  return { generate, reasons, release: () => releases.shift()?.() };
}

test('a burst of changes starts one run; changes during a run queue exactly one rerun', async () => {
  const { generate, reasons, release } = controlledGenerate();
  const regenerator = createRegenerator(generate, 5);
  regenerator.trigger('a');
  regenerator.trigger('b');
  await tick();
  assert.deepEqual(reasons, ['b']);

  regenerator.trigger('c');
  await tick();
  regenerator.trigger('d');
  await tick();
  assert.deepEqual(reasons, ['b']);
  release();
  await tick();
  assert.deepEqual(reasons, ['b', 'd']);
  release();
  await tick();
  assert.deepEqual(reasons, ['b', 'd']);
  regenerator.close();
});

test('close drops the pending timer and the queued rerun', async () => {
  const { generate, reasons, release } = controlledGenerate();
  const regenerator = createRegenerator(generate, 5);
  regenerator.trigger('first');
  await tick();
  regenerator.trigger('queued');
  await tick();
  regenerator.close();
  release();
  await tick();
  assert.deepEqual(reasons, ['first']);

  regenerator.trigger('after close');
  await tick();
  assert.deepEqual(reasons, ['first']);

  const pending = controlledGenerate();
  const idle = createRegenerator(pending.generate, 20);
  idle.trigger('never');
  idle.close();
  await tick(40);
  assert.deepEqual(pending.reasons, []);
});
