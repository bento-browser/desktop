import { describe, expect, it } from 'vitest';
import { followColorStamp } from './colorStamp';

describe('followColorStamp', () => {
  it('takes the first stamp and a higher sequence of the same run', () => {
    expect(followColorStamp(null, { run: 'a', seq: 1 })).toEqual({ run: 'a', seq: 1 });
    expect(followColorStamp({ run: 'a', seq: 1 }, { run: 'a', seq: 3 })).toEqual({
      run: 'a',
      seq: 3,
    });
  });

  it('keeps the higher sequence when an older event of the same run is replayed', () => {
    const recorded = { run: 'a', seq: 5 };
    expect(followColorStamp(recorded, { run: 'a', seq: 2 })).toBe(recorded);
    expect(followColorStamp(recorded, { run: 'a', seq: 5 })).toEqual(recorded);
  });

  it('follows a new run even when its sequence or clock is lower', () => {
    // A surviving sidebar after a tools restart: the old run reached 40, the new one starts at 1.
    expect(followColorStamp({ run: 'old', seq: 40 }, { run: 'new', seq: 1 })).toEqual({
      run: 'new',
      seq: 1,
    });
  });
});
