import { afterEach, expect, it, vi } from 'vitest';
import type { BentoSettings } from '@shared/protocol';
import { NativeModeStateOwner } from './nativeModeState';
import { PrivateWindowSettings } from './privateWindowSettings';

afterEach(() => vi.useRealTimers());
const record = (requestId: string, isPrivate = false) => ({
  documentId: null, windowId: 7, isPrivate, sessionId: 'native-session',
  message: { kind: 'mode-state-request', requestId },
});
function fixture(instanceId = 'background') {
  const privateSettings = new PrivateWindowSettings(instanceId);
  const send = vi.fn<(message: object) => boolean>(() => true), reply = vi.fn();
  const owner = new NativeModeStateOwner({ instanceId, privateSettings, send, reply });
  return { privateSettings, send, reply, owner };
}
const result = (requestId: string, pref = 'dark') => ({
  type: 'settings/result', requestId, ok: true, revision: 0,
  result: { settings: { uiColorMode: pref }, colorStamp: { run: 'tools', seq: 8 } },
});

it('only native records request a correlated atomic owner snapshot and consume its internal answer', () => {
  const f = fixture();
  expect(f.owner.request({ ...record('spoof'), documentId: 'shell-document' })).toBe(false);
  expect(f.owner.request(record('nonce'))).toBe(true);
  const request = f.send.mock.calls[0]?.[0] as unknown as { requestId: string; caller: object };
  expect(request).toMatchObject({ operation: 'snapshot/get', payload: { domains: ['settings'] },
    caller: { documentId: 'native:nonce', windowId: 7, isPrivate: false, sessionId: 'native-session' } });
  expect(f.owner.result(result('ordinary'))).toBe(false);
  expect(f.owner.result(result(request.requestId))).toBe(true);
  expect(f.reply).toHaveBeenCalledWith('nonce', { ok: true, pref: 'dark', stamp: { run: 'tools', seq: 8 } });
  f.owner.result(result(request.requestId, 'light'));
  expect(f.reply).toHaveBeenCalledTimes(1);
});

it('disconnect, timeout and background replacement cannot consume late replies or use the ordinary backlog', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.owner.request(record('old'));
  const oldId = (f.send.mock.calls[0]?.[0] as unknown as { requestId: string }).requestId;
  f.owner.dropPending(7);
  expect(f.reply).toHaveBeenLastCalledWith('old', { ok: false, error: 'owner_disconnected' });
  expect(f.owner.result(result(oldId))).toBe(true);
  expect(fixture('replacement').owner.result(result(oldId))).toBe(false);
  f.owner.request(record('timeout'));
  vi.advanceTimersByTime(5000);
  expect(f.reply).toHaveBeenLastCalledWith('timeout', { ok: false, error: 'owner_timeout' });
  f.send.mockReturnValue(false);
  f.owner.request(record('disconnected'));
  expect(f.reply).toHaveBeenLastCalledWith('disconnected', { ok: false, error: 'owner_disconnected' });
});

it('private queries read the actual window owner; global copies and unrelated preferences do not advance its stamp', () => {
  const f = fixture();
  f.owner.request(record('unseeded', true));
  expect(f.reply).toHaveBeenLastCalledWith('unseeded', { ok: false, error: 'owner_not_ready' });
  f.privateSettings.saved({ uiColorMode: 'dark' } as BentoSettings);
  f.owner.request(record('seeded', true));
  expect(f.reply).toHaveBeenLastCalledWith('seeded', { ok: true, pref: 'dark', stamp: { run: 'background:1', seq: 1 } });
  f.privateSettings.saved({ uiColorMode: 'light' } as BentoSettings);
  f.privateSettings.update(7, { sidebarCollapsed: true, uiColorMode: 'dark' });
  expect(f.privateSettings.modeState(7)?.stamp.seq).toBe(1);
  f.privateSettings.update(7, { uiColorMode: 'system' });
  f.owner.request(record('changed', true));
  expect(f.reply).toHaveBeenLastCalledWith('changed', { ok: true, pref: 'system', stamp: { run: 'background:1', seq: 2 } });
  expect(f.send).not.toHaveBeenCalled();
  f.privateSettings.close(7);
  expect(f.privateSettings.modeState(7)).toBeNull();
});
