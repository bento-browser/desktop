import { describe, expect, it } from 'vitest';
import type { Action } from '@shared/protocol';
import { MAX_URL_LENGTH } from '@shared/export-schema';
import { parseWireAction } from '@shared/wire-action';

type ActionType = Action['type'];
type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;

/** A valid https URL of exactly `length` characters. */
const urlOfLength = (length: number) => 'https://example.com/'.padEnd(length, 'a');

/** One valid message per Action type; the mapped type fails to compile if a type is missing. */
const VALID: { [T in ActionType]: ActionOf<T> } = {
  ping: { type: 'ping' },
  'shell/hello': { type: 'shell/hello', windowId: 3 },
  'tabs/requestSnapshot': { type: 'tabs/requestSnapshot' },
  'tabFolders/requestSnapshot': { type: 'tabFolders/requestSnapshot' },
  'tab/activate': { type: 'tab/activate', id: 12 },
  'tab/close': { type: 'tab/close', id: 12 },
  'tabs/close': { type: 'tabs/close', ids: [1, 2, 3] },
  'tabs/reload': { type: 'tabs/reload', ids: [1, 2], bypassCache: true },
  'tab/closeMain': { type: 'tab/closeMain', id: 12 },
  'tab/rename': { type: 'tab/rename', id: 12, title: 'Reading list' },
  'tab/assignWorkspace': { type: 'tab/assignWorkspace', id: 12, workspaceId: 'ws-1' },
  'tabs/assignWorkspace': { type: 'tabs/assignWorkspace', ids: [1, 2], workspaceId: 'ws-1' },
  'tabFolder/create': { type: 'tabFolder/create', id: 'f-1', name: 'Docs', tabIds: [1, 2] },
  'tabFolder/rename': { type: 'tabFolder/rename', id: 'f-1', name: 'Docs' },
  'tabFolder/delete': { type: 'tabFolder/delete', id: 'f-1' },
  'tabFolder/setCollapsed': { type: 'tabFolder/setCollapsed', id: 'f-1', collapsed: true },
  'tabFolder/reorder': { type: 'tabFolder/reorder', workspaceId: 'ws-1', orderedIds: ['f-1'] },
  'tabFolder/assignWorkspace': {
    type: 'tabFolder/assignWorkspace',
    id: 'f-1',
    workspaceId: 'ws-2',
  },
  'tabs/setFolder': { type: 'tabs/setFolder', ids: [1], folderId: null },
  'tabs/moveToNewWorkspace': { type: 'tabs/moveToNewWorkspace', ids: [1], name: 'Research' },
  'tab/openUrl': { type: 'tab/openUrl', url: 'https://example.com/a?b=c', active: true },
  'tab/reopenClosed': { type: 'tab/reopenClosed' },
  'tab/create': { type: 'tab/create', active: false, index: 4 },
  'tab/reload': { type: 'tab/reload', id: 12, bypassCache: false },
  'tab/unload': { type: 'tab/unload', id: 12 },
  'tab/setPinned': { type: 'tab/setPinned', id: 12, pinned: true },
  'tab/togglePin': { type: 'tab/togglePin', id: 12 },
  'tab/toggleMuted': { type: 'tab/toggleMuted', id: 12 },
  'workspaces/requestSnapshot': { type: 'workspaces/requestSnapshot' },
  'workspace/create': { type: 'workspace/create', name: 'Work', themeId: 'default' },
  'workspace/rename': { type: 'workspace/rename', id: 'ws-1', name: 'Work' },
  'workspace/update': {
    type: 'workspace/update',
    id: 'ws-1',
    changes: { name: 'Work', themeId: 'sage', icon: undefined },
  },
  'workspace/delete': { type: 'workspace/delete', id: 'ws-1', closeTabs: true },
  'workspace/activate': { type: 'workspace/activate', id: 'ws-1' },
  'settings/requestSnapshot': { type: 'settings/requestSnapshot' },
  'settings/update': { type: 'settings/update', changes: { sidebarCollapsed: true } },
  'settings/reset': { type: 'settings/reset' },
  'panel/add': { type: 'panel/add', id: 9 },
  'panel/addDevtools': { type: 'panel/addDevtools', tabId: 9, forTabId: null, inspectedTabId: 4 },
  'panel/focus': { type: 'panel/focus', workspaceId: 'ws-1', id: 9 },
  'panel/openAt': { type: 'panel/openAt', url: 'about:newtab', sourceTabId: null, position: 'end' },
  'panel/remove': { type: 'panel/remove', id: 9 },
  'panel/focusedChanged': { type: 'panel/focusedChanged', tabId: null },
  'panels/clear': { type: 'panels/clear' },
  'panelLayout/reorderRoot': { type: 'panelLayout/reorderRoot', rootNodeIds: ['panel:9', 'g1'] },
  'panelLayout/movePanel': {
    type: 'panelLayout/movePanel',
    tabId: 9,
    target: { type: 'horizontal', groupId: 'g1', row: 'top', position: 'after' },
  },
  'panel/setWidth': { type: 'panel/setWidth', id: 9, widthPx: 640 },
  'panel/setHeaderHidden': { type: 'panel/setHeaderHidden', id: 9, hidden: true },
  'panel/setMainWidth': { type: 'panel/setMainWidth', widthPx: 800 },
  'panel/setStripScroll': { type: 'panel/setStripScroll', workspaceId: 'ws-1', scrollLeft: 120.5 },
  'panelLayout/subdivide': { type: 'panelLayout/subdivide', tabId: 9 },
  'panelLayout/splitTopPanel': { type: 'panelLayout/splitTopPanel', tabId: 9, url: '' },
  'panelLayout/splitBottomPanel': {
    type: 'panelLayout/splitBottomPanel',
    tabId: 9,
    url: 'https://example.com',
  },
  'panelLayout/fillChooser': {
    type: 'panelLayout/fillChooser',
    chooserId: 'c1',
    mode: 'dual',
    urls: ['', 'https://example.com'],
  },
  'panelLayout/breakOut': { type: 'panelLayout/breakOut', tabId: 9 },
  'panelLayout/removeVerticalGroup': {
    type: 'panelLayout/removeVerticalGroup',
    groupId: 'g1',
    closeDelayMs: 200,
  },
  'panelLayout/setGroupRatio': { type: 'panelLayout/setGroupRatio', groupId: 'g1', ratio: 0.4 },
  'privacy/requestSnapshot': { type: 'privacy/requestSnapshot' },
  'privacy/setProtectionLevel': { type: 'privacy/setProtectionLevel', level: 'enhanced' },
  'privacy/setAdvanced': { type: 'privacy/setAdvanced', key: 'httpsOnlyMode', value: true },
  'privacy/setDefaultSearchEngine': { type: 'privacy/setDefaultSearchEngine', id: 'ddg' },
  'searchEngines/requestSnapshot': { type: 'searchEngines/requestSnapshot' },
  'addrbar/query': { type: 'addrbar/query', requestId: 'query-1', query: 'bento', limit: 8 },
  'addrbar/restoreClosed': {
    type: 'addrbar/restoreClosed',
    requestId: 'restore-1',
    sessionId: 'closed-1',
  },
  'pinnedPanel/add': { type: 'pinnedPanel/add', workspaceId: 'ws-1', tabId: 9 },
  'pinnedPanel/remove': { type: 'pinnedPanel/remove', workspaceId: 'ws-1', tabId: -2 },
  'pinnedPanel/open': { type: 'pinnedPanel/open', workspaceId: 'ws-1', tabId: -1 },
  'pinnedPanel/close': { type: 'pinnedPanel/close', workspaceId: 'ws-1', tabId: 9 },
  'pinnedPanel/activate': { type: 'pinnedPanel/activate', workspaceId: 'ws-1', tabId: 9 },
  'pinnedPanels/reorder': {
    type: 'pinnedPanels/reorder',
    orderedKeys: [{ workspaceId: 'ws-1', tabId: -1 }],
  },
  'pinnedPanels/requestSnapshot': { type: 'pinnedPanels/requestSnapshot' },
  'savedPanels/save': {
    type: 'savedPanels/save',
    url: 'https://example.com/',
    title: 'Example',
    favIconUrl: 'data:image/png;base64,AAAA',
  },
  'savedPanels/requestSnapshot': { type: 'savedPanels/requestSnapshot' },
  'externalMerge/requestSources': { type: 'externalMerge/requestSources', requestId: 'r-1' },
  'externalMerge/merge': {
    type: 'externalMerge/merge',
    sourceId: 'firefox:abc:def',
    operationId: 'op-1',
    targetIds: ['w1'],
  },
  'externalMerge/cancel': { type: 'externalMerge/cancel', operationId: 'op-1' },
};

