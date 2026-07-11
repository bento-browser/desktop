import { memo, useEffect, useRef, useState } from 'react';
import { Icon } from '@tale-ui/react/icon';
import { Text } from '@tale-ui/react/text';
import Folder from 'lucide-react/dist/esm/icons/folder';
import FolderOpen from 'lucide-react/dist/esm/icons/folder-open';
import type { TabFolder } from '@shared/protocol';
import { dispatch } from '../../bridge/useToolsPort';
import { useUiStore } from '../../state/ui';
import './FolderRow.css';

export interface FolderRowProps {
  folder: TabFolder;
  tabCount: number;
  dragging?: boolean;
  dropTarget?: boolean;
  onContextMenu?: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  onToggleCollapsed?: (id: string, collapsed: boolean) => void;
  onDragStart?: (id: string) => void;
  onDragEnd?: (id: string) => void;
}

function FolderRowImpl({
  folder,
  tabCount,
  dragging = false,
  dropTarget = false,
  onContextMenu,
  onToggleCollapsed,
  onDragStart,
  onDragEnd,
}: FolderRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(folder.name);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameRequest = useUiStore((state) => state.renameRequest);
  const clearRenameRequest = useUiStore((state) => state.clearRenameRequest);
  const draggable = onDragStart !== undefined;

  const commitRename = () => {
    if (!renaming) return;
    const next = draftTitle.trim();
    if (next.length > 0 && next !== folder.name) {
      dispatch({ type: 'tabFolder/rename', id: folder.id, name: next });
    }
    setRenaming(false);
  };
  const cancelRename = () => {
    setDraftTitle(folder.name);
    setRenaming(false);
  };

  useEffect(() => {
    if (renameRequest?.kind !== 'folder' || renameRequest.id !== folder.id) return;
    if (!dragging) {
      setDraftTitle(folder.name);
      setRenaming(true);
    }
    clearRenameRequest();
  }, [clearRenameRequest, dragging, folder.id, folder.name, renameRequest]);

  useEffect(() => {
    if (!renaming) return;
    let stopped = false;
    let raf = 0;
    const deadline = performance.now() + 500;
    const focusInput = () => {
      const input = renameInputRef.current;
      if (!input) return;
      window.focus();
      input.focus();
      input.select();
      if (document.activeElement === input || performance.now() >= deadline || stopped) return;
      raf = requestAnimationFrame(focusInput);
    };
    focusInput();
    const timer = setTimeout(focusInput, 80);
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [renaming]);

  return (
    <div
      className={
        'bento-folder-row' +
        (dragging ? ' bento-folder-row--dragging' : '') +
        (dropTarget ? ' bento-folder-row--drop-target' : '')
      }
      draggable={draggable && !renaming}
      title={folder.name}
      onDragStart={
        draggable
          ? (event) => {
              event.dataTransfer.effectAllowed = 'move';
              try {
                event.dataTransfer.setData('application/x-bento-folder-id', folder.id);
              } catch {
                // Drag state is also tracked in React state.
              }
              onDragStart(folder.id);
            }
          : undefined
      }
      onDragEnd={draggable ? () => onDragEnd?.(folder.id) : undefined}
      onClick={() => {
        if (renaming || dragging) return;
        const collapsed = !folder.collapsed;
        if (onToggleCollapsed) onToggleCollapsed(folder.id, collapsed);
        else dispatch({ type: 'tabFolder/setCollapsed', id: folder.id, collapsed });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(folder.id, event);
      }}
    >
      <span className="bento-folder-row__icon">
        <Icon icon={folder.collapsed ? Folder : FolderOpen} size="sm" />
      </span>
      {renaming ? (
        <input
          ref={renameInputRef}
          className="bento-folder-row__rename-input"
          value={draftTitle}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraftTitle(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelRename();
            }
          }}
          onBlur={commitRename}
        />
      ) : (
        <Text className="bento-folder-row__label" variant="text" size="s" color="muted">
          {folder.name}
        </Text>
      )}
      {!renaming && (
        <Text className="bento-folder-row__count" variant="text" size="xs">
          {tabCount}
        </Text>
      )}
    </div>
  );
}

export const FolderRow = memo(FolderRowImpl);
