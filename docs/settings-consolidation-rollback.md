# Settings consolidation rollback

The native-settings migration has a two-release rollback. Do not install the final legacy-only build directly over a consolidated profile.

The archived native mount was restored from the complete pre-native-settings
source at commit `b50d410e3179dce2544445795f40d8c2a447db85`. Its previous snapshot
contained truncated tool output rather than valid JavaScript; the preserved
beginning and end matched that historical source exactly.
That source intentionally has no native-settings IPC. The rollback migration
only adapts its chrome class names to the Bento-owned namespace and documents
the generated public Mux token projection; it does not replace the historical
mount with the current native-settings mount.

## Transition r1

`pnpm rollback:build-transition` builds tools `0.1.12` and shell `0.0.4` from the committed legacy source snapshot under `rollback/legacy-source/`. The tools entry first runs `GraphOperationRollbackAdapter`, which durably records `bento.rollbackTransition.v1`, blocks legacy startup, and checks the native graph journal, source cache, publication, session ledger, and operation registry.

Profiles with a nonterminal or ambiguous native operation remain on transition r1 in `blocked-corrupt`; legacy hydration does not start. Clean profiles remove native operational artifacts with storage set/get read-back, start the bundled legacy runtime, and reach locally inspectable `ready-for-final`. The transition add-on opens its packaged recovery page for both outcomes.

Transition browser/add-on updates are generated only with `pnpm rollback:updates-transition`. Transition r1 remains the supported recovery build for blocked profiles.

## Isolated Mux validation

The variant builder has a read-only `check` action for validating rollback
source against the current Mux dependency graph without changing the engine,
canonical `dist/`, or the worktree's installed extensions. Use the project's
Node 24.19 runtime and installed dependencies:

```sh
node scripts/build-rollback-variant.mjs rollback-transition-r1 check
node scripts/build-rollback-variant.mjs rollback-final-r2 check
```

Each check stages the current shell, tools, and shared protocol into a
temporary directory, overlays the rollback sources, and uses the repository's
existing `node_modules` through a temporary symlink. It typechecks the shell,
the staged tools entry, and the transition entry, runs the existing backup
privacy tests against the staged `BackupStore`, builds the 13 Vite HTML
entries (including standalone Settings), confirms the plain `panel-newtab.html`
page and its `assets/panel-newtab.css` were emitted, and bundles the selected
background entry. The archived Vite config does not list `panel-newtab` as an
entry: it is the live `public/` page, and the archived config imports the live
`panel-newtab-css.ts` plugin that emits its stylesheet. Transition r1 keeps the current privacy and chrome experiment entries;
final r2 uses the legacy tools manifest, removes the native-preferences and
chrome-bridge experiment files from the staged tree, and requires the archived
native mount to pass `node --check`.

The check intentionally leaves its printed `isolatedRoot` and generated
outputs in place for follow-on runtime verification; the caller owns cleanup
after collecting that evidence. The check proves extension source and
packaging inputs only. It does not claim a fresh C++/Firefox engine build, a
full final-engine rollout, signing, or publication. A successful check prints
`rollback-check.json` beside its temporary staged output for review.

## Final r2

After a transition profile reports `ready-for-final`, invoke the explicit prepare-final action on the transition recovery page. It repeats the zero check, removes the transition marker with read-back, and instructs the user to shut down Bento immediately so the staged profile cannot mutate again before final installation.

Build the manual/staged final artifact with `pnpm rollback:build-final`, `rollback:package-final`, or `rollback:release-final`. Final r2 uses tools `0.1.13`, shell `0.0.5`, restores the standalone Settings runtime, removes patch 15 and the native experiments from the staged package, and restores the pre-consolidation mount overlay. The variant builder restores the developer worktree and replayed engine afterward.

No command generates a final-r2 automatic update. If preparation was skipped or Bento restarted before installation, reinstall transition r1 and repeat the gate.

## Mux dependency validation

Both supported rollback variants compile their archived React source against
the same exact published `@muxui/react` npm dependency as the normal shell. The
archive keeps rollback behavior and Settings routes; it uses the current public
Mux Text sizes (`sm`, `md`, `lg`). Run each isolated check after a UI package
upgrade. These checks create temporary source/build directories and report their
paths without importing into the developer engine:

```sh
node scripts/build-rollback-variant.mjs rollback-transition-r1 check
node scripts/build-rollback-variant.mjs rollback-final-r2 check
```

## Security parity

The rollback variants overlay archived sources on the current tree, so they
share the current experiments and `_shared` code but carry their own mount
script and tools background. Security fixes to those two files must be applied
to the archive too, then both `check` actions above rerun.

Applied to both variants (the archived mount and tools background carry the same
change as the current files):

- Clipboard suggestion gate: the empty new-tab address open reads the clipboard
  only while `browser.urlbar.suggest.clipboard` is true (a missing pref takes
  Firefox's default, true; a wrong-typed pref disables the read).
- Add-panel grant: the Add panel button creates
  `about:blank?bento_add_as_panel=<token>` and a one-time grant on the native tab;
  the archived tools background consumes it through
  `bentoPrivacy.consumeAddPanelGrant` (current experiment, present in both
  tools manifests) via `src/panels/AddPanelGrant.ts` from the current tree. A
  page-supplied `bento_add_as_panel=1` URL no longer makes a panel.
- Dev-only reload: the archived shell `background.ts` registers the `dev-reload`
  command handler only `if (__BENTO_DEV_RELOAD__)`, like the current one. Release
  builds define the flag `false` and the installer drops the command from the
  archived manifest, so rollback releases do not ship Alt+Shift+R. `check` builds
  in release mode and fails if the archived bundle still has the handler. The
  `build` and `package` actions run in dev mode unless the build is a release
  build (`BENTO_RELEASE=1`, `BENTO_BUILD_MODE=release`, or `build.mode: "release"`
  in `bento.json`); `release` always goes through `build-release.sh`. `package`
  imports fresh extensions without rebuilding native output, so an object
  directory from an earlier dev build can still hold the command. Both `package`
  and `release` end in the driver's `package` command, which in a release build
  scans the object directory's shell add-on (following symlinks) and refuses to
  package it while `dev-reload` is there; rebuild natively (`pnpm run build`)
  to clear it. See
  [docs/build-tooling.md](build-tooling.md#dev-only-reload-command).

Not applied (the archived tools background still lacks it):

- Shell port validation (`parseWireAction` and the window-existence check in
  `createShellActionIntake`). The archived `port.onMessage` handler still casts
  each message to `WireAction` and trusts `__windowId`. Porting is a listener
  swap, but the archived mount and shell dispatch sites need a runtime pass
  against `ACTION_FIELDS` first, so it was left out of the clipboard and
  add-panel parity change. Until then, a rollback build is only as hardened as
  the extension-origin boundary described in the audit (S-07).

When a security fix lands in `bento-shell-mount.js` or `bento-tools/src/background.ts`,
check whether the same code exists under `rollback/legacy-source/` before
releasing a rollback build.
