# Mach build hang — investigation plan

## Symptom

`./mach build` (and therefore `npm run build`) hangs indefinitely at startup. The Python process consumes 0% CPU, has no live children, and never produces output. A defunct (zombie) child process appears in `ps`.

This blocked Phase 4c's actor packaging — the workaround was to manually `cp` the actor files into the dist bundle. Until this is fixed, every chrome-engine change requires the same manual step.

## Evidence already collected

- The mach process loads python3.12 via `~/.mozbuild/srcdirs/engine-978f37b56e10/_virtualenvs/mach/lib/python3.12/...` (so the bundled mach virtualenv works; system Python 3.9 lacking `tomllib` is a separate issue that only surfaces on direct `./mach` invocation, not the surfer-wrapped path).
- `sample <pid>` shows the main thread blocked on `PyThread_acquire_lock_timed → _pthread_cond_wait → __psynch_cvwait`. A worker thread is blocked on `_io_FileIO_readinto → read` from a pipe (file descriptor for inter-process communication).
- A glean dispatcher thread is parked (normal idle).
- `pgrep -P <mach_pid>` returns no live children.
- `ps -o pid,ppid -ax | awk '$2==<mach_pid>'` shows one entry: a `<defunct>` PID with no command name.
- The hang is deterministic — same stack signature across 4+ reproductions.
- It happens identically with `CLAUDECODE` set or unset (the env var only affects log filtering, not behaviour).
- Earlier in this session the build succeeded; the hang appeared without a clearly attributable trigger. Possible candidates: the moz.build patch landing (touches `FINAL_TARGET_FILES.actors`), `surfer import` re-applying patches against a dirty engine, or one of the killed-then-restarted build attempts leaving stale state somewhere.

## Hypothesis

Mach forks an early-startup helper subprocess (likely the Python virtualenv bootstrap, glean dispatcher initialisation, or build-config subprocess). The child exits — quickly, before mach has finished reading from its pipe. Mach's pipe-reader thread is stuck on `read()` because either:

1. **Mach holds both ends of the pipe.** Bug pattern: `subprocess.Popen` with `pass_fds` or fork-without-cleanup leaves the write end open in mach. When the child closes its write end, mach's read still blocks because mach itself still has a writer. This is a classic Python multiprocessing footgun and would explain the deterministic hang + the `<defunct>` child.

2. **Mach's main thread is waiting on a lock the dead child held.** The `PyThread_acquire_lock_timed` on main suggests this. If the child was supposed to release a lock but exited without doing so, main waits forever.

(2) is more consistent with the defunct child. (1) would also produce a defunct child but the parent's main thread wouldn't be blocked on a thread-lock — it'd be blocked on the pipe read directly.

## Investigation plan

### Phase 1 — Reproduce + capture (30 min)

Clean state every time so we're measuring the hang in isolation, not stale state from prior attempts.

1. **Reset everything**:
   - `pkill -9 -f "mach"; pkill -9 -f "surfer"`
   - `git -C engine checkout -- .`
   - `rm -rf ~/.mozbuild/srcdirs/engine-978f37b56e10` (forces virtualenv rebuild)
   - `cd engine && ./mach clobber` if it doesn't itself hang
