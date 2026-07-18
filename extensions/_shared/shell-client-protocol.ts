import type {
  PinnedPanelEntry,
  SavedPanelEntry,
  TabFolder,
  TabSnapshot,
  Workspace,
} from './protocol';

export interface ProfileGraphSlice {
  workspaces: Workspace[];
  savedPanels: SavedPanelEntry[];
}

export interface PanelWorkspaceProjection {
  workspaceId: string;
  tabIds: number[];
}

export interface RegularLiveGraphSlice {
  activeId: string | null;
  activeIdByWindow: Record<number, string>;
  tabs: TabSnapshot[];
  tabFolders: TabFolder[];
  panelsByWorkspace: PanelWorkspaceProjection[];
  pinnedPanels: PinnedPanelEntry[];
}

export interface PrivateWindowLiveGraphSlice {
  windowId: number;
  activeWorkspaceId: string | null;
  tabs: TabSnapshot[];
  tabFolders: TabFolder[];
  panelsByWorkspace: PanelWorkspaceProjection[];
  pinnedPanels: PinnedPanelEntry[];
}

export type TargetedGraphEvent =
  | {
      type: 'graph/regular-snapshot';
      backendInstanceId: string;
      publicationId: string;
      graphRevision: number;
      reason: 'connect' | 'replacement';
      requiresAck: boolean;
      audience: { kind: 'regular' };
      profile: ProfileGraphSlice;
      live: RegularLiveGraphSlice;
    }
  | {
      type: 'graph/private-snapshot';
      backendInstanceId: string;
      publicationId: string;
      graphRevision: number;
      reason: 'connect' | 'refresh';
      requiresAck: false;
      audience: { kind: 'private-window'; windowId: number };
      profile: ProfileGraphSlice;
      live: PrivateWindowLiveGraphSlice;
    }
  | {
      type: 'graph/resync-required';
      backendInstanceId: string;
      publicationId: string;
      graphRevision: number;
      audience: { kind: 'regular' };
    };

export type ShellClientToTools =
  | {
      type: 'shell-client/register';
      shellBackgroundInstanceId: string;
      clientInstanceId: string;
      mountToken: string;
      role: 'primary' | 'auxiliary';
      windowId: number;
      audience: 'regular' | 'private';
      registryRevision: number;
    }
  | {
      type:
        | 'shell-client/ready'
        | 'shell-client/heartbeat'
        | 'shell-client/hidden'
        | 'shell-client/bye';
      shellBackgroundInstanceId: string;
      clientInstanceId: string;
      windowId: number;
      registryRevision: number;
    }
  | {
      type: 'shell-client/delivery';
      deliveryId: string;
      targetClientInstanceId: string;
      disposition: 'routed' | 'target-missing' | 'binding-mismatch';
    }
  | {
      type: 'shell-client/action';
      clientInstanceId: string;
      windowId: number;
      action: 'graph/applied' | 'graph/already-applied';
      backendInstanceId: string;
      publicationId: string;
      graphRevision: number;
      registryRevision: number;
    };

export interface ToolsToShellTargeted {
  type: 'shell-client/event';
  shellBackgroundInstanceId: string;
  targetClientInstanceId: string;
  expectedRole: 'primary' | 'auxiliary';
  expectedWindowId: number;
  expectedAudience: 'regular' | 'private';
  deliveryId: string;
  event: TargetedGraphEvent;
}

export function isShellClientMessage(value: unknown): value is ShellClientToTools {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<ShellClientToTools> & Record<string, unknown>;
  const exact = (required: string[]) => {
    const keys = Object.keys(message);
    return (
      required.every((key) => Object.hasOwn(message, key)) &&
      keys.every((key) => required.includes(key))
    );
  };
  switch (message.type) {
    case 'shell-client/register':
      return (
        exact([
          'type',
          'shellBackgroundInstanceId',
          'clientInstanceId',
          'mountToken',
          'role',
          'windowId',
          'audience',
          'registryRevision',
        ]) &&
        typeof message.shellBackgroundInstanceId === 'string' &&
        typeof message.clientInstanceId === 'string' &&
        typeof message.mountToken === 'string' &&
        (message.role === 'primary' || message.role === 'auxiliary') &&
        Number.isInteger(message.windowId) &&
        (message.audience === 'regular' || message.audience === 'private') &&
        Number.isSafeInteger(message.registryRevision)
      );
    case 'shell-client/ready':
    case 'shell-client/heartbeat':
    case 'shell-client/hidden':
    case 'shell-client/bye':
      return (
        exact([
          'type',
          'shellBackgroundInstanceId',
          'clientInstanceId',
          'windowId',
          'registryRevision',
        ]) &&
        typeof message.shellBackgroundInstanceId === 'string' &&
        typeof message.clientInstanceId === 'string' &&
        Number.isInteger(message.windowId) &&
        Number.isSafeInteger(message.registryRevision)
      );
    case 'shell-client/delivery':
      return (
        exact(['type', 'deliveryId', 'targetClientInstanceId', 'disposition']) &&
        typeof message.deliveryId === 'string' &&
        typeof message.targetClientInstanceId === 'string' &&
        ['routed', 'target-missing', 'binding-mismatch'].includes(String(message.disposition))
      );
    case 'shell-client/action':
      return (
        exact([
          'type',
          'clientInstanceId',
          'windowId',
          'action',
          'backendInstanceId',
          'publicationId',
          'graphRevision',
          'registryRevision',
        ]) &&
        typeof message.clientInstanceId === 'string' &&
        Number.isInteger(message.windowId) &&
        (message.action === 'graph/applied' || message.action === 'graph/already-applied') &&
        typeof message.backendInstanceId === 'string' &&
        typeof message.publicationId === 'string' &&
        Number.isSafeInteger(message.graphRevision) &&
        Number.isSafeInteger(message.registryRevision)
      );
    default:
      return false;
  }
}

export function isTargetedShellEvent(value: unknown): value is ToolsToShellTargeted {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<ToolsToShellTargeted>;
  return (
    Object.keys(message).length === 8 &&
    Object.keys(message).every((key) =>
      [
        'type',
        'shellBackgroundInstanceId',
        'targetClientInstanceId',
        'expectedRole',
        'expectedWindowId',
        'expectedAudience',
        'deliveryId',
        'event',
      ].includes(key),
    ) &&
    message.type === 'shell-client/event' &&
    typeof message.shellBackgroundInstanceId === 'string' &&
    typeof message.targetClientInstanceId === 'string' &&
    (message.expectedRole === 'primary' || message.expectedRole === 'auxiliary') &&
    typeof message.expectedWindowId === 'number' &&
    (message.expectedAudience === 'regular' || message.expectedAudience === 'private') &&
    typeof message.deliveryId === 'string' &&
    Boolean(message.event)
  );
}
