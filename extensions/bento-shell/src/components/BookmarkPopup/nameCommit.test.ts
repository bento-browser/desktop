import { describe, expect, it } from 'vitest';

import { createNameCommitter } from './nameCommit';

describe('committing the name', () => {
  it('sends a new name once, however many ways commit it before the snapshot shows it', () => {
    const names = createNameCommitter();
    expect(names.commit('Beta', 'Alpha')).toEqual({ kind: 'send', title: 'Beta' });
    // Enter, then blur, then Done.
    expect(names.commit('Beta', 'Alpha')).toEqual({ kind: 'keep' });
    expect(names.commit(' Beta ', 'Alpha')).toEqual({ kind: 'keep' });
  });

  it('commits a name again after it was changed elsewhere following its own commit', () => {
    const names = createNameCommitter();
    expect(names.commit('Beta', 'Alpha')).toEqual({ kind: 'send', title: 'Beta' });
    names.acknowledge('Beta');
    // Another window renames the link to Gamma; the user types Beta once more.
    names.edited();
    expect(names.commit('Beta', 'Gamma')).toEqual({ kind: 'send', title: 'Beta' });
  });

  it('is not held back by an acknowledged name even when the text was not touched since', () => {
    const names = createNameCommitter();
    names.commit('Beta', 'Alpha');
    names.acknowledge('Beta');
    expect(names.commit('Beta', 'Gamma')).toEqual({ kind: 'send', title: 'Beta' });
  });

  it('commits the typed name again after an edit, if the first send never showed up', () => {
    const names = createNameCommitter();
    expect(names.commit('Beta', 'Alpha')).toEqual({ kind: 'send', title: 'Beta' });
    names.edited();
    expect(names.commit('Beta', 'Alpha')).toEqual({ kind: 'send', title: 'Beta' });
  });

  it('keeps waiting for a name when the snapshot shows a different title', () => {
    const names = createNameCommitter();
    names.commit('Beta', 'Alpha');
    names.acknowledge('Delta');
    expect(names.commit('Beta', 'Delta')).toEqual({ kind: 'keep' });
  });

  it('ignores an untouched field, the saved title, and restores an emptied one', () => {
    const names = createNameCommitter();
    expect(names.commit(null, 'Alpha')).toEqual({ kind: 'keep' });
    expect(names.commit('Alpha', 'Alpha')).toEqual({ kind: 'keep' });
    expect(names.commit('   ', 'Alpha')).toEqual({ kind: 'restore' });
  });
});
