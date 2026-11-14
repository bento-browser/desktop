// Invariants every shell document entry has to keep. They are source checks
// because each entry is a side-effecting module that mounts into a real document.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOOLS_FAMILIES, type ToolsFamily } from './bridge/useToolsPort';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const SHARED = fileURLToPath(new URL('../../_shared/', import.meta.url));

/** Entry directory -> OverlayName it announces (bridge/overlayReady.ts). Chrome
 * creates these documents lazily, so each must announce when it can receive an open. */
const OVERLAY_ENTRIES: Record<string, string> = {
  palette: 'palette',
  'workspace-palette': 'workspace-palette',
  'merge-palette': 'merge-palette',
  'settings-palette': 'settings-palette',
  bookmarks: 'bookmarks',
  'bookmarks-popup': 'bookmarks-popup',
  'address-bar': 'addrbar',
  'workspace-layers': 'workspace-layers',
  welcome: 'welcome',
  menu: 'menu',
  'panel-navigator-tooltip': 'panel-navigator-tooltip',
};

const TOOLS_PORT = join(SRC, 'bridge', 'useToolsPort.ts');

/** Store module -> the tools family that feeds it. */
const STORE_FAMILY = new Map<string, ToolsFamily>(
  Object.entries({
    tabs: 'tabs',
    workspaces: 'workspaces',
    settings: 'settings',
    panels: 'panels',
    pinnedPanels: 'pinnedPanels',
    tabFolders: 'tabFolders',
    savedPanels: 'savedPanels',
    bookmarks: 'bookmarks',
    privacy: 'privacy',
    searchEngines: 'searchEngines',
    addressBar: 'addrbar',
    panelFocus: 'panelFocus',
    externalMerge: 'externalMerge',
  } satisfies Record<string, ToolsFamily>).map(([name, family]) => [
    join(SRC, 'state', `${name}.ts`),
    family,
  ]),
);

/** Reads a source file, or null when it does not exist. The negative tests pass
 * in-memory modules in front of the disk. */
type ReadSource = (path: string) => string | null;

const readDisk: ReadSource = (path) => {
  // Read directly instead of checking first: a missing file or a directory throws.
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function parse(path: string, source: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
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

/** The sidebar entry and every `<dir>/main.tsx`, relative to src. */
function entryFiles(): string[] {
  return ['main.tsx', ...entryDirectories().map((d) => join(d, 'main.tsx'))];
}

/** The families an entry passes to its single `initToolsPort({ families: [...] })`
 * call. Throws when the call is missing (commented out counts), repeated, or not
 * an array literal of strings, because then the declaration cannot be checked. */
function declaredFamilies(file: ts.SourceFile): string[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'initToolsPort'
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const [call, ...extra] = calls;
  if (!call || extra.length > 0)
    throw new Error(`${file.fileName}: expected one initToolsPort call, found ${calls.length}`);
  const [options] = call.arguments;
  const families =
    options && ts.isObjectLiteralExpression(options) && call.arguments.length === 1
      ? options.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'families',
        )?.initializer
      : undefined;
  if (
    !families ||
    !ts.isArrayLiteralExpression(families) ||
    !families.elements.every(ts.isStringLiteralLike)
  )
    throw new Error(
      `${file.fileName}: initToolsPort needs { families: [...] } with an array of string literals`,
    );
  return families.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
}

/** Specifiers a module loads at runtime: static imports and re-exports that are
 * not `import type`/`export type`, and `import('literal')`. */
function runtimeSpecifiers(file: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

/** Resolves a relative or aliased (@bento, @shared) source import to a file. */
function resolveImport(from: string, request: string, readSource: ReadSource): string | null {
  // Vite query suffixes ('?no-inline', '?url') name the same file.
  const specifier = request.replace(/\?.*$/, '');
  let base: string;
  if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else if (specifier.startsWith('@bento/')) base = join(SRC, specifier.slice('@bento/'.length));
  else if (specifier.startsWith('@shared/'))
    base = join(SHARED, specifier.slice('@shared/'.length));
  else return null;
  // TypeScript and Vite resolve a '.js' specifier to its '.ts'/'.tsx' source.
  const stem = base.replace(/\.(?:m?js|jsx)$/, '');
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  const found = candidates.find((candidate) => readSource(candidate) !== null);
  // An unresolved local import would hide the stores behind it.
  if (!found) throw new Error(`entries guard: cannot resolve ${specifier} from ${from}`);
  return found;
}

/** Every source module an entry loads at runtime. The tools port itself is not
 * followed: it imports every store to feed them. */
function reachableModules(entry: string, readSource: ReadSource): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (path === TOOLS_PORT || !/\.tsx?$/.test(path)) continue;
    const source = readSource(path);
    if (source === null) continue;
    for (const specifier of runtimeSpecifiers(parse(path, source))) {
      const resolved = resolveImport(path, specifier, readSource);
      if (resolved) pending.push(resolved);
    }
  }
  return seen;
}

