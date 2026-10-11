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
    await expect(result).resolves.toBe('loaded');
  });

  it('needs no sheet for Default, unknown ids, or missing ids', async () => {
    await expect(
      sheets.setThemeSheets('root', ['default', 'deleted-theme', undefined, null]),
    ).resolves.toBe('loaded');
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
    await expect(failed).resolves.toBe('failed');
    expect(head.links.size).toBe(0);

    void sheets.setThemeSheets('root', ['standard-harbour']);
    expect(head.links.size).toBe(1);
  });

  describe('while the displayed theme changes', () => {
    /** Show `themeId` for `owner`, as useWorkspaceTheme does once the sheet has loaded. */
    async function show(owner: string, themeId: string) {
      const result = sheets.setThemeSheets(owner, [themeId]);
      linkFor(themeId).fire('load');
      await expect(result).resolves.toBe('loaded');
    }

    it('keeps the displayed sheet when a superseded request finishes first (A, B, C)', async () => {
      await show('root', 'standard-harbour');

      const b = sheets.setThemeSheets('root', ['standard-lagoon']);
      const lagoonLink = linkFor('standard-lagoon');
      const c = sheets.setThemeSheets('root', ['standard-fern']);
      // B finishes while C is still loading: it must not apply or prune the shown sheet.
      lagoonLink.fire('load');
      await expect(b).resolves.toBe('superseded');
      expect(head.hrefs).toContain('./themes/standard-harbour.css');

      linkFor('standard-fern').fire('load');
      await expect(c).resolves.toBe('loaded');
      expect(head.hrefs).toEqual(['./themes/standard-fern.css']);
    });

    it('keeps the displayed sheet until C fails, then drops it for the Default fallback', async () => {
      await show('root', 'standard-harbour');

      const b = sheets.setThemeSheets('root', ['standard-lagoon']);
      const lagoonLink = linkFor('standard-lagoon');
      const c = sheets.setThemeSheets('root', ['standard-fern']);
      lagoonLink.fire('load');
      await expect(b).resolves.toBe('superseded');
      expect(head.hrefs).toContain('./themes/standard-harbour.css');

      linkFor('standard-fern').fire('error');
      await expect(c).resolves.toBe('failed');
      expect(head.links.size).toBe(0);
    });

    it('leaves the displayed sheet alone when the owner switches back before B loads', async () => {
      await show('root', 'standard-harbour');

      const b = sheets.setThemeSheets('root', ['standard-lagoon']);
      const back = sheets.setThemeSheets('root', ['standard-harbour']);
      await expect(back).resolves.toBe('loaded');
      await expect(b).resolves.toBe('superseded');
      expect(head.hrefs).toEqual(['./themes/standard-harbour.css']);
    });

    it('does not bring back an owner that was released while loading', async () => {
      const pending = sheets.setThemeSheets('root', ['standard-harbour']);
      const harbourLink = linkFor('standard-harbour');
      sheets.releaseThemeSheets('root');
      harbourLink.fire('load');
      await expect(pending).resolves.toBe('superseded');
      expect(head.links.size).toBe(0);
    });

    it('keeps a pinned panel theme attached across workspace switches', async () => {
      // A pinned panel from a Lagoon workspace renders while Harbour is active.
      await show('pin', 'standard-lagoon');
      await show('root', 'standard-harbour');

      await show('root', 'standard-fern');
      await show('root', 'standard-harbour');
      expect(head.hrefs.sort()).toEqual([
        './themes/standard-harbour.css',
        './themes/standard-lagoon.css',
      ]);

      // Only unmounting the pin lets Lagoon go.
      sheets.releaseThemeSheets('pin');
      expect(head.hrefs).toEqual(['./themes/standard-harbour.css']);
    });
  });

  it('lists every registered theme for preview documents', () => {
    expect(sheets.ALL_THEME_IDS).toContain('default');
    expect(sheets.ALL_THEME_IDS).toContain('standard-harbour');
    expect(sheets.ALL_THEME_IDS).toHaveLength(16);
  });
});
