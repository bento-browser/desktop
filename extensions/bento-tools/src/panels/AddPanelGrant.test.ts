import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAddPanelMarkerHandler,
  parseAddPanelMarker,
  readAddPanelGrant,
} from './AddPanelGrant';

const TOKEN = '3f1c2a4e-9b7d-4c1a-8e5f-0a1b2c3d4e5f';
const MARKER = `about:blank?bento_add_as_panel=${TOKEN}`;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets the handler's async consume/apply chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(consume: (tabId: number, token: string) => Promise<unknown>) {
  const consumeSpy = vi.fn(consume);
  const apply = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return {
    handler: createAddPanelMarkerHandler({ consume: consumeSpy, apply }),
    consumeSpy,
    apply,
  };
}

describe('parseAddPanelMarker', () => {
  it('accepts only the exact about:blank marker shape', () => {
    expect(parseAddPanelMarker(MARKER)).toBe(TOKEN);
    for (const url of [
      'about:blank?bento_add_as_panel=1',
      `https://example.com/?bento_add_as_panel=${TOKEN}`,
      `https://example.com/#bento_add_as_panel=${TOKEN}`,
      `about:blank?bento_add_as_panel=${TOKEN}&ts=1`,
      `about:blank?x=1&bento_add_as_panel=${TOKEN}`,
      `about:blank?bento_add_as_panel=${TOKEN}#frag`,
      `about:blank#bento_add_as_panel=${TOKEN}`,
      `about:blank?bento_add_as_panel=${TOKEN.toUpperCase()}`,
      'about:blank?bento_add_as_panel=',
      'about:blank',
      '',
    ]) {
      expect(parseAddPanelMarker(url)).toBeNull();
    }
  });
});

describe('readAddPanelGrant', () => {
  it('accepts the three insertion sources', () => {
    expect(readAddPanelGrant({ windowId: 3, source: 'main' })).toEqual({
      windowId: 3,
      source: 'main',
    });
    expect(readAddPanelGrant({ windowId: 3, source: 'end' })).toEqual({
      windowId: 3,
      source: 'end',
    });
    expect(readAddPanelGrant({ windowId: 3, source: 12 })).toEqual({ windowId: 3, source: 12 });
  });

  it('rejects malformed results', () => {
    for (const value of [
      null,
      undefined,
      'main',
      {},
      { windowId: 3 },
      { windowId: -1, source: 'end' },
      { windowId: 1.5, source: 'end' },
      { windowId: '3', source: 'end' },
      { windowId: 3, source: -2 },
      { windowId: 3, source: 2.5 },
      { windowId: 3, source: Number.NaN },
      { windowId: 3, source: 'later' },
    ]) {
      expect(readAddPanelGrant(value)).toBeNull();
    }
  });
});

describe('createAddPanelMarkerHandler', () => {
  it('applies the grant that the privileged check returns', async () => {
    const { handler, consumeSpy, apply } = setup(async () => ({ windowId: 7, source: 'end' }));
    handler.handle(41, MARKER);
    await settle();
    expect(consumeSpy).toHaveBeenCalledWith(41, TOKEN);
    expect(apply).toHaveBeenCalledWith(41, { windowId: 7, source: 'end' });
  });

  it('never consults the privileged check for URLs that are not markers', async () => {
    const { handler, consumeSpy, apply } = setup(async () => ({ windowId: 7, source: 'end' }));
    handler.handle(41, 'https://example.com/?bento_add_as_panel=1');
    handler.handle(41, 'about:blank?bento_add_as_panel=1');
    handler.handle(41, 'about:blank');
    await settle();
    expect(consumeSpy).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('ignores a marker the privileged check rejects', async () => {
    const { handler, apply } = setup(async () => null);
    handler.handle(41, MARKER);
    await settle();
    expect(apply).not.toHaveBeenCalled();
  });

  it('ignores a malformed privileged result', async () => {
    const { handler, apply } = setup(async () => ({ windowId: 'x', source: 'end' }));
    handler.handle(41, MARKER);
    await settle();
    expect(apply).not.toHaveBeenCalled();
  });

  it('swallows privileged check failures, sync and async', async () => {
    const rejecting = setup(async () => {
      throw new Error('boom');
    });
    expect(() => rejecting.handler.handle(41, MARKER)).not.toThrow();
    const throwing = setup(() => {
      throw new Error('no experiment');
    });
    expect(() => throwing.handler.handle(41, MARKER)).not.toThrow();
    await settle();
    expect(rejecting.apply).not.toHaveBeenCalled();
    expect(throwing.apply).not.toHaveBeenCalled();
  });

  it('attempts each tab once so onCreated and onUpdated do not double-apply', async () => {
    const { handler, consumeSpy, apply } = setup(async () => ({ windowId: 7, source: 'main' }));
    handler.handle(41, MARKER);
    handler.handle(41, MARKER);
    await settle();
    handler.handle(41, MARKER);
    await settle();
    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('allows a new attempt after the tab id is forgotten', async () => {
    const { handler, consumeSpy } = setup(async () => null);
    handler.handle(41, MARKER);
    await settle();
    handler.forget(41);
    handler.handle(41, MARKER);
    await settle();
    expect(consumeSpy).toHaveBeenCalledTimes(2);
  });
});
