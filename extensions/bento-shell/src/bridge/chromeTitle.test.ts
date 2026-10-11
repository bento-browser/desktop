import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChromeTitle } from './fakeChromeTitle';

describe('sendChromeTitle', () => {
  let chrome: ReturnType<typeof installFakeChromeTitle>;
  let sendChromeTitle: typeof import('./chromeTitle').sendChromeTitle;

  beforeEach(async () => {
    chrome = installFakeChromeTitle();
    vi.resetModules();
    ({ sendChromeTitle } = await import('./chromeTitle'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('premise: a raw title slot reports only the last of several writes made before the report', () => {
    // Raw writes are the thing the sendChromeTitle lint rule forbids.
    /* eslint-disable no-restricted-syntax */
    document.title = 'BENTO_PANELS:1';
    document.title = 'BENTO_OPEN_WELCOME_1';
    /* eslint-enable no-restricted-syntax */
    chrome.settle();

    expect(chrome.observed).toEqual(['BENTO_OPEN_WELCOME_1']);
  });

  it('reports every title sent in one task, in order', () => {
    sendChromeTitle('BENTO_PANELS:1');
    sendChromeTitle('BENTO_OPEN_WELCOME_1');
    sendChromeTitle('BENTO_SCROLL_TO_MAIN_1');
    chrome.settle();

    expect(chrome.observed).toEqual([
      'BENTO_PANELS:1',
      'BENTO_OPEN_WELCOME_1',
      'BENTO_SCROLL_TO_MAIN_1',
    ]);
  });

  it('reports a title when another task is already queued ahead of the first report', () => {
    // A bus message handler writes BENTO_PANELS while the next task (a React
    // effect, the next bus message) is already waiting in the queue.
    setTimeout(() => sendChromeTitle('BENTO_OPEN_WELCOME_1'), 0);
    sendChromeTitle('BENTO_PANELS:1');
    chrome.settle();

    expect(chrome.observed).toEqual(['BENTO_PANELS:1', 'BENTO_OPEN_WELCOME_1']);
  });

  it('writes straight away when nothing is pending', () => {
    sendChromeTitle('BENTO_PANELS:1');

    expect(document.title).toBe('BENTO_PANELS:1');
  });

  it('delivers the latest title of each prefix when producers interleave', () => {
    const sent: string[] = [];
    const send = (title: string) => {
      sent.push(title);
      sendChromeTitle(title);
    };
    // Panels forwards, welcome retries 200 ms apart, and menu signals, with
    // several of them landing in the same task.
    send('BENTO_PANELS:1');
    send('BENTO_OPEN_WELCOME_1');
    send('BENTO_PANELS:2');
    for (const [delay, title] of [
      [200, 'BENTO_OPEN_WELCOME_2'],
      [200, 'BENTO_PANELS:3'],
      [400, 'BENTO_OPEN_WELCOME_3'],
      [400, 'BENTO_MENU_CLOSE:ctx'],
      [400, 'BENTO_PANELS:4'],
    ] as const) {
      setTimeout(() => send(title), delay);
    }
    chrome.settle();

    expect(chrome.observed).toEqual(sent);
    const latest = (titles: string[], prefix: string) =>
      titles.filter((title) => title.startsWith(prefix)).at(-1);
    for (const prefix of ['BENTO_PANELS:', 'BENTO_OPEN_WELCOME_', 'BENTO_MENU_CLOSE:']) {
      expect(latest(chrome.observed, prefix)).toBe(latest(sent, prefix));
    }
  });
});
