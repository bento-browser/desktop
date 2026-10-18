// The step index is a persisted contract: 'bento-welcome-step', the
// #bentoWelcomeStep hash chrome stamps after a profile migration, and the next
// step in BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts> all carry it.

import { describe, expect, it } from 'vitest';

import {
  LAST_STEP,
  parseStoredStep,
  searchEngineName,
  startImport,
  stepAfter,
  stepIndexOf,
  WELCOME_STEPS,
} from './WelcomeSurfaces';

describe('welcome steps', () => {
  it('keeps the persisted step order', () => {
    expect(WELCOME_STEPS.map((step) => step.id)).toEqual([
      'welcome',
      'appearance',
      'import',
      'privacy',
      'search',
      'tour',
      'ready',
    ]);
    expect(LAST_STEP).toBe(6);
  });

  it('stores Privacy as the resume step, then signals chrome, after an import', async () => {
    const log: string[] = [];
    const next = stepAfter(stepIndexOf('import'));
    await startImport(
      next,
      async (step) => {
        log.push(`store ${step}`);
      },
      (title) => log.push(title),
    );
    expect(next).toBe(stepIndexOf('privacy'));
    expect(log).toEqual(['store 3', expect.stringMatching(/^BENTO_IMPORT_BROWSER_DATA_3_\d+$/)]);
  });

  it('never resumes past the last step', () => {
    expect(stepAfter(LAST_STEP)).toBe(LAST_STEP);
  });

  it('parses stored steps from storage, localStorage and the hash', () => {
    expect(parseStoredStep(0)).toBe(0);
    expect(parseStoredStep(6)).toBe(6);
    expect(parseStoredStep('3')).toBe(3);
  });

  it('rejects values outside the step table', () => {
    for (const value of [-1, 7, 2.5, Number.NaN, '', 'x', null, undefined, {}]) {
      expect(parseStoredStep(value)).toBeNull();
    }
  });
});

describe('searchEngineName', () => {
  const loaded = [{ id: 'ddg', name: 'DuckDuckGo (Private)', isDefault: true }];

  it('prefers the loaded engine list', () => {
    expect(searchEngineName(loaded, 'ddg')).toBe('DuckDuckGo (Private)');
  });

  it('names a default engine before the list loads, and falls back to the id', () => {
    expect(searchEngineName([], 'ddg')).toBe('DuckDuckGo');
    expect(searchEngineName([], 'custom-engine')).toBe('custom-engine');
    expect(searchEngineName([], 'constructor')).toBe('constructor');
  });
});
