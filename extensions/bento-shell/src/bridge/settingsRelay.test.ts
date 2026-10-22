import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BentoSettings, Event } from '@shared/protocol';
import type { SettingsResult } from '@shared/settings-client-protocol';
import { PrivateWindowSettings } from './privateWindowSettings';
import { SettingsRelay } from './settingsRelay';
import type { BusDown } from './shellBus';

const settings = (uiColorMode: BentoSettings['uiColorMode'], sidebarCollapsed = false) =>
  ({
    uiColorMode,
    sidebarCollapsed,
    sidebarHidden: false,
    panelCornerRadiusPx: 6,
  }) as BentoSettings;

const REGULAR = { windowId: 1, isPrivate: false };
const PRIVATE = { windowId: 7, isPrivate: true };

let wire = 0;

function setup(options: { toolsUp?: boolean; delivered?: boolean } = {}) {
  wire = 0;
  const toTools = vi.fn<(message: object) => boolean>(() => options.toolsUp ?? true);
  const posted: Array<{ documentId: string; message: BusDown }> = [];
  const privateSettings = new PrivateWindowSettings();
  privateSettings.saved(settings('system'));
  const applyLocalSettings = vi.fn(
    (windowId: number, local: Parameters<PrivateWindowSettings['update']>[1]) => {
      privateSettings.update(windowId, local);
    },
  );
  const relay = new SettingsRelay({
    instanceId: 'bg-1',
    toTools,
    toDocument: async (documentId, message) => {
      posted.push({ documentId, message });
      return options.delivered ?? true;
    },
    privateSettings,
    applyLocalSettings,
    newId: () => `wire-${++wire}`,
  });
  return { relay, toTools, posted, privateSettings, applyLocalSettings };
}

const ok = (requestId: string, result: unknown): SettingsResult => ({
  type: 'settings/result',
  requestId,
  ok: true,
  result,
  revision: 1,
});

const resultsTo = (posted: Array<{ documentId: string; message: BusDown }>, documentId: string) =>
  posted
    .filter((entry) => entry.documentId === documentId && entry.message.kind === 'settings-result')
    .map((entry) => (entry.message as Extract<BusDown, { kind: 'settings-result' }>).result);

