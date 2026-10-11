import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const THEME_DIR = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(`${path}/`);
    return /\.tsx?$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// A theme other than the document's own only paints once its sheet is attached, so a
// component that renders a scope must keep that theme's sheet registered while it does.
describe('nested theme scopes', () => {
  it('register their theme sheets wherever a scope is rendered', () => {
    const missing = sourceFiles(SRC)
      .filter((file) => !file.startsWith(THEME_DIR))
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(
        ({ source }) =>
          source.includes('getThemeScopeAttributes(') && !/\buseThemeSheets?\(/.test(source),
      )
      .map(({ file }) => file.slice(SRC.length));
    expect(missing).toEqual([]);
  });
});
