import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MUXUI_THEME_PRESETS } from '@muxui/react/themes';

import {
  createFakeDocument,
  createFakeStorage,
  insertBootLink,
  type FakeHead,
  type FakeLink,
} from './fakeThemeDom';

describe('theme sheets', () => {
  let head: FakeHead;
  let sheets: typeof import('./themeSheets');

  const linkFor = (themeId: string): FakeLink =>
    [...head.links].find((link) => link.dataset.bentoThemeSheet === themeId)!;

  beforeEach(async () => {
    const fake = createFakeDocument();
    head = fake.head;
    vi.stubGlobal('document', fake.document);
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

  describe('the sheet public/boot.js requested early', () => {
    it('adopts a link that already loaded, without a second request', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loaded');
      await expect(sheets.setThemeSheets('root', ['standard-harbour'])).resolves.toBe('loaded');
      expect([...head.links]).toEqual([boot]);
      expect(boot.removed).toBe(false);
    });

    it('treats a sheet already on the element as loaded when the marker has not caught up', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loading');
      boot.sheet = { cssRules: [] };
      await expect(sheets.setThemeSheets('root', ['standard-harbour'])).resolves.toBe('loaded');
      expect(head.links.size).toBe(1);
    });

    it('waits for a link that is still loading, even if the engine already exposes its sheet', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loading');
      Object.defineProperty(boot, 'sheet', {
        get: () => ({
          get cssRules(): unknown[] {
            throw new Error('InvalidAccessError');
          },
        }),
      });
      let settled = false;
      const result = sheets.setThemeSheets('root', ['standard-harbour']).then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(head.links.size).toBe(1);

      boot.fire('load');
      await expect(result).resolves.toBe('loaded');
      expect([...head.links]).toEqual([boot]);
    });

    it('reports a failure when a link that was loading errors after adoption', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loading');
      const result = sheets.setThemeSheets('root', ['standard-harbour']);
      boot.fire('error');
      await expect(result).resolves.toBe('failed');
      expect(head.links.size).toBe(0);

      // The next request retries with a fresh link.
      void sheets.setThemeSheets('root', ['standard-harbour']);
      expect(head.hrefs).toEqual(['./themes/standard-harbour.css']);
      expect(boot.removed).toBe(true);
    });

    it('drops a link that failed before adoption and requests the sheet again', async () => {
      const failed = insertBootLink(head, 'standard-harbour', 'failed');
      const result = sheets.setThemeSheets('root', ['standard-harbour']);
      expect(failed.removed).toBe(true);
      expect(head.links.size).toBe(1);

      linkFor('standard-harbour').fire('load');
      await expect(result).resolves.toBe('loaded');
    });

    it('keeps the link while other owners come and go, until the workspace theme is known', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loaded');
      await sheets.setThemeSheets('avatar', []);
      await sheets.setThemeSheets('root', []);
      expect(boot.removed).toBe(false);
    });

    it('keeps the link when the root request names the same theme', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loaded');
      const result = sheets.setThemeSheets('root', ['standard-harbour']);
      sheets.releaseThemeSheets(sheets.BOOT_THEME_OWNER);
      await expect(result).resolves.toBe('loaded');
      expect([...head.links]).toEqual([boot]);
    });

    it('prunes the link once the workspace names a different theme', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loaded');
      const result = sheets.setThemeSheets('root', ['standard-lagoon']);
      expect(head.hrefs).toEqual(['./themes/standard-harbour.css', './themes/standard-lagoon.css']);

      sheets.releaseThemeSheets(sheets.BOOT_THEME_OWNER);
      expect(boot.removed).toBe(true);
      linkFor('standard-lagoon').fire('load');
      await expect(result).resolves.toBe('loaded');
      expect(head.hrefs).toEqual(['./themes/standard-lagoon.css']);
    });

    it('prunes the link when the workspace uses Default', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loaded');
      await sheets.setThemeSheets('root', ['default']);
      sheets.releaseThemeSheets(sheets.BOOT_THEME_OWNER);
      expect(boot.removed).toBe(true);
      expect(head.links.size).toBe(0);
    });

    it('keeps a sheet another owner needs when the boot hold is released', async () => {
      const boot = insertBootLink(head, 'standard-harbour', 'loaded');
      await sheets.setThemeSheets('avatar', ['standard-harbour']);
      await sheets.setThemeSheets('root', []);
      sheets.releaseThemeSheets(sheets.BOOT_THEME_OWNER);
      expect(boot.removed).toBe(false);
    });

    it.each(['removed-theme', 'default'])(
      'removes a link for %s, which has no sheet',
      async (id) => {
        const stale = insertBootLink(head, id, 'loading');
        await sheets.setThemeSheets('root', []);
        expect(stale.removed).toBe(true);
      },
    );
  });

  describe('theme hint', () => {
    it('stores the resolved id, never an alias, unknown, or missing id', () => {
      const storage = createFakeStorage();
      vi.stubGlobal('localStorage', storage);
      const write = (themeId: string | null | undefined) => {
        sheets.writeThemeHint(themeId);
        return storage.values.get(sheets.THEME_HINT_KEY);
      };

      expect(write('standard-harbour')).toBe('standard-harbour');
      expect(write('teal')).toBe('monochrome-teal');
      expect(write('deleted-theme')).toBe('default');
      expect(write('../etc')).toBe('default');
      expect(write(undefined)).toBe('default');
      expect(write(null)).toBe('default');
    });
  });

  it('lists every registered theme for preview documents', () => {
    expect(sheets.ALL_THEME_IDS).toContain('default');
    expect(sheets.ALL_THEME_IDS).toContain('standard-harbour');
    // Bento Default plus every theme the pinned Mux package ships.
    expect(sheets.ALL_THEME_IDS).toHaveLength(MUXUI_THEME_PRESETS.length + 1);
  });
});
