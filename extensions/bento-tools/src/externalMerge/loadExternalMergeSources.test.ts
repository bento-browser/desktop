import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadExternalMergeSources } from './loadExternalMergeSources';

describe('loadExternalMergeSources', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed source summaries for readable candidates', async () => {
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        listCandidates: vi.fn(async () => [
          {
            sourceId: 'firefox-default',
            kind: 'firefox',
            browserName: 'Firefox',
            profileName: 'default-release',
            lastModified: 100,
          },
        ]),
        readSnapshot: vi.fn(async () => ({
          sourceId: 'firefox-default',
          kind: 'firefox',
          browserName: 'Firefox',
          profileName: 'default-release',
          lastModified: 100,
          capturedAt: 200,
          format: 'firefox-json',
          json: JSON.stringify({
            windows: [
              {
                selected: 1,
                tabs: [{ entries: [{ url: 'https://example.com/', title: 'Example' }], index: 1 }],
              },
            ],
          }),
        })),
      },
    });

    await expect(loadExternalMergeSources()).resolves.toEqual([
      {
        id: 'firefox-default',
        kind: 'firefox',
        browserName: 'Firefox',
        profileName: 'default-release',
        lastModified: 100,
        windowCount: 1,
        tabCount: 1,
        groupCount: 0,
        targets: [
          {
            id: 'window:firefox-window-1',
            kind: 'window',
            name: 'Window 1',
            windowCount: 1,
            tabCount: 1,
            groupCount: 0,
            previewTabs: [
              {
                title: 'Example',
                url: 'https://example.com/',
                active: true,
              },
            ],
          },
        ],
      },
    ]);
  });

  it('returns unavailable rows when discovery succeeds but reads fail', async () => {
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        listCandidates: vi.fn(async () => [
          {
            sourceId: 'zen-default',
            kind: 'zen',
            browserName: 'Zen Browser',
            profileName: 'Default (release)',
            lastModified: 100,
          },
        ]),
        readSnapshot: vi.fn(async () => {
          throw new Error('Browser session snapshot is unreadable.');
        }),
      },
    });

    await expect(loadExternalMergeSources()).resolves.toEqual([
      {
        id: 'zen-default',
        kind: 'zen',
        browserName: 'Zen Browser',
        profileName: 'Default (release)',
        lastModified: 100,
        windowCount: 0,
        tabCount: 0,
        groupCount: 0,
        unavailableReason: 'Session file unreadable',
      },
    ]);
  });

  it('keeps unreadable candidates visible beside mergeable sources', async () => {
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        listCandidates: vi.fn(async () => [
          {
            sourceId: 'chrome-default',
            kind: 'chrome',
            browserName: 'Chrome',
            profileName: 'Your Chrome',
            lastModified: 300,
          },
          {
            sourceId: 'firefox-default',
            kind: 'firefox',
            browserName: 'Firefox',
            profileName: 'default-release',
            lastModified: 100,
          },
        ]),
        readSnapshot: vi.fn(async (sourceId: string) => {
          if (sourceId === 'chrome-default') {
            throw new Error('Browser session snapshot is unreadable.');
          }
          return {
            sourceId: 'firefox-default',
            kind: 'firefox',
            browserName: 'Firefox',
            profileName: 'default-release',
            lastModified: 100,
            capturedAt: 200,
            format: 'firefox-json',
            json: JSON.stringify({
              windows: [
                {
                  selected: 1,
                  tabs: [
                    { entries: [{ url: 'https://example.com/', title: 'Example' }], index: 1 },
                  ],
                },
              ],
            }),
          };
        }),
      },
    });

    await expect(loadExternalMergeSources()).resolves.toEqual([
      {
        id: 'chrome-default',
        kind: 'chrome',
        browserName: 'Chrome',
        profileName: 'Your Chrome',
        lastModified: 300,
        windowCount: 0,
        tabCount: 0,
        groupCount: 0,
        unavailableReason: 'Session file unreadable',
      },
      {
        id: 'firefox-default',
        kind: 'firefox',
        browserName: 'Firefox',
        profileName: 'default-release',
        lastModified: 100,
        windowCount: 1,
        tabCount: 1,
        groupCount: 0,
        targets: [
          {
            id: 'window:firefox-window-1',
            kind: 'window',
            name: 'Window 1',
            windowCount: 1,
            tabCount: 1,
            groupCount: 0,
            previewTabs: [
              {
                title: 'Example',
                url: 'https://example.com/',
                active: true,
              },
            ],
          },
        ],
      },
    ]);
  });

  it('surfaces when Chrome session metadata is visible but file reads fail', async () => {
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        listCandidates: vi.fn(async () => [
          {
            sourceId: 'chrome-default',
            kind: 'chrome',
            browserName: 'Chrome',
            profileName: 'Your Chrome',
            lastModified: 300,
          },
        ]),
        readSnapshot: vi.fn(async () => {
          throw new Error('Session files were found, but file reads failed.');
        }),
      },
    });

    await expect(loadExternalMergeSources()).resolves.toEqual([
      {
        id: 'chrome-default',
        kind: 'chrome',
        browserName: 'Chrome',
        profileName: 'Your Chrome',
        lastModified: 300,
        windowCount: 0,
        tabCount: 0,
        groupCount: 0,
        unavailableReason: 'Session files visible, but unreadable',
      },
    ]);
  });

  it('preserves sanitized Chrome read failure categories', async () => {
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        listCandidates: vi.fn(async () => [
          {
            sourceId: 'chrome-default',
            kind: 'chrome',
            browserName: 'Chrome',
            profileName: 'Your Chrome',
            lastModified: 300,
          },
        ]),
        readSnapshot: vi.fn(async () => {
          throw new Error('Session files were found, but file reads failed (permission denied).');
        }),
      },
    });

    await expect(loadExternalMergeSources()).resolves.toEqual([
      {
        id: 'chrome-default',
        kind: 'chrome',
        browserName: 'Chrome',
        profileName: 'Your Chrome',
        lastModified: 300,
        windowCount: 0,
        tabCount: 0,
        groupCount: 0,
        unavailableReason: 'Session files visible, but unreadable (permission denied)',
      },
    ]);
  });

  it('preserves sanitized Chrome read failure tokens', async () => {
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        listCandidates: vi.fn(async () => [
          {
            sourceId: 'chrome-default',
            kind: 'chrome',
            browserName: 'Chrome',
            profileName: 'Your Chrome',
            lastModified: 300,
          },
        ]),
        readSnapshot: vi.fn(async () => {
          throw new Error(
            'Session files were found, but file reads failed (read failed: NotAllowedError:0x80520015,NS_ERROR_FILE_ACCESS_DENIED:0x80520015).',
          );
        }),
      },
    });

    await expect(loadExternalMergeSources()).resolves.toEqual([
      {
        id: 'chrome-default',
        kind: 'chrome',
        browserName: 'Chrome',
        profileName: 'Your Chrome',
        lastModified: 300,
        windowCount: 0,
        tabCount: 0,
        groupCount: 0,
        unavailableReason:
          'Session files visible, but unreadable (read failed: NotAllowedError:0x80520015,NS_ERROR_FILE_ACCESS_DENIED:0x80520015)',
      },
    ]);
  });
});
