# Mach build hang — investigation plan

## 2026-05-10 status check

This plan describes a real failure mode, but parts of it are now stale:

- `patches/chrome-layout/04-bento-key-actors.patch` exists and is applied to `engine/browser/actors/moz.build`.
- The BentoKey actor files are currently present in the built app:
  - `engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/Resources/browser/actors/BentoKeyChild.sys.mjs`
  - `engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/Resources/browser/actors/BentoKeyParent.sys.mjs`
- That means the original Phase 4c blocker, "manual cp actor files into the dist bundle", is not currently blocking this checkout.
- `scripts/reset-engine-patches.sh` now exists and is safer than the raw `git -C engine checkout -- .` step below because it only resets files touched by Bento patches.

Before doing the destructive reset steps in Phase 1, first re-check whether the hang still reproduces. If `npm run build` completes, archive this as historical context rather than active work.

## Quick decision tree

Use this before starting the full investigation.

1. Check whether the actor files are already in the app bundle:

   ```sh
   find engine/obj-*/dist -path '*BentoKey*.sys.mjs' -print
   ```

2. Run the normal product build:

   ```sh
   npm run build
   ```

3. Interpret the result:
   - If `npm run build` completes and `Bento.app/.../browser/actors/BentoKey*.sys.mjs` exists, this plan is historical. Do not run destructive reset steps.
   - If `npm run build` appears to succeed but the actors are missing, suspect Surfer/mach output filtering or stale dist state. Follow "Raw mach debugging recipe".
   - If `npm run build` hangs, follow Phase 1 capture before killing anything.
   - If only direct `./mach build` fails with `tomllib`, that is the separate Python 3.9 issue documented below, not the zombie hang.

## Symptom

`./mach build` (and therefore `npm run build`) hangs indefinitely at startup. The Python process consumes 0% CPU, has no live children, and never produces output. A defunct (zombie) child process appears in `ps`.

An earlier debugging pass tried invoking `./mach build` directly instead of `npm run build` / `surfer build` to get raw mach output without Surfer's wrapping or log filtering. That direct path also hung or failed silently, so the problem was not just npm or Surfer swallowing output.

During the original failed session this blocked Phase 4c's actor packaging, and the workaround was to manually `cp` the actor files into the dist bundle. As of the 2026-05-10 status check above, the actor files are present in `Bento.app`, so that workaround is historical unless the hang reproduces again and the actors disappear from a fresh build.

## Investigation timeline

Chronological account of what was tried during the original session, with what each step revealed and why it failed. Recorded in detail because the failure modes layered on top of each other and several were red herrings — future sessions should know which signals are real and which are environment artefacts.

### 1. Phase 4c first attempt: actor at chrome:// URI

Goal: register a JSWindowActor pair (`BentoKey{Child,Parent}.sys.mjs`) so content keys (Vimium j/k, ←/→ panel cycling) work while content has focus.

- Files placed at `src/browser/base/content/BentoKey{Child,Parent}.sys.mjs`.
- Registration in `bento-shell-mount.js`: `esModuleURI: 'chrome://browser/content/BentoKey{Child,Parent}.sys.mjs'`.
- Patch `01-bento-shell-mount.patch` extended to add `content/browser/BentoKeyChild.sys.mjs (content/BentoKeyChild.sys.mjs)` to `browser/base/jar.mn`.
- Build succeeded, files appeared at `Bento.app/.../browser/chrome/browser/content/browser/BentoKey*.sys.mjs`.
- **Browser console error: `Error: Failed to load chrome://browser/content/BentoKeyChild.sys.mjs`** when ←/→ pressed.

Diagnosis: surveyed `engine/browser/components/`. Every Firefox-shipped JSWindowActor uses `resource:///actors/...`, never `chrome://`. The `chrome://` scheme works for normal scripts and CSS but the ESM actor loader has a stricter URI policy that rejects content-accessible chrome:// resources.

### 2. Move to resource:///actors/

- Moved files: `src/browser/base/content/BentoKey*.sys.mjs` → `src/browser/actors/BentoKey*.sys.mjs`.
- Updated `bento-shell-mount.js` registration to `resource:///actors/BentoKey{Child,Parent}.sys.mjs`.
- Reverted the new jar.mn entries from `01-bento-shell-mount.patch` (back to its pre-Phase-4c contents).
- Created `patches/chrome-layout/04-bento-key-actors.patch` that adds `BentoKey{Child,Parent}.sys.mjs` to `FINAL_TARGET_FILES.actors` in `browser/actors/moz.build`. This is how Firefox's own actors land at `resource:///actors/`.
- `surfer import` applied all 5 patches cleanly. `engine/browser/actors/BentoKey*.sys.mjs` correctly appeared as symlinks to `src/browser/actors/`.

