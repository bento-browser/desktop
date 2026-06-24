import type {
  ChromiumExternalSessionSnapshot,
  NormalizedExternalSession,
  NormalizedExternalTab,
} from '../sourceTypes';
import { ExternalMergeError } from '../sourceTypes';

const URL_PREFIX_RE = /\b(?:https?|ftp|file):\/\//gi;
const GROUP_MARKERS = ['tab_group', 'tabgroup', 'group_visual_data', 'saved_tab_group'];

const SNSS_HEADER = 'SNSS';
const SNSS_VERSION = 3;
const COMMAND_SET_TAB_WINDOW = 0;
const COMMAND_SET_TAB_INDEX_IN_WINDOW = 2;
const COMMAND_UPDATE_TAB_NAVIGATION = 6;
const COMMAND_SET_SELECTED_NAVIGATION_INDEX = 7;
const COMMAND_SET_SELECTED_TAB_IN_WINDOW = 8;
const COMMAND_SET_WINDOW_TYPE = 9;
const COMMAND_SET_PINNED_STATE = 12;
const COMMAND_TAB_CLOSED = 16;
const COMMAND_WINDOW_CLOSED = 17;
const COMMAND_TAB_NAVIGATION_PATH_PRUNED = 24;
const COMMAND_SET_TAB_GROUP = 25;

interface ChromiumSessionCommand {
  id: number;
  payload: Uint8Array;
}

interface ChromiumTabRecord {
  id: number;
  windowId: number;
  index: number;
  currentNavigationIndex: number;
  pinned: boolean;
  groupId?: string;
  navigations: Map<number, string>;
}

interface ChromiumWindowRecord {
  id: number;
  selectedTabIndex: number;
  tabs: ChromiumTabRecord[];
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return out;
}

function bytesToUtf16LeAscii(bytes: Uint8Array): string {
  let out = '';
  const chars: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const lo = bytes[i]!;
    const hi = bytes[i + 1]!;
    chars.push(hi === 0 ? lo : 32);
    if (chars.length >= 0x8000) {
      out += String.fromCharCode(...chars);
      chars.length = 0;
    }
  }
  if (chars.length > 0) out += String.fromCharCode(...chars);
  return out;
}

function isSnssFile(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === SNSS_HEADER &&
    readInt32LE(bytes, 4) === SNSS_VERSION
  );
}

function readInt32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  );
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) return 0;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUtf8(bytes: Uint8Array, offset: number, length: number): string | null {
  if (length < 0 || offset + length > bytes.length) return null;
  try {
    return new TextDecoder().decode(bytes.subarray(offset, offset + length));
  } catch {
    return null;
  }
}

function readCommands(bytes: Uint8Array): ChromiumSessionCommand[] {
  if (!isSnssFile(bytes)) return [];
  const commands: ChromiumSessionCommand[] = [];
  for (let offset = 8; offset + 3 <= bytes.length; ) {
    const length = readUint16LE(bytes, offset);
    if (length < 1 || offset + 2 + length > bytes.length) break;
    commands.push({
      id: bytes[offset + 2]!,
      payload: bytes.subarray(offset + 3, offset + 2 + length),
    });
    offset += 2 + length;
  }
  return commands;
}

function tabRecord(tabs: Map<number, ChromiumTabRecord>, tabId: number): ChromiumTabRecord {
  let tab = tabs.get(tabId);
  if (!tab) {
    tab = {
      id: tabId,
      windowId: 0,
      index: 0,
      currentNavigationIndex: 0,
      pinned: false,
      navigations: new Map(),
    };
    tabs.set(tabId, tab);
  }
  return tab;
}

function windowRecord(
  windows: Map<number, ChromiumWindowRecord>,
  windowId: number,
): ChromiumWindowRecord {
  let window = windows.get(windowId);
  if (!window) {
    window = {
      id: windowId,
      selectedTabIndex: 0,
      tabs: [],
    };
    windows.set(windowId, window);
  }
  return window;
}

