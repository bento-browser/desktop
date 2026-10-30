// Runtime validation for Action messages on the shell <-> tools port.
//
// `Action` is a compile-time type; the port delivers whatever any
// extension-origin document posted. bento-tools parses every message here
// before dispatch: exact keys (plus the `__windowId` routing envelope), bounded
// strings and arrays, safe integer ids, and URL schemes the action may open.
// ACTION_FIELDS has one entry per Action type and one guard per field, both
// enforced by the compiler, so a new action or field cannot ship without a
// validator. Deeper domain checks stay with the stores.

import {
  ALLOWED_URL_SCHEMES,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  isBoundedString,
  isFiniteNumber,
  isInteger,
  isRecord,
  isValidBentoSettingsPatch,
} from './export-schema';
import { ADVANCED_KEY_TO_BROWSER_PRIVACY, ADVANCED_KEY_TO_PREF } from './privacy-levels';
import type {
  Action,
  BentoSettings,
  PanelLayoutMoveTarget,
  PrivacyAdvancedKey,
  Workspace,
} from './protocol';

type Guard<T> = (value: unknown) => value is T;
type ActionType = Action['type'];
type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;
type Guards<T> = { [K in keyof T]-?: Guard<T[K]> };

const MAX_TAB_IDS = 20_000;
const MAX_ID_LIST = 5_000;
const MAX_QUERY_LENGTH = MAX_TITLE_LENGTH;
const MAX_FAVICON_URL_LENGTH = 262_144;
const MAX_PIXELS = 100_000;
const MAX_SCROLL_PIXELS = 10_000_000;
const MAX_CLOSE_DELAY_MS = 60_000;
const MAX_ADDRESS_RESULTS = 100;
const NAVIGATION_SCHEMES = new Set([...ALLOWED_URL_SCHEMES, 'view-source:', 'moz-extension:']);
const FAVICON_URL = /^(?:https?|data|moz-extension|chrome|resource|page-icon|moz-icon):/i;