2. **Trigger the hang**: `npm run build > /tmp/repro.log 2>&1 & echo $!`
3. **Capture within 60s of hang**:
   - `ps -o pid,ppid,etime,pcpu,state,wchan,command -ax | grep -E "(mach|surfer|<defunct>)"`
   - `sample <mach_pid> 2 -file /tmp/sample.txt` (full stack trace of every thread)
   - `lsof -p <mach_pid>` (open files + pipes — names of any pipe peers)
   - `dtrace -n 'syscall::wait*:entry /pid == <mach_pid>/ { ustack(); }'` if SIP allows (probably won't)
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

**Approach B — System-level tracing**:

- macOS `dtrace -n 'proc:::exec /execname == "python3.12"/ { trace(curpsinfo->pr_psargs); }'` from before the hang.
- Captures the actual exec'd command.
- **Risk**: requires SIP-disabled or csrutil tweaks to dtrace user processes. May not be feasible without rebooting to recovery mode.

Default to (A). Fall back to (B) if instrumentation doesn't catch the spawn.

### Phase 3 — Diagnose the deadlock (1–2 hours)

Once the spawn site is known:

1. **Read the spawn site code**: how does mach communicate with this child? `subprocess.Popen(stdout=PIPE)` → reads via `.communicate()` or `.stdout.read()`?
2. **Check pipe handling**: does mach close its write end after the spawn? Does the child close stdout before exiting? Are file descriptors leaked across forks?
3. **Check thread interactions**: is there a lock the child was supposed to release? Look at the mach commands loaded around startup — `mach_initialize.py`, the glean integration, the virtualenv setup.
4. **Bisect the moz.build patch**: temporarily revert `patches/chrome-layout/04-bento-key-actors.patch` (touch `engine/browser/actors/moz.build` directly via the patch). If the hang goes away, the moz.build evaluation path is involved (unlikely given the hang is at startup, before moz.build evaluation, but worth ruling out).
5. **Diff the working state vs broken state**: when did the hang start? Check `git reflog` in engine, look at `~/.mozbuild` directory mtime, check if a Python package was added/upgraded recently.

### Phase 4 — Test workarounds (30 min)

In parallel with Phase 3, try cheap workarounds in case one fixes it without root-cause work:

1. `cd engine && ./mach clobber && npm run build` — clobber re-runs configure
2. `rm -rf ~/.mozbuild/srcdirs/engine-978f37b56e10 && npm run build` — wipe mach virtualenv, force rebuild
3. `MOZ_DISABLE_GLEAN=1 npm run build` — if glean is the deadlock culprit
4. Try `npm run build` from a fresh terminal (no inherited env vars from this session)
5. Try after a system reboot (clears any kernel-level fd leaks)

If any of these unblocks the build, that's a strong signal about the root cause (e.g. workaround #2 succeeding ⇒ the virtualenv's state is corrupt; #3 succeeding ⇒ glean is at fault).

### Phase 5 — Root cause + fix (variable)

Three possible outcomes:

- **Local mach bug, local fix**: patch the spawn site to close fds correctly or use a different communication pattern. Add patch under `patches/build-fixes/`.
- **Upstream Firefox bug**: file a bug at bugzilla.mozilla.org with the reproducer + sample stack. Pin a workaround locally until upstream lands a fix.
- **Environmental issue** (e.g. specific to this machine, this Python version, this macOS version): document in `docs/maintaining-surfer.md` and CLAUDE.md, with the workaround commands (#2, #3 above).

## Risks & costs

| Risk                                                              | Likelihood | Mitigation                                                                                                                    |
| ----------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Investigation derails into Firefox build-system rabbit hole       | Medium     | Set a 4-hour cap. If unfixed by then, fall back to documenting the workaround (manual `cp` to dist) and resume Phase 5.       |
| Workaround #2 (wipe `~/.mozbuild` virtualenv) breaks other things | Low        | The virtualenv is mach's per-srcdir build cache, not the user's environment. Rebuild takes ~5 min.                            |
| dtrace requires SIP disabled and the user doesn't want to         | High       | Default to instrumentation (Approach A) — works without SIP changes.                                                          |
| The hang clears itself before we can investigate                  | Low        | The repro has been deterministic across 4+ attempts in one session.                                                           |
| Real fix is upstream-only                                         | Medium     | Maintain a local patch under `patches/build-fixes/` until upstream lands. Same pattern Bento already uses for chrome patches. |

## Success criteria

- `npm run build` runs to completion with no manual intervention.
- A clean clone (`git clone && pnpm install && npm run build`) builds successfully on this machine.
- Phase 4c's actor files land at `Bento.app/.../browser/actors/BentoKey*.sys.mjs` automatically via `FINAL_TARGET_FILES.actors`.
- The fix (or documented workaround) is committed and explained in CLAUDE.md.

## When to give up

If after Phase 1–4 we still can't identify the spawn site or root cause:

- Document the workaround (`cp` to dist) in CLAUDE.md.
- Add a `npm run install-actors` script that does the cp automatically.
- Move on to Phase 5 of [bento-spaces-split-view-panels.md](bento-spaces-split-view-panels.md).
- Revisit after a Firefox version bump (the rebase may shake the hang loose).
