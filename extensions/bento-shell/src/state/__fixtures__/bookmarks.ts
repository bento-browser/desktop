// Fake Bookmarks manager data for Ladle stories and tests. `useFakeBookmarks` stands in for
// bento-tools: it applies the same `bookmarks/*` actions the real store does to a local snapshot,
// so reordering, deleting and undoing work in a story. It follows the same contract for client
// ids (a create with an id that exists is refused), a to-do's `done` on create, `tabs/save`
// placement (`beforeId`, `ids`) and the load status (`loadFailed` refuses everything until a
// `requestSnapshot` retries). Nothing here reaches the tools port.

import { useCallback, useState } from 'react';
import type {
  BookmarkColor,
  BookmarkGroup,
  BookmarkItem,
  BookmarkItemInput,
  BookmarkSpace,
  BookmarksSnapshot,
} from '@shared/protocol';
import type { BookmarksAction, OpenTab } from '../../components/BookmarksView/types';

// A square favicon, so a missing corner radius shows as sharp corners.
function favicon(host: string): string {
  const hue = [...host].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 0);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="hsl(${hue} 55% 46%)"/>` +
    `<text x="8" y="12" font-size="10" font-family="sans-serif" text-anchor="middle" fill="#fff">${host[0]!.toUpperCase()}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

type Seed =
  | { link: [title: string, url: string, icon?: boolean] }
  | { note: string }
  | { todo: string; done?: boolean };

function itemsOf(groupId: string, seeds: Seed[]): BookmarkItem[] {
  return seeds.map((seed, order): BookmarkItem => {
    const base = { id: nextId('item'), groupId, order, createdAt: 1_700_000_000_000 + order };
    if ('note' in seed) return { ...base, kind: 'note', text: seed.note };
    if ('todo' in seed) return { ...base, kind: 'todo', text: seed.todo, done: seed.done ?? false };
    const [title, url, icon = true] = seed.link;
    const host = new URL(url).hostname.replace(/^www\./, '');
    return { ...base, kind: 'link', url, title, ...(icon ? { favIconUrl: favicon(host) } : {}) };
  });
}

function group(
  id: string,
  spaceId: string,
  order: number,
  name: string,
  color: BookmarkColor,
  seeds: Seed[],
) {
  return {
    group: { id, spaceId, order, name, color } satisfies BookmarkGroup,
    items: itemsOf(id, seeds),
  };
}

const SPACES: BookmarkSpace[] = [
  { id: 'space-personal', name: 'Personal', color: 'blue', order: 0 },
  { id: 'space-work', name: 'Work', color: 'green', order: 1 },
  { id: 'space-climbing', name: 'Climbing', color: 'red', order: 2 },
  { id: 'space-trip', name: 'Trip planning', color: 'purple', order: 3 },
];

const personal = [
  group('group-reading', 'space-personal', 0, 'Reading', 'blue', [
    { link: ['Hacker News', 'https://news.ycombinator.com/'] },
    { link: ['The Verge', 'https://www.theverge.com/'] },
    { link: ['Aeon', 'https://aeon.co/'] },
  ]),
  group('group-home', 'space-personal', 1, 'Home', 'yellow', [
    { link: ['Energy provider', 'https://example-energy.com.au/account'] },
    { todo: 'Renew car registration' },
  ]),
];

const work = [
  group('group-docs', 'space-work', 0, 'Docs', 'green', [
    { link: ['Linear', 'https://linear.app/'] },
    { link: ['Notion', 'https://www.notion.so/'] },
    { link: ['Figma', 'https://www.figma.com/'] },
    { link: ['GitHub', 'https://github.com/'] },
  ]),
];

