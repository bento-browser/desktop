import { describe, expect, it, vi } from 'vitest';

import {
  BOOKMARKS_HIDE_EVENT,
  BOOKMARKS_SHOW_EVENT,
  listenForVisibility,
  showMayFocus,
} from './visibility';

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

  it('hands over whether the show may take the focus', () => {
    const source = new EventTarget();
    const focus: boolean[] = [];
    listenForVisibility(source, { onShow: (show) => focus.push(show.focus), onHide: () => {} });
    source.dispatchEvent(new CustomEvent(BOOKMARKS_SHOW_EVENT, { detail: { focus: false } }));
    source.dispatchEvent(new CustomEvent(BOOKMARKS_SHOW_EVENT, { detail: { focus: true } }));
    expect(focus).toEqual([false, true]);
  });
});

describe('showMayFocus', () => {
  const show = (detail?: unknown) => new CustomEvent(BOOKMARKS_SHOW_EVENT, { detail });

  it('is false only when chrome says focus: false', () => {
    expect(showMayFocus(show({ focus: false }))).toBe(false);
    expect(showMayFocus(show({ focus: true }))).toBe(true);
  });

  it('is true without a usable detail, as for a story or a test dispatching a plain event', () => {
    expect(showMayFocus(new Event(BOOKMARKS_SHOW_EVENT))).toBe(true);
    expect(showMayFocus(show())).toBe(true);
    expect(showMayFocus(show(null))).toBe(true);
    expect(showMayFocus(show({}))).toBe(true);
    expect(showMayFocus(show('no'))).toBe(true);
    expect(showMayFocus(show({ focus: 0 }))).toBe(true);
  });
});
