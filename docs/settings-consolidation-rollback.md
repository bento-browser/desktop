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
privacy tests against the staged `BackupStore`, builds all 14 Vite HTML
entries (including standalone Settings), and bundles the selected background
entry. Transition r1 keeps the current privacy and chrome experiment entries;
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
