// Local Mux UI development mode.
//
// MUXUI_LOCAL points at a local Mux checkout's `packages/react`. While it is set,
// the shell and Ladle Vite configs resolve every public `@muxui/react` export
// from that checkout's generated output instead of the published npm package.
// Releases never use it: this module throws in release mode, the shell build
// stamps `dist/muxui-source.json`, and packaging rejects any non-npm stamp.
// See docs/build-tooling.md, "Local Mux UI".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isReleaseBuild } from '../../scripts/build-mode.mjs';

export const MUX_PACKAGE = '@muxui/react';
export const MUX_SOURCE_STAMP = 'muxui-source.json';

// The repository whose bento.json decides the build mode. fileURLToPath rather than
// import.meta.dirname: Vite bundles its config and rewrites import.meta.url per module.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates MUXUI_LOCAL without requiring generated output, so a dev loop can run
 * Mux generate first. Returns the package root, or undefined when unset. Throws in a
 * release build as scripts/build-mode.mjs defines it, including `build.mode:
 * "release"` in the repository's bento.json.
 */
export function muxLocalRoot(env = process.env, repoRoot = REPO_ROOT) {
  const root = env.MUXUI_LOCAL;
  if (!root) return undefined;
  if (isReleaseBuild(repoRoot, env)) {
    throw new Error(
      'MUXUI_LOCAL is set during a release build (BENTO_RELEASE=1, BENTO_BUILD_MODE=release, ' +
        'or build.mode "release" in bento.json). ' +
        'Releases use only the published npm @muxui/react; unset MUXUI_LOCAL.',
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`MUXUI_LOCAL must be an absolute path, got "${root}".`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`MUXUI_LOCAL "${root}" has no readable package.json (${error.message}).`);
  }
  if (manifest.name !== MUX_PACKAGE) {
    throw new Error(
      `MUXUI_LOCAL "${root}" is package "${manifest.name}", expected "${MUX_PACKAGE}". ` +
        "Point it at Mux's packages/react directory.",
    );
  }
  return root;
}

/**
 * Resolves the local Mux checkout for Vite and the type check, or undefined in
 * npm mode. Aliases are exact-match regexes, one per public export in the local
 * `package.json` exports map; a prefix alias would rewrite subpaths such as
 * `@muxui/react/themes` into `<entry>/themes`.
 */
export function resolveMuxLocal(env = process.env, repoRoot = REPO_ROOT) {
  const root = muxLocalRoot(env, repoRoot);
  if (root === undefined) return undefined;
  if (!fs.existsSync(path.join(root, 'generated', 'index.mjs'))) {
    throw new Error(
      `MUXUI_LOCAL "${root}" has no generated/index.mjs. Run Mux generate, or use a *:mux ` +
        'script, which generates first.',
    );
  }
  const { exports } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const aliases = [];
  /** @type {Record<string, string>} */
  const types = {};
  for (const [key, target] of Object.entries(exports ?? {})) {
    if (key !== '.' && !key.startsWith('./')) {
      throw new Error(`MUXUI_LOCAL exports key "${key}" is not a package subpath.`);
    }
    const specifier = key === '.' ? MUX_PACKAGE : `${MUX_PACKAGE}/${key.slice(2)}`;
    const entry = typeof target === 'string' ? { default: target } : target;
    if (typeof entry.default !== 'string') {
      throw new Error(`MUXUI_LOCAL export "${key}" has no default target.`);
    }
    for (const file of [entry.default, entry.types]) {
      if (file !== undefined && !fs.existsSync(path.resolve(root, file))) {
        throw new Error(`MUXUI_LOCAL export "${key}" points at missing ${file}; run Mux generate.`);
      }
    }
    aliases.push({
      find: new RegExp(`^${escapeRegExp(specifier)}$`),
      replacement: path.resolve(root, entry.default),
    });
    if (entry.types !== undefined) types[specifier] = path.resolve(root, entry.types);
  }
  if (aliases.length === 0) throw new Error(`MUXUI_LOCAL "${root}" has no package exports.`);
  return { root, aliases, types };
}

/**
 * Vite config fragment for local mode; empty in npm mode. Setting server.fs.allow
 * replaces Vite's default, so the workspace root stays listed beside the Mux
 * package root (generated CSS loads fonts from the package's assets/). React and
 * React DOM resolve from Bento so Mux shares its React instance. React Aria
 * aliases stay in each Vite config so both sides share one React Aria. Mux's own
 * lucide, motion, tiptap, and shiki resolve from the Mux checkout.
 */
export function muxLocalViteConfig(mux, workspaceRoot) {
  if (!mux) return {};
  return {
    resolve: { alias: mux.aliases, dedupe: ['react', 'react-dom'] },
    server: { fs: { allow: [workspaceRoot, mux.root] } },
  };
}

/**
 * Shell-build plugin that records which Mux the bundle was built from, so
 * packaging can refuse anything but the published npm package.
 */
export function muxSourcePlugin(mux, npmPackageJson) {
  return {
    name: 'bento-muxui-source',
    apply: 'build',
    generateBundle() {
      const stamp = mux
        ? { source: 'local' }
        : { source: 'npm', version: JSON.parse(fs.readFileSync(npmPackageJson, 'utf8')).version };
      this.emitFile({
        type: 'asset',
        fileName: MUX_SOURCE_STAMP,
        source: `${JSON.stringify(stamp)}\n`,
      });
    },
  };
}

/** Stamp the rollback script gives the archived shell, whose Vite config cannot stamp itself. */
export function rollbackMuxStamp(variant) {
  return { source: 'rollback', variant };
}

/**
 * Throws unless `text` (the contents of a packaged `muxui-source.json`, or
 * undefined when absent) allows shipping. Without a rollback variant only the
 * published npm package is allowed; with one, only that variant's own stamp.
 * `where` names the inspected location for the error message.
 */
export function assertMuxSourceStamp(text, { where, variant, variants }) {
  if (variant !== undefined && !variants.includes(variant)) {
    throw new Error(
      `BENTO_RELEASE_VARIANT "${variant}" is not a rollback variant (${variants.join(', ')}).`,
    );
  }
  const expected = variant === undefined ? 'the published npm @muxui/react' : `${variant}`;
  const fix =
    variant === undefined
      ? 'Unset MUXUI_LOCAL, then rebuild (pnpm run ext:build), re-import (pnpm run import), and rebuild the native resources (pnpm run build) before packaging.'
      : 'Rebuild the variant (pnpm run rollback:build-*) so its archived shell is imported and built natively.';
  let stamp;
  if (text === undefined) {
    throw new Error(`${where} is missing, so the shell's Mux source is unknown. ${fix}`);
  }
  try {
    stamp = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not valid JSON. ${fix}`);
  }
  const allowed =
    variant === undefined
      ? stamp?.source === 'npm'
      : stamp?.source === 'rollback' && stamp.variant === variant;
  if (!allowed) {
    throw new Error(
      `${where} says the shell was built from ${JSON.stringify(stamp)}; expected ${expected}. ${fix}`,
    );
  }
}

/**
 * Generated tsconfig that type-checks the shell against the local Mux public
 * declarations. `paths` replaces tsconfig.base.json's list, so @shared is repeated.
 */
export function muxLocalTsconfig(mux) {
  return {
    extends: './tsconfig.json',
    compilerOptions: {
      paths: {
        '@shared/*': ['../_shared/*'],
        ...Object.fromEntries(
          Object.entries(mux.types).map(([specifier, file]) => [specifier, [file]]),
        ),
      },
    },
  };
}
