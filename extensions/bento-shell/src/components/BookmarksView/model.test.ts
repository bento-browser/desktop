import { describe, expect, it } from 'vitest';
import type { BookmarksSnapshot } from '@shared/protocol';

import { SAMPLE_SNAPSHOT } from '../../state/__fixtures__/bookmarks';
import {
  buildBoard,
  groupChoices,
  hostnameOf,
  parseAddInput,
  searchBookmarks,
  stableChoices,
} from './model';

describe('buildBoard', () => {
  it('shows the last space with its groups, items in order, and counts links per space', () => {
    const board = buildBoard(SAMPLE_SNAPSHOT);
    expect(board.current?.id).toBe('space-climbing');
    expect(board.groups.map(({ group }) => group.name)).toEqual([
      'Bouldering apps',
      'Gyms',
      'Training',
      'Gear',
    ]);
    const apps = board.groups[0]!;
    expect(apps.items).toHaveLength(8);
    expect(apps.items.map((item) => item.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Notes and to-dos are rows, but only links count in the meta and the spaces list.
    expect(board.linkCount).toBe(18);
    expect(board.spaces.find((entry) => entry.space.id === 'space-trip')).toMatchObject({
      groupCount: 0,
      linkCount: 0,
    });
  });

  it('falls back to the first space when lastSpaceId names none', () => {
    const snapshot: BookmarksSnapshot = { ...SAMPLE_SNAPSHOT, lastSpaceId: 'gone' };
    expect(buildBoard(snapshot).current?.id).toBe('space-personal');
    expect(buildBoard({ ...snapshot, spaces: [], groups: [], items: [] }).current).toBeNull();
  });
});

describe('parseAddInput', () => {
  it('makes a link from an address with a scheme, titled by its host', () => {
    expect(parseAddInput('https://www.example.com/a/b?x=1')).toEqual({
      kind: 'link',
      url: 'https://www.example.com/a/b?x=1',
      title: 'example.com',
    });
  });

  it('makes a link from a bare domain, with https', () => {
    expect(parseAddInput('  example.com/path ')).toEqual({
      kind: 'link',
      url: 'https://example.com/path',
      title: 'example.com',
    });
    expect(parseAddInput('localhost.dev:8080')).toMatchObject({
      url: 'https://localhost.dev:8080',
    });
  });

  it('makes a to-do from text that starts with "[] "', () => {
    expect(parseAddInput('[] book a day pass')).toEqual({ kind: 'todo', text: 'book a day pass' });
    expect(parseAddInput('[]   ')).toBeNull();
  });

  it('makes a note from anything else, including text with a colon or a space in it', () => {
    expect(parseAddInput('Compare grading UI')).toEqual({
      kind: 'note',
      text: 'Compare grading UI',
    });
    expect(parseAddInput('todo: buy chalk')).toMatchObject({ kind: 'note' });
    expect(parseAddInput('see example.com later')).toMatchObject({ kind: 'note' });
    expect(parseAddInput('javascript:alert(1)')).toMatchObject({ kind: 'note' });
    expect(parseAddInput('first\nsecond')).toEqual({ kind: 'note', text: 'first\nsecond' });
  });

  it('adds nothing for blank text', () => {
    expect(parseAddInput('   \n ')).toBeNull();
  });
});

describe('searchBookmarks', () => {
  it('finds items of every space, grouped by space and group in order', () => {
    const hits = searchBookmarks(SAMPLE_SNAPSHOT, 'hub');
    expect(hits.map(({ space, group }) => `${space.name}/${group.name}`)).toEqual(['Work/Docs']);

    const wide = searchBookmarks(SAMPLE_SNAPSHOT, 'toplogger');
    expect(wide.map(({ group }) => group.name)).toEqual(['Bouldering apps']);
    // The link and the to-do both mention it.
    expect(wide[0]!.items.map((item) => item.kind)).toEqual(['link', 'todo']);
  });

  it('needs every word, in any order, and ignores case', () => {
    expect(searchBookmarks(SAMPLE_SNAPSHOT, 'DRAGO scarpa')[0]?.items).toHaveLength(1);
    expect(searchBookmarks(SAMPLE_SNAPSHOT, 'drago zzz')).toEqual([]);
  });

  it('matches a link by address as well as title, and a note by its text', () => {
    expect(searchBookmarks(SAMPLE_SNAPSHOT, 'toplogger.nu')).toHaveLength(1);
    expect(searchBookmarks(SAMPLE_SNAPSHOT, 'resoling')[0]?.items[0]).toMatchObject({
      kind: 'note',
    });
  });

  it('returns nothing for a blank query', () => {
    expect(searchBookmarks(SAMPLE_SNAPSHOT, '  ')).toEqual([]);
  });
});

describe('hostnameOf', () => {
  it('drops www and returns the text for a non-URL', () => {
    expect(hostnameOf('https://www.reddit.com/r/bouldering')).toBe('reddit.com');
    expect(hostnameOf('not a url')).toBe('not a url');
  });
});

describe('group choices for the menus', () => {
  const choices = groupChoices(buildBoard(SAMPLE_SNAPSHOT).groups);

  it("lists the current space's groups in order with their colour", () => {
    expect(choices.map((choice) => [choice.name, choice.color])).toEqual([
      ['Bouldering apps', 'red'],
      ['Gyms', 'green'],
      ['Training', 'orange'],
      ['Gear', 'gray'],
    ]);
  });

  it('keeps the same list across snapshots that did not change the groups', () => {
    const again = groupChoices(buildBoard({ ...SAMPLE_SNAPSHOT }).groups);
    expect(stableChoices(choices, again)).toBe(choices);
    const renamed = again.map((choice, index) =>
      index === 1 ? { ...choice, name: 'Gym' } : choice,
    );
    expect(stableChoices(choices, renamed)).toBe(renamed);
    expect(stableChoices(choices, again.slice(1))).toEqual(again.slice(1));
  });
});
