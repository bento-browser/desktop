// Build guard for the React context-identity defect that `manualChunks` once
// papered over: a second copy of a React Aria module carries its own
// module-level contexts (for example `SubmenuTriggerContext`), so a parent
// `Menu` from one copy never reaches a `Menu.Submenu` consumer from the other
// and the kebab menu throws on open.
//
// Rollup places every module id in exactly one chunk, so the chunk check below
// only trips if a plugin or output option starts duplicating modules. The
// install-root check is the one that catches the original defect class: the
// same package bundled from two directories (nested install, symlink, local Mux
// checkout) yields two ids and therefore two sets of contexts.

import type { Plugin } from 'vite';

/** Packages whose module-level state must exist exactly once in a bundle. */
const SINGLE_COPY_PACKAGE =
  /^(react|react-dom|scheduler|react-aria|react-aria-components|react-stately|@react-aria\/.+|@react-stately\/.+|@react-types\/.+|@internationalized\/.+)$/;

export interface ChunkModules {
  fileName: string;
  moduleIds: string[];
}

/**
 * `/x/node_modules/@scope/pkg/dist/a.mjs?v=1` becomes the package name and its install root.
 * Plugin-virtual ids (a leading `\0`, a `?commonjs-*` query) map to the file they wrap.
 */
export function packageOf(moduleId: string): { name: string; root: string } | undefined {
  const path = moduleId.replace(/^\0/, '').split('?')[0]!.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const markerAt = path.lastIndexOf(marker);
  if (markerAt < 0) return undefined;
  const parts = path.slice(markerAt + marker.length).split('/');
  const name = parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return { name, root: `${path.slice(0, markerAt + marker.length)}${name}` };
}

/** Describes every module or package that the bundle contains more than once. */
export function findDuplicateModules(chunks: ChunkModules[]): string[] {
  const problems: string[] = [];
  const chunkOfModule = new Map<string, string>();
  const rootsByPackage = new Map<string, Set<string>>();

  for (const { fileName, moduleIds } of chunks) {
    for (const id of moduleIds) {
      const firstChunk = chunkOfModule.get(id);
      if (firstChunk === undefined) chunkOfModule.set(id, fileName);
      else if (firstChunk !== fileName) {
        problems.push(`${id} is in both ${firstChunk} and ${fileName}`);
      }

      const pkg = packageOf(id);
      if (!pkg || !SINGLE_COPY_PACKAGE.test(pkg.name)) continue;
      const roots = rootsByPackage.get(pkg.name) ?? new Set<string>();
      roots.add(pkg.root);
      rootsByPackage.set(pkg.name, roots);
    }
  }

  for (const [name, roots] of rootsByPackage) {
    if (roots.size > 1) problems.push(`${name} is bundled from ${[...roots].join(' and ')}`);
  }
  return problems;
}

/** Fails the build when a context-bearing package would exist twice in the output. */
export function moduleIdentityGuard(): Plugin {
  return {
    name: 'bento-module-identity-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk'
          ? [
              {
                fileName: output.fileName,
                moduleIds: Object.entries(output.modules)
                  .filter(([, module]) => module.renderedLength > 0)
                  .map(([id]) => id),
              },
            ]
          : [],
      );
      const problems = findDuplicateModules(chunks);
      if (problems.length > 0) {
        this.error(
          `Duplicate module identity would split React contexts:\n  ${problems.join('\n  ')}\n` +
            'Keep one install of each package and the resolve.alias entries in vite.config.ts.',
        );
      }
    },
  };
}
