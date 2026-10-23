// The text the Settings palette shows about a setting: a page description under the path, and
// a second line under options whose behaviour differs. Plain, short and true to the code, with
// no em dashes. It lives apart from `settingsCatalog.ts` because the command palette bundle
// reads that catalog for labels and must not carry this copy; only `rows.ts` imports it.
//
// When a setting's behaviour changes in tools or chrome, change its line here in the same
// change. The code each line rests on is recorded in docs/technical/privacy-search.md.

import type { PrivacyAdvancedKey } from '@shared/protocol';
import { PANEL_SIZE_LIMITS, type EnumKey, type NumberSettingKey } from './settingsCatalog';

export const NUMBER_DESCRIPTIONS: Record<NumberSettingKey, string> = {
  tabSleepAfterMinutes:
    'How long a tab can go unused before Bento puts it to sleep to free memory. Sleeping tabs reload when you open them.',
  tabSleepKeepAlivePerWorkspace:
    "How many of each workspace's most recently used tabs stay awake. Other tabs sleep after sitting idle for the Sleep tabs after time. No effect while Sleep idle tabs is off.",
  defaultPanelWidthPx:
    'The width a new side panel opens at. It is also the minimum width of the main page area. Existing panels keep their widths.',
  panelCornerRadiusPx:
    'How rounded the corners of the main page and every panel are. 0 gives square corners.',
  panelSplitterSizePx:
    'The gap between panels, which is also the width of the draggable splitter between them.',
  autoBackupIntervalMinutes:
    'How often Bento saves an automatic backup while it is running. Applies only while Automatic backups is on.',
  autoBackupMaxCount:
    'How many automatic backups Bento keeps. When a new one pushes past the limit, the oldest is deleted.',
};

export const ENUM_DESCRIPTIONS: Record<EnumKey, string> = {
  uiColorMode:
    "Light or dark for Bento's own interface: the sidebar, panels, and Settings. It does not change how websites look.",
  sidebarShortcutBehavior:
    'What Cmd/Ctrl+S does to the sidebar. Pressing it again brings the full sidebar back.',
  webRTCIPHandlingPolicy:
    'Which of your network addresses websites can see during video calls and peer-to-peer features.',
  httpsOnlyMode:
    'Whether Bento upgrades sites to HTTPS and warns before loading a site that only supports HTTP.',
};

/** The line under each option of a choice, by option value. */
export const ENUM_OPTION_DESCRIPTIONS: Record<EnumKey, Readonly<Record<string, string>>> = {
  uiColorMode: {
    light: 'Always light.',
    dark: 'Always dark.',
    system: "Switches with your computer's appearance setting.",
  },
  sidebarShortcutBehavior: {
    collapse: 'Shrinks it to a narrow rail of tab icons and the workspace avatar.',
    hide: 'Removes it from the window. Move the pointer to the left edge to peek at the rail.',
  },
  webRTCIPHandlingPolicy: {
    default: 'Sites may see your local network address during calls. Best compatibility.',
    disable_non_proxied_udp:
      'Hides your local network address from sites. If you use a proxy, calls go only through it. Some calls may fail to connect.',
  },
  httpsOnlyMode: {
    never: 'Sites load over HTTP when that is what the address says. No warning.',
    always: 'Tries HTTPS for every site and warns you before loading one that only supports HTTP.',
  },
};

/** The line under each Advanced privacy row. The two choices say what their page says. */
export const ADVANCED_DESCRIPTIONS: Record<
  Exclude<PrivacyAdvancedKey, 'searchSuggestionsEnabled'>,
  string
