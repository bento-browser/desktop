import { describe, expect, it } from 'vitest';
import { normalizeExternalSession } from '../normalizeExternalSession';
import { ExternalMergeError } from '../sourceTypes';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function int32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function command(id: number, payload: number[]): number[] {
  const length = payload.length + 1;
  return [length & 0xff, (length >> 8) & 0xff, id, ...payload];
}

function navigationPayload(tabId: number, index: number, url: string): number[] {
  const urlBytes = [...new TextEncoder().encode(url)];
  return [
    ...int32(urlBytes.length + 12),
    ...int32(tabId),
    ...int32(index),
    ...int32(urlBytes.length),
    ...urlBytes,
  ];
}

function snssBase64(commands: number[][]): string {
  return bytesToBase64(new Uint8Array([0x53, 0x4e, 0x53, 0x53, ...int32(3), ...commands.flat()]));
}

describe('external merge session parsers', () => {
  it('imports only Firefox open non-private current tab entries', () => {
    const session = normalizeExternalSession({
      sourceId: 'firefox-default',
      kind: 'firefox',
      browserName: 'Firefox',
      profileName: 'Default',
      lastModified: 100,
      capturedAt: 200,
      format: 'firefox-json',
      json: JSON.stringify({
        selectedWindow: 1,
        _closedWindows: [
          {
            tabs: [{ entries: [{ url: 'https://closed.example/' }], index: 1 }],
          },
        ],
        windows: [
          {
            selected: 1,
            tabs: [
              {
                entries: [
                  { url: 'https://history.example/', title: 'History' },
                  { url: 'https://current.example/', title: 'Current' },
                ],
                index: 2,
                groupId: 'g1',
              },
              {
                entries: [{ url: 'https://private.example/' }],
                index: 1,
                isPrivate: true,
              },
            ],
            tabGroups: [{ id: 'g1', name: 'Research', index: 0 }],
          },
        ],
      }),
    });

    expect(session.windows).toHaveLength(1);
    expect(session.windows[0]!.tabs.map((tab) => tab.url)).toEqual(['https://current.example/']);
    expect(session.windows[0]!.groups).toEqual([{ id: 'g1', name: 'Research', index: 0 }]);
  });

  it('maps Zen spaces to native workspaces and skips hidden tabs', () => {
    const session = normalizeExternalSession({
      sourceId: 'zen-default',
      kind: 'zen',
      browserName: 'Zen Browser',
      profileName: 'Default',
      lastModified: 100,
      capturedAt: 200,
      format: 'zen-json',
      json: JSON.stringify({
        spaces: [{ uuid: 'space-a', name: 'Space A' }],
        groups: [{ id: 'zen-group-1', name: 'Tale UI', collapsed: true }],
        tabs: [
          {
            zenWorkspace: 'space-a',
            entries: [{ url: 'https://space.example/', title: 'Space' }],
            groupId: 'zen-group-1',
            _zenIsActiveTab: true,
            index: 1,
          },
          {
            zenWorkspace: 'space-a',
            hidden: true,
            entries: [{ url: 'https://hidden.example/' }],
            index: 1,
          },
        ],
      }),
    });

    expect(session.workspaces).toEqual([
      { id: 'space-a', name: 'Space A', windowIds: ['zen-window-space-a'] },
    ]);
    expect(session.windows).toHaveLength(1);
    expect(session.windows[0]!.workspaceId).toBe('space-a');
    expect(session.windows[0]!.groups).toEqual([
      { id: 'zen-group-1', name: 'Tale UI', index: 0, collapsed: true },
    ]);
    expect(session.windows[0]!.tabs.map((tab) => tab.url)).toEqual(['https://space.example/']);
    expect(session.windows[0]!.tabs[0]!.active).toBe(true);
  });

  it('extracts Chromium session URLs and rejects grouped sessions', () => {
    const plain = btoa('xxxx https://one.example/\u0000yyyy https://two.example/path');
    const session = normalizeExternalSession({
      sourceId: 'chrome-default',
      kind: 'chrome',
      browserName: 'Chrome',
      profileName: 'Default',
      lastModified: 100,
      capturedAt: 200,
      format: 'chromium-session-files',
      files: [{ name: 'Session_1', payloadBase64: plain, lastModified: 100 }],
    });
    expect(session.windows[0]!.tabs.map((tab) => tab.url)).toEqual([
      'https://one.example/',
      'https://two.example/path',
    ]);

    expect(() =>
      normalizeExternalSession({
        sourceId: 'chrome-grouped',
        kind: 'chrome',
        browserName: 'Chrome',
        profileName: 'Default',
        lastModified: 100,
        capturedAt: 200,
        format: 'chromium-session-files',
        files: [
          {
            name: 'Session_1',
            payloadBase64: btoa('tab_group https://group.example/'),
            lastModified: 100,
          },
        ],
      }),
    ).toThrow(ExternalMergeError);
  });

  it('uses Chromium live tab commands instead of every URL string in rotated files', () => {
    const session = normalizeExternalSession({
      sourceId: 'chrome-default',
      kind: 'chrome',
      browserName: 'Chrome',
      profileName: 'Default',
      lastModified: 200,
      capturedAt: 300,
      format: 'chromium-session-files',
      files: [
        {
          name: 'Tabs_older',
          payloadBase64: btoa('https://stale-one.example/ https://stale-two.example/'),
          lastModified: 100,
        },
        {
          name: 'Session_newer',
          payloadBase64: snssBase64([
            command(0, [...int32(1), ...int32(10)]),
            command(2, [...int32(10), ...int32(0)]),
            command(6, navigationPayload(10, 0, 'https://current.example/')),
            command(6, navigationPayload(10, 1, 'https://selected.example/')),
            command(7, [...int32(10), ...int32(1)]),
            command(8, [...int32(1), ...int32(0)]),
          ]),
          lastModified: 200,
        },
      ],
    });

    expect(session.windows).toHaveLength(1);
    expect(session.windows[0]!.tabs.map((tab) => tab.url)).toEqual(['https://selected.example/']);
  });
});