### 3. The build started failing silently

`npm run build` reported exit 0 but:

- `Bento.app/.../browser/actors/BentoKey*.sys.mjs` did NOT appear (would have meant `FINAL_TARGET_FILES.actors` was processed).
- `Bento.app/.../browser/chrome/browser/content/browser/BentoKey*.sys.mjs` was still present, but those were stale leftovers from step 1 — the new build hadn't actually run mach successfully.

Output captured was ~830 bytes of surfer pre-amble, then nothing. Looked like success.

### 4. CLAUDECODE filter discovered

- Direct `./mach build` invocation (instead of via `npm run build`) printed: `AI agent detected. Terminal output limited to warnings and errors.`
- Source: `engine/python/mozbuild/mozbuild/util.py:85` — `is_running_under_coding_agent()` checks for `CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE` env vars. If any are set, mach silences info-level logs and `quiet=True` is forced.
- Tried `MOZ_NO_TERMINAL_FOOTER=1` — unrelated, didn't help.
- Tried `MOZ_AUTOMATION=1` — didn't disable the AI filter.
- Workaround: `env -u CLAUDECODE ./mach build` bypasses the check.

This explained why earlier "successful" builds in this session looked fine but were potentially hiding errors. CLAUDECODE was set the entire session; the filter just doesn't always silence the _interesting_ output (warnings/errors do leak through, info logs don't).

### 5. Python 3.9 lacks tomllib

After unsetting CLAUDECODE, direct `./mach --help` and `./mach build` produced:

```text
File "/Users/admin/Projects/bento-browser/engine/toolkit/components/ml/eval/mach_commands.py", line 15, in <module>
    import tomllib
ModuleNotFoundError: No module named 'tomllib'
```

- macOS system Python (`/usr/bin/python3`) is 3.9.6.
- `tomllib` was added to the stdlib in Python 3.11.
- mach's shebang `#!/usr/bin/env python3` resolves to system Python, which doesn't satisfy a recently-added mach command's import.
- mach has a `try_alternate_python3_executables` helper but it only runs when version < `MIN_PYTHON_VERSION = (3, 9)`. 3.9.6 passes the version check but lacks tomllib, so the helper never fires.

Workaround: prepend a Python 3.11+ to PATH before invoking mach.

- Found `python3.12` at `/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12` (bundled with the Codex sandbox runtime, not officially installed).
- `PATH="/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin:$PATH" env -u CLAUDECODE npm run build`.

This unblocked the tomllib import, but the build still hung — see next section. The tomllib issue and the hang are separate; one masked the other for a while.

Important caveat: when mach is wrapped by surfer, surfer's own Python execution path uses a different python (it sets up its own virtualenv at `~/.mozbuild/srcdirs/engine-978f37b56e10/_virtualenvs/mach/`, which is python3.12). So `npm run build` does NOT need PATH overriding for tomllib. The tomllib error only surfaces when running `./mach` directly.

### 6. The hang itself

With `env -u CLAUDECODE` + `python3.12` in PATH, the build still hung at startup. Captured evidence:

- `ps -p <mach_pid> -o pcpu` → 0.0% CPU, sustained for 10+ minutes.
- `pgrep -P <mach_pid>` → no live children.
- `ps -o pid,ppid -ax | awk '$2==<mach_pid>'` → one entry: `<defunct>` zombie with no command name.
- `sample <mach_pid> 2 -file /tmp/sample.txt`:
  - Main thread: `start → Py_BytesMain → pymain_main → Py_RunMain → ... → method_vectorcall_VARARGS_KEYWORDS → lock_PyThread_acquire_lock → acquire_timed → PyThread_acquire_lock_timed → _pthread_cond_wait → __psynch_cvwait`.
  - Worker thread: `pythread_wrapper → thread_run → _PyEval_EvalFrameDefault → _textiowrapper_readline → textiowrapper_read_chunk → _io__Buffered_read1 → _bufferedreader_raw_read → _io_FileIO_readinto → _Py_read → read`.
  - Glean dispatcher thread: parked on a crossbeam channel recv (normal idle).
