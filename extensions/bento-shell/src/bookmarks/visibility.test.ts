import { describe, expect, it, vi } from 'vitest';

import { BOOKMARKS_HIDE_EVENT, BOOKMARKS_SHOW_EVENT, listenForVisibility } from './visibility';

describe('listenForVisibility', () => {
  it('reports chrome shows and hides, and stops when unsubscribed', () => {
    const source = new EventTarget();
    const onShow = vi.fn();
    const onHide = vi.fn();
    const stop = listenForVisibility(source, { onShow, onHide });

    source.dispatchEvent(new CustomEvent(BOOKMARKS_SHOW_EVENT));
    source.dispatchEvent(new CustomEvent(BOOKMARKS_HIDE_EVENT));
    expect([onShow.mock.calls.length, onHide.mock.calls.length]).toEqual([1, 1]);

    stop();
    source.dispatchEvent(new CustomEvent(BOOKMARKS_SHOW_EVENT));
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});
