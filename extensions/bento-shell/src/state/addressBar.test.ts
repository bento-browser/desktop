import { beforeEach, describe, expect, it } from 'vitest';
import { useAddressBarStore as store } from './addressBar';

const result = { kind: 'topSite' as const, url: 'https://example.test', title: 'Test', score: 1 };
describe('address request correlation', () => {
  beforeEach(() => store.getState().clear());
  it('accepts only the latest request, even for equal queries and cross-document replies', () => {
    const s = store.getState();
    s.beginQuery('old-open', '');
    s.beginQuery('new-open', '');
    s.applyResults('new-open', '', [result]);
    s.applyResults('old-open', '', []);
    s.applyResults('other-document', '', []);
    s.applyResults('new-open', 'wrong', []);
    expect(store.getState().results).toEqual([result]);
    s.clear();
    s.applyResults('new-open', '', [result]);
    expect(store.getState().results).toEqual([]);
  });
  it('invalidates before debounce and blocks duplicate activation until a correlated outcome', () => {
    const s = store.getState();
    s.beginQuery('q', '');
    expect(s.beginRestore('r', 'session')).toBe(true);
    expect(s.beginRestore('duplicate', 'other')).toBe(false);
    s.applyRestoreResult('other-document', 'session', {
      status: 'restored',
      tabId: 1,
      windowId: 1,
    });
    expect(store.getState().pendingRestore).not.toBeNull();
    s.clear();
    s.applyRestoreResult('r', 'session', { status: 'restored', tabId: 1, windowId: 1 });
    expect(store.getState().restored).toBe(false);
  });
  it.each(['unavailable', 'failed'] as const)(
    'keeps %s restoration usable and requests a refresh',
    (status) => {
      const s = store.getState();
      s.beginQuery('q', '');
      s.applyResults('q', '', [result]);
      s.beginRestore('r', 'session');
      const before = store.getState().refreshVersion;
      s.applyRestoreResult('r', 'session', { status });
      expect(store.getState()).toMatchObject({
        pendingRestore: null,
        requestId: null,
        results: [],
        refreshVersion: before + 1,
      });
      expect(store.getState().error).toBeTruthy();
      s.beginQuery('refresh', '');
      expect(s.beginRestore('retry', 'another')).toBe(true);
    },
  );
  it('closes only on the pending session success', () => {
    const s = store.getState();
    s.beginQuery('q', '');
    s.beginRestore('r', 'session');
    s.applyRestoreResult('r', 'wrong-session', { status: 'restored', tabId: 1, windowId: 1 });
    expect(store.getState().restored).toBe(false);
    s.applyRestoreResult('r', 'session', { status: 'restored', tabId: 1, windowId: 1 });
    expect(store.getState().restored).toBe(true);
  });
});
