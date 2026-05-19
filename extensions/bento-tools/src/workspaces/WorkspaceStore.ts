// Source-of-truth workspace tracker for Bento. Mirrors the TabRegistry pattern:
// in-memory Map<id, Workspace>, batched delta listeners, persistence via
// storage.local. UI never mutates this directly — it dispatches Actions.
//
// First-boot bootstrap: if persistence is empty, creates a default "Personal"
// workspace and assigns no tabs to it (per-tab assignment lives in the
// browser.sessions layer, see step 3b).

import type { Workspace, WorkspaceDelta } from '@shared/protocol';
import { Persistence, load } from './Persistence';

type Listener = (deltas: WorkspaceDelta[]) => void;

const DEFAULT_WORKSPACE_NAME = 'Personal';
const DEFAULT_WORKSPACE_COLOR = 'blue';

// Per-window active workspace persistence. Rides Firefox SessionStore's
// extData via browser.sessions.setWindowValue, the same way per-tab
// workspace assignment uses setTabValue. Restored by background.ts's boot
// sequence (Phase G.1) before any backfill runs.
const ACTIVE_WORKSPACE_SESSION_KEY = 'bento.activeWorkspaceId';

function makeId(): string {
  // crypto.randomUUID is available in Firefox 95+; Bento targets 150.
  return crypto.randomUUID();
}

export class WorkspaceStore {
  #workspaces = new Map<string, Workspace>();
  /** Last globally-activated workspace. Persisted across sessions. Used as
   * the fallback "current workspace" for callers that don't supply a
   * windowId (legacy single-window code paths, tools-internal dispatches,
   * and the brief window between a shell document mounting and resolving
   * its WebExtension windowId). Also seeds the active workspace for any
   * new window's first getActiveId(windowId) lookup. */
  #lastGlobalActiveId: string | null = null;
  /** Per-window active workspace. Populated by `activate(id, windowId)`
   * and updated on every workspace change scoped to a window. Persisted
   * to SessionStore via `browser.sessions.setWindowValue` (Phase G.1) —
   * the map is rehydrated by background.ts's boot sequence before
   * backfill runs. Windows without a saved value (first launch, brand-
   * new windows mid-session) fall back to `#lastGlobalActiveId` via
   * `getActiveId(windowId)`. */
  #activeIdByWindow = new Map<number, string>();
  #pending: WorkspaceDelta[] = [];
  #flushScheduled = false;
  #listeners = new Set<Listener>();
  #persistence = new Persistence();

  async init(): Promise<void> {
    const persisted = await load();
    if (persisted && persisted.workspaces.length > 0) {
      for (const w of persisted.workspaces) this.#workspaces.set(w.id, w);
      this.#lastGlobalActiveId =
        persisted.activeId && this.#workspaces.has(persisted.activeId)
          ? persisted.activeId
          : (persisted.workspaces[0]?.id ?? null);
    } else {
      // First boot — bootstrap with one default workspace.
      const w: Workspace = {
        id: makeId(),
        name: DEFAULT_WORKSPACE_NAME,
        color: DEFAULT_WORKSPACE_COLOR,
        createdAt: Date.now(),
      };
      this.#workspaces.set(w.id, w);
      this.#lastGlobalActiveId = w.id;
      this.#schedulePersist();
    }
  }

