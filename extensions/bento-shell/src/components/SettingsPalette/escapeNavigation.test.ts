import { describe, expect, it } from 'vitest';
import { REGULAR_MODEL } from '../../state/__fixtures__/settingsPalette';
import { rowsForStage } from './rows';
import {
  ROOT_STAGE,
  escapeOutcome,
  initialStack,
  popStage,
  pushStage,
  stageKey,
  topStage,
  type Stage,
} from './stageStack';
import type { SettingsPaletteModel } from './types';

/** Every stack the palette can reach by choosing rows that push a stage, found from the rows
 * themselves, so a stage added later is covered without a new case here. */
function reachableStacks(model: SettingsPaletteModel): Stage[][] {
  const seen = new Map<string, Stage[]>();
  const queue: Stage[][] = [initialStack()];
  for (let stack = queue.shift(); stack; stack = queue.shift()) {
    for (const row of rowsForStage(topStage(stack), model)) {
      if (row.intent.type !== 'push') continue;
      const next = pushStage(stack, row.intent.stage);
      const key = next.map(stageKey).join('>');
      if (seen.has(key)) continue;
      seen.set(key, next);
      queue.push(next);
    }
  }
  return [...seen.values()];
}

const idle = { query: '', importPreview: false };

describe('Esc', () => {
  const stacks = reachableStacks(REGULAR_MODEL);

  it('reaches every stage the palette pushes, down to the confirmations and the size editor', () => {
    const paths = stacks.map((stack) => stack.map((stage) => stage.kind).join('>'));
    expect(paths).toContain('root>category>sizes>sizeActions>sizeEdit');
    expect(paths).toContain('root>category>backups>backupRow>confirm');
    expect(paths).toContain('root>category>confirm');
    expect(paths).toContain('root>category>advanced>enum');
    expect(stacks.some((stack) => topStage(stack).kind === 'protection')).toBe(true);
  });

  it('goes back exactly one stage from every stage that was pushed, and closes only from the root', () => {
    for (const start of stacks) {
      let stack = start;
      while (stack.length > 1) {
        expect(escapeOutcome(stack, idle)).toBe('back');
        const next = popStage(stack);
        expect(next).toEqual(stack.slice(0, -1));
        stack = next;
      }
      expect(topStage(stack)).toBe(ROOT_STAGE);
      expect(escapeOutcome(stack, idle)).toBe('close');
    }
  });

  it('asks the restore and delete confirmations to step back to the stored backup', () => {
    const backupRow: Stage = { kind: 'backupRow', backupId: 'b2', label: 'L' };
    for (const action of ['restore', 'delete'] as const) {
      const confirm: Stage = {
        kind: 'confirm',
        action: { kind: action, backupId: 'b2', label: 'L' },
      };
      const stack = [
        ROOT_STAGE,
        { kind: 'category', id: 'backup' },
        { kind: 'backups' },
        backupRow,
        confirm,
      ] as Stage[];
      expect(escapeOutcome(stack, idle)).toBe('back');
      expect(topStage(popStage(stack))).toBe(backupRow);
    }
  });

  it('dismisses an import preview before it leaves the Backups stage', () => {
    const backups = [
      ROOT_STAGE,
      { kind: 'category', id: 'backup' },
      { kind: 'backups' },
    ] as Stage[];
    expect(escapeOutcome(backups, { query: '', importPreview: true })).toBe('cancelImport');
    // Once the preview is gone the next Esc is the ordinary one stage back.
    expect(escapeOutcome(backups, idle)).toBe('back');
  });

  it('leaves a preview alone while another stage is on top of Backups', () => {
    const row = [
      ROOT_STAGE,
      { kind: 'category', id: 'backup' },
      { kind: 'backups' },
      { kind: 'backupRow', backupId: 'b', label: 'L' },
    ];
    expect(escapeOutcome(row as Stage[], { query: '', importPreview: true })).toBe('back');
  });

  it('clears a search first in a list, and never reads the field of an editor as a search', () => {
    const advanced = [
      ROOT_STAGE,
      { kind: 'category', id: 'privacy' },
      { kind: 'advanced' },
    ] as Stage[];
    expect(escapeOutcome(advanced, { query: 'rtc', importPreview: false })).toBe('clearQuery');
    expect(escapeOutcome(advanced, idle)).toBe('back');
    expect(escapeOutcome([ROOT_STAGE], { query: 'radius', importPreview: false })).toBe(
      'clearQuery',
    );
    const sizeEdit = [
      ROOT_STAGE,
      { kind: 'category', id: 'panels' },
      { kind: 'sizes' },
      { kind: 'sizeActions', index: 0 },
      { kind: 'sizeEdit', index: 0 },
    ] as Stage[];
    expect(escapeOutcome(sizeEdit, { query: '480', importPreview: false })).toBe('back');
    // A search typed on the Backups stage goes before the preview does.
    const backups = [
      ROOT_STAGE,
      { kind: 'category', id: 'backup' },
      { kind: 'backups' },
    ] as Stage[];
    expect(escapeOutcome(backups, { query: 'x', importPreview: true })).toBe('clearQuery');
  });
});
