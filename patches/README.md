# patches/

Surgical patches applied to the Firefox source tree by Surfer, for changes
that cannot be expressed via prefs, branding, or bundled extensions.
Implemented in **Phase 4** of the project plan.

Apply order:
1. `core-ui/` — URL bar, toolbars, menu items
2. `chrome-layout/` — window structure, panes, new containers
3. `experiments/` — temporary or high-risk patches

Patch format: `git format-patch` style files (`.patch`). Keep each patch small,
single-feature, and well-named so it can be skipped or rebased independently.

Patches are re-validated and likely re-applied for every Firefox version bump
([config/firefox-versions.json](../config/firefox-versions.json)).

See [docs/firefox-patches.md](../docs/firefox-patches.md) for the full
developer workflow, including adding a new patch and syncing to the latest
upstream Firefox release with `pnpm run firefox:sync`.
