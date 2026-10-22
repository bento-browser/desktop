import { describe, expect, it } from 'vitest';
import { targetForShow } from './useShowSignal';

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