function restoreNavigation(
  payload: Uint8Array,
): { tabId: number; index: number; url: string } | null {
  if (payload.length < 20) return null;
  const tabId = readInt32LE(payload, 4);
  const index = readInt32LE(payload, 8);
  const urlLength = readInt32LE(payload, 12);
  if (tabId === 0 || index < 0 || urlLength < 0 || urlLength > 1024 * 1024) return null;
  const url = readUtf8(payload, 16, urlLength);
  return url ? { tabId, index, url } : null;
}

function selectedNavigationUrl(tab: ChromiumTabRecord): string | null {
  if (tab.navigations.has(tab.currentNavigationIndex)) {
    return tab.navigations.get(tab.currentNavigationIndex) ?? null;
  }
  const ordered = [...tab.navigations.entries()].sort((a, b) => a[0] - b[0]);
  return ordered.at(-1)?.[1] ?? null;
}

function parseSnssSession(
  snapshot: ChromiumExternalSessionSnapshot,
  bytes: Uint8Array,
): NormalizedExternalSession | null {
  const commands = readCommands(bytes);
  if (commands.length === 0) return null;

  const tabs = new Map<number, ChromiumTabRecord>();
  const windows = new Map<number, ChromiumWindowRecord>();

  for (const command of commands) {
    const payload = command.payload;
    switch (command.id) {
      case COMMAND_SET_TAB_WINDOW: {
        if (payload.length < 8) break;
        const windowId = readInt32LE(payload, 0);
        const tabId = readInt32LE(payload, 4);
        tabRecord(tabs, tabId).windowId = windowId;
        windowRecord(windows, windowId);
        break;
      }
      case COMMAND_SET_TAB_INDEX_IN_WINDOW:
        if (payload.length >= 8)
          tabRecord(tabs, readInt32LE(payload, 0)).index = readInt32LE(payload, 4);
        break;
      case COMMAND_UPDATE_TAB_NAVIGATION: {
        const navigation = restoreNavigation(payload);
        if (navigation) {
          tabRecord(tabs, navigation.tabId).navigations.set(navigation.index, navigation.url);
        }
        break;
      }
      case COMMAND_SET_SELECTED_NAVIGATION_INDEX:
        if (payload.length >= 8) {
          tabRecord(tabs, readInt32LE(payload, 0)).currentNavigationIndex = readInt32LE(payload, 4);
        }
        break;
      case COMMAND_SET_SELECTED_TAB_IN_WINDOW:
        if (payload.length >= 8) {
          windowRecord(windows, readInt32LE(payload, 0)).selectedTabIndex = readInt32LE(payload, 4);
        }
        break;
      case COMMAND_SET_WINDOW_TYPE:
        if (payload.length >= 8) windowRecord(windows, readInt32LE(payload, 0));
        break;
      case COMMAND_SET_PINNED_STATE:
        if (payload.length >= 5) tabRecord(tabs, readInt32LE(payload, 0)).pinned = payload[4] !== 0;
        break;
      case COMMAND_TAB_CLOSED:
        if (payload.length >= 4) tabs.delete(readInt32LE(payload, 0));
        break;
      case COMMAND_WINDOW_CLOSED:
        if (payload.length >= 4) windows.delete(readInt32LE(payload, 0));
        break;
      case COMMAND_TAB_NAVIGATION_PATH_PRUNED: {
        if (payload.length < 12) break;
        const tab = tabRecord(tabs, readInt32LE(payload, 0));
        const start = readInt32LE(payload, 4);
        const count = readInt32LE(payload, 8);
        for (let index = start; index < start + count; index += 1) tab.navigations.delete(index);
        break;
      }
      case COMMAND_SET_TAB_GROUP:
        if (payload.length >= 21 && payload[20] !== 0) {
          tabRecord(tabs, readInt32LE(payload, 0)).groupId = [
            readInt32LE(payload, 4),
            readInt32LE(payload, 8),
            readInt32LE(payload, 12),
            readInt32LE(payload, 16),
          ].join('-');
        }
        break;
      default:
        break;
    }
  }

  for (const tab of tabs.values()) {
    if (!tab.windowId || tab.navigations.size === 0) continue;
    windowRecord(windows, tab.windowId).tabs.push(tab);
  }

  const normalizedWindows = [...windows.values()]
    .map((window, windowIndex) => {
      const normalizedTabs = window.tabs
        .sort((a, b) => a.index - b.index || a.id - b.id)
        .map((tab, tabIndex): NormalizedExternalTab | null => {
          const url = selectedNavigationUrl(tab);
          if (!url) return null;
          return {
            id: `chromium-tab-${tab.id}`,
            url,
            title: url,
            index: tabIndex,
            active: tabIndex === window.selectedTabIndex,
            pinned: tab.pinned,
            groupId: tab.groupId,
          };
        })
        .filter((tab): tab is NormalizedExternalTab => tab !== null);

      return {
        id: `chromium-window-${window.id}`,
        active: windowIndex === 0,
        tabs: normalizedTabs,
        groups: [],
      };
    })
    .filter((window) => window.tabs.length > 0);

  return normalizedWindows.length > 0
    ? {
        sourceId: snapshot.sourceId,
        kind: snapshot.kind,
        browserName: snapshot.browserName,
        profileName: snapshot.profileName,
        capturedAt: snapshot.capturedAt,
        lastModified: snapshot.lastModified,
        windows: normalizedWindows,
      }
    : null;
}

