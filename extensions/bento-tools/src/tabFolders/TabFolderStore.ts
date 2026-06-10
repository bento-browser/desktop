import type { TabFolder, TabFolderDelta } from '@shared/protocol';
import { Persistence, load } from './Persistence';

type Listener = (deltas: TabFolderDelta[]) => void;

export class TabFolderStore {
  #byId = new Map<string, TabFolder>();
  #pending: TabFolderDelta[] = [];
  #flushScheduled = false;
  #listeners = new Set<Listener>();
  #persistence = new Persistence();

  async init(): Promise<void> {
    const persisted = await load();
    if (!persisted) return;
    for (const folder of persisted.folders) {
      this.#byId.set(folder.id, folder);
    }
  }

  onDeltas(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): TabFolder[] {
    return Array.from(this.#byId.values()).sort(compareFolders);
  }

  foldersForWorkspace(workspaceId: string): TabFolder[] {
    return this.snapshot().filter((folder) => folder.workspaceId === workspaceId);
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  get(id: string): TabFolder | undefined {
    return this.#byId.get(id);
  }

  create(input: { id: string; workspaceId: string; name?: string }): TabFolder {
    const existing = this.#byId.get(input.id);
    if (existing) return existing;
    const siblings = this.foldersForWorkspace(input.workspaceId);
    const order = siblings.reduce((max, folder) => Math.max(max, folder.order), -1) + 1;
    const name = input.name?.trim() || 'New folder';
    const folder: TabFolder = {
      id: input.id,
      workspaceId: input.workspaceId,
      name,
      order,
      collapsed: false,
      createdAt: Date.now(),
    };
    this.#byId.set(folder.id, folder);
    this.#enqueue({ kind: 'created', folder });
    this.#schedulePersist();
    return folder;
  }

  rename(id: string, name: string): boolean {
    const folder = this.#byId.get(id);
    if (!folder) return false;
    const nextName = name.trim();
    if (nextName.length === 0 || nextName === folder.name) return false;
    const next = { ...folder, name: nextName };
    this.#byId.set(id, next);
    this.#enqueue({ kind: 'updated', id, changes: { name: nextName } });
    this.#schedulePersist();
    return true;
  }

  setCollapsed(id: string, collapsed: boolean): boolean {
    const folder = this.#byId.get(id);
    if (!folder || folder.collapsed === collapsed) return false;
    const next = { ...folder, collapsed };
    this.#byId.set(id, next);
    this.#enqueue({ kind: 'updated', id, changes: { collapsed } });
    this.#schedulePersist();
    return true;
  }

  delete(id: string): TabFolder | undefined {
    const folder = this.#byId.get(id);
    if (!folder) return undefined;
    this.#byId.delete(id);
    this.#enqueue({ kind: 'removed', id });
    this.#schedulePersist();
    return folder;
  }

  reorder(workspaceId: string, orderedIds: string[]): boolean {
    const current = this.foldersForWorkspace(workspaceId);
    if (current.length !== orderedIds.length) return false;
    const currentIds = new Set(current.map((folder) => folder.id));
    if (orderedIds.some((id) => !currentIds.has(id))) return false;
    let changed = false;
    orderedIds.forEach((id, order) => {
      const folder = this.#byId.get(id);
      if (!folder || folder.order === order) return;
      this.#byId.set(id, { ...folder, order });
      this.#enqueue({ kind: 'updated', id, changes: { order } });
      changed = true;
    });
    if (changed) this.#schedulePersist();
    return changed;
  }

  removeForWorkspace(workspaceId: string): TabFolder[] {
    const removed: TabFolder[] = [];
    for (const [id, folder] of Array.from(this.#byId.entries())) {
      if (folder.workspaceId !== workspaceId) continue;
      this.#byId.delete(id);
      removed.push(folder);
      this.#enqueue({ kind: 'removed', id });
    }
    if (removed.length > 0) this.#schedulePersist();
    return removed;
  }

  #enqueue(delta: TabFolderDelta): void {
    this.#pending.push(delta);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const flush = () => {
      this.#flushScheduled = false;
      const batch = this.#pending;
      this.#pending = [];
      if (batch.length === 0) return;
      for (const listener of this.#listeners) listener(batch);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  #schedulePersist(): void {
    this.#persistence.schedule({ folders: this.snapshot() });
  }
}

function compareFolders(a: TabFolder, b: TabFolder): number {
  if (a.workspaceId !== b.workspaceId) return a.workspaceId.localeCompare(b.workspaceId);
  if (a.order !== b.order) return a.order - b.order;
  return a.createdAt - b.createdAt;
}
