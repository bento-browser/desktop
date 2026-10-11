import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;

class FakeLink {
  rel = '';
  href = '';
  dataset: Record<string, string> = {};
  removed = false;
  private listeners = new Map<string, Listener>();

  constructor(private head: FakeHead) {}

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  remove() {
    this.removed = true;
    this.head.links.delete(this);
  }

  fire(type: 'load' | 'error') {
    this.listeners.get(type)?.();
  }
}

class FakeHead {
  links = new Set<FakeLink>();

  append(link: FakeLink) {
    this.links.add(link);
  }

  get hrefs() {
    return [...this.links].map((link) => link.href);
  }
}

describe('theme sheets', () => {
  let head: FakeHead;
  let sheets: typeof import('./themeSheets');

  const linkFor = (themeId: string) =>
    [...head.links].find((link) => link.dataset.bentoThemeSheet === themeId)!;

  beforeEach(async () => {
    head = new FakeHead();
    vi.stubGlobal('document', { head, createElement: () => new FakeLink(head) });
    vi.resetModules();
    sheets = await import('./themeSheets');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches a registered theme sheet and resolves when it loads', async () => {
    const result = sheets.setThemeSheets('root', ['standard-harbour']);
    expect(head.hrefs).toEqual(['./themes/standard-harbour.css']);
    linkFor('standard-harbour').fire('load');
    await expect(result).resolves.toBe(true);
  });

  it('needs no sheet for Default, unknown ids, or missing ids', async () => {
    await expect(
      sheets.setThemeSheets('root', ['default', 'deleted-theme', undefined, null]),
    ).resolves.toBe(true);
    expect(head.links.size).toBe(0);
  });

  it('resolves legacy aliases to the canonical sheet', () => {
    void sheets.setThemeSheets('root', ['teal']);
    expect(head.hrefs).toEqual(['./themes/monochrome-teal.css']);
  });

  it('keeps the previous sheet until the next one has loaded', async () => {
    const first = sheets.setThemeSheets('root', ['standard-harbour']);
    linkFor('standard-harbour').fire('load');
    await first;

    const second = sheets.setThemeSheets('root', ['standard-lagoon']);
    expect(head.hrefs).toEqual(['./themes/standard-harbour.css', './themes/standard-lagoon.css']);
    linkFor('standard-lagoon').fire('load');
    await second;
    expect(head.hrefs).toEqual(['./themes/standard-lagoon.css']);
  });

  it('keeps a sheet another owner still needs', async () => {
    const nested = sheets.setThemeSheets('nested', ['standard-harbour']);
    linkFor('standard-harbour').fire('load');
    await nested;

    const root = sheets.setThemeSheets('root', ['standard-harbour']);
    await root;
    const next = sheets.setThemeSheets('root', ['standard-lagoon']);
    linkFor('standard-lagoon').fire('load');
    await next;
    expect(head.hrefs.sort()).toEqual([
      './themes/standard-harbour.css',
      './themes/standard-lagoon.css',
    ]);

    sheets.releaseThemeSheets('nested');
    expect(head.hrefs).toEqual(['./themes/standard-lagoon.css']);
  });

  it('shares one link between owners that name the same theme', () => {
    void sheets.setThemeSheets('root', ['standard-harbour']);
    void sheets.setThemeSheets('nested', ['standard-harbour']);
    expect(head.links.size).toBe(1);
  });

  it('reports a failed load, drops the link, and retries on the next request', async () => {
    const failed = sheets.setThemeSheets('root', ['standard-harbour']);
    linkFor('standard-harbour').fire('error');
    await expect(failed).resolves.toBe(false);
    expect(head.links.size).toBe(0);

    void sheets.setThemeSheets('root', ['standard-harbour']);
    expect(head.links.size).toBe(1);
  });

  it('lists every registered theme for preview documents', () => {
    expect(sheets.ALL_THEME_IDS).toContain('default');
    expect(sheets.ALL_THEME_IDS).toContain('standard-harbour');
    expect(sheets.ALL_THEME_IDS).toHaveLength(16);
  });
});
