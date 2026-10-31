import { describe, expect, it } from 'vitest';
import { PRIVATE_MODEL, REGULAR_MODEL } from '../state/__fixtures__/settingsPalette';
import { ROOT_TARGET, targetForModel } from '../components/SettingsPalette/targets';
import {
  listenForVisibility,
  originForShow,
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
      { kind: 'category', id: 'privacy' },
      { kind: 'protection' },
    ]);
    expect(targetForShow(JSON.stringify({ target: 'setting:nope' })).stages).toEqual([
      { kind: 'root' },
    ]);
  });
});

describe('show targets awaiting a snapshot', () => {
  it('preserves a startup deep link until a ready model can accept it', () => {
    const requested = targetForShow(JSON.stringify({ target: 'privacy:level' }));
    expect(requested.stages.at(-1)).toEqual({ kind: 'protection' });
    expect(targetForModel(requested, REGULAR_MODEL)).toBe(requested);
    expect(targetForModel(requested, { ...REGULAR_MODEL, search: null })).toBe(ROOT_TARGET);
  });

  it('falls back for unavailable ready targets without changing unknown fallback', () => {
    const backup = targetForShow(JSON.stringify({ target: 'backup:open' }));
    expect(targetForModel(backup, PRIVATE_MODEL)).toBe(ROOT_TARGET);
    const tints = targetForShow(JSON.stringify({ target: 'setting:tabStateTintsEnabled' }));
    expect(targetForModel(tints, REGULAR_MODEL)).toBe(tints);
    expect(
      targetForModel(targetForShow(JSON.stringify({ target: 'setting:nope' })), REGULAR_MODEL),
    ).toBe(ROOT_TARGET);
  });
});

describe('originForShow', () => {
  it('knows only the command palette as an origin', () => {
    expect(originForShow(JSON.stringify({ target: null, origin: 'palette' }))).toBe('palette');
    for (const detail of [JSON.stringify({ origin: 'menu' }), '{}', 'not json', undefined]) {
      expect(originForShow(detail)).toBeNull();
    }
  });
});

describe('listenForVisibility', () => {
  it('reports a show with its target and origin and a hide, until it is unsubscribed', () => {
    const source = new EventTarget();
    const seen: string[] = [];
    const stop = listenForVisibility(source, {
      onShow: (target, origin) => seen.push(`show:${target.stages.length}:${origin}`),
      onHide: () => seen.push('hide'),
    });
    source.dispatchEvent(
      new CustomEvent(SETTINGS_SHOW_EVENT, {
        detail: JSON.stringify({ target: 'privacy:level', origin: 'palette' }),
      }),
    );
    source.dispatchEvent(new CustomEvent(SETTINGS_HIDE_EVENT));
    stop();
    source.dispatchEvent(new CustomEvent(SETTINGS_HIDE_EVENT));
    expect(seen).toEqual(['show:3:palette', 'hide']);
  });
});