describe('SettingsRelay', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('acknowledges a hello and registers the private window', () => {
    ctx.relay.hello('doc-p', PRIVATE, 'h1');
    expect(ctx.posted).toEqual([{ documentId: 'doc-p', message: { kind: 'ack', helloId: 'h1' } }]);
    expect(ctx.privateSettings.own(7)).toBeDefined();
    ctx.relay.hello('doc-r', REGULAR, 7);
    expect(ctx.posted).toHaveLength(1);
  });

  it('forwards a request with the hub caller and its own wire id, whatever the page sent', () => {
    ctx.relay.request('doc-r', REGULAR, {
      requestId: 'req-1',
      operation: 'snapshot/get',
      payload: { domains: ['settings'] },
      caller: { documentId: 'forged', windowId: 99, isPrivate: true },
    });
    expect(ctx.toTools).toHaveBeenCalledWith({
      kind: 'settings-client/request',
      shellBackgroundInstanceId: 'bg-1',
      caller: { documentId: 'doc-r', windowId: 1, isPrivate: false },
      requestId: 'wire-1',
      operation: 'snapshot/get',
      payload: { domains: ['settings'] },
    });
  });

  it('delivers a result to the document that asked under its own request id', () => {
    ctx.relay.request('doc-a', REGULAR, {
      requestId: 'same',
      operation: 'operation/status',
      payload: { operationId: 'x' },
    });
    ctx.relay.request('doc-b', PRIVATE, {
      requestId: 'same',
      operation: 'operation/status',
      payload: { operationId: 'x' },
    });
    expect(ctx.relay.result(ok('wire-2', { n: 2 }))).toBe(true);
    expect(resultsTo(ctx.posted, 'doc-b')).toEqual([ok('same', { n: 2 })]);
    expect(resultsTo(ctx.posted, 'doc-a')).toEqual([]);
    // A second answer to the same request has nobody waiting.
    ctx.relay.result(ok('wire-2', { n: 3 }));
    expect(resultsTo(ctx.posted, 'doc-b')).toHaveLength(1);
  });

  it('leaves messages that are not results to the caller', () => {
    expect(ctx.relay.result({ type: 'settings/changed', settings: settings('dark') })).toBe(false);
  });

  it('answers an unusable request without involving tools', () => {
    ctx.relay.request('doc-r', REGULAR, { requestId: 'bad', operation: 'nope' });
    expect(ctx.toTools).not.toHaveBeenCalled();
    expect(resultsTo(ctx.posted, 'doc-r')).toEqual([
      {
        type: 'settings/result',
        requestId: 'bad',
        ok: false,
        error: { code: 'invalid_payload', retryable: false },
      },
    ]);
    ctx.relay.request('doc-r', REGULAR, { operation: 'snapshot/get' });
    expect(ctx.posted).toHaveLength(1);
  });

  it('answers at once when tools is not connected', () => {
    const down = setup({ toolsUp: false });
    down.relay.request('doc-r', REGULAR, {
      requestId: 'r',
      operation: 'snapshot/get',
      payload: { domains: [] },
    });
    expect(resultsTo(down.posted, 'doc-r')).toMatchObject([
      { requestId: 'r', ok: false, error: { code: 'internal_error', retryable: true } },
    ]);
  });

  it('shows a private window its own colour mode in snapshots and applies a local update after tools answers', () => {
    ctx.relay.hello('doc-p', PRIVATE, 'h');
    ctx.privateSettings.update(7, { uiColorMode: 'dark' });

    ctx.relay.request('doc-p', PRIVATE, {
      requestId: 's',
      operation: 'snapshot/get',
      payload: { domains: ['settings'] },
    });
    ctx.relay.result(ok('wire-1', { settings: { uiColorMode: 'system', panelCornerRadiusPx: 6 } }));
    expect(resultsTo(ctx.posted, 'doc-p')[0]).toMatchObject({
      ok: true,
      result: { settings: { uiColorMode: 'dark', panelCornerRadiusPx: 6 } },
    });

    ctx.relay.request('doc-p', PRIVATE, {
      requestId: 'u',
      operation: 'settings/update',
      payload: { changes: { uiColorMode: 'light', panelCornerRadiusPx: 8 } },
    });
    expect(ctx.applyLocalSettings).not.toHaveBeenCalled(); // Only once tools has saved the rest.
    ctx.relay.result(ok('wire-2', { settings: settings('system'), durableRevision: 3 }));
    expect(ctx.applyLocalSettings).toHaveBeenCalledWith(7, { uiColorMode: 'light' });
    expect(resultsTo(ctx.posted, 'doc-p')[1]).toMatchObject({
      result: { settings: { uiColorMode: 'light' }, durableRevision: 3 },
    });
  });

  it('does not apply a private update that tools refused', () => {
    ctx.relay.hello('doc-p', PRIVATE, 'h');
    ctx.relay.request('doc-p', PRIVATE, {
      requestId: 'u',
      operation: 'settings/update',
      payload: { changes: { uiColorMode: 'light' } },
    });
    ctx.relay.result({
      type: 'settings/result',
      requestId: 'wire-1',
      ok: false,
      error: { code: 'busy', retryable: true },
    });
    expect(ctx.applyLocalSettings).not.toHaveBeenCalled();
  });

  it('leaves a regular window the profile values', () => {
    ctx.relay.request('doc-r', REGULAR, {
      requestId: 'u',
      operation: 'settings/update',
      payload: { changes: { uiColorMode: 'light' } },
    });
    const answer = { settings: settings('light'), durableRevision: 3 };
    ctx.relay.result(ok('wire-1', answer));
    expect(ctx.applyLocalSettings).not.toHaveBeenCalled();
    expect(resultsTo(ctx.posted, 'doc-r')[0]).toMatchObject({ result: answer });
  });

  it('sends change notices to every Settings document, a private one with its own values', () => {
    ctx.relay.hello('doc-r', REGULAR, 'h1');
    ctx.relay.hello('doc-p', PRIVATE, 'h2');
    ctx.privateSettings.update(7, { uiColorMode: 'dark' });
    ctx.posted.length = 0;

    const changed: Event = { type: 'settings/changed', settings: settings('light') };
    ctx.relay.notice(changed);
    ctx.relay.notice({ type: 'tabs/changed', deltas: [] });

    const events = ctx.posted.map((entry) => [entry.documentId, entry.message]);
    expect(events).toEqual([
      ['doc-r', { kind: 'event', event: changed }],
      ['doc-p', { kind: 'event', event: { type: 'settings/changed', settings: settings('dark') } }],
    ]);
  });

  it('posts to the Settings documents of one window only', () => {
    ctx.relay.hello('doc-r', REGULAR, 'h1');
    ctx.relay.hello('doc-p', PRIVATE, 'h2');
    ctx.posted.length = 0;
    ctx.relay.postToWindow(7, { kind: 'ack', helloId: 'x' });
    expect(ctx.posted.map((entry) => entry.documentId)).toEqual(['doc-p']);
  });

  it('forgets a closed document and the requests it was waiting on', () => {
    ctx.relay.request('doc-r', REGULAR, {
      requestId: 'r',
      operation: 'snapshot/get',
      payload: { domains: [] },
    });
    expect(ctx.relay.forget('doc-r')).toEqual(REGULAR);
    expect(ctx.relay.forget('doc-r')).toBeUndefined();
    ctx.relay.result(ok('wire-1', {}));
    expect(resultsTo(ctx.posted, 'doc-r')).toEqual([]);
  });

  it('forgets a document the hub says is gone', async () => {
    const gone = setup({ delivered: false });
    gone.relay.hello('doc-r', REGULAR, 'h');
    await Promise.resolve();
    await Promise.resolve();
    gone.posted.length = 0;
    gone.relay.notice({ type: 'settings/changed', settings: settings('dark') });
    expect(gone.posted).toEqual([]);
  });

  it('drops pending requests when the tools port goes away', () => {
    ctx.relay.request('doc-r', REGULAR, {
      requestId: 'r',
      operation: 'snapshot/get',
      payload: { domains: [] },
    });
    ctx.relay.dropPending();
    ctx.relay.result(ok('wire-1', {}));
    expect(resultsTo(ctx.posted, 'doc-r')).toEqual([]);
  });
});
