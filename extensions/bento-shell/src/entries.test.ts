// Invariants every shell document entry has to keep. They are source checks
// because each entry is a side-effecting module that mounts into a real document.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** Entry directory -> OverlayName it announces (bridge/overlayReady.ts). Chrome
 * creates these documents lazily, so each must announce when it can receive an open. */
const OVERLAY_ENTRIES: Record<string, string> = {
  palette: 'palette',
  'workspace-palette': 'workspace-palette',
  'merge-palette': 'merge-palette',
  'address-bar': 'addrbar',
  confirm: 'confirm',
  'edit-workspace': 'edit-workspace',
  welcome: 'welcome',
  'workspace-switcher': 'workspace-switcher',
  menu: 'menu',
  'panel-navigator-tooltip': 'panel-navigator-tooltip',
};

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function entryDirectories(): string[] {
  return readdirSync(SRC).filter((name) => {
    try {
      return statSync(join(SRC, name, 'main.tsx')).isFile();
    } catch {
      return false;
    }
  });
}

describe('shell document entries', () => {
  it('finds the overlay entries this test lists', () => {
    const directories = entryDirectories();
    for (const name of Object.keys(OVERLAY_ENTRIES)) expect(directories).toContain(name);
  });

  it('joins the shell bus in every entry that applies the workspace theme', () => {
    // useWorkspaceTheme and useFirefoxTheme read the workspace and settings
    // mirrors. A document that never calls initToolsPort() leaves them empty and
    // keeps the Default theme and the color mode from boot (the old tooltip).
    const entries = [
      join(SRC, 'main.tsx'),
      ...entryDirectories().map((d) => join(SRC, d, 'main.tsx')),
    ];
    for (const file of entries) {
      const source = read(file);
      if (!source.includes('useWorkspaceTheme(')) continue;
      expect(source, file).toContain('initToolsPort()');
    }
  });

  it.each(Object.entries(OVERLAY_ENTRIES))(
    'announces readiness from the %s overlay entry',
    (directory, overlay) => {
      const source = read(join(SRC, directory, 'main.tsx'));
      expect(source).toContain(`useOverlayReadySignal('${overlay}')`);
    },
  );
});