const climbing = [
  group('group-apps', 'space-climbing', 0, 'Bouldering apps', 'red', [
    { link: ['Bould Buddy', 'https://play.google.com/store/apps/bould-buddy'] },
    { link: ['RouteIt Indoor Bouldering', 'https://routeit.app/'] },
    { link: ['Campus: Climb and Boulder', 'https://campus.climb/'] },
    { link: ['BoulderBot Climbing', 'https://apps.apple.com/app/boulderbot'] },
    { link: ['TopLogger', 'https://toplogger.nu/'] },
    { link: ['Boulder Bud', 'https://play.google.com/store/apps/boulder-bud', false] },
    { note: 'Compare grading UI and session logging. Shortlist 3.' },
    { todo: 'Test TopLogger offline mode' },
  ]),
  group('group-gyms', 'space-climbing', 1, 'Gyms', 'green', [
    { link: ['Blochaus', 'https://blochaus.com.au/'] },
    { link: ['Northside Boulders', 'https://northsideboulders.com/'] },
    { link: ['9 Degrees', 'https://9degrees.com.au/'] },
    { link: ['Urban Climb', 'https://urbanclimb.com.au/'] },
    { link: ['Crux Climbing', 'https://cruxclimbing.com.au/'] },
  ]),
  group('group-training', 'space-climbing', 2, 'Training', 'orange', [
    { link: ['Lattice Training', 'https://latticetraining.com/'] },
    { link: ["Hooper's Beta", 'https://www.youtube.com/@hoopersbeta'] },
    { link: ['r/bouldering', 'https://www.reddit.com/r/bouldering'] },
    { link: ['Crimpd', 'https://crimpd.com/'] },
    { todo: 'Book assessment', done: true },
  ]),
  group('group-gear', 'space-climbing', 3, 'Gear', 'gray', [
    { link: ['Scarpa Drago', 'https://www.scarpa.com/drago'] },
    { link: ['La Sportiva Solution', 'https://www.lasportiva.com/solution'] },
    {
      link: [
        'The complete beginner-to-expert chalk bag roundup, with weights, closures, brush holders and a long title that has to truncate',
        'https://gearjunkie.com/climbing/best-chalk-bags-and-the-long-url-that-follows',
      ],
    },
    {
      note: 'Size 41.5 in Drago, 42 in Solution.\nAsk the shop about resoling before buying a second pair.',
    },
  ]),
];

function snapshotOf(
  spaces: BookmarkSpace[],
  columns: ReturnType<typeof group>[],
  lastSpaceId: string | null,
  firefoxImportOffered = true,
): BookmarksSnapshot {
  return {
    status: 'ready',
    spaces,
    groups: columns.map((column) => column.group),
    items: columns.flatMap((column) => column.items),
    lastSpaceId,
    firefoxImportOffered,
  };
}

/** The mock's default state: four spaces, the Climbing board open with four groups. */
export const SAMPLE_SNAPSHOT: BookmarksSnapshot = snapshotOf(
  SPACES,
  [...personal, ...work, ...climbing],
  'space-climbing',
);

/** The store could not read its data: empty arrays, every change refused until a retry. */
export const LOAD_FAILED_SNAPSHOT: BookmarksSnapshot = {
  status: 'loadFailed',
  spaces: [],
  groups: [],
  items: [],
  lastSpaceId: null,
  firefoxImportOffered: false,
};

/** A space with no groups yet. */
export const EMPTY_SPACE_SNAPSHOT: BookmarksSnapshot = snapshotOf(
  SPACES,
  [...personal, ...work, ...climbing],
  'space-trip',
  false,
);

/** A first run: the one empty "Personal" space tools seeds, with no group and no link. */
export const FIRST_RUN_SNAPSHOT: BookmarksSnapshot = snapshotOf(
  [SPACES[0]!],
  [],
  'space-personal',
  false,
);

