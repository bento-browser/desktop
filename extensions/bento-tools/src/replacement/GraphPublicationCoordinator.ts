import type {
  ProfileGraphSlice,
  RegularLiveGraphSlice,
  ShellClientToTools,
  TargetedGraphEvent,
  ToolsToShellTargeted,
} from '@shared/shell-client-protocol';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import type { TabFolderStore } from '../tabFolders/TabFolderStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';

const PUBLICATION_KEY = 'bento.graphPublication.v1';
const ACK_TIMEOUT_MS = 5000;

interface Recipient {
  port: browser.runtime.Port;
  shellBackgroundInstanceId: string;
  clientInstanceId: string;
  role: 'primary' | 'auxiliary';
  windowId: number;
  audience: 'regular' | 'private';
  registryRevision: number;
  ready: boolean;
  lastHeartbeatAt: number;
}

interface PublicationSlot {
  clientInstanceId: string;
  windowId: number;
  registryRevisionAtSnapshot: number;
  terminal: boolean;
}

interface DurablePublication {
  version: 1;
  backendInstanceId: string;
  publicationId: string;
  graphRevision: number;
  event: TargetedGraphEvent;
  slots: PublicationSlot[];
  phase: 'publishing' | 'awaiting-acks' | 'graph-published';
  createdAt: number;
  updatedAt: number;
}

export class GraphPublicationCoordinator {
  #backendInstanceId: string;
  #graphRevision = 0;
  #recipients = new Map<string, Recipient>();
  #pendingAckResolvers = new Set<() => void>();
  #workspaces: WorkspaceStore;
  #tabs: TabRegistry;
  #panels: PanelStore;
  #pinnedPanels: PinnedPanelsStore;
  #tabFolders: TabFolderStore;
  #savedPanels: SavedPanelsStore;

  constructor(input: {
    backendInstanceId: string;
    workspaces: WorkspaceStore;
    tabs: TabRegistry;
    panels: PanelStore;
    pinnedPanels: PinnedPanelsStore;
    tabFolders: TabFolderStore;
    savedPanels: SavedPanelsStore;
  }) {
    this.#backendInstanceId = input.backendInstanceId;
    this.#workspaces = input.workspaces;
    this.#tabs = input.tabs;
    this.#panels = input.panels;
    this.#pinnedPanels = input.pinnedPanels;
    this.#tabFolders = input.tabFolders;
    this.#savedPanels = input.savedPanels;
  }