- `lsof -p <mach_pid>`:
  - cwd correctly at `engine/`.
  - Loaded `libpython3.12.dylib` (so the python override worked).
  - Loaded mach's virtualenv site-packages (psutil, glean, yaml, zstandard).
  - fd 0 → `/dev/null`, fd 1/2 → log file (so no interactive stdin to be waiting on).
  - Two pipe descriptors paired with each other (writer end mach holds; reader end mach also holds via the worker thread). Classic self-pipe-deadlock smoke alarm.

Reproduced 4+ times with identical stack signature. Deterministic, not a transient race.

### 7. Reset attempts that didn't help

- Killed all mach processes, ran clean `npm run build`. Same hang.
- Reverted engine state via `git -C engine checkout -- .` and re-ran `surfer import` + `npm run build`. Same hang.
- Tried direct `./mach build browser/actors` (build only the actors subtree). Same hang.
- Tried `./mach build` after `touch engine/browser/actors/moz.build` to force re-evaluation. Same hang.

A previous session's fast-build cycles using `pnpm --filter @bento/tools build && npx surfer import` (no mach build) DID complete. So pre-mach steps work; only the mach-driven part hangs.

### 8. Direct file-copy workaround into Bento.app

Since the build pipeline couldn't be unstuck, the actor files needed to land in `Bento.app/.../browser/actors/` some other way.

- First tried symlinks: `ln -sf src/browser/actors/BentoKey*.sys.mjs Bento.app/.../browser/actors/`.
- Symlinks were created and `cat` confirmed they resolved to the source files.
- Browser console: still `Error: Failed to load resource:///actors/BentoKeyChild.sys.mjs`.
- Replaced with real file copies: `cp src/browser/actors/BentoKey*.sys.mjs Bento.app/.../browser/actors/`.
- Browser console: clean. ←/→ cycled panels, Vimium j/k worked, search inputs preserved caret motion.

**Conclusion: macOS sandboxes the content process more strictly than the chrome process.** The actor child runs in the content process. The content sandbox restricts file reads to within the app bundle and refuses to follow symlinks pointing outside (`/Users/admin/Projects/bento-browser/src/...` is outside `Bento.app`). The actor parent runs in the chrome process, which is permissive — but the parent never instantiates if the child fails.

Practical implication for the build pipeline: surfer's symlink-everything-into-engine pattern is fine for chrome-process resources (`bento-shell-mount.js`, `bento-chrome-tokens.css`, jar.mn-mounted CSS/JS) but **NOT for any future content-process JS** — actor children, DOM_FullScreen-style content modules, content scripts. Those need real files in the dist bundle, not symlinks.

## Raw mach debugging recipe

Use direct mach only when the normal build is hiding useful information. `npm run build` is still the product build command because it also runs extension builds, patch reset/import, Bento pref append, and symlink sync.

Run direct mach from the Firefox checkout, not from the Bento repo root:

```sh
cd engine
```

On this machine, direct `./mach` may resolve to macOS system Python 3.9, which lacks `tomllib`. Put a Python 3.11+ earlier in PATH before direct mach calls:

```sh
export PATH="/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin:$PATH"
```

Unset coding-agent environment variables when collecting output. Otherwise mach's AI-agent filter can force quiet logging and make hangs look like silent success:

```sh
env -u CLAUDECODE -u CODEX_SANDBOX -u GEMINI_CLI -u OPENCODE ./mach build
```

If the goal is to compare normal build vs raw mach, capture both logs explicitly:

```sh
env -u CLAUDECODE -u CODEX_SANDBOX -u GEMINI_CLI -u OPENCODE npm run build > /tmp/bento-npm-build.log 2>&1

cd engine
env -u CLAUDECODE -u CODEX_SANDBOX -u GEMINI_CLI -u OPENCODE ./mach build > /tmp/bento-mach-build.log 2>&1
```

Expected interpretations:

- `ModuleNotFoundError: No module named 'tomllib'`: direct mach used Python 3.9. Fix PATH and retry; this is not the zombie hang.
- `AI agent detected. Terminal output limited to warnings and errors.`: one of the agent env vars is still set. Unset all four names above.
- 0% CPU, no output growth, zombie child under the mach PID: this is the hang described by this plan.
- npm build succeeds while direct mach fails with Python import errors: direct mach environment differs from Surfer's wrapped mach environment.

## Evidence already collected