/** Group names that are too long for a toolbar button, to check that they truncate. */
export const LONG_NAMES_SNAPSHOT: BookmarksSnapshot = (() => {
  const names = [
    'Reading list for the long weekend away',
    'Design references and inspiration from around the web',
    'Short',
    'Bouldering apps and training programmes worth trying before the season starts',
  ];
  const columns = names.map((name, index) =>
    group(`group-long-${index}`, 'space-climbing', index, name, 'blue', [
      { link: [`Link ${index + 1}`, `https://example${index}.com/`] },
    ]),
  );
  return snapshotOf(SPACES, columns, 'space-climbing');
})();

/** Many columns and long lists, to scroll the board both ways. */
export const MANY_SNAPSHOT: BookmarksSnapshot = (() => {
  const colors: BookmarkColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
  const columns = Array.from({ length: 9 }, (_, index) =>
    group(
      `group-many-${index}`,
      'space-climbing',
      index,
      `Reading list ${index + 1}`,
      colors[index % colors.length]!,
      Array.from({ length: 6 + index * 3 }, (_, n) => ({
        link: [`Article ${index + 1}.${n + 1}`, `https://example${n}.com/post/${index}`] as [
          string,
          string,
        ],
      })),
    ),
  );
  return snapshotOf(SPACES, columns, 'space-climbing');
})();

export const SAMPLE_TABS: OpenTab[] = [
  {
    id: 101,
    title: 'Sign up | Etch',
    url: 'https://etch.app/signup',
    favIconUrl: favicon('etch.app'),
  },
  {
    id: 102,
    title: 'Kilter Board app',
    url: 'https://kilterboardapp.com/',
    favIconUrl: favicon('kilterboardapp.com'),
  },
  {
    id: 103,
    title:
      '1.4 Display Port KVM Switch for two computers, dual monitor, with USB 3.0 hub and a very long title',
    url: 'https://www.amazon.com.au/dp/B0KVM',
    favIconUrl: favicon('amazon.com.au'),
  },
  {
    id: 104,
    title: 'Moon Board',
    url: 'https://moonboard.com/',
    favIconUrl: favicon('moonboard.com'),
  },
  { id: 105, title: 'Google', url: 'https://www.google.com/' },
];

// ---- The fake tools -------------------------------------------------------------------------

function renumber<T extends { order: number }>(list: T[]): void {
  list.forEach((entry, index) => {
    entry.order = index;
  });
}

function insert<T extends { id: string; order: number }>(
  siblings: T[],
  moved: T,
  beforeId: string | null,
): void {
  const rest = siblings.filter((entry) => entry.id !== moved.id).sort((a, b) => a.order - b.order);
  const at = beforeId === null ? -1 : rest.findIndex((entry) => entry.id === beforeId);
  rest.splice(at === -1 ? rest.length : at, 0, moved);
  renumber(rest);
}

function itemFrom(
  groupId: string,
  order: number,
  input: BookmarkItemInput,
  id: string = nextId('item'),
): BookmarkItem {
  const base = { id, groupId, order, createdAt: Date.now() };
  if (input.kind === 'link') {
    return {
      ...base,
      kind: 'link',
      url: input.url,
      title: input.title || input.url,
      ...(input.favIconUrl ? { favIconUrl: input.favIconUrl } : {}),
    };
  }
  return input.kind === 'note'
    ? { ...base, kind: 'note', text: input.text }
    : { ...base, kind: 'todo', text: input.text, done: input.done ?? false };
}