  handle(port: browser.runtime.Port, message: ShellClientToTools): boolean {
    switch (message.type) {
      case 'shell-client/register':
        this.#recipients.set(message.clientInstanceId, {
          port,
          shellBackgroundInstanceId: message.shellBackgroundInstanceId,
          clientInstanceId: message.clientInstanceId,
          role: message.role,
          windowId: message.windowId,
          audience: message.audience,
          registryRevision: message.registryRevision,
          ready: false,
          lastHeartbeatAt: Date.now(),
        });
        return true;
      case 'shell-client/ready':
      case 'shell-client/heartbeat': {
        const recipient = this.#recipients.get(message.clientInstanceId);
        if (!recipient || recipient.port !== port || recipient.windowId !== message.windowId)
          return true;
        recipient.ready = true;
        recipient.registryRevision = message.registryRevision;
        recipient.lastHeartbeatAt = Date.now();
        return true;
      }
      case 'shell-client/hidden':
      case 'shell-client/bye':
        this.#recipients.delete(message.clientInstanceId);
        this.#notifyAckChange();
        return true;
      case 'shell-client/action':
        if (message.action.startsWith('graph/')) {
          void this.#ack(message);
          return true;
        }
        return false;
      case 'shell-client/delivery':
        return true;
    }
  }

  disconnect(port: browser.runtime.Port): void {
    for (const [id, recipient] of this.#recipients) {
      if (recipient.port === port) this.#recipients.delete(id);
    }
    this.#notifyAckChange();
  }

  async publishReplacement(): Promise<{ publicationId: string; graphRevision: number }> {
    const event = await this.#buildRegularEvent('replacement', true);
    const recipients = Array.from(this.#recipients.values()).filter(
      (recipient) =>
        recipient.ready &&
        recipient.role === 'primary' &&
        recipient.audience === 'regular' &&
        Date.now() - recipient.lastHeartbeatAt <= 3000,
    );
    const publication: DurablePublication = {
      version: 1,
      backendInstanceId: event.backendInstanceId,
      publicationId: event.publicationId,
      graphRevision: event.graphRevision,
      event,
      slots: recipients.map((recipient) => ({
        clientInstanceId: recipient.clientInstanceId,
        windowId: recipient.windowId,
        registryRevisionAtSnapshot: recipient.registryRevision,
        terminal: false,
      })),
      phase: 'publishing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.#persist(publication);
    publication.phase = 'awaiting-acks';
    publication.updatedAt = Date.now();
    await this.#persist(publication);
    for (const recipient of recipients) this.#deliver(recipient, event);
    await this.#awaitQuorum(publication);
    publication.phase = 'graph-published';
    publication.updatedAt = Date.now();
    await this.#persist(publication);
    return { publicationId: event.publicationId, graphRevision: event.graphRevision };
  }

  async complete(publicationId: string): Promise<void> {
    const raw = (await browser.storage.local.get(PUBLICATION_KEY)) as Record<string, unknown>;
    const current = raw[PUBLICATION_KEY] as Partial<DurablePublication> | undefined;
    if (current?.publicationId === publicationId && current.phase === 'graph-published') {
      await browser.storage.local.remove(PUBLICATION_KEY);
    }
  }

  async #buildRegularEvent(
    reason: 'connect' | 'replacement',
    requiresAck: boolean,
  ): Promise<Extract<TargetedGraphEvent, { type: 'graph/regular-snapshot' }>> {
    const workspaceSnapshot = this.#workspaces.snapshot();
    const classifiedTabs = [];
    for (const tab of this.#tabs.snapshot()) {
      try {
        const live = await browser.tabs.get(tab.id);
        if (live.incognito !== true) classifiedTabs.push(tab);
      } catch {
        // Missing tabs are excluded from the projection.
      }
    }
    const eligibleTabIds = new Set(classifiedTabs.map((tab) => tab.id));
    const profile: ProfileGraphSlice = {
      workspaces: workspaceSnapshot.workspaces,
      savedPanels: this.#savedPanels.list(),
    };
    const live: RegularLiveGraphSlice = {
      activeId: workspaceSnapshot.activeId,
      activeIdByWindow: workspaceSnapshot.activeIdByWindow,
      tabs: classifiedTabs,
      tabFolders: this.#tabFolders.snapshot(),
      panelsByWorkspace: workspaceSnapshot.workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        tabIds: this.#panels
          .getVisiblePanelIds(workspace.id)
          .filter((tabId) => eligibleTabIds.has(tabId)),
      })),
      pinnedPanels: this.#pinnedPanels.entries().filter((entry) => eligibleTabIds.has(entry.tabId)),
    };
    this.#graphRevision += 1;
    return {
      type: 'graph/regular-snapshot',
      backendInstanceId: this.#backendInstanceId,
      publicationId: crypto.randomUUID(),
      graphRevision: this.#graphRevision,
      reason,
      requiresAck,
      audience: { kind: 'regular' },
      profile,
      live,
    };
  }

  #deliver(recipient: Recipient, event: TargetedGraphEvent): void {
    const envelope: ToolsToShellTargeted = {
      type: 'shell-client/event',
      shellBackgroundInstanceId: recipient.shellBackgroundInstanceId,
      targetClientInstanceId: recipient.clientInstanceId,
      expectedRole: recipient.role,
      expectedWindowId: recipient.windowId,
      expectedAudience: recipient.audience,
      deliveryId: crypto.randomUUID(),
      event,
    };
    recipient.port.postMessage(envelope);
  }

  async #ack(message: Extract<ShellClientToTools, { type: 'shell-client/action' }>): Promise<void> {
    const raw = (await browser.storage.local.get(PUBLICATION_KEY)) as Record<string, unknown>;
    const publication = raw[PUBLICATION_KEY] as DurablePublication | undefined;
    if (
      publication?.publicationId !== message.publicationId ||
      publication.graphRevision !== message.graphRevision ||
      publication.backendInstanceId !== message.backendInstanceId
    ) {
      return;
    }
    const slot = publication.slots.find(
      (candidate) =>
        candidate.clientInstanceId === message.clientInstanceId &&
        candidate.windowId === message.windowId &&
        candidate.registryRevisionAtSnapshot <= message.registryRevision,
    );
    if (!slot || slot.terminal) return;
    slot.terminal = true;
    publication.updatedAt = Date.now();
    await this.#persist(publication);
    this.#notifyAckChange();
  }

  async #awaitQuorum(publication: DurablePublication): Promise<void> {
    const deadline = Date.now() + ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const raw = (await browser.storage.local.get(PUBLICATION_KEY)) as Record<string, unknown>;
      const current = raw[PUBLICATION_KEY] as DurablePublication | undefined;
      if (current?.slots.every((slot) => slot.terminal)) {
        publication.slots = current.slots;
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.#pendingAckResolvers.delete(done);
          resolve();
        }, 100);
        const done = () => {
          clearTimeout(timeout);
          this.#pendingAckResolvers.delete(done);
          resolve();
        };
        this.#pendingAckResolvers.add(done);
      });
    }
    throw new Error('busy');
  }

  #notifyAckChange(): void {
    for (const resolve of this.#pendingAckResolvers) resolve();
  }

  #persist(publication: DurablePublication): Promise<void> {
    return browser.storage.local.set({ [PUBLICATION_KEY]: publication });
  }
}