- The mach process loads python3.12 via `~/.mozbuild/srcdirs/engine-978f37b56e10/_virtualenvs/mach/lib/python3.12/...` (so the bundled mach virtualenv works; system Python 3.9 lacking `tomllib` is a separate issue that only surfaces on direct `./mach` invocation, not the surfer-wrapped path).
- `sample <pid>` shows the main thread blocked on `PyThread_acquire_lock_timed → _pthread_cond_wait → __psynch_cvwait`. A worker thread is blocked on `_io_FileIO_readinto → read` from a pipe (file descriptor for inter-process communication).
- A glean dispatcher thread is parked (normal idle).
- `pgrep -P <mach_pid>` returns no live children.
- `ps -o pid,ppid -ax | awk '$2==<mach_pid>'` shows one entry: a `<defunct>` PID with no command name.
- `lsof -p <mach_pid>` shows a self-paired pipe (mach holds both ends).
- The hang is deterministic — same stack signature across 4+ reproductions.
- It happens identically with `CLAUDECODE` set or unset (the env var only affects log filtering, not behaviour).
- Direct `./mach build` was intentionally used during debugging to get raw build-system output. It still hung or failed silently, which points at mach / its Python startup path rather than npm's script runner.
- Earlier in the same session the build succeeded; the hang appeared without a clearly attributable trigger. Possible candidates: the moz.build patch landing (touches `FINAL_TARGET_FILES.actors`), `surfer import` re-applying patches against a dirty engine, or one of the killed-then-restarted build attempts leaving stale state somewhere (e.g. an obj-dir lock, a glean state file in `~/.mozbuild/`, or a virtualenv corruption).

## Hypothesis

Mach forks an early-startup helper subprocess (likely the Python virtualenv bootstrap, glean dispatcher initialisation, or build-config subprocess). The child exits — quickly, before mach has finished reading from its pipe. Mach's pipe-reader thread is stuck on `read()` because either:

1. **Mach holds both ends of the pipe.** Bug pattern: `subprocess.Popen` with `pass_fds` or fork-without-cleanup leaves the write end open in mach. When the child closes its write end, mach's read still blocks because mach itself still has a writer. This is a classic Python multiprocessing footgun and would explain the deterministic hang + the `<defunct>` child + the self-paired pipe in `lsof`.

2. **Mach's main thread is waiting on a lock the dead child held.** The `PyThread_acquire_lock_timed` on main suggests this. If the child was supposed to release a lock but exited without doing so, main waits forever.

(1) is now the leading hypothesis given the `lsof` evidence (self-paired pipe). (2) is consistent with the main-thread stack but doesn't explain why fd cleanup is the visible smoking gun.

## Investigation plan

### Phase 1 — Reproduce + capture (30 min)

Start with a non-destructive repro. Only move to the reset steps if the hang still occurs.

0. **Current-state check**:
   - `find engine/obj-*/dist -path '*BentoKey*.sys.mjs' -print`
   - `npm run build`
   - If the build completes and actor files are still present in `Bento.app`, the issue is not active.

Clean state every time once the hang is confirmed, so we're measuring the hang in isolation, not stale state from prior attempts.

1. **Reset everything**:
   - `pkill -9 -f "mach"; pkill -9 -f "surfer"` (only if stuck mach/surfer processes are confirmed)
   - `bash scripts/reset-engine-patches.sh`
   - `rm -rf ~/.mozbuild/srcdirs/engine-978f37b56e10` (forces virtualenv rebuild; destructive to local mach cache only)
   - `cd engine && ./mach clobber` if it doesn't itself hang
2. **Trigger the hang**: `env -u CLAUDECODE npm run build > /tmp/repro.log 2>&1 & echo $!`
   - Prefer unsetting every known agent env var:
     `env -u CLAUDECODE -u CODEX_SANDBOX -u GEMINI_CLI -u OPENCODE npm run build > /tmp/repro.log 2>&1 & echo $!`
   - This is intentional — without it the AI-detection filter swallows mach output and you can't tell hang-vs-error.