> = {
  safeBrowsingEnabled:
    'Warns about known malware and phishing sites, and dangerous downloads, using lists stored on your computer.',
  remoteSafeBrowsingEnabled:
    "Asks Google Safe Browsing about downloads it cannot judge locally. This sends the download's address, file name, size, and checksum to Google.",
  resistFingerprinting:
    'Makes Bento report generic details, such as time zone and screen size, so sites cannot single you out. Can change dates, sizes, or appearance on some sites.',
  letterboxing:
    'Adds margins so the page area is a common size, which hides your exact window size. Pages may not fill the whole window.',
  networkPrediction:
    'Loads links and opens connections before you click, to speed things up. Off avoids contacting sites you have not opened.',
  peerConnection: 'Allows in-browser video calls and peer-to-peer features. Off breaks them.',
  webRTCIPHandlingPolicy: ENUM_DESCRIPTIONS.webRTCIPHandlingPolicy,
  httpsOnlyMode: ENUM_DESCRIPTIONS.httpsOnlyMode,
  drmEnabled: 'Lets streaming sites play protected video. Off stops that video playing.',
  diskCacheEnabled:
    'Keeps website files on disk so pages reload faster. Off keeps the cache in memory only, so some pages load slower.',
  webglEnabled:
    'Lets sites draw 3D graphics, such as maps, games, and design tools. Off breaks those sites.',
  webgpuEnabled: 'Newer graphics and compute support used by demanding sites and apps.',
  passwordSavingEnabled: 'Lets Bento offer to save passwords you enter on sites.',
  formHistoryEnabled: 'Remembers what you type in forms and the search field to suggest it later.',
  sanitizeOnShutdown: 'Clears cookies, site data, and cache when Bento quits.',
};

/** Under the path on the page of a stage that is not a number or a choice setting. */
export const STAGE_DESCRIPTIONS = {
  defaultWorkspaceName:
    'The name Bento gives the first workspace in a new profile, and any workspace it adds for an import that has none or no name. Existing workspaces are never renamed.',
  protection:
    'How much Bento restricts tracking, fingerprinting and some web features. Picking a level sets the switches under Advanced privacy to match, except Remote download reputation.',
  search:
    'The engine used when you search from the address bar, in regular and private windows. Engines you add in Firefox settings appear here.',
  sizes:
    "The widths offered in each side panel's menu under Custom panel widths. Choosing one resizes that panel only.",
  sizeActions: 'Change this width, move it up or down in the panel menu, or remove it.',
  sizeEdit: `Set this width in pixels, from ${PANEL_SIZE_LIMITS.min} to ${PANEL_SIZE_LIMITS.max}. Panels already at this width keep it.`,
  advanced:
    'Individual privacy and security switches. Changing one moves Protection level to Custom unless the result still matches a level.',
  backups:
    'Export or import your Bento data as a file, and restore the automatic backups Bento keeps on this computer.',
  backupRow: 'Restore this backup or delete it.',
} as const;

/** The reason shown under the Custom protection level, which is detected and never chosen. */
export const CUSTOM_PROTECTION_DESCRIPTION =
  'Appears when your settings no longer match a level exactly. It cannot be chosen.';

/** The page text of each confirmation. */
export const CONFIRM_DESCRIPTIONS = {
  reset:
    'Resets every Bento setting to its default, Protection level to Standard, and search to DuckDuckGo. Your workspaces, tabs, and backups are kept. The welcome tour opens again.',
  restore:
    "Adds the backup's workspaces and tabs as new workspaces. Your current workspaces and settings are not changed.",
  delete: 'Permanently removes this stored backup. Your current tabs are not affected.',
} as const;

/** Under the rows of the custom panel size actions. */
export const SIZE_ACTION_DESCRIPTIONS = {
  edit: `Change the width, ${PANEL_SIZE_LIMITS.min} to ${PANEL_SIZE_LIMITS.max} px.`,
  move: 'Changes where this width appears in the panel menu.',
  remove: 'Takes it out of the panel menu. Panels already at this width keep it.',
} as const;

/** Under the rows of the Backups page that start something, and under a stored backup's actions. */
export const BACKUP_ROW_DESCRIPTIONS = {
  export: 'Saves your workspaces, tabs, panels, saved panels, and changed settings to a file.',
  import:
    'Adds the workspaces and tabs from a Bento file. Settings in the file overwrite matching ones you have now.',
  merge: "Brings in tabs from another browser's session.",
  restore: "Adds this backup's workspaces and tabs as new workspaces.",
  delete: 'Removes this backup permanently.',
} as const;