function isUrlTerminator(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    code <= 0x1f ||
    code === 0x7f ||
    char.trim() === '' ||
    char === '"' ||
    char === "'" ||
    char === '<' ||
    char === '>' ||
    char === '\\'
  );
}

function urlCandidateEnd(text: string, start: number): number {
  for (let i = start; i < text.length; i += 1) {
    if (isUrlTerminator(text.charAt(i))) return i;
  }
  return text.length;
}

function cleanCandidateUrl(raw: string): string {
  return raw.replace(/[),.;\]]+$/u, '');
}

function extractUrls(text: string): string[] {
  const urls: string[] = [];
  let consumedUntil = 0;

  for (const match of text.matchAll(URL_PREFIX_RE)) {
    if (match.index === undefined || match.index < consumedUntil) continue;
    const end = urlCandidateEnd(text, match.index);
    consumedUntil = end;
    const value = cleanCandidateUrl(text.slice(match.index, end));
    if (value) urls.push(value);
  }
  return urls;
}

export function parseChromiumSession(
  snapshot: ChromiumExternalSessionSnapshot,
): NormalizedExternalSession {
  const allUrls: string[] = [];
  let sawGroupMarker = false;
  const sortedFiles = [...snapshot.files].sort((a, b) => b.lastModified - a.lastModified);

  for (const file of sortedFiles.filter((file) => /^Session_|^Current Session$/i.test(file.name))) {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(file.payloadBase64);
    } catch {
      throw new ExternalMergeError(
        'unsupported-session',
        'The Chromium session snapshot is corrupt.',
      );
    }
    const session = parseSnssSession(snapshot, bytes);
    if (session) return session;
  }

  for (const file of sortedFiles) {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(file.payloadBase64);
    } catch {
      throw new ExternalMergeError(
        'unsupported-session',
        'The Chromium session snapshot is corrupt.',
      );
    }
    const latin1 = bytesToLatin1(bytes);
    const utf16 = bytesToUtf16LeAscii(bytes);
    const haystack = `${latin1}\n${utf16}`.toLowerCase();
    sawGroupMarker ||= GROUP_MARKERS.some((marker) => haystack.includes(marker));
    allUrls.push(...extractUrls(latin1), ...extractUrls(utf16));
  }

  if (sawGroupMarker) {
    throw new ExternalMergeError(
      'unsupported-session',
      'This Chromium session contains grouped tabs that Bento cannot safely map yet.',
    );
  }

  const seen = new Set<string>();
  const tabs: NormalizedExternalTab[] = [];
  for (const url of allUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    tabs.push({
      id: `chromium-tab-${tabs.length + 1}`,
      url,
      title: url,
      index: tabs.length,
      active: tabs.length === 0,
      pinned: false,
    });
  }

  return {
    sourceId: snapshot.sourceId,
    kind: snapshot.kind,
    browserName: snapshot.browserName,
    profileName: snapshot.profileName,
    capturedAt: snapshot.capturedAt,
    lastModified: snapshot.lastModified,
    windows:
      tabs.length > 0
        ? [
            {
              id: 'chromium-window-1',
              active: true,
              tabs,
              groups: [],
            },
          ]
        : [],
  };
}
