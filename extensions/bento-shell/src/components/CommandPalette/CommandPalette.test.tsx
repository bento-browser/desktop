import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BentoSettings } from '@shared/protocol';
import { DEFAULT_FIXTURE } from '../../state/__fixtures__/settings';
import { useCommands } from './CommandPalette';

const state = vi.hoisted(() => ({
  settings: null as BentoSettings | null,
  isPrivate: false,
}));
vi.mock('../../bridge/useToolsPort', () => ({ dispatch: vi.fn(), useCurrentWindowId: () => 1 }));
vi.mock('../../bridge/chromeTitle', () => ({ sendChromeTitle: vi.fn() }));
vi.mock('../../state/privateWindow', () => ({ usePrivateWindow: () => state.isPrivate }));
vi.mock('../../state/settings', () => ({
  useSettingsStore: (selector: (value: { current: BentoSettings | null }) => unknown) =>
    selector({ current: state.settings }),
}));

/** The ids of the commands the palette offers for an empty query. */
function Commands() {
  return (
    <>
      {useCommands('')
        .map((command) => command.id)
        .join(' ')}
    </>
  );
}
const render = () => renderToStaticMarkup(<Commands />);

beforeEach(() => {
  state.settings = { ...DEFAULT_FIXTURE };
  state.isPrivate = false;
});

describe('the Open Bookmarks command', () => {
  it('shows while the Bookmarks manager is on, also before settings have arrived', () => {
    expect(render()).toContain('nav:bookmarks');
    state.settings = null;
    expect(render()).toContain('nav:bookmarks');
  });

  it('is hidden while the Bookmarks manager is off, and in a private window', () => {
    state.settings = { ...DEFAULT_FIXTURE, bookmarksEnabled: false };
    expect(render()).not.toContain('nav:bookmarks');
    state.settings = { ...DEFAULT_FIXTURE };
    state.isPrivate = true;
    expect(render()).not.toContain('nav:bookmarks');
  });
});