/** Applies one action to a copy of the snapshot, as bento-tools' store does (without validation). */
export function applyFakeAction(
  current: BookmarksSnapshot,
  action: BookmarksAction,
  tabs: readonly OpenTab[] = SAMPLE_TABS,
): BookmarksSnapshot {
  if (current.status === 'loadFailed') {
    // A retry reads the storage again: here it finds nothing and seeds the first space.
    if (action.type !== 'bookmarks/requestSnapshot') return current;
    const seeded: BookmarkSpace = {
      id: nextId('space'),
      name: 'Personal',
      color: 'blue',
      order: 0,
    };
    return { ...current, status: 'ready', spaces: [seeded], lastSpaceId: seeded.id };
  }
  const next: BookmarksSnapshot = {
    ...current,
    spaces: current.spaces.map((space) => ({ ...space })),
    groups: current.groups.map((entry) => ({ ...entry })),
    items: current.items.map((item) => ({ ...item })),
  };
  const groupsOf = (spaceId: string) => next.groups.filter((entry) => entry.spaceId === spaceId);
  const itemsIn = (groupId: string) => next.items.filter((item) => item.groupId === groupId);
  /** One id namespace, as in tools: a client id that is taken makes the create a no-op. */
  const taken = (id: string | undefined) =>
    id !== undefined &&
    (next.spaces.some((entry) => entry.id === id) ||
      next.groups.some((entry) => entry.id === id) ||
      next.items.some((entry) => entry.id === id));
  const addGroup = (spaceId: string, name: string, id: string = nextId('group')) => {
    const created: BookmarkGroup = {
      id,
      spaceId,
      name,
      color: 'gray',
      order: groupsOf(spaceId).length,
    };
    next.groups.push(created);
    return created;
  };
  const addItem = (groupId: string, input: BookmarkItemInput, id?: string) => {
    const created = itemFrom(groupId, itemsIn(groupId).length, input, id);
    next.items.push(created);
    return created;
  };
  switch (action.type) {
    case 'bookmarks/space/create':
      if (taken(action.id)) break;
      next.spaces.push({
        id: action.id ?? nextId('space'),
        name: action.name.trim() || 'Untitled space',
        color: 'gray',
        order: next.spaces.length,
      });
      break;
    case 'bookmarks/space/update': {
      const space = next.spaces.find((entry) => entry.id === action.id);
      if (space)
        Object.assign(space, {
          name: action.name?.trim() || space.name,
          color: action.color ?? space.color,
        });
      break;
    }
    case 'bookmarks/space/delete': {
      const doomed = new Set(groupsOf(action.id).map((entry) => entry.id));
      next.items = next.items.filter((item) => !doomed.has(item.groupId));
      next.groups = next.groups.filter((entry) => entry.spaceId !== action.id);
      next.spaces = next.spaces.filter((space) => space.id !== action.id);
      renumber(next.spaces);
      if (next.lastSpaceId === action.id) next.lastSpaceId = next.spaces[0]?.id ?? null;
      break;
    }
    case 'bookmarks/space/select':
      next.lastSpaceId = action.id;
      break;
    case 'bookmarks/group/create':
      if (taken(action.id) || !next.spaces.some((entry) => entry.id === action.spaceId)) break;
      addGroup(action.spaceId, action.name.trim() || 'Untitled group', action.id);
      break;
    case 'bookmarks/group/update': {
      const target = next.groups.find((entry) => entry.id === action.id);
      if (target)
        Object.assign(target, {
          name: action.name?.trim() || target.name,
          color: action.color ?? target.color,
        });
      break;
    }
    case 'bookmarks/group/delete': {
      const target = next.groups.find((entry) => entry.id === action.id);
      next.items = next.items.filter((item) => item.groupId !== action.id);
      next.groups = next.groups.filter((entry) => entry.id !== action.id);
      if (target) renumber(groupsOf(target.spaceId));
      break;
    }
    case 'bookmarks/group/move': {
      const target = next.groups.find((entry) => entry.id === action.id);
      if (!target) break;
      const from = target.spaceId;
      target.spaceId = action.spaceId;
      insert(groupsOf(action.spaceId), target, action.beforeId);
      if (from !== action.spaceId) renumber(groupsOf(from));
      break;
    }
    case 'bookmarks/item/create': {
      if (taken(action.id) || !next.groups.some((entry) => entry.id === action.groupId)) break;
      const created = addItem(action.groupId, action.item, action.id);
      insert(itemsIn(action.groupId), created, action.beforeId);
      break;
    }
    case 'bookmarks/item/update': {
      const item = next.items.find((entry) => entry.id === action.id);
      if (!item) break;
      if (item.kind === 'link') {
        if (action.url) item.url = action.url;
        if (action.title !== undefined) item.title = action.title.trim() || item.url;
      } else {
        if (action.text !== undefined) item.text = action.text;
        if (item.kind === 'todo' && action.done !== undefined) item.done = action.done;
      }
      break;
    }
    case 'bookmarks/item/delete': {
      const item = next.items.find((entry) => entry.id === action.id);
      next.items = next.items.filter((entry) => entry.id !== action.id);
      if (item) renumber(itemsIn(item.groupId));
      break;
    }
    case 'bookmarks/item/move': {
      const item = next.items.find((entry) => entry.id === action.id);
      if (!item) break;
      const from = item.groupId;
      item.groupId = action.groupId;
      insert(itemsIn(action.groupId), item, action.beforeId);
      if (from !== action.groupId) renumber(itemsIn(from));
      break;
    }
    case 'bookmarks/tabs/save': {
      const ids = action.ids ?? [];
      // Tools saves nothing when a client id repeats or is taken.
      if (new Set(ids).size !== ids.length || ids.some(taken)) break;
      if (!next.spaces.some((entry) => entry.id === action.spaceId)) break;
      // A tab that is gone, or a repeat of an earlier one, is skipped and leaves its id slot unused.
      const seen = new Set<number>();
      const saved: Array<{ tab: OpenTab; id: string | undefined }> = [];
      action.tabIds.forEach((tabId, slot) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab || seen.has(tabId)) return;
        seen.add(tabId);
        saved.push({ tab, id: ids[slot] });
      });
      if (saved.length === 0) break;
      const existing = action.groupId
        ? next.groups.find(
            (entry) => entry.id === action.groupId && entry.spaceId === action.spaceId,
          )
        : undefined;
      if (action.groupId !== null && !existing) break;
      const target = existing ?? addGroup(action.spaceId, 'Saved tabs');
      for (const { tab, id } of saved) {
        const created = addItem(
          target.id,
          { kind: 'link', url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
          id,
        );
        // The run goes in before `beforeId`, in order (a new group has nothing to go before).
        if (existing) insert(itemsIn(target.id), created, action.beforeId ?? null);
      }
      break;
    }
    case 'bookmarks/import/firefox': {
      const space: BookmarkSpace = {
        id: nextId('space'),
        name: 'Firefox bookmarks',
        color: 'gray',
        order: next.spaces.length,
      };
      next.spaces.push(space);
      const folder = addGroup(space.id, 'Bookmarks Toolbar');
      addItem(folder.id, { kind: 'link', url: 'https://www.mozilla.org/', title: 'Mozilla' });
      next.lastSpaceId = space.id;
      next.firefoxImportOffered = true;
      break;
    }
    case 'bookmarks/import/dismiss':
      next.firefoxImportOffered = true;
      break;
    case 'bookmarks/item/open':
    case 'bookmarks/requestSnapshot':
      break;
  }
  // The real store sends every array sorted by `order`.
  const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;
  next.spaces.sort(byOrder);
  next.groups.sort(byOrder);
  next.items.sort(byOrder);
  return next;
}

/** A snapshot that edits itself as the real store would, and the `send` that edits it. Each call
 * of an action is also counted on <body> so a story can show that an open was requested. */
export function useFakeBookmarks(
  initial: BookmarksSnapshot,
  tabs: readonly OpenTab[] = SAMPLE_TABS,
) {
  const [snapshot, setSnapshot] = useState(initial);
  const send = useCallback(
    (action: BookmarksAction) => {
      if (action.type === 'bookmarks/item/open') {
        document.body.dataset.lastOpen = `${action.where}:${action.id}`;
        return;
      }
      setSnapshot((current) => applyFakeAction(current, action, tabs));
    },
    [tabs],
  );
  return { snapshot, send };
}