/** Non-negative safe integer: tab, window, and index values. */
const nat: Guard<number> = (v): v is number => isInteger(v, 0, Number.MAX_SAFE_INTEGER);
/** Any safe integer: pinned-panel placeholders use negative tab ids. */
const int: Guard<number> = (v): v is number =>
  isInteger(v, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
const bool: Guard<boolean> = (v): v is boolean => typeof v === 'boolean';
const text =
  (max: number, allowEmpty = true): Guard<string> =>
  (v): v is string =>
    isBoundedString(v, max, allowEmpty);
const id = text(MAX_ID_LENGTH, false);
const title = text(MAX_TITLE_LENGTH);
const name = text(MAX_NAME_LENGTH);
const bounded =
  (max: number, min = 1): Guard<number> =>
  (v): v is number =>
    isFiniteNumber(v, min, max);
const optional =
  <T>(guard: Guard<T>): Guard<T | undefined> =>
  (v): v is T | undefined =>
    v === undefined || guard(v);
const nullable =
  <T>(guard: Guard<T>): Guard<T | null> =>
  (v): v is T | null =>
    v === null || guard(v);
const list =
  <T>(guard: Guard<T>, max: number): Guard<T[]> =>
  (v): v is T[] =>
    Array.isArray(v) && v.length <= max && v.every(guard);
const oneOf =
  <const T extends string>(...values: T[]): Guard<T> =>
  (v): v is T =>
    typeof v === 'string' && (values as string[]).includes(v);

/** Exact-key object: no unknown keys, every field guard satisfied. */
function shape<T>(fields: Guards<T>): Guard<T> {
  const guards = Object.entries(fields) as [string, Guard<unknown>][];
  return (v): v is T =>
    isRecord(v) &&
    Object.keys(v).every((key) => Object.hasOwn(fields as object, key)) &&
    guards.every(([key, guard]) => guard(v[key]));
}

function hasNavigationScheme(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  try {
    return NAVIGATION_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** URL a tab or panel may open. `allowEmpty` means the new-tab page. */
const navUrl =
  (allowEmpty = false): Guard<string> =>
  (v): v is string =>
    typeof v === 'string' && (v === '' ? allowEmpty : hasNavigationScheme(v));

const favIconUrl: Guard<string> = (v): v is string =>
  typeof v === 'string' && v.length <= MAX_FAVICON_URL_LENGTH && (v === '' || FAVICON_URL.test(v));

const ids = list(nat, MAX_TAB_IDS);
const idStrings = list(id, MAX_ID_LIST);
const bypassCache = optional(bool);
const widthPx = bounded(MAX_PIXELS);
const pinKey = { workspaceId: id, tabId: int };
const pinned = shape<{ workspaceId: string; tabId: number }>(pinKey);

const MOVE_TARGETS: { [K in PanelLayoutMoveTarget['type']]: Guard<PanelLayoutMoveTarget> } = {
  root: shape<Extract<PanelLayoutMoveTarget, { type: 'root' }>>({
    type: oneOf('root'),
    index: nat,
  }),
  chooser: shape<Extract<PanelLayoutMoveTarget, { type: 'chooser' }>>({
    type: oneOf('chooser'),
    chooserId: id,
  }),
  horizontal: shape<Extract<PanelLayoutMoveTarget, { type: 'horizontal' }>>({
    type: oneOf('horizontal'),
    groupId: id,
    row: oneOf('top', 'bottom'),
    position: oneOf('before', 'after'),
  }),
};

const moveTarget: Guard<PanelLayoutMoveTarget> = (v): v is PanelLayoutMoveTarget =>
  isRecord(v) &&
  typeof v.type === 'string' &&
  Object.hasOwn(MOVE_TARGETS, v.type) &&
  MOVE_TARGETS[v.type as PanelLayoutMoveTarget['type']](v);

// The two tables partition every PrivacyAdvancedKey the handler can apply.
const advancedKey: Guard<PrivacyAdvancedKey> = (v): v is PrivacyAdvancedKey =>
  typeof v === 'string' &&
  (Object.hasOwn(ADVANCED_KEY_TO_PREF, v) || Object.hasOwn(ADVANCED_KEY_TO_BROWSER_PRIVACY, v));

const advancedValue: Guard<boolean | string> = (v): v is boolean | string =>
  typeof v === 'boolean' || isBoundedString(v, 64);

const workspaceChanges = shape<Partial<Pick<Workspace, 'name' | 'themeId' | 'icon'>>>({
  name: optional(name),
  themeId: optional(text(MAX_ID_LENGTH)),
  icon: optional(text(MAX_ID_LENGTH)),
});

const settingsChanges: Guard<Partial<BentoSettings>> = (v): v is Partial<BentoSettings> =>
  isValidBentoSettingsPatch(v);

/** One entry per Action type; adding a type or field without a guard fails to compile. */
const ACTION_FIELDS: { [T in ActionType]: Guards<Omit<ActionOf<T>, 'type'>> } = {
  ping: {},
  'shell/hello': { windowId: nat },
  'tabs/requestSnapshot': {},
  'tabFolders/requestSnapshot': {},
  'tab/activate': { id: nat },
  'tab/close': { id: nat },
  'tabs/close': { ids },
  'tabs/reload': { ids, bypassCache },
  'tab/closeMain': { id: nat },
  'tab/rename': { id: nat, title },
  'tab/assignWorkspace': { id: nat, workspaceId: id },
  'tabs/assignWorkspace': { ids, workspaceId: id },
  'tabFolder/create': { id: optional(text(MAX_ID_LENGTH)), name: optional(name), tabIds: ids },
  'tabFolder/rename': { id, name },
  'tabFolder/delete': { id },
  'tabFolder/setCollapsed': { id, collapsed: bool },
  'tabFolder/reorder': { workspaceId: id, orderedIds: idStrings },
  'tabFolder/assignWorkspace': { id, workspaceId: id },
  'tabs/setFolder': { ids, folderId: nullable(id) },
  'tabs/moveToNewWorkspace': { ids, name: optional(name) },
  'tab/openUrl': { url: navUrl(), active: optional(bool), focusExisting: optional(bool) },
  'tab/reopenClosed': {},
  'tab/create': { active: optional(bool), index: optional(nat) },
  'tab/reload': { id: nat, bypassCache },
  'tab/unload': { id: nat },
  'tab/setPinned': { id: nat, pinned: bool },
  'tab/togglePin': { id: nat },
  'tab/toggleMuted': { id: nat },
  'workspaces/requestSnapshot': {},
  'workspace/create': {
    name,
    themeId: optional(text(MAX_ID_LENGTH)),
    icon: optional(text(MAX_ID_LENGTH)),
  },
  'workspace/rename': { id, name },
  'workspace/update': { id, changes: workspaceChanges },
  'workspace/delete': { id, closeTabs: optional(bool) },
  'workspace/activate': { id },
  'settings/requestSnapshot': {},
  'settings/update': { changes: settingsChanges },
  'settings/reset': {},
  'panel/add': { id: nat },
  'panel/addDevtools': { tabId: nat, forTabId: nullable(nat), inspectedTabId: nat },
  'panel/focus': { workspaceId: id, id: nat },
  'panel/openAt': {
    url: navUrl(),
    sourceTabId: nullable(nat),
    position: optional(oneOf('after', 'end')),
  },
  'panel/remove': { id: nat },
  'panel/focusedChanged': { tabId: nullable(nat) },
  'panels/clear': {},
  'panelLayout/reorderRoot': { rootNodeIds: idStrings },
  'panelLayout/movePanel': { tabId: nat, target: moveTarget },
  'panel/setWidth': { id: nat, widthPx },
  'panel/setHeaderHidden': { id: nat, hidden: bool },
  'panel/setMainWidth': { widthPx },
  'panel/setStripScroll': { workspaceId: id, scrollLeft: bounded(MAX_SCROLL_PIXELS, 0) },
  'panelLayout/subdivide': { tabId: nat },
  'panelLayout/splitTopPanel': { tabId: nat, url: optional(navUrl(true)) },
  'panelLayout/splitBottomPanel': { tabId: nat, url: optional(navUrl(true)) },
  'panelLayout/fillChooser': {
    chooserId: id,
    mode: oneOf('single', 'dual'),
    urls: list(navUrl(true), 2),
  },
  'panelLayout/breakOut': { tabId: nat },
  'panelLayout/removeVerticalGroup': {
    groupId: id,
    closeDelayMs: optional(bounded(MAX_CLOSE_DELAY_MS, 0)),
  },
  'panelLayout/setGroupRatio': { groupId: id, ratio: bounded(1, 0) },
  'privacy/requestSnapshot': {},
  'privacy/setProtectionLevel': { level: oneOf('standard', 'enhanced', 'hardened') },
  'privacy/setAdvanced': {
    key: advancedKey,
    value: advancedValue,
  },
  'privacy/setDefaultSearchEngine': { id },
  'searchEngines/requestSnapshot': {},
  'addrbar/query': {
    requestId: id,
    query: text(MAX_QUERY_LENGTH),
    limit: optional((v): v is number => isInteger(v, 1, MAX_ADDRESS_RESULTS)),
  },
  'addrbar/restoreClosed': { requestId: id, sessionId: id },
  'pinnedPanel/add': { workspaceId: id, tabId: nat },
  'pinnedPanel/remove': pinKey,
  'pinnedPanel/open': pinKey,
  'pinnedPanel/close': pinKey,
  'pinnedPanel/activate': pinKey,
  'pinnedPanels/reorder': { orderedKeys: list(pinned, MAX_ID_LIST) },
  'pinnedPanels/requestSnapshot': {},
  'savedPanels/save': { url: navUrl(), title, favIconUrl: optional(favIconUrl) },
  'savedPanels/requestSnapshot': {},
  'externalMerge/requestSources': { requestId: id },
  'externalMerge/merge': {
    sourceId: id,
    operationId: id,
    targetIds: optional(idStrings),
  },
  'externalMerge/cancel': { operationId: id },
};

export interface ParsedWireAction {
  action: Action;
  /** The sender's claimed window; null when the envelope omits it. */
  windowId: number | null;
}

/**
 * Validates one port message. Returns null for anything that is not exactly an
 * Action (plus an optional integer `__windowId`); never throws.
 */
export function parseWireAction(message: unknown): ParsedWireAction | null {
  if (!isRecord(message)) return null;
  const { __windowId: windowId, ...action } = message;
  if (windowId !== undefined && !nat(windowId)) return null;
  const type = action.type;
  if (typeof type !== 'string' || !Object.hasOwn(ACTION_FIELDS, type)) return null;
  const fields: Record<string, Guard<unknown>> = ACTION_FIELDS[type as ActionType];
  const exact =
    Object.keys(action).every((key) => key === 'type' || Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(([key, guard]) => guard(action[key]));
  // The per-type guards above are the proof for this assertion.
  return exact ? { action: action as unknown as Action, windowId: windowId ?? null } : null;
}