const parse = (message: unknown) => parseWireAction(message);
const withFields = (type: ActionType, fields: Record<string, unknown>) => ({
  ...VALID[type],
  ...fields,
});

describe('parseWireAction: valid messages', () => {
  it.each(Object.entries(VALID))('accepts %s', (_type, action) => {
    expect(parse(action)).toEqual({ action, windowId: null });
  });

  it('separates the __windowId envelope from the action', () => {
    expect(parse({ ...VALID['tab/close'], __windowId: 0 })).toEqual({
      action: VALID['tab/close'],
      windowId: 0,
    });
    expect(parse({ ...VALID['tab/close'], __windowId: 7 })?.windowId).toBe(7);
    expect(parse({ ...VALID['tab/close'], __windowId: undefined })?.windowId).toBeNull();
  });

  it('accepts optional fields as absent or explicitly undefined', () => {
    expect(parse({ type: 'tab/create' })).not.toBeNull();
    expect(parse({ type: 'tab/create', active: undefined, index: undefined })).not.toBeNull();
    expect(parse({ type: 'workspace/update', id: 'ws-1', changes: {} })).not.toBeNull();
  });
});

describe('parseWireAction: malformed messages', () => {
  it('rejects non-objects and missing or unknown types', () => {
    for (const message of [
      null,
      undefined,
      0,
      42,
      'ping',
      true,
      [],
      [VALID.ping],
      () => VALID.ping,
      {},
      { type: 7 },
      { type: null },
      { type: '' },
      { type: 'tab/explode' },
      { type: 'ui/renameRequest' },
      { type: 'menu/open' },
      { type: 'toString' },
      { type: 'constructor' },
      { type: '__proto__' },
      { type: 'hasOwnProperty' },
    ]) {
      expect(parse(message)).toBeNull();
    }
  });

  it('rejects unknown and inherited keys', () => {
    expect(parse(withFields('tab/close', { extra: 1 }))).toBeNull();
    expect(parse(withFields('ping', { windowId: 3 }))).toBeNull();
    expect(parse(JSON.parse('{"type":"ping","__proto__":{"x":1}}'))).toBeNull();
    expect(parse(JSON.parse('{"type":"ping","constructor":1}'))).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(parse({ type: 'tab/close' })).toBeNull();
    expect(parse({ type: 'tab/rename', id: 3 })).toBeNull();
    expect(parse({ type: 'panel/addDevtools', tabId: 3, inspectedTabId: 4 })).toBeNull();
    expect(parse({ type: 'tab/close', id: undefined })).toBeNull();
  });

  it('rejects invalid __windowId envelopes', () => {
    for (const windowId of [-1, 1.5, Number.NaN, Infinity, '3', null, {}, [], true, 2 ** 53]) {
      expect(parse({ ...VALID['tab/close'], __windowId: windowId })).toBeNull();
    }
  });

  it('rejects non-finite, negative, fractional, and unsafe ids', () => {
    for (const id of [
      Number.NaN,
      Infinity,
      -Infinity,
      -1,
      1.5,
      2 ** 53,
      '3',
      null,
      undefined,
      {},
    ]) {
      expect(parse(withFields('tab/close', { id }))).toBeNull();
      expect(parse(withFields('panel/focus', { id }))).toBeNull();
      expect(parse(withFields('shell/hello', { windowId: id }))).toBeNull();
    }
    expect(parse(withFields('tabs/close', { ids: [1, -1] }))).toBeNull();
    expect(parse(withFields('tabs/close', { ids: [1, Number.NaN] }))).toBeNull();
    expect(parse(withFields('panel/openAt', { sourceTabId: -3 }))).toBeNull();
    expect(parse(withFields('tab/create', { index: -1 }))).toBeNull();
    expect(parse(withFields('pinnedPanel/add', { tabId: -1 }))).toBeNull();
    expect(parse(withFields('pinnedPanel/open', { tabId: Number.NaN }))).toBeNull();
    expect(parse(withFields('pinnedPanel/open', { tabId: 1.5 }))).toBeNull();
  });

  it('rejects non-finite and out-of-range numbers', () => {
    for (const widthPx of [0, -5, Number.NaN, Infinity, 1_000_000, '640']) {
      expect(parse(withFields('panel/setWidth', { widthPx }))).toBeNull();
      expect(parse(withFields('panel/setMainWidth', { widthPx }))).toBeNull();
    }
    for (const scrollLeft of [-1, Number.NaN, Infinity, 1e9]) {
      expect(parse(withFields('panel/setStripScroll', { scrollLeft }))).toBeNull();
    }
    for (const ratio of [-0.1, 1.5, Number.NaN, Infinity]) {
      expect(parse(withFields('panelLayout/setGroupRatio', { ratio }))).toBeNull();
    }
    expect(parse(withFields('addrbar/query', { limit: 0 }))).toBeNull();
    expect(parse(withFields('addrbar/query', { limit: 5000 }))).toBeNull();
    expect(parse(withFields('panelLayout/removeVerticalGroup', { closeDelayMs: -1 }))).toBeNull();
  });

  it('rejects wrong field types', () => {
    expect(parse(withFields('tabs/reload', { bypassCache: 'yes' }))).toBeNull();
    expect(parse(withFields('tab/setPinned', { pinned: 1 }))).toBeNull();
    expect(parse(withFields('tabFolder/setCollapsed', { collapsed: 'true' }))).toBeNull();
    expect(parse(withFields('tab/rename', { title: 5 }))).toBeNull();
    expect(parse(withFields('tab/assignWorkspace', { workspaceId: 7 }))).toBeNull();
    expect(parse(withFields('tabs/close', { ids: 'all' }))).toBeNull();
    expect(parse(withFields('tabs/close', { ids: { length: 1, 0: 1 } }))).toBeNull();
    expect(parse(withFields('privacy/setProtectionLevel', { level: 'custom' }))).toBeNull();
    expect(parse(withFields('privacy/setProtectionLevel', { level: 'off' }))).toBeNull();
    expect(parse(withFields('panel/openAt', { position: 'middle' }))).toBeNull();
    expect(parse(withFields('panelLayout/fillChooser', { mode: 'triple' }))).toBeNull();
  });

  it('rejects oversized strings and empty ids', () => {
    expect(parse(withFields('workspace/rename', { name: 'n'.repeat(1_025) }))).toBeNull();
    expect(parse(withFields('tab/rename', { title: 't'.repeat(4_097) }))).toBeNull();
    expect(parse(withFields('tab/assignWorkspace', { workspaceId: 'w'.repeat(257) }))).toBeNull();
    expect(parse(withFields('tab/assignWorkspace', { workspaceId: '' }))).toBeNull();
    expect(parse(withFields('addrbar/query', { query: 'q'.repeat(4_097) }))).toBeNull();
    expect(parse(withFields('privacy/setAdvanced', { value: 'v'.repeat(65) }))).toBeNull();
    expect(
      parse(withFields('workspace/update', { changes: { icon: 'i'.repeat(257) } })),
    ).toBeNull();
    expect(parse(withFields('tab/rename', { title: 't'.repeat(4_096) }))).not.toBeNull();
  });

  it('rejects oversized arrays and bad elements', () => {
    const ids = Array.from({ length: 20_001 }, (_, index) => index);
    expect(parse(withFields('tabs/close', { ids }))).toBeNull();
    expect(parse(withFields('tabs/close', { ids: ids.slice(0, 20_000) }))).not.toBeNull();
    const strings = Array.from({ length: 5_001 }, (_, index) => `id-${index}`);
    expect(parse(withFields('tabFolder/reorder', { orderedIds: strings }))).toBeNull();
    expect(parse(withFields('panelLayout/reorderRoot', { rootNodeIds: strings }))).toBeNull();
    expect(parse(withFields('externalMerge/merge', { targetIds: strings }))).toBeNull();
    expect(parse(withFields('tabFolder/reorder', { orderedIds: ['ok', 5] }))).toBeNull();
    expect(parse(withFields('panelLayout/fillChooser', { urls: ['', '', ''] }))).toBeNull();
    expect(
      parse(withFields('pinnedPanels/reorder', { orderedKeys: [{ workspaceId: 'ws-1' }] })),
    ).toBeNull();
    expect(
      parse(
        withFields('pinnedPanels/reorder', {
          orderedKeys: [{ workspaceId: 'ws-1', tabId: 1, extra: true }],
        }),
      ),
    ).toBeNull();
  });

  it('rejects URL schemes an action should not open', () => {
    const urlActions = [
      (url: string) => withFields('tab/openUrl', { url }),
      (url: string) => withFields('panel/openAt', { url }),
      (url: string) => withFields('panelLayout/splitTopPanel', { url }),
      (url: string) => withFields('panelLayout/splitBottomPanel', { url }),
      (url: string) => withFields('panelLayout/fillChooser', { urls: [url] }),
      (url: string) => withFields('savedPanels/save', { url }),
    ];
    for (const url of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/uuid',
      'chrome://browser/content/browser.xhtml',
      'resource://gre/modules/Services.sys.mjs',
      'mailto:a@example.com',
      'ws://example.com/',
      'not a url',
      '//example.com/path',
      urlOfLength(MAX_URL_LENGTH + 1),
    ]) {
      for (const make of urlActions) expect(parse(make(url))).toBeNull();
    }
    for (const url of [
      'https://example.com/',
      'http://localhost:8080/x',
      'file:///tmp/a.html',
      'ftp://example.com/',
      'about:newtab',
      'view-source:https://example.com/',
      'moz-extension://abc/dist/settings.html',
      urlOfLength(40_000),
    ]) {
      for (const make of urlActions) expect(parse(make(url))).not.toBeNull();
    }
    // The cap is Firefox's standard-URL limit: exactly at it passes.
    for (const make of urlActions.slice(0, 2)) {
      expect(parse(make(urlOfLength(MAX_URL_LENGTH)))).not.toBeNull();
    }
    expect(parse(withFields('tab/openUrl', { url: '' }))).toBeNull();
    expect(parse(withFields('panel/openAt', { url: '' }))).toBeNull();
    expect(parse(withFields('panelLayout/fillChooser', { urls: [''] }))).not.toBeNull();
    expect(parse(withFields('savedPanels/save', { favIconUrl: 'javascript:alert(1)' }))).toBeNull();
    expect(
      parse(withFields('savedPanels/save', { favIconUrl: 'data:' + 'a'.repeat(262_144) })),
    ).toBeNull();
    expect(parse(withFields('savedPanels/save', { favIconUrl: '' }))).not.toBeNull();
    expect(
      parse(withFields('savedPanels/save', { favIconUrl: 'https://example.com/f.ico' })),
    ).not.toBeNull();
  });

  it('validates settings patches, workspace changes, move targets, and advanced keys', () => {
    expect(parse(withFields('settings/update', { changes: { notASetting: true } }))).toBeNull();
    expect(
      parse(withFields('settings/update', { changes: { sidebarCollapsed: 'yes' } })),
    ).toBeNull();
    expect(
      parse(withFields('settings/update', { changes: { defaultPanelWidthPx: -5 } })),
    ).toBeNull();
    expect(parse(withFields('settings/update', { changes: 'x' }))).toBeNull();
    expect(parse(withFields('workspace/update', { changes: { id: 'other' } }))).toBeNull();
    expect(parse(withFields('workspace/update', { changes: { name: 5 } }))).toBeNull();
    expect(parse(withFields('privacy/setAdvanced', { key: 'notAKey' }))).toBeNull();
    expect(parse(withFields('privacy/setAdvanced', { key: 'constructor' }))).toBeNull();
    expect(parse(withFields('privacy/setAdvanced', { value: {} }))).toBeNull();
    expect(
      parse(withFields('privacy/setAdvanced', { key: 'webRTCIPHandlingPolicy', value: 'default' })),
    ).not.toBeNull();
    for (const target of [
      null,
      'root',
      {},
      { type: 'root' },
      { type: 'root', index: -1 },
      { type: 'root', index: 1, extra: true },
      { type: 'chooser' },
      { type: 'horizontal', groupId: 'g1', row: 'middle', position: 'after' },
      { type: 'horizontal', groupId: 'g1', row: 'top' },
      { type: 'toString' },
    ]) {
      expect(parse(withFields('panelLayout/movePanel', { target }))).toBeNull();
    }
    expect(
      parse(withFields('panelLayout/movePanel', { target: { type: 'root', index: 0 } })),
    ).not.toBeNull();
    expect(
      parse(withFields('panelLayout/movePanel', { target: { type: 'chooser', chooserId: 'c1' } })),
    ).not.toBeNull();
  });

  it('never throws on hostile input', () => {
    const hostile = [
      Object.create(null),
      Object.assign(Object.create(null), { type: 'ping' }),
      new Map([['type', 'ping']]),
      new Date(),
      Symbol('x'),
      10n,
      { type: 'tab/close', id: Object.create(null) },
      { type: 'tab/openUrl', url: { toString: () => 'https://example.com/' } },
      { type: 'tabs/close', ids: new Proxy([], {}) },
    ];
    for (const message of hostile) expect(() => parse(message)).not.toThrow();
  });
});

describe('address request identifiers', () => {
  it('requires bounded, nonempty ids and exact action keys', () => {
    expect(parse({ type: 'addrbar/query', query: '' })).toBeNull();
    expect(parse(withFields('addrbar/query', { requestId: '' }))).toBeNull();
    expect(parse(withFields('addrbar/restoreClosed', { sessionId: '' }))).toBeNull();
    expect(parse(withFields('addrbar/restoreClosed', { sessionId: 'x'.repeat(257) }))).toBeNull();
    expect(parse(withFields('addrbar/restoreClosed', { url: 'https://wrong.test/' }))).toBeNull();
  });
});
