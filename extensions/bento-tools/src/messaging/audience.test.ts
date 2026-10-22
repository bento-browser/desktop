import { describe, expect, it, vi } from 'vitest';
import type { TabDelta, TabSnapshot } from '@shared/protocol';
import { partitionTabDeltas, sendWorkspaceEvent } from './audience';

const tab = (id: number): TabSnapshot =>
  ({ id, windowId: 1, index: 0, title: '', active: false, pinned: false }) as TabSnapshot;

describe('partitionTabDeltas', () => {
  it('splits a batch into the regular part and one part per private window, keeping order', () => {
    const deltas: TabDelta[] = [
      { kind: 'created', tab: tab(1) },
      { kind: 'created', tab: tab(900) },
      { kind: 'updated', id: 1, changes: { title: 'a' } },
      { kind: 'created', tab: tab(1001) },
      { kind: 'removed', id: 900 },
    ];
    const privateWindow = new Map<TabDelta, number>([
      [deltas[1]!, 9],
      [deltas[3]!, 10],
      [deltas[4]!, 9],
    ]);

    const { regular, privateByWindow } = partitionTabDeltas(
      { privateWindowOf: (delta) => privateWindow.get(delta) },
      deltas,
    );

    expect(regular).toEqual([deltas[0], deltas[2]]);
    expect(privateByWindow.get(9)).toEqual([deltas[1], deltas[4]]);
    expect(privateByWindow.get(10)).toEqual([deltas[3]]);
  });
});

describe('sendWorkspaceEvent', () => {
  /** A resolvable gate for the read the build awaits (browser.tabs.get in tools). */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function owners(map: Map<string, number>) {
    return { privateWindowOf: (workspaceId: string) => map.get(workspaceId) ?? null };
  }

  it('sends a regular workspace to the regular documents', async () => {
    const send = vi.fn();

    await sendWorkspaceEvent(owners(new Map()), 'ws-1', async () => 'sync', send);

    expect(send).toHaveBeenCalledWith('regular', 'sync');
  });

  it('sends a Private workspace to its own window', async () => {
    const send = vi.fn();

    await sendWorkspaceEvent(
      owners(new Map([['private:a', 9]])),
      'private:a',
      async () => 'x',
      send,
    );

    expect(send).toHaveBeenCalledWith({ privateWindowId: 9 }, 'x');
  });

  it('drops the event when the private window closes while the build awaits, never sending it regular', async () => {
    const map = new Map([['private:a', 9]]);
    const gate = deferred<string>();
    const send = vi.fn();

    const sent = sendWorkspaceEvent(owners(map), 'private:a', () => gate.promise, send);
    map.delete('private:a');
    gate.resolve('private urls and titles');
    await sent;

    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing for a Private workspace whose window is already gone', async () => {
    const build = vi.fn(async () => 'x');
    const send = vi.fn();

    await sendWorkspaceEvent(owners(new Map()), 'private:gone', build, send);

    expect(build).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when the build has nothing to send', async () => {
    const send = vi.fn();

    await sendWorkspaceEvent(owners(new Map()), 'ws-1', async () => null, send);

    expect(send).not.toHaveBeenCalled();
  });
});
