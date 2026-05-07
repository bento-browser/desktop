// pnpm install hook — toggles Tale UI between local link and npm pin.
//
// Default (no env): rewrite @tale-ui/* deps to point at the local Tale UI
// checkout at /Users/admin/Projects/tale-ui/core/packages/* via the same
// `link:` paths the project used before R-1. This is what every developer
// gets, so source edits in tale-ui hot-reload into Bento exactly as before.
//
// BENTO_RELEASE=1: leave the npm-pinned versions in package.json untouched.
// Release CI (scripts/build-release.sh, GitHub Actions) sets this so the
// install pulls @tale-ui/* from the npm registry — byte-reproducible
// across machines, no working-tree dependency. See CLAUDE.md
// "Tale UI: development → release migration" for the full rationale.
//
// Why a hook instead of pnpm.overrides in package.json: overrides are
// global and there's no built-in way to disable them per-install. A
// readPackage hook lets us condition on env so the same lockfile + the
// same package.json work for both flows.

const path = require('path');

// Resolve absolute path to the local Tale UI checkout. Anchored on this
// file so pnpm running from any cwd inside the workspace finds it.
const TALE_UI_ROOT = path.resolve(__dirname, '..', 'tale-ui', 'core', 'packages');

// Map @tale-ui/* package names → local subdirectory under TALE_UI_ROOT.
// The /react entry points to packages/react/build (the compiled output)
// because the source-only package contains TS that Vite stumbles on for
// some peer deps; same path Bento was using before R-1.
const TALE_UI_LINKS = {
  '@tale-ui/core': path.join(TALE_UI_ROOT, 'css'),
  '@tale-ui/react': path.join(TALE_UI_ROOT, 'react', 'build'),
  '@tale-ui/react-styles': path.join(TALE_UI_ROOT, 'styles'),
  '@tale-ui/utils': path.join(TALE_UI_ROOT, 'utils'),
};

function rewriteTaleUiDeps(pkg) {
  if (!pkg.dependencies) return pkg;
  for (const name of Object.keys(TALE_UI_LINKS)) {
    if (pkg.dependencies[name]) {
      pkg.dependencies[name] = `link:${TALE_UI_LINKS[name]}`;
    }
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      // Only rewrite our own workspace packages — never tinker with deps
      // of third-party packages. Identifying by `@bento/*` keeps the hook
      // narrow and predictable.
      if (pkg.name && pkg.name.startsWith('@bento/')) {
        if (process.env.BENTO_RELEASE !== '1') {
          return rewriteTaleUiDeps(pkg);
        }
      }
      return pkg;
    },
  },
};