3. **Capture within 60s of hang**:
   - `ps -o pid,ppid,etime,pcpu,state,wchan,command -ax | grep -E "(mach|surfer|<defunct>)"`
   - `sample <mach_pid> 2 -file /tmp/sample.txt` (full stack trace of every thread)
   - `lsof -p <mach_pid>` (open files + pipes — names of any pipe peers; look for the self-paired pipe pattern from §6)
   - `dtrace -n 'syscall::wait*:entry /pid == <mach_pid>/ { ustack(); }'` if SIP allows (probably won't on a stock macOS)
4. **Identify the defunct child**:
   - The defunct PID is shown in `ps`. We need its **original command name** before it died — `ps` shows `<defunct>` for both name and args after exit.
   - Approach: enable `dtrace -n 'proc:::exec /pid == <something>/ { trace(execname); }'` from before the hang, OR
   - Cleaner: instrument `subprocess.Popen` in mach to log every spawn (see Phase 2).

### Phase 2 — Identify the subprocess (1–2 hours)

Need to know **which** subprocess mach spawned that became the zombie. Two approaches:

**Approach A — Instrument mach** (faster, more precise):

- Edit `engine/python/mach/mach/mixin/process.py` and `engine/python/mozbuild/mozbuild/util.py` (wherever `subprocess.Popen` is called) to print `[spawn] pid={pid} cmd={cmd}` on every spawn and `[wait] pid={pid} status={status}` on every wait.
- Re-run the hang. The last `[spawn]` without a matching `[wait]` is the culprit.
- **Risk**: the hang happens before `print()` flushes. Use `print(..., flush=True)` and `sys.stderr` to dodge stdout buffering.
- **Risk**: mach's own logging system may suppress the prints when `quiet=True` (CLAUDECODE filter). Write directly to `os.write(2, b"...")` to bypass mach's logger.

**Approach B — System-level tracing**:

- macOS `dtrace -n 'proc:::exec /execname == "python3.12"/ { trace(curpsinfo->pr_psargs); }'` from before the hang.
- Captures the actual exec'd command.
- **Risk**: requires SIP-disabled or csrutil tweaks to dtrace user processes. May not be feasible without rebooting to recovery mode.

Default to (A). Fall back to (B) if instrumentation doesn't catch the spawn.

**Approach C — fs_usage**:

- macOS `fs_usage -w -f exec` shows every exec system-wide. Simpler than dtrace, doesn't need SIP off.
- Filter by parent PID once mach is running: `fs_usage -w -f exec | grep <mach_pid>`.
- Less detailed than dtrace ustack but enough to identify the spawn site.

### Phase 3 — Diagnose the deadlock (1–2 hours)

Once the spawn site is known:

1. **Read the spawn site code**: how does mach communicate with this child? `subprocess.Popen(stdout=PIPE)` → reads via `.communicate()` or `.stdout.read()`?
2. **Check pipe handling**: does mach close its write end after the spawn? Does the child close stdout before exiting? Are file descriptors leaked across forks? (The `lsof` self-paired-pipe finding from §6 suggests yes.)
3. **Check thread interactions**: is there a lock the child was supposed to release? Look at the mach commands loaded around startup — `mach_initialize.py`, the glean integration, the virtualenv setup.
4. **Bisect the moz.build patch**: temporarily revert `patches/chrome-layout/04-bento-key-actors.patch` (the one that touches `engine/browser/actors/moz.build`). If the hang goes away, the moz.build evaluation path is involved (unlikely given the hang is at startup, before moz.build evaluation, but worth ruling out).
5. **Diff the working state vs broken state**: when did the hang start? Check `git reflog` in engine, look at `~/.mozbuild` directory mtime, check if a Python package was added/upgraded recently (e.g. did `pnpm install` bump a dep that pulled a new mach version?).

### Phase 4 — Test workarounds (30 min)

In parallel with Phase 3, try cheap workarounds in case one fixes it without root-cause work:

1. `cd engine && ./mach clobber && env -u CLAUDECODE npm run build` — clobber re-runs configure
2. `rm -rf ~/.mozbuild/srcdirs/engine-978f37b56e10 && env -u CLAUDECODE npm run build` — wipe mach virtualenv, force rebuild
3. `MOZ_DISABLE_GLEAN=1 env -u CLAUDECODE npm run build` — if glean is the deadlock culprit
4. `env -i HOME=$HOME PATH=/usr/bin:/usr/local/bin npm run build` from a fresh terminal — strip ALL inherited env vars; isolates whether something in the shell is contributing
5. Try after a system reboot (clears any kernel-level fd leaks)
6. Run the same `npm run build` inside Codex's runtime if available — its python3.12 environment is the one mach actually loads, so eliminating PATH discrepancies may help

If any of these unblocks the build, that's a strong signal about the root cause (e.g. workaround #2 succeeding ⇒ the virtualenv's state is corrupt; #3 succeeding ⇒ glean is at fault; #4 succeeding ⇒ a stale env var is the trigger).

### Phase 5 — Root cause + fix (variable)

Three possible outcomes:

- **Local mach bug, local fix**: patch the spawn site to close fds correctly or use a different communication pattern. Add patch under `patches/build-fixes/`.
- **Upstream Firefox bug**: file a bug at bugzilla.mozilla.org with the reproducer + sample stack. Pin a workaround locally until upstream lands a fix.
- **Environmental issue** (e.g. specific to this machine, this Python version, this macOS version): document in `docs/maintaining-surfer.md` and CLAUDE.md, with the workaround commands (#2, #3 above).

## Manual actor-copy workaround

This workaround was needed during the original failed session. It is not currently needed if Phase 1 step 0 shows that `BentoKey*.sys.mjs` already exists in `Bento.app`.

Use it only when all of these are true:

- The build is still hanging or silently skipping the mach packaging step.
- The actor patch is applied in `engine/browser/actors/moz.build`.
- The built app is missing `Bento.app/.../browser/actors/BentoKey*.sys.mjs`.

Then copy content-process resources (anything destined for `resource:///actors/` or other paths read by content-process loaders) into the dist bundle as real files:

```sh
cp src/browser/actors/BentoKey*.sys.mjs \
   engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/Resources/browser/actors/
```

Symlinks DO NOT work for content-process loads — see §8 in the timeline. They work fine for chrome-process resources.

When the build pipeline gets unstuck, this manual step disappears: Phase 4c's `04-bento-key-actors.patch` already adds the actors to `FINAL_TARGET_FILES.actors`, which puts them at the right path automatically on a working build.

Verification after using the workaround:

```sh
find engine/obj-*/dist/Bento.app -path '*browser/actors/BentoKey*.sys.mjs' -type f -print
```

## Risks & costs

| Risk                                                                  | Likelihood | Mitigation                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Investigation derails into Firefox build-system rabbit hole           | Medium     | Set a 4-hour cap. If unfixed by then, fall back to documenting the workaround (manual `cp` to dist) and resume Phase 5 of the panels plan.                                                                                                                                                         |
| Workaround #2 (wipe `~/.mozbuild` virtualenv) breaks other things     | Low        | The virtualenv is mach's per-srcdir build cache, not the user's environment. Rebuild takes ~5 min.                                                                                                                                                                                                 |
| dtrace requires SIP disabled and the user doesn't want to             | High       | Default to instrumentation (Approach A) or `fs_usage` (Approach C) — both work without SIP changes.                                                                                                                                                                                                |
| The hang clears itself before we can investigate                      | Medium     | The 2026-05-10 status check at the top of this doc suggests the bundle currently has the actor files present, which means a build DID succeed at some point after the original session ended. The hang may have been transient — confirm via Phase 1 step 0 before sinking time into reproduction. |
| Real fix is upstream-only                                             | Medium     | Maintain a local patch under `patches/build-fixes/` until upstream lands. Same pattern Bento already uses for chrome patches.                                                                                                                                                                      |
| Future content-process JS lands as symlinks again and silently breaks | Medium     | Add a build-pipeline assert: any file destined for `Bento.app/.../browser/actors/`, content scripts dirs, etc. must be a regular file, not a symlink. Could be a one-line check in `scripts/append-prefs.sh` or a new `scripts/verify-content-resources.sh`.                                       |

## Success criteria

- `npm run build` runs to completion with no manual intervention.
- A clean clone (`git clone && pnpm install && npm run build`) builds successfully on this machine.
- Phase 4c's actor files land at `Bento.app/.../browser/actors/BentoKey*.sys.mjs` automatically via `FINAL_TARGET_FILES.actors`.
- The fix (or documented workaround) is committed and explained in CLAUDE.md.
- CLAUDE.md gains a "future content-process resources need real files, not symlinks" note that future sessions will see.

## When to give up

If after Phase 1–4 we still can't identify the spawn site or root cause:

- Document the workaround (`cp` to dist) in CLAUDE.md.
- Add a `npm run install-actors` script that does the cp automatically.
- Move on to Phase 5 of [bento-spaces-split-view-panels.md](bento-spaces-split-view-panels.md).
- Revisit after a Firefox version bump (the rebase may shake the hang loose).
