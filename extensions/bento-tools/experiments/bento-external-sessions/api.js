'use strict';

/* globals ChromeUtils, Ci, Components, Cr, ExtensionAPI, IOUtils, PathUtils, Services */

(function (global) {
  const { AppConstants } = ChromeUtils.importESModule(
    'resource://gre/modules/AppConstants.sys.mjs',
  );
  const { ExtensionError } = ChromeUtils.importESModule(
    'resource://gre/modules/ExtensionUtils.sys.mjs',
  );
  const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
  const NS_ERROR_FILE_ACCESS_DENIED = Cr.NS_ERROR_FILE_ACCESS_DENIED;
  const NS_ERROR_FILE_NOT_FOUND = Cr.NS_ERROR_FILE_NOT_FOUND;

  const FileInputStream = Components.Constructor(
    '@mozilla.org/network/file-input-stream;1',
    'nsIFileInputStream',
    'init',
  );
  const LocalFile = Components.Constructor('@mozilla.org/file/local;1', 'nsIFile', 'initWithPath');

  const MAX_CHROMIUM_FILE_BYTES = 64 * 1024 * 1024;
  const FIREFOX_SNAPSHOT_CANDIDATES = [
    ['sessionstore.jsonlz4'],
    ['sessionstore-backups', 'recovery.jsonlz4'],
    ['sessionstore-backups', 'recovery.baklz4'],
    ['sessionstore-backups', 'previous.jsonlz4'],
  ];

  const CHROMIUM_BROWSER_ROOTS = [
    {
      kind: 'chrome',
      browserName: 'Chrome',
      mac: ['Library', 'Application Support', 'Google', 'Chrome'],
      winLocal: ['Google', 'Chrome', 'User Data'],
      linux: ['.config', 'google-chrome'],
    },
    {
      kind: 'chromium',
      browserName: 'Chromium',
      mac: ['Library', 'Application Support', 'Chromium'],
      winLocal: ['Chromium', 'User Data'],
      linux: ['.config', 'chromium'],
    },
    {
      kind: 'brave',
      browserName: 'Brave',
      mac: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
      winLocal: ['BraveSoftware', 'Brave-Browser', 'User Data'],
      linux: ['.config', 'BraveSoftware', 'Brave-Browser'],
    },
    {
      kind: 'edge',
      browserName: 'Microsoft Edge',
      mac: ['Library', 'Application Support', 'Microsoft Edge'],
      winLocal: ['Microsoft', 'Edge', 'User Data'],
      linux: ['.config', 'microsoft-edge'],
    },
    {
      kind: 'opera',
      browserName: 'Opera',
      mac: ['Library', 'Application Support', 'com.operasoftware.Opera'],
      winRoaming: ['Opera Software', 'Opera Stable'],
      linux: ['.config', 'opera'],
    },
    {
      kind: 'vivaldi',
      browserName: 'Vivaldi',
      mac: ['Library', 'Application Support', 'Vivaldi'],
      winLocal: ['Vivaldi', 'User Data'],
      linux: ['.config', 'vivaldi'],
    },
  ];

  let descriptorCache = new Map();

  function now() {
    return Date.now();
  }

  function env(name) {
    try {
      return Services.env.get(name) || '';
    } catch {
      return '';
    }
  }

  function homeDir() {
    const envHome = AppConstants.platform === 'win' ? env('USERPROFILE') : env('HOME');
    if (envHome) return envHome;
    try {
      return Services.dirsvc.get('Home', Ci.nsIFile).path;
    } catch {
      return null;
    }
  }

  function join(base, parts) {
    return PathUtils.join(base, ...parts);
  }

  function isAbsolutePath(path) {
    return /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  }

  function joinProfilePath(root, rawPath) {
    if (isAbsolutePath(rawPath)) return rawPath;
    return PathUtils.join(root, ...rawPath.split(/[\\/]+/).filter(Boolean));
  }

  function filename(path) {
    return path.split(/[\\/]/).pop() || path;
  }

  function hashPath(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function sourceIdFor(kind, profilePath, snapshotKey) {
    return `${kind}:${hashPath(profilePath)}:${hashPath(snapshotKey)}`;
  }

  async function statPath(path) {
    try {
      return await IOUtils.stat(path);
    } catch {
      return null;
    }
  }

  function mtimeMs(stat) {
    if (!stat) return 0;
    if (stat.lastModified instanceof Date) return stat.lastModified.getTime();
    if (typeof stat.lastModified === 'number') return stat.lastModified;
    return 0;
  }

  async function fileExists(path) {
    const stat = await statPath(path);
    return !!stat && stat.type !== 'directory';
  }

  async function directoryExists(path) {
    const stat = await statPath(path);
    return !!stat && stat.type === 'directory';
  }

  async function readText(path) {
    const bytes = await readBytes(path);
    return new TextDecoder().decode(bytes);
  }

  async function readJson(path) {
    try {
      return await IOUtils.readJSON(path, { decompress: true });
    } catch {
      const text = await readText(path);
      return JSON.parse(text);
    }
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asCollection(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).map(([key, raw]) => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const record = { ...raw };
        if (
          record.id === undefined &&
          record.uuid === undefined &&
          record.groupId === undefined &&
          record.tabGroupId === undefined &&
          record.folderId === undefined
        ) {
          record.id = key;
        }
        return record;
      }
      return { id: key, value: raw };
    });
  }

  function compactMemberRefs(value) {
    return asCollection(value)
      .map((member) => {
        if (member && typeof member === 'object' && !Array.isArray(member)) {
          const out = {};
          for (const key of [
            'id',
            'uuid',
            'tabId',
            'tabID',
            'tabUuid',
            'tabUUID',
            'zenTabId',
            'zenTabID',
          ]) {
            if (member[key] !== undefined) out[key] = member[key];
          }
          return Object.keys(out).length > 0 ? out : null;
        }
        return member;
      })
      .filter((member) => member !== null && member !== undefined);
  }

  function compactGroupLike(group, index) {
    return {
      id:
        group?.id ??
        group?.groupId ??
        group?.tabGroupId ??
        group?.folderId ??
        group?.folderUUID ??
        group?.folderUuid ??
        group?.uuid ??
        String(index + 1),
      groupId: group?.groupId,
      tabGroupId: group?.tabGroupId,
      folderId: group?.folderId,
      folderUUID: group?.folderUUID,
      folderUuid: group?.folderUuid,
      uuid: group?.uuid,
      name: group?.name,
      title: group?.title,
      label: group?.label,
      index: group?.index ?? group?.order ?? index,
      collapsed: group?.collapsed,
      tabs: compactMemberRefs(group?.tabs),
      tabIds: compactMemberRefs(group?.tabIds),
      tabIDs: compactMemberRefs(group?.tabIDs),
      tabUuids: compactMemberRefs(group?.tabUuids),
      tabUUIDs: compactMemberRefs(group?.tabUUIDs),
      children: compactMemberRefs(group?.children),
      childIds: compactMemberRefs(group?.childIds),
      items: compactMemberRefs(group?.items),
    };
  }

  function compactExtData(extData) {
    if (typeof extData === 'string' && extData.trim().startsWith('{')) return extData;
    if (!extData || typeof extData !== 'object' || Array.isArray(extData)) return undefined;
    const out = {};
    for (const key of [
      'private',
      'tabGroupId',
      'groupId',
      'folderId',
      'folder',
      'folderUUID',
      'folderUuid',
      'tabFolderId',
      'tabFolder',
      'zenFolderId',
      'zenFolder',
      'zenFolderUUID',
      'zenFolderUuid',
      'zenTabFolderId',
      'zenTabFolder',
      'zenWorkspace',
    ]) {
      if (extData[key] !== undefined) out[key] = extData[key];
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function selectedEntry(tab) {
    const entries = asArray(tab?.entries);
    if (entries.length === 0) return null;
    const index =
      typeof tab.index === 'number' && Number.isFinite(tab.index) ? tab.index : entries.length;
    const selected =
      index > 0 && index <= entries.length ? Math.floor(index) - 1 : entries.length - 1;
    const entry = entries[selected];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  }

  function compactEntry(entry) {
    if (!entry) return null;
    const out = {};
    for (const key of ['url', 'title', 'private', 'isPrivate', 'incognito']) {
      if (entry[key] !== undefined) out[key] = entry[key];
    }
    return out;
  }

  function compactFirefoxSession(data) {
    return {
      selectedWindow: data?.selectedWindow,
      windows: asArray(data?.windows).map((window) => ({
        selected: window?.selected,
        isPrivate: window?.isPrivate,
        private: window?.private,
        incognito: window?.incognito,
        tabGroups: asArray(window?.tabGroups).map((group) => ({
          id: group?.id,
          groupId: group?.groupId,
          name: group?.name,
          title: group?.title,
          label: group?.label,
          index: group?.index,
          collapsed: group?.collapsed,
        })),
        groups: asArray(window?.groups).map((group) => ({
          id: group?.id,
          groupId: group?.groupId,
          name: group?.name,
          title: group?.title,
          label: group?.label,
          index: group?.index,
          collapsed: group?.collapsed,
        })),
        tabs: asArray(window?.tabs).map((tab) => ({
          entries: [compactEntry(selectedEntry(tab))].filter(Boolean),
          index: 1,
          hidden: tab?.hidden,
          pinned: tab?.pinned,
          groupId: tab?.groupId,
          group: tab?.group,
          isPrivate: tab?.isPrivate,
          private: tab?.private,
          incognito: tab?.incognito,
          attributes:
            tab?.attributes && typeof tab.attributes === 'object'
              ? { private: tab.attributes.private }
              : undefined,
          extData:
            tab?.extData && typeof tab.extData === 'object'
              ? {
                  private: tab.extData.private,
                  tabGroupId: tab.extData.tabGroupId,
                }
              : undefined,
        })),
      })),
    };
  }

  function compactZenSession(data) {
    const windows = asCollection(data?.windows).map((window) => ({
      groups: asCollection(window?.groups).map(compactGroupLike),
      tabGroups: asCollection(window?.tabGroups).map(compactGroupLike),
      folders: asCollection(window?.folders).map(compactGroupLike),
      tabFolders: asCollection(window?.tabFolders).map(compactGroupLike),
    }));
    return {
      lastCollected: data?.lastCollected,
      spaces: asCollection(data?.spaces).map((space) => ({
        uuid: space?.uuid,
        id: space?.id,
        name: space?.name,
        groups: asCollection(space?.groups).map(compactGroupLike),
        tabGroups: asCollection(space?.tabGroups).map(compactGroupLike),
        folders: asCollection(space?.folders).map(compactGroupLike),
        tabFolders: asCollection(space?.tabFolders).map(compactGroupLike),
      })),
      windows,
      groups: asCollection(data?.groups).map(compactGroupLike),
      tabGroups: asCollection(data?.tabGroups).map(compactGroupLike),
      folders: asCollection(data?.folders).map(compactGroupLike),
      tabFolders: asCollection(data?.tabFolders).map(compactGroupLike),
      zenFolders: asCollection(data?.zenFolders).map(compactGroupLike),
      zenTabFolders: asCollection(data?.zenTabFolders).map(compactGroupLike),
      tabs: asCollection(data?.tabs).map((tab) => ({
        id: tab?.id,
        uuid: tab?.uuid,
        tabId: tab?.tabId,
        tabID: tab?.tabID,
        tabUuid: tab?.tabUuid,
        tabUUID: tab?.tabUUID,
        zenTabId: tab?.zenTabId,
        zenTabID: tab?.zenTabID,
        entries: [compactEntry(selectedEntry(tab))].filter(Boolean),
        index: 1,
        hidden: tab?.hidden,
        pinned: tab?.pinned,
        groupId: tab?.groupId,
        tabGroupId: tab?.tabGroupId,
        group: tab?.group,
        folderId: tab?.folderId,
        folder: tab?.folder,
        folderUUID: tab?.folderUUID,
        folderUuid: tab?.folderUuid,
        tabFolderId: tab?.tabFolderId,
        tabFolder: tab?.tabFolder,
        zenFolderId: tab?.zenFolderId,
        zenFolder: tab?.zenFolder,
        zenFolderUUID: tab?.zenFolderUUID,
        zenFolderUuid: tab?.zenFolderUuid,
        zenTabFolderId: tab?.zenTabFolderId,
        zenTabFolder: tab?.zenTabFolder,
        zenWorkspace: tab?.zenWorkspace,
        zenEssential: tab?.zenEssential,
        _zenIsActiveTab: tab?._zenIsActiveTab,
        active: tab?.active,
        isPrivate: tab?.isPrivate,
        private: tab?.private,
        incognito: tab?.incognito,
        extData: compactExtData(tab?.extData),
      })),
    };
  }

  function compactSessionJson(format, json) {
    if (format === 'firefox-json') return compactFirefoxSession(json);
    if (format === 'zen-json') return compactZenSession(json);
    return json;
  }

  const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const first = bytes[i] ?? 0;
      const second = bytes[i + 1] ?? 0;
      const third = bytes[i + 2] ?? 0;
      const quartet = (first << 16) | (second << 8) | third;

      out += BASE64_ALPHABET[(quartet >> 18) & 63];
      out += BASE64_ALPHABET[(quartet >> 12) & 63];
      out += i + 1 < bytes.length ? BASE64_ALPHABET[(quartet >> 6) & 63] : '=';
      out += i + 2 < bytes.length ? BASE64_ALPHABET[quartet & 63] : '=';
    }
    return out;
  }

  function readFailureToken(error) {
    if (!error || typeof error !== 'object') return '';
    const name =
      typeof error.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(error.name) ? error.name : '';
    const result = typeof error.result === 'number' ? `0x${(error.result >>> 0).toString(16)}` : '';
    const code =
      typeof error.code === 'number' && Number.isFinite(error.code) ? String(error.code) : '';
    const message =
      name === 'ReferenceError' &&
      typeof error.message === 'string' &&
      /^[A-Za-z0-9_.$ -]+$/.test(error.message)
        ? error.message.replace(/\s+/g, ' ').trim()
        : '';
    return [name, result || code, message].filter(Boolean).join(':');
  }

  async function readBytes(path) {
    try {
      return await IOUtils.read(path);
    } catch (ioError) {
      let inputStream;
      try {
        inputStream = new FileInputStream(new LocalFile(path), -1, -1, false);
        return NetUtil.readInputStream(inputStream, inputStream.available());
      } catch (streamError) {
        const error = new Error('all read strategies failed');
        error.bentoReadFailures = [ioError, streamError];
        throw error;
      } finally {
        try {
          inputStream?.close();
        } catch {
          // Best effort.
        }
      }
    }
  }

  function parseProfilesIni(text) {
    const profiles = [];
    let current = null;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      const section = /^\[(.+)]$/.exec(line);
      if (section) {
        if (current) profiles.push(current);
        current = {};
        continue;
      }
      if (!current) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    if (current) profiles.push(current);
    return profiles;
  }

  function firefoxProfileRoot() {
    if (AppConstants.platform === 'win') {
      const appData = env('APPDATA');
      return appData ? PathUtils.join(appData, 'Mozilla', 'Firefox') : null;
    }
    if (AppConstants.platform === 'macosx') {
      const home = homeDir();
      return home ? PathUtils.join(home, 'Library', 'Application Support', 'Firefox') : null;
    }
    const home = homeDir();
    return home ? PathUtils.join(home, '.mozilla', 'firefox') : null;
  }

  function zenProfileRoots() {
    if (AppConstants.platform !== 'macosx') return [];
    const home = homeDir();
    if (!home) return [];
    return [
      PathUtils.join(home, 'Library', 'Application Support', 'zen'),
      PathUtils.join(home, 'Library', 'Application Support', 'Zen'),
    ];
  }

  function descriptorForProfile(kind, browserName, profileName, profilePath, snapshot) {
    const sourceId = sourceIdFor(kind, profilePath, snapshot.path);
    return {
      candidate: {
        sourceId,
        kind,
        browserName,
        profileName,
        lastModified: snapshot.lastModified,
      },
      descriptor: {
        sourceId,
        kind,
        browserName,
        profileName,
        lastModified: snapshot.lastModified,
        format: snapshot.format,
        path: snapshot.path,
        snapshots: snapshot.snapshots || [
          {
            path: snapshot.path,
            lastModified: snapshot.lastModified,
            format: snapshot.format,
          },
        ],
      },
    };
  }

  async function discoverProfileRegistry(root, kind, browserName, snapshotResolver) {
    if (!root) return [];
    const iniPath = PathUtils.join(root, 'profiles.ini');
    if (!(await fileExists(iniPath))) return [];

    let text;
    try {
      text = await readText(iniPath);
    } catch {
      return [];
    }

    const out = [];
    for (const profile of parseProfilesIni(text)) {
      const rawPath = profile.Path;
      if (!rawPath) continue;
      const profilePath = profile.IsRelative === '1' ? joinProfilePath(root, rawPath) : rawPath;
      if (!(await directoryExists(profilePath))) continue;
      const snapshot = await snapshotResolver(profilePath);
      if (!snapshot) continue;
      const profileName = profile.Name || filename(profilePath);
      out.push(descriptorForProfile(kind, browserName, profileName, profilePath, snapshot));
    }
    return out;
  }

  async function discoverProfiles(root, kind, browserName, snapshotResolver) {
    const bySourceId = new Map();
    for (const item of await discoverProfileRegistry(root, kind, browserName, snapshotResolver)) {
      bySourceId.set(item.candidate.sourceId, item);
    }

    const scanRoots = root ? [root, PathUtils.join(root, 'Profiles')] : [];
    for (const scanRoot of scanRoots) {
      if (!(await directoryExists(scanRoot))) continue;
      let children = [];
      try {
        children = await IOUtils.getChildren(scanRoot);
      } catch {
        children = [];
      }
      for (const child of children) {
        if (!(await directoryExists(child))) continue;
        const snapshot = await snapshotResolver(child);
        if (!snapshot) continue;
        const item = descriptorForProfile(kind, browserName, filename(child), child, snapshot);
        bySourceId.set(item.candidate.sourceId, item);
      }
    }
    return Array.from(bySourceId.values());
  }

  async function newestFirefoxSnapshot(profilePath) {
    const found = [];
    for (const parts of FIREFOX_SNAPSHOT_CANDIDATES) {
      const path = join(profilePath, parts);
      const stat = await statPath(path);
      if (!stat || stat.type === 'directory') continue;
      found.push({ path, lastModified: mtimeMs(stat), format: 'firefox-json' });
    }
    found.sort((a, b) => b.lastModified - a.lastModified);
    const newest = found[0];
    return newest ? { ...newest, snapshots: found } : null;
  }

  async function zenSnapshot(profilePath) {
    const found = [];
    const primary = PathUtils.join(profilePath, 'zen-sessions.jsonlz4');
    const primaryStat = await statPath(primary);
    if (primaryStat && primaryStat.type !== 'directory') {
      found.push({ path: primary, lastModified: mtimeMs(primaryStat), format: 'zen-json' });
    }
    const backup = PathUtils.join(profilePath, 'zen-sessions-backup', 'clean.jsonlz4');
    const backupStat = await statPath(backup);
    if (backupStat && backupStat.type !== 'directory') {
      found.push({ path: backup, lastModified: mtimeMs(backupStat), format: 'zen-json' });
    }
    found.sort((a, b) => b.lastModified - a.lastModified);
    const newest = found[0];
    return newest ? { ...newest, snapshots: found } : null;
  }

  function chromiumRootFor(entry) {
    const home = homeDir();
    if (AppConstants.platform === 'macosx') return home ? join(home, entry.mac) : null;
    if (AppConstants.platform === 'win') {
      if (entry.winRoaming) {
        const roaming = env('APPDATA');
        if (roaming) return join(roaming, entry.winRoaming);
      }
      const local = env('LOCALAPPDATA');
      return local && entry.winLocal ? join(local, entry.winLocal) : null;
    }
    return home ? join(home, entry.linux) : null;
  }

  async function readProfileDisplayName(root, profileDir) {
    try {
      const localState = await IOUtils.readJSON(PathUtils.join(root, 'Local State'));
      const infoCache = localState?.profile?.info_cache;
      const entry = infoCache?.[filename(profileDir)];
      if (typeof entry?.name === 'string' && entry.name.trim()) return entry.name.trim();
    } catch {
      // Preferences fallback below.
    }
    try {
      const prefs = await IOUtils.readJSON(PathUtils.join(profileDir, 'Preferences'));
      if (typeof prefs?.profile?.name === 'string' && prefs.profile.name.trim()) {
        return prefs.profile.name.trim();
      }
    } catch {
      // Directory leaf fallback below.
    }
    return filename(profileDir);
  }

  async function chromiumSessionFiles(profileDir) {
    const files = [];
    const sessionsDir = PathUtils.join(profileDir, 'Sessions');
    if (await directoryExists(sessionsDir)) {
      try {
        for (const child of await IOUtils.getChildren(sessionsDir)) {
          const leaf = filename(child);
          if (!/^Session_|^Tabs_/i.test(leaf)) continue;
          const stat = await statPath(child);
          if (!stat || stat.type === 'directory') continue;
          if (typeof stat.size === 'number' && stat.size > MAX_CHROMIUM_FILE_BYTES) continue;
          files.push({ path: child, lastModified: mtimeMs(stat) });
        }
      } catch {
        // Legacy file fallback below.
      }
    }

    for (const leaf of ['Current Session', 'Last Session', 'Current Tabs', 'Last Tabs']) {
      const path = PathUtils.join(profileDir, leaf);
      const stat = await statPath(path);
      if (!stat || stat.type === 'directory') continue;
      if (typeof stat.size === 'number' && stat.size > MAX_CHROMIUM_FILE_BYTES) continue;
      files.push({ path, lastModified: mtimeMs(stat) });
    }

    files.sort((a, b) => b.lastModified - a.lastModified);
    return files.slice(0, 4);
  }

  async function discoverChromium(entry) {
    const root = chromiumRootFor(entry);
    if (!root || !(await directoryExists(root))) return [];

    const out = [];
    let children = [];
    try {
      children = await IOUtils.getChildren(root);
    } catch {
      return [];
    }

    for (const child of children) {
      if (!(await directoryExists(child))) continue;
      const files = await chromiumSessionFiles(child);
      if (files.length === 0) continue;
      const profileName = await readProfileDisplayName(root, child);
      const snapshotKey = files.map((file) => file.path).join('\n');
      const lastModified = Math.max(...files.map((file) => file.lastModified));
      const sourceId = sourceIdFor(entry.kind, child, snapshotKey);
      out.push({
        candidate: {
          sourceId,
          kind: entry.kind,
          browserName: entry.browserName,
          profileName,
          lastModified,
        },
        descriptor: {
          sourceId,
          kind: entry.kind,
          browserName: entry.browserName,
          profileName,
          lastModified,
          format: 'chromium-session-files',
          files,
        },
      });
    }
    return out;
  }

  async function listDescriptors() {
    const descriptors = [
      ...(await discoverProfiles(
        firefoxProfileRoot(),
        'firefox',
        'Firefox',
        newestFirefoxSnapshot,
      )),
    ];
    const seenZenKeys = new Set();
    for (const root of zenProfileRoots()) {
      for (const item of await discoverProfiles(root, 'zen', 'Zen Browser', zenSnapshot)) {
        const key =
          AppConstants.platform === 'macosx'
            ? item.descriptor.path.toLowerCase()
            : item.candidate.sourceId;
        if (seenZenKeys.has(key)) continue;
        seenZenKeys.add(key);
        descriptors.push(item);
      }
    }
    for (const entry of CHROMIUM_BROWSER_ROOTS) {
      descriptors.push(...(await discoverChromium(entry)));
    }
    return descriptors;
  }

  function sanitizedError(message) {
    return new ExtensionError(message);
  }

  function sanitizedReadFailureReason(error) {
    const failures = Array.isArray(error?.bentoReadFailures) ? error.bentoReadFailures : [error];
    const result = failures.map((failure) => failure?.result).find((value) => value !== undefined);
    const name =
      failures
        .map((failure) => (typeof failure?.name === 'string' ? failure.name : ''))
        .find(Boolean) || '';
    const message = failures
      .map((failure) => (typeof failure?.message === 'string' ? failure.message : ''))
      .join(' ');
    const text = `${name} ${message} ${result || ''}`.toLowerCase();
    if (
      text.includes('denied') ||
      text.includes('not permitted') ||
      text.includes('permission') ||
      result === NS_ERROR_FILE_ACCESS_DENIED
    ) {
      return 'permission denied';
    }
    if (text.includes('busy') || text.includes('locked')) return 'file locked';
    if (text.includes('not found') || result === NS_ERROR_FILE_NOT_FOUND) return 'file missing';
    const tokens = failures.map(readFailureToken).filter(Boolean);
    return tokens.length > 0 ? `read failed: ${tokens.join(',')}` : 'read failed';
  }

  global.bentoExternalSessions = class extends ExtensionAPI {
    getAPI() {
      return {
        bentoExternalSessions: {
          async listCandidates() {
            const listed = await listDescriptors();
            for (const item of listed)
              descriptorCache.set(item.candidate.sourceId, item.descriptor);
            return listed
              .map((item) => item.candidate)
              .sort((a, b) => b.lastModified - a.lastModified);
          },

          async readSnapshot(sourceId) {
            if (typeof sourceId !== 'string' || !sourceId) {
              throw sanitizedError('Unknown browser session source.');
            }
            const descriptor = descriptorCache.get(sourceId);
            if (!descriptor) throw sanitizedError('Unknown browser session source.');

            if (descriptor.format === 'firefox-json' || descriptor.format === 'zen-json') {
              const snapshots = descriptor.snapshots || [
                {
                  path: descriptor.path,
                  lastModified: descriptor.lastModified,
                  format: descriptor.format,
                },
              ];
              for (const snapshot of snapshots) {
                try {
                  const json = await readJson(snapshot.path);
                  const compactJson = compactSessionJson(descriptor.format, json);
                  return {
                    sourceId: descriptor.sourceId,
                    kind: descriptor.kind,
                    browserName: descriptor.browserName,
                    profileName: descriptor.profileName,
                    lastModified: snapshot.lastModified,
                    capturedAt: now(),
                    format: descriptor.format,
                    json: JSON.stringify(compactJson),
                  };
                } catch {
                  // Recovery snapshots can be mid-write. Try the next candidate.
                }
              }
              throw sanitizedError('Browser session snapshot is unreadable.');
            }

            if (descriptor.format === 'chromium-session-files') {
              const files = [];
              let firstFailureReason = '';
              for (const file of descriptor.files) {
                try {
                  const bytes = await readBytes(file.path);
                  files.push({
                    name: filename(file.path),
                    payloadBase64: bytesToBase64(bytes),
                    lastModified: file.lastModified,
                  });
                } catch (error) {
                  firstFailureReason ||= sanitizedReadFailureReason(error);
                  // Chromium rotates session files while running. Keep readable siblings.
                }
              }
              if (files.length === 0) {
                const suffix = firstFailureReason ? ` (${firstFailureReason})` : '';
                throw sanitizedError(`Session files were found, but file reads failed${suffix}.`);
              }
              return {
                sourceId: descriptor.sourceId,
                kind: descriptor.kind,
                browserName: descriptor.browserName,
                profileName: descriptor.profileName,
                lastModified: descriptor.lastModified,
                capturedAt: now(),
                format: 'chromium-session-files',
                files,
              };
            }

            throw sanitizedError('Unsupported browser session source.');
          },
        },
      };
    }
  };
})(globalThis);
