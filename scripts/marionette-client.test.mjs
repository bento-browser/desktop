import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeMessage, FrameParser } from './marionette-client.mjs';

test('encodes the length in bytes, not characters', () => {
  const frame = encodeMessage([0, 1, 'x', { text: 'é→😀' }]);
  const colon = frame.indexOf(':');
  const body = frame.subarray(colon + 1);
  assert.equal(Number(frame.subarray(0, colon).toString()), body.length);
  assert.notEqual(body.length, body.toString('utf8').length);
});

test('decodes several messages from one chunk', () => {
  const parser = new FrameParser();
  const chunk = Buffer.concat([
    encodeMessage({ applicationType: 'gecko', marionetteProtocol: 3 }),
    encodeMessage([1, 1, null, { value: 'ok' }]),
  ]);
  assert.deepEqual(parser.push(chunk), [
    { applicationType: 'gecko', marionetteProtocol: 3 },
    [1, 1, null, { value: 'ok' }],
  ]);
});

test('reassembles a message delivered one byte at a time', () => {
  const parser = new FrameParser();
  const message = [1, 7, null, { value: 'é→😀'.repeat(20) }];
  const frame = encodeMessage(message);
  const out = [];
  for (const byte of frame) out.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(out, [message]);
});

test('keeps a partial next message until the rest arrives', () => {
  const parser = new FrameParser();
  const first = encodeMessage([1, 1, null, { value: 1 }]);
  const second = encodeMessage([1, 2, null, { value: 2 }]);
  const cut = 5;
  assert.deepEqual(parser.push(Buffer.concat([first, second.subarray(0, cut)])), [
    [1, 1, null, { value: 1 }],
  ]);
  assert.deepEqual(parser.push(second.subarray(cut)), [[1, 2, null, { value: 2 }]]);
});

test('splits inside a multi-byte character', () => {
  const parser = new FrameParser();
  const message = [1, 3, null, { value: '😀' }];
  const frame = encodeMessage(message);
  const mid = frame.indexOf(Buffer.from('😀')) + 2;
  assert.deepEqual(parser.push(frame.subarray(0, mid)), []);
  assert.deepEqual(parser.push(frame.subarray(mid)), [message]);
});

test('rejects data that is not length-prefixed', () => {
  assert.throws(
    () => new FrameParser().push(Buffer.from('GET / HTTP/1.1\r\nhost: x')),
    /length prefix/,
  );
  assert.throws(() => new FrameParser().push(Buffer.from('x'.repeat(40))), /no length prefix/);
  assert.throws(() => new FrameParser().push(Buffer.from('abc:{}')), /length prefix/);
});
