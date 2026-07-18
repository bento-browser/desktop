# Settings consolidation rollback

The native-settings migration has a two-release rollback. Do not install the final legacy-only build directly over a consolidated profile.

## Transition r1

`pnpm rollback:build-transition` builds tools `0.1.12` and shell `0.0.4` from the committed legacy source snapshot under `rollback/legacy-source/`. The tools entry first runs `GraphOperationRollbackAdapter`, which durably records `bento.rollbackTransition.v1`, blocks legacy startup, and checks the native graph journal, source cache, publication, session ledger, and operation registry.

Profiles with a nonterminal or ambiguous native operation remain on transition r1 in `blocked-corrupt`; legacy hydration does not start. Clean profiles remove native operational artifacts with storage set/get read-back, start the bundled legacy runtime, and reach locally inspectable `ready-for-final`. The transition add-on opens its packaged recovery page for both outcomes.

Transition browser/add-on updates are generated only with `pnpm rollback:updates-transition`. Transition r1 remains the supported recovery build for blocked profiles.

## Final r2

After a transition profile reports `ready-for-final`, invoke the explicit prepare-final action on the transition recovery page. It repeats the zero check, removes the transition marker with read-back, and instructs the user to shut down Bento immediately so the staged profile cannot mutate again before final installation.

Build the manual/staged final artifact with `pnpm rollback:build-final`, `rollback:package-final`, or `rollback:release-final`. Final r2 uses tools `0.1.13`, shell `0.0.5`, restores the standalone Settings runtime, removes patch 15 and the native experiments from the staged package, and restores the pre-consolidation mount overlay. The variant builder restores the developer worktree and replayed engine afterward.

No command generates a final-r2 automatic update. If preparation was skipped or Bento restarted before installation, reinstall transition r1 and repeat the gate.
