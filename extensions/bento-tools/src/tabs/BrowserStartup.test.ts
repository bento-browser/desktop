import { describe, expect, it } from 'vitest';
import { createBrowserStartup } from './BrowserStartup';

describe('createBrowserStartup', () => {
  it('reports a browser start only after runtime.onStartup has fired', () => {
    const startup = createBrowserStartup();

    expect(startup.browserStarted()).toBe(false);
    startup.noteStartup();
    expect(startup.browserStarted()).toBe(true);
  });
});