  snapshot(): {
    workspaces: Workspace[];
    activeId: string | null;
    activeIdByWindow: Record<number, string>;
  } {
    return {
      workspaces: Array.from(this.#workspaces.values()).sort((a, b) => a.createdAt - b.createdAt),
      activeId: this.#lastGlobalActiveId,
      activeIdByWindow: Object.fromEntries(this.#activeIdByWindow.entries()),
    };
  }

  /** Returns the active workspace for `windowId` if it has one; otherwise
   * the global fallback IF that fallback isn't already owned by another
   * window. When the fallback IS owned, returns null — the action that
   * called this should no-op rather than target another window's
   * workspace (Bento enforces "one workspace per window"). Pass
   * null/undefined for legacy single-window callers — same fallback
   * behaviour as today, no isolation check applies. */
  getActiveId(windowId?: number | null): string | null {
    if (typeof windowId === 'number') {
      const perWindow = this.#activeIdByWindow.get(windowId);
      if (perWindow !== undefined) return perWindow;
      // Per-window not assigned. Use the global fallback only if no
      // OTHER window already owns it.
      const fallback = this.#lastGlobalActiveId;
      if (!fallback) return null;
      for (const [otherWinId, wsId] of this.#activeIdByWindow.entries()) {
        if (otherWinId === windowId) continue;
        if (wsId === fallback) return null;
      }
      return fallback;
    }
    return this.#lastGlobalActiveId;
  }

  /** Returns the per-window active map as a plain record. Useful for the
   * orchestrator in background.ts when it needs to walk every window. */
  getActiveIdByWindow(): Record<number, string> {
    return Object.fromEntries(this.#activeIdByWindow.entries());
  }

  has(id: string): boolean {
    return this.#workspaces.has(id);
  }

  onDeltas(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  create(
    input: { name: string; color?: string; icon?: string },
    windowId?: number | null,
  ): Workspace {
    const w: Workspace = {
      id: makeId(),
      name: input.name,
      color: input.color,
      icon: input.icon,
      createdAt: Date.now(),
    };
    this.#workspaces.set(w.id, w);
    this.#enqueue({ kind: 'created', workspace: w });
    // Newly created workspaces auto-activate so the user immediately lands
    // in the workspace they just made (matches the user's "I created this
    // for a reason" intent). Per-window scoping: when the request carried
    // a windowId (new-shell builds), only that window switches — the new
    // workspace exists for everyone but only the requesting window
    // foregrounds it. When the request had no windowId (legacy / tools-
    // internal), the activation is global and updates the fallback.
    if (typeof windowId === 'number') {
      this.#activeIdByWindow.set(windowId, w.id);
      this.#persistActiveForWindow(windowId, w.id);
      // Per-window scoped: only this window foregrounds the new
      // workspace. Other windows stay on their current active. Matches
      // the plan's invariant "switching in window A doesn't switch
      // window B". We do NOT update #lastGlobalActiveId here for the
      // same reason as in activate() — a per-window choice mustn't
      // bleed back into the global fallback, otherwise the next window
      // to query getActiveId(N) for a brand-new N would inherit a
      // workspace its user never asked for.
      this.#enqueue({ kind: 'activated', id: w.id, windowId });
    } else {
      this.#lastGlobalActiveId = w.id;
      this.#enqueue({ kind: 'activated', id: w.id });
    }
    this.#schedulePersist();
    return w;
  }

  rename(id: string, name: string): void {
    const w = this.#workspaces.get(id);
    if (!w || w.name === name) return;
    w.name = name;
    this.#enqueue({ kind: 'updated', id, changes: { name } });
    this.#schedulePersist();
  }

  recolor(id: string, color: string | undefined): void {
    const w = this.#workspaces.get(id);
    if (!w || w.color === color) return;
    w.color = color;
    this.#enqueue({ kind: 'updated', id, changes: { color } });
    this.#schedulePersist();
  }

  /** Atomic multi-field update for the workspace edit dialog. Computes the
   * actual diff against the existing workspace and emits a single delta
   * containing only the fields that changed (so listeners can rely on
   * `changes` keys to know what to re-render). No-op if nothing changed. */
  update(id: string, changes: Partial<Pick<Workspace, 'name' | 'color' | 'icon'>>): void {
    const w = this.#workspaces.get(id);
    if (!w) return;
    const diff: Partial<Pick<Workspace, 'name' | 'color' | 'icon'>> = {};
    if ('name' in changes && changes.name !== undefined && changes.name !== w.name) {
      diff.name = changes.name;
    }
    if ('color' in changes && changes.color !== w.color) {
      diff.color = changes.color;
    }
    if ('icon' in changes && changes.icon !== w.icon) {
      diff.icon = changes.icon;
    }
    if (Object.keys(diff).length === 0) return;
    Object.assign(w, diff);
    this.#enqueue({ kind: 'updated', id, changes: diff });
    this.#schedulePersist();
  }

  delete(id: string): void {
    if (!this.#workspaces.delete(id)) return;
    this.#enqueue({ kind: 'removed', id });
    // Pick a fallback workspace for the global slot and for any per-
    // window slot that pointed at the just-deleted workspace. Each
    // affected window gets its own `activated` delta so listeners can
    // react per-window.
    const fallback = this.#workspaces.values().next().value as Workspace | undefined;
    const fallbackId = fallback ? fallback.id : null;
    if (this.#lastGlobalActiveId === id) {
      this.#lastGlobalActiveId = fallbackId;
      if (fallbackId) this.#enqueue({ kind: 'activated', id: fallbackId });
    }
    for (const [winId, wsId] of Array.from(this.#activeIdByWindow.entries())) {
      if (wsId !== id) continue;
      if (fallbackId) {
        this.#activeIdByWindow.set(winId, fallbackId);
        this.#persistActiveForWindow(winId, fallbackId);
        this.#enqueue({ kind: 'activated', id: fallbackId, windowId: winId });
      } else {
        this.#activeIdByWindow.delete(winId);
        this.#persistActiveForWindow(winId, null);
      }
    }
    this.#schedulePersist();
  }

  /** Find the windowId currently displaying `workspaceId`, or null if no
   * window has it active. Used to detect cross-window conflicts so the
   * UX can focus the owning window instead of double-opening the same
   * workspace (which produces panel-rendering bugs in multi-window mode
   * pending Phase C). */
  findOwningWindow(workspaceId: string): number | null {
    for (const [winId, wsId] of this.#activeIdByWindow.entries()) {
      if (wsId === workspaceId) return winId;
    }
    return null;
  }

  /** Activate `id` either globally (no windowId) or for a specific window.
   *
   * Per-window activations are isolated: window A switching to X does NOT
   * change window B's active workspace, does NOT change the global
   * fallback. The plan's invariant — "switching in window A doesn't
   * switch window B" — depends on this. A brand-new window's first read
   * of getActiveId(windowId) returns `#lastGlobalActiveId` (the most-
   * recent persisted / globally-activated workspace) since the new
   * window has no per-window entry yet.
   *
   * Global activations (no windowId — legacy path, tools-internal, and
   * the first-boot bootstrap) update `#lastGlobalActiveId` AND propagate
   * to any windows already tracking the old global value. This matches
   * pre-A.2 single-window semantics: legacy callers see global behaviour
   * unchanged.
   *
   * Conflict policy: two windows can't display the same workspace at
   * once. If `id` is already active in some OTHER window, the activation
   * is refused and `findOwningWindow(id)` returns the owning windowId so
   * the caller can focus that window instead. Returns `'conflict'` in
   * that case; `'activated'` on a real activation; `'noop'` when the
   * requested workspace was already active for this window. */
  activate(id: string, windowId?: number | null): 'activated' | 'conflict' | 'noop' {
    if (!this.#workspaces.has(id)) return 'noop';
    if (typeof windowId === 'number') {
      if (this.#activeIdByWindow.get(windowId) === id) return 'noop';
      // Cross-window conflict — another window already owns this
      // workspace. The handler is expected to react by focusing the
      // owning window rather than activating here.
      const owner = this.findOwningWindow(id);
      if (owner !== null && owner !== windowId) return 'conflict';
      this.#activeIdByWindow.set(windowId, id);
      this.#persistActiveForWindow(windowId, id);
      // Deliberately do NOT touch #lastGlobalActiveId — see method
      // docstring. Per-window activations stay scoped to that window.
      this.#enqueue({ kind: 'activated', id, windowId });
    } else {
      if (this.#lastGlobalActiveId === id) return 'noop';
      this.#lastGlobalActiveId = id;
      this.#enqueue({ kind: 'activated', id });
    }
    this.#schedulePersist();
    return 'activated';
  }

  /** Pick a workspace for a newly-opened window, choosing the first one
   * that is NOT already owned by another window. Returns null when every
   * workspace is currently taken (the caller is expected to leave the
   * window with no active workspace and let the user pick or create
   * one). Updates `#activeIdByWindow` and emits an activation delta.
   *
   * Preference order:
   *   1. The persisted #lastGlobalActiveId if it isn't already taken
   *      (preserves "default workspace" UX for the first window opened
   *      after a fresh start).
   *   2. Then the workspaces in createdAt order.
   */
  assignAvailable(windowId: number): string | null {
    if (this.#activeIdByWindow.has(windowId)) {
      return this.#activeIdByWindow.get(windowId) ?? null;
    }
    const taken = new Set(this.#activeIdByWindow.values());
    const tryAssign = (id: string | null): string | null => {
      if (!id) return null;
      if (taken.has(id)) return null;
      if (!this.#workspaces.has(id)) return null;
      this.#activeIdByWindow.set(windowId, id);
      this.#persistActiveForWindow(windowId, id);
      this.#enqueue({ kind: 'activated', id, windowId });
      return id;
    };
    const fromGlobal = tryAssign(this.#lastGlobalActiveId);
    if (fromGlobal) return fromGlobal;
    const ordered = Array.from(this.#workspaces.values()).sort((a, b) => a.createdAt - b.createdAt);
    for (const ws of ordered) {
      const picked = tryAssign(ws.id);
      if (picked) return picked;
    }
    return null;
  }

  /** Called by background.ts when a window's port disconnects (the chrome
   * window closed). Drops that window's per-window state so the map
   * doesn't grow unbounded across long sessions with many windows. */
  forgetWindow(windowId: number): void {
    this.#activeIdByWindow.delete(windowId);
  }

  /** Boot-time per-window restore (Phase G.1). Reads the active workspace
   * SessionStore value for `windowId` and, if present and still valid,
   * primes `#activeIdByWindow`. Skips silently when no value is saved
   * (first launch, brand-new windows), when the saved workspace was
   * deleted between sessions, or when another window has already claimed
   * the workspace during this boot (cross-window conflict — defensive,
   * shouldn't happen under 1-WS-per-window). Returns the workspace ID
   * that ended up active for the window, or null if no restore happened
   * (so the caller can log or fall through). */
  async restoreFromSession(windowId: number): Promise<string | null> {
    let savedId: string | undefined;
    try {
      const value = await browser.sessions.getWindowValue(windowId, ACTIVE_WORKSPACE_SESSION_KEY);
      savedId = typeof value === 'string' ? value : undefined;
    } catch (err) {
      console.warn('[bento-tools] getWindowValue failed:', windowId, err);
      return null;
    }
    if (!savedId) return null;
    if (!this.#workspaces.has(savedId)) {
      console.log(
        '[bento-tools] saved workspace no longer exists; window will fall back:',
        windowId,
        savedId,
      );
      return null;
    }
    const result = this.activate(savedId, windowId);
    return result === 'activated' || result === 'noop' ? savedId : null;
  }

  #enqueue(delta: WorkspaceDelta): void {
    this.#pending.push(delta);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const flush = () => {
      this.#flushScheduled = false;
      const batch = this.#pending;
      this.#pending = [];
      if (batch.length === 0) return;
      for (const l of this.#listeners) l(batch);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 16);
    }
  }

  #schedulePersist(): void {
    // Persistence (storage.local) stores workspace metadata + the global
    // fallback active id. Per-window active workspace persistence rides
    // SessionStore via #persistActiveForWindow, written eagerly on every
    // per-window change rather than debounced — the write is cheap and
    // a debounce would risk losing the latest activation on crash.
    this.#persistence.schedule({
      workspaces: Array.from(this.#workspaces.values()),
      activeId: this.#lastGlobalActiveId,
    });
  }

  /** Persist (or clear) a window's active workspace to SessionStore.
   * Fire-and-forget: failures are logged but never block the in-memory
   * update or the activation UX. Called from every code path that
   * mutates `#activeIdByWindow`. */
  #persistActiveForWindow(windowId: number, workspaceId: string | null): void {
    if (workspaceId === null) {
      browser.sessions
        .removeWindowValue(windowId, ACTIVE_WORKSPACE_SESSION_KEY)
        .catch((err) => console.warn('[bento-tools] removeWindowValue failed:', windowId, err));
    } else {
      browser.sessions
        .setWindowValue(windowId, ACTIVE_WORKSPACE_SESSION_KEY, workspaceId)
        .catch((err) => console.warn('[bento-tools] setWindowValue failed:', windowId, err));
    }
  }
}
