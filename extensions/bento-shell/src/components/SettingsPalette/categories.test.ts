import { describe, expect, it } from 'vitest';
import { PRIVATE_MODEL, REGULAR_MODEL } from '../../state/__fixtures__/settingsPalette';
import { categoryForRow, openerRows, settingPath, SETTINGS_CATEGORIES } from './categories';
import {
  controlRows,
  filterRows,
  footerFor,
  isFilterable,
  pageDescription,
  rootRows,
  rowsForStage,
  searchableRows,
  showsFieldRow,
} from './rows';
import { resolveSettingsTarget } from './targets';
import { popStage, ROOT_STAGE, topStage, type Stage } from './stageStack';

describe('Settings categories', () => {
  it('lists only described category openers in the established order, under every visibility gate', () => {
    for (const isPrivate of [false, true]) {
      for (const privacy of [REGULAR_MODEL.privacy, null]) {
        for (const search of [REGULAR_MODEL.search, null]) {
          const model = { ...REGULAR_MODEL, isPrivate, privacy, search };
          const expected = SETTINGS_CATEGORIES.filter(
            ({ id }) =>
              (id !== 'privacy' || (privacy && search)) &&
              (!['backup', 'reset'].includes(id) || !isPrivate),
          );
          const rows = rootRows(model);
          expect(rows.map((row) => row.label)).toEqual(expected.map(({ label }) => label));
          expect(rows.map((row) => row.description)).toEqual(
            expected.map(({ description }) => description),
          );
          for (const row of rows) {
            expect(row.id).toMatch(/^category:/);
            expect(row).toMatchObject({ trail: '›', intent: { type: 'push' } });
            expect(row.switchOn).toBeUndefined();
            expect(row.value).toBeUndefined();
          }
          if (!privacy || !search)
            expect(searchableRows(model).some((row) => row.id.startsWith('advanced:'))).toBe(false);
        }
      }
    }
    expect(controlRows(REGULAR_MODEL)).toHaveLength(24);
    expect(rootRows(REGULAR_MODEL)).toHaveLength(9);
    expect(rootRows(PRIVATE_MODEL)).toHaveLength(7);
  });

  it('reaches every former control once through its category, opening shortcuts directly', () => {
    for (const model of [REGULAR_MODEL, PRIVATE_MODEL]) {
      const children = rootRows(model).flatMap((row) =>
        row.intent.type === 'push' ? rowsForStage(row.intent.stage, model) : [],
      );
      const controls = controlRows(model).filter((row) => row.id !== 'shortcuts:open');
      expect(children.filter((row) => !row.id.startsWith('shortcut:'))).toEqual(controls);
      expect(children.filter((row) => row.id.startsWith('shortcut:'))).toHaveLength(12);
      expect(new Set(children.map((row) => row.id)).size).toBe(children.length);
      const sizes = new Map(
        rootRows(model).map((row) => [
          row.id,
          row.intent.type === 'push' ? rowsForStage(row.intent.stage, model).length : 0,
        ]),
      );
      expect(sizes.get('category:appearance')).toBe(1);
      expect(sizes.get('category:tabAppearance')).toBe(2);
      expect(sizes.get('category:performance')).toBe(3);
      expect(sizes.get('category:workspaces')).toBe(1);
      expect(sizes.get('category:panels')).toBe(6);
      expect(sizes.get('category:privacy')).toBe(4);
      expect(sizes.get('category:backup')).toBe(model.isPrivate ? undefined : 5);
      expect(sizes.get('category:reset')).toBe(model.isPrivate ? undefined : 1);
    }
  });

  it('filters only a category’s children and keeps global controls, privacy and shortcuts searchable', () => {
    const panels: Stage = { kind: 'category', id: 'panels' };
    expect(isFilterable(panels)).toBe(true);
    expect(filterRows(rowsForStage(panels, REGULAR_MODEL), 'shadows').map((row) => row.id)).toEqual(
      ['setting:panelShadowsEnabled'],
    );
    expect(filterRows(rowsForStage(panels, REGULAR_MODEL), 'sleep')).toEqual([]);
    for (const row of controlRows(REGULAR_MODEL))
      expect(searchableRows(REGULAR_MODEL).map((entry) => entry.id)).toContain(row.id);
    expect(
      searchableRows(REGULAR_MODEL).filter((row) => row.id.startsWith('advanced:')),
    ).toHaveLength(15);
    expect(
      searchableRows(REGULAR_MODEL).filter((row) => row.id.startsWith('shortcut:')),
    ).toHaveLength(12);
    expect(pageDescription(panels)).toBeNull();
    expect(showsFieldRow({ kind: 'category', id: 'performance' }, 3)).toBe(false);
    expect(showsFieldRow({ kind: 'category', id: 'performance' }, 3, 'Sleep')).toBe(true);
    expect(showsFieldRow(panels, 6)).toBe(true);
    expect(footerFor(ROOT_STAGE, REGULAR_MODEL, 9)).toMatchObject({
      hints: ['↑↓ move', 'Enter open', 'Esc close'],
      status: '9 categories',
    });
    expect(footerFor(ROOT_STAGE, PRIVATE_MODEL, 7).status).toBe('7 categories');
    expect(footerFor({ kind: 'category', id: 'appearance' }, REGULAR_MODEL, 1).hints).toContain(
      'Enter open',
    );
    expect(footerFor({ kind: 'category', id: 'tabAppearance' }, REGULAR_MODEL, 2).hints).toContain(
      'Enter toggle',
    );
  });
});

describe('category ancestry and return focus', () => {
  it('uses the same category for every command target and global search drilldown', () => {
    for (const row of controlRows(REGULAR_MODEL)) {
      expect(categoryForRow(row.id), row.id).toBeDefined();
      const target = resolveSettingsTarget(row.id);
      if (target) expect(target.stages[1]).toEqual(settingPath(row.id)[1]);
      if (row.intent.type === 'push') {
        const path = settingPath(row.id, row.intent.stage);
        expect(topStage(path)).toEqual(row.intent.stage);
        expect(path[1]).toEqual(settingPath(row.id)[1]);
        // A cleared root search cannot restore focus to its former flat control id.
        const openers = openerRows(path);
        for (let depth = 0; depth < path.length - 1; depth += 1) {
          expect(
            rowsForStage(path[depth]!, REGULAR_MODEL).map((entry) => entry.id),
            row.id,
          ).toContain(openers[depth]);
        }
        const rootOpener = openers[0];
        expect(rootRows(REGULAR_MODEL).map((entry) => entry.id)).toContain(rootOpener);
      }
    }
  });

  it('includes Advanced privacy before a global enum result and restores each opener on Back', () => {
    const path = settingPath('advanced:httpsOnlyMode', { kind: 'enum', key: 'httpsOnlyMode' });
    expect(path).toEqual([
      ROOT_STAGE,
      { kind: 'category', id: 'privacy' },
      { kind: 'advanced' },
      { kind: 'enum', key: 'httpsOnlyMode' },
    ]);
    expect(openerRows(path)).toEqual([
      'category:privacy',
      'privacy:advanced',
      'advanced:httpsOnlyMode',
    ]);
    expect(topStage(popStage(path))).toEqual({ kind: 'advanced' });
    expect(settingPath('shortcut:0', { kind: 'shortcuts' })).toEqual([
      ROOT_STAGE,
      { kind: 'shortcuts' },
    ]);
    expect(openerRows(settingPath('shortcut:0', { kind: 'shortcuts' }))[0]).toBe(
      'category:shortcuts',
    );
    expect(categoryForRow('constructor')).toBeUndefined();
  });
});
