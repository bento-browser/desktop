import { describe, expect, it } from 'vitest';
import {
  listenForVisibility,
  SETTINGS_HIDE_EVENT,
  SETTINGS_SHOW_EVENT,
  targetForShow,
} from './useShowSignal';

describe('targetForShow', () => {
  it('names the first list for a show with no target or one that cannot be read', () => {
    for (const detail of [JSON.stringify({ target: null }), 'not json', undefined, '{}']) {
      expect(targetForShow(detail).stages).toEqual([{ kind: 'root' }]);
    }
  });

  it('names the stages of a known target and ignores an unknown one', () => {
    expect(targetForShow(JSON.stringify({ target: 'privacy:level' })).stages).toEqual([
      { kind: 'root' },
      { kind: 'protection' },
    ]);
    expect(targetForShow(JSON.stringify({ target: 'setting:nope' })).stages).toEqual([
      { kind: 'root' },
    ]);
  });
});

describe('listenForVisibility', () => {
  it('reports a show with its target and a hide, until it is unsubscribed', () => {
    const source = new EventTarget();
    const seen: string[] = [];
    const stop = listenForVisibility(source, {
      onShow: (target) => seen.push(`show:${target.stages.length}`),
      onHide: () => seen.push('hide'),
    });
    source.dispatchEvent(
      new CustomEvent(SETTINGS_SHOW_EVENT, { detail: JSON.stringify({ target: 'privacy:level' }) }),
    );
    source.dispatchEvent(new CustomEvent(SETTINGS_HIDE_EVENT));
    stop();
    source.dispatchEvent(new CustomEvent(SETTINGS_HIDE_EVENT));
    expect(seen).toEqual(['show:2', 'hide']);
  });
});