/** What an entry declares to initToolsPort and the families its import graph
 * reaches, both sorted. */
function entryFamilies(
  entry: string,
  readSource: ReadSource = readDisk,
): { declared: string[]; reached: string[] } {
  const source = readSource(entry);
  if (source === null) throw new Error(`${entry}: not found`);
  const declared = declaredFamilies(parse(entry, source));
  const reached = new Set(
    [...reachableModules(entry, readSource)]
      .map((module) => STORE_FAMILY.get(module))
      .filter((family) => family !== undefined),
  );
  return { declared: declared.sort(), reached: [...reached].sort() };
}

describe('shell document entries', () => {
  it('finds the overlay entries this test lists', () => {
    const directories = entryDirectories();
    for (const name of Object.keys(OVERLAY_ENTRIES)) expect(directories).toContain(name);
  });

  // Each document mirrors only the tools families its entry passes to initToolsPort
  // (bridge/useToolsPort.ts); every other store stays empty. A component reading a
  // store its document does not mirror would show empty data, and a document that
  // mirrors a store nothing reads pays for it per open tab. So the families must be
  // exactly the tools-fed stores the entry's import graph reaches. The theme hooks
  // read workspaces and settings, so any entry that themes itself joins the bus.
  it.each(entryFiles())('mirrors exactly the stores %s reaches', (file) => {
    const { declared, reached } = entryFamilies(join(SRC, file));
    expect(declared, file).toEqual(reached);
  });

  describe('family check', () => {
    const ENTRY = join(SRC, '__fixture-entry__', 'main.tsx');
    const withEntry =
      (source: string): ReadSource =>
      (path) =>
        path === ENTRY ? source : readDisk(path);

    it('follows a .js store specifier and rejects an unresolved local import', () => {
      const viaJs = entryFamilies(
        ENTRY,
        withEntry(
          "import { useTabsStore } from '../state/tabs.js';\ninitToolsPort({ families: [] });\n",
        ),
      );
      expect(viaJs.reached).toContain('tabs');
      expect(() =>
        entryFamilies(
          ENTRY,
          withEntry("import { x } from '../state/missing';\ninitToolsPort({ families: [] });\n"),
        ),
      ).toThrow(/cannot resolve/);
    });

    it('follows a double-quoted store import the declaration leaves out', () => {
      const tabsImport = 'import { useTabsStore } from "../state/tabs";\n';
      const missing = entryFamilies(
        ENTRY,
        withEntry(`${tabsImport}initToolsPort({ families: [] });\n`),
      );
      expect(missing.reached).toContain('tabs');
      expect(missing.declared).not.toEqual(missing.reached);
      // Declaring what the store graph reaches passes, so the check is not vacuous.
      const declared = JSON.stringify(missing.reached).replaceAll('"', "'");
      const complete = entryFamilies(
        ENTRY,
        withEntry(`${tabsImport}initToolsPort({ families: ${declared} });\n`),
      );
      expect(complete.declared).toEqual(complete.reached);
    });

    it('follows dynamic imports and skips type-only ones', () => {
      const { reached } = entryFamilies(
        ENTRY,
        withEntry(
          [
            "import type { TabsState } from '../state/tabs';",
            "export type { PanelsState } from '../state/panels';",
            "void import('../state/bookmarks');",
            "initToolsPort({ families: ['bookmarks'] });",
          ].join('\n'),
        ),
      );
      expect(reached).toEqual(['bookmarks']);
    });

    it.each([
      ['commented out', "// initToolsPort({ families: ['workspaces'] });"],
      [
        'called twice',
        "initToolsPort({ families: ['workspaces'] });\ninitToolsPort({ families: ['tabs'] });",
      ],
      ['not a literal', 'initToolsPort({ families: FAMILIES });'],
      ['not string literals', "initToolsPort({ families: ['workspaces', name] });"],
    ])('rejects an initToolsPort call that is %s', (_case, source) => {
      expect(() => entryFamilies(ENTRY, withEntry(source))).toThrow(/initToolsPort/);
    });
  });

  it('maps every store the tools port feeds to one family', () => {
    const stores = runtimeSpecifiers(parse(TOOLS_PORT, read(TOOLS_PORT)))
      .map((specifier) => resolveImport(TOOLS_PORT, specifier, readDisk))
      .filter((path) => path !== null && dirname(path) === join(SRC, 'state'));
    expect(stores.sort()).toEqual([...STORE_FAMILY.keys()].sort());
    expect([...STORE_FAMILY.values()].sort()).toEqual([...TOOLS_FAMILIES].sort());
  });

  it.each(Object.entries(OVERLAY_ENTRIES))(
    'announces readiness from the %s overlay entry',
    (directory, overlay) => {
      const source = read(join(SRC, directory, 'main.tsx'));
      expect(source).toContain(`useOverlayReadySignal('${overlay}')`);
    },
  );
});
