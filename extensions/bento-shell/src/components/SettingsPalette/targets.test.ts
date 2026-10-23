import { describe, expect, it } from 'vitest';
import { resolveSettingsTarget } from './targets';

describe('settings targets', () => {
  it('opens a number, choice or name setting on its own list', () => {
    expect(resolveSettingsTarget('setting:panelCornerRadiusPx')).toEqual({
      stages: [{ kind: 'root' }, { kind: 'number', key: 'panelCornerRadiusPx' }],
      query: '',
    });
    expect(resolveSettingsTarget('setting:uiColorMode')?.stages.at(-1)).toEqual({
      kind: 'enum',
      key: 'uiColorMode',
    });
    // A setting this build no longer has is not a target: it opens the first list.
    expect(resolveSettingsTarget('setting:defaultWorkspaceName')).toBeNull();
  });

  it('opens the privacy rows on their lists', () => {
    expect(resolveSettingsTarget('privacy:level')?.stages.at(-1)).toEqual({ kind: 'protection' });
    expect(resolveSettingsTarget('privacy:search')?.stages.at(-1)).toEqual({ kind: 'search' });
    expect(resolveSettingsTarget('privacy:advanced')?.stages.at(-1)).toEqual({ kind: 'advanced' });
  });

  it('puts a switch, which has no list, first by typing its label into the root', () => {
    expect(resolveSettingsTarget('setting:panelShadowsEnabled')).toEqual({
      stages: [{ kind: 'root' }],
      query: 'Show panel shadows',
    });
    expect(resolveSettingsTarget('advanced:resistFingerprinting')).toEqual({
      stages: [{ kind: 'root' }, { kind: 'advanced' }],
      query: 'Resist fingerprinting',
    });
  });

  it('refuses an id the palette does not have, including inherited property names', () => {
    for (const id of ['', 'setting:nope', 'setting:constructor', 'advanced:nope', 'reset:open']) {
      expect(resolveSettingsTarget(id), id).toBeNull();
    }
  });
});
