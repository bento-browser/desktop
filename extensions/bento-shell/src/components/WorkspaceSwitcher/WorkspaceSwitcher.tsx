import { Menu } from '@tale-ui/react/menu';
import { Text } from '@tale-ui/react/text';
import { Icon } from '@tale-ui/react/icon';
import { Avatar } from '@tale-ui/react/avatar';
import { useShallow } from 'zustand/shallow';
// Per-icon deep imports — barrel is forbidden by eslint (bundle size, §6.2).
import Check from 'lucide-react/dist/esm/icons/check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import ChevronsUpDown from 'lucide-react/dist/esm/icons/chevrons-up-down';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import Pencil from 'lucide-react/dist/esm/icons/pencil';

import { useWorkspacesStore } from '../../state/workspaces';
import { useWorkspaceTabIds } from '../../state/tabs';
import { dispatch } from '../../bridge/useToolsPort';
import { requestConfirm } from '../../bridge/useConfirm';
import { requestEditWorkspace } from '../../bridge/useEditWorkspace';
import './WorkspaceSwitcher.css';

const NEW_WORKSPACE_KEY = '__new__';
const EDIT_WORKSPACE_KEY = '__edit__';
const DELETE_WORKSPACE_KEY = '__delete__';
// Rotates through the per-workspace accent presets defined in bento-tokens.css.
const COLOR_ROTATION = ['blue', 'emerald', 'amber'] as const;

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?';
}

export function WorkspaceSwitcher() {
  // useShallow keeps the snapshot referentially stable when neither orderedIds
  // nor any individual workspace has changed — required by useSyncExternalStore
  // to avoid the "infinite loop" guard React throws on unstable snapshots.
  const workspaces = useWorkspacesStore(useShallow((s) => s.orderedIds.map((id) => s.byId[id]!)));
  const activeId = useWorkspacesStore((s) => s.activeId);
  const active = activeId ? workspaces.find((w) => w.id === activeId) : undefined;
  const tabIdsInActive = useWorkspaceTabIds(activeId);
  const tabCount = tabIdsInActive.length;
  // Cannot delete the last workspace — UI would have no workspace to fall
  // back to and tabs would orphan. Disable the delete affordance instead.
  const canDelete = workspaces.length > 1 && active !== undefined;
  const canEdit = active !== undefined;

  const onActivate = (id: string) => dispatch({ type: 'workspace/activate', id });
  const onCreate = () => {
    const nextIndex = workspaces.length;
    dispatch({
      type: 'workspace/create',
      name: `Workspace ${nextIndex + 1}`,
      color: COLOR_ROTATION[nextIndex % COLOR_ROTATION.length],
    });
  };
  const onRequestEdit = () => {
    if (!canEdit || !active) return;
    // Edit form lives in a chrome-mounted overlay (edit-workspace.html)
    // so the modal covers the whole window — sidebar must never host
    // modal UI. Same pattern as the delete-confirmation overlay.
    requestEditWorkspace({
      workspaceId: active.id,
      name: active.name,
      color: active.color,
      icon: active.icon,
    });
  };
  const onRequestDelete = () => {
    if (!canDelete || !active) return;
    if (tabCount === 0) {
      // No friction needed — empty workspace deletes immediately.
      dispatch({ type: 'workspace/delete', id: active.id, closeTabs: false });
      return;
    }
    requestConfirm({
      title: `Delete "${active.name}"?`,
      description: `This will close ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'} in this workspace. This action cannot be undone.`,
      confirmLabel: 'Delete workspace',
      variant: 'danger',
      action: { type: 'workspace/delete', id: active.id, closeTabs: true },
    });
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        className="bento-workspace-switcher__trigger"
        aria-label={active ? `Workspace ${active.name} — switch workspace` : 'Switch workspace'}
      >
        <Avatar.Root
          size="sm"
          className="bento-workspace-switcher__avatar"
          data-workspace-color={active?.color}
        >
          <Avatar.Fallback>{active?.icon || workspaceInitial(active?.name ?? '?')}</Avatar.Fallback>
        </Avatar.Root>
        <Text variant="text" size="s" className="bento-workspace-switcher__trigger-name">
          {active?.name ?? 'No workspace'}
        </Text>
        <Icon icon={ChevronsUpDown} size="sm" className="bento-workspace-switcher__chevron" />
      </Menu.Trigger>
      <Menu.Popover
        placement="bottom start"
        offset={4}
        className="bento-workspace-switcher__popover"
      >
        <Menu.MenuList aria-label="Workspaces">
          {workspaces.map((w) => (
            <Menu.Item key={w.id} id={w.id} textValue={w.name} onAction={() => onActivate(w.id)}>
              <Avatar.Root
                size="sm"
                className="bento-workspace-switcher__avatar"
                data-workspace-color={w.color}
              >
                <Avatar.Fallback>{w.icon || workspaceInitial(w.name)}</Avatar.Fallback>
              </Avatar.Root>
              <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
                {w.name}
              </Text>
              {w.id === activeId ? <Icon icon={Check} size="sm" label="Active" /> : null}
            </Menu.Item>
          ))}
          <Menu.Separator />
          <Menu.Item id={NEW_WORKSPACE_KEY} textValue="New workspace" onAction={onCreate}>
            <Icon icon={Plus} size="sm" />
            <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
              New workspace
            </Text>
          </Menu.Item>
          {canEdit ? (
            <Menu.Item
              id={EDIT_WORKSPACE_KEY}
              textValue={`Edit ${active!.name}`}
              onAction={onRequestEdit}
            >
              <Icon icon={Pencil} size="sm" />
              <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
                Edit {active!.name}
              </Text>
            </Menu.Item>
          ) : null}
          {canDelete ? (
            <Menu.Item
              id={DELETE_WORKSPACE_KEY}
              textValue={`Delete ${active!.name}`}
              onAction={onRequestDelete}
              className="bento-workspace-switcher__delete-item"
            >
              <Icon icon={Trash2} size="sm" />
              <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
                Delete {active!.name}
              </Text>
            </Menu.Item>
          ) : null}
        </Menu.MenuList>
      </Menu.Popover>
    </Menu.Root>
  );
}
