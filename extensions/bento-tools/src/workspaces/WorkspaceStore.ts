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

function makeId(): string {
  // crypto.randomUUID is available in Firefox 95+; Bento targets 150.
  return crypto.randomUUID();
}

export class WorkspaceStore {
  #workspaces = new Map<string, Workspace>();
  #activeId: string | null = null;
  #pending: WorkspaceDelta[] = [];
  #flushScheduled = false;
  #listeners = new Set<Listener>();
  #persistence = new Persistence();

  async init(): Promise<void> {
    const persisted = await load();
    if (persisted && persisted.workspaces.length > 0) {
      for (const w of persisted.workspaces) this.#workspaces.set(w.id, w);
      this.#activeId =
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
      this.#activeId = w.id;
      this.#schedulePersist();
    }
  }

  snapshot(): { workspaces: Workspace[]; activeId: string | null } {
    return {
      workspaces: Array.from(this.#workspaces.values()).sort((a, b) => a.createdAt - b.createdAt),
      activeId: this.#activeId,
    };
  }

  getActiveId(): string | null {
    return this.#activeId;
  }

  has(id: string): boolean {
    return this.#workspaces.has(id);
  }

  onDeltas(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  create(input: { name: string; color?: string; icon?: string }): Workspace {
    const w: Workspace = {
      id: makeId(),
      name: input.name,
      color: input.color,
      icon: input.icon,
      createdAt: Date.now(),
    };
    this.#workspaces.set(w.id, w);
    this.#enqueue({ kind: 'created', workspace: w });
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

  delete(id: string): void {
    if (!this.#workspaces.delete(id)) return;
    this.#enqueue({ kind: 'removed', id });
    if (this.#activeId === id) {
      // Pick another workspace if we just removed the active one.
      const next = this.#workspaces.values().next().value as Workspace | undefined;
      this.#activeId = next ? next.id : null;
      if (this.#activeId) this.#enqueue({ kind: 'activated', id: this.#activeId });
    }
    this.#schedulePersist();
  }

  activate(id: string): void {
    if (!this.#workspaces.has(id) || this.#activeId === id) return;
    this.#activeId = id;
    this.#enqueue({ kind: 'activated', id });
    this.#schedulePersist();
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
    this.#persistence.schedule({
      workspaces: Array.from(this.#workspaces.values()),
      activeId: this.#activeId,
    });
  }
}
