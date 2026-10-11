// Test kit for the overlay request tests: several shell documents in several
// chrome windows on one in-memory BroadcastChannel network. Each document gets
// its own module instances (vi.resetModules) and the window id its frame URL
// hash would carry, like the documents chrome loads.

import { vi } from 'vitest';
import type { ConfirmPayload } from './useConfirm';
import type { EditWorkspacePayload } from './useEditWorkspace';
import type { WorkspaceSwitcherOpenPayload } from './useWorkspaceSwitcher';
import type { OverlayName } from './overlayReady';

/** Delivers to every other instance with the same name, in any document. */
export class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  closed = false;

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.#listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.instances) {
      if (other === this || other.closed || other.name !== this.name) continue;
      for (const listener of other.#listeners) listener({ data } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

export function installFakeNetwork(): void {
  FakeBroadcastChannel.instances = [];
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
}

/** Posts on a bus as some other party would (chrome's frame scripts, a stale document). */
export function postRaw(busName: string, message: unknown): void {
  new FakeBroadcastChannel(busName).postMessage(message);
}

export interface OverlayAdapter {
  overlay: OverlayName;
  busName: string;
  /** A sender document asks for the overlay to open, with a payload named `label`. */
  request(label: string): void;
  /** An overlay document subscribes; the handler gets the label of each applied payload. */
  subscribe(handler: (label: string) => void): () => void;
  /** The overlay document announces it is mounted and subscribed. */
  signalReady(): void;
}

export type OverlayKind = 'confirm' | 'edit-workspace' | 'workspace-switcher';

const switcherLabels: string[] = [];

/** Loads the modules of one shell document in chrome window `windowId`. */
export async function loadDocument(
  windowId: number | null,
  kind: OverlayKind,
): Promise<OverlayAdapter> {
  vi.stubGlobal('location', { hash: windowId === null ? '' : `#bentoWindowId=${windowId}` });
  vi.resetModules();
  const ready = await import('./overlayReady');
  if (kind === 'confirm') {
    const bridge = await import('./useConfirm');
    return {
      overlay: 'confirm',
      busName: bridge.CONFIRM_BUS_NAME,
      request: (label) =>
        bridge.requestConfirm({
          title: label,
          description: '',
          confirmLabel: 'Confirm',
          variant: 'danger',
          action: { type: 'workspace/delete', id: label },
        } satisfies ConfirmPayload),
      subscribe: (handler) =>
        bridge.subscribeToConfirmRequests((payload) => handler(payload.title)),
      signalReady: () => ready.signalOverlayReady('confirm'),
    };
  }
  if (kind === 'edit-workspace') {
    const bridge = await import('./useEditWorkspace');
    return {
      overlay: 'edit-workspace',
      busName: bridge.EDIT_WORKSPACE_BUS_NAME,
      request: (label) =>
        bridge.requestEditWorkspace({
          workspaceId: label,
          name: label,
        } satisfies EditWorkspacePayload),
      subscribe: (handler) =>
        bridge.subscribeToEditWorkspaceRequests((payload) => handler(payload.name)),
      signalReady: () => ready.signalOverlayReady('edit-workspace'),
    };
  }
  const bridge = await import('./useWorkspaceSwitcher');
  // The switcher payload is numeric only, so labels travel as an index.
  return {
    overlay: 'workspace-switcher',
    busName: bridge.WORKSPACE_SWITCHER_BUS_NAME,
    request: (label) =>
      bridge.requestWorkspaceSwitcher({
        triggerRect: { x: 0, y: 0, width: 1, height: 1 },
        sidebarScreenX: switcherLabels.push(label) - 1,
        sidebarScreenY: 0,
      } satisfies WorkspaceSwitcherOpenPayload),
    subscribe: (handler) =>
      bridge.subscribeToWorkspaceSwitcherRequests((payload) =>
        handler(switcherLabels[payload.sidebarScreenX] ?? ''),
      ),
    signalReady: () => ready.signalOverlayReady('workspace-switcher'),
  };
}
