import { memo, useEffect, useId, useRef, useState } from 'react';
import { Text } from '@tale-ui/react/text';
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import { Spinner } from '@tale-ui/react/spinner';
// Per-icon imports (no lucide-react barrel — see eslint config + §6.2).
import X from 'lucide-react/dist/esm/icons/x';
import PanelRightOpen from 'lucide-react/dist/esm/icons/panel-right-open';
import Volume2 from 'lucide-react/dist/esm/icons/volume-2';
import VolumeX from 'lucide-react/dist/esm/icons/volume-x';
import type { TabSnapshot } from '@shared/protocol';

import { dispatch } from '../../bridge/useToolsPort';
import { useTab } from '../../state/tabs';
import { useUiStore } from '../../state/ui';
import './TabRow.css';

export interface TabRowProps {
  id: number;
  active: boolean;
  /** True while this row is being removed from the list. TabList keeps
   * the row mounted briefly so it can fade out via the
   * `bento-tab-row--removing` modifier before the virtualizer drops it. */
  removing?: boolean;
  /** True while this row is the source of an in-flight drag. Dimmed via
   * the `bento-tab-row--dragging` modifier so the user has a clear cue
   * which row is being moved — Firefox renders a translucent drag-image
   * floating with the cursor, but the in-list source row still occupies
   * its original slot and without an explicit modifier it reads
   * identically to a stationary row. */
  dragging?: boolean;
  indent?: boolean;
  selected?: boolean;
  onActivate: (id: number, event: React.MouseEvent<HTMLDivElement>) => void;
  onClose: (id: number) => void;
  /** Open this tab's URL in the chrome side panel (Bento Spaces M2-PR-3
   * foundation). Tools resolves the URL and tells chrome to reveal +
   * navigate the side <browser>. */
  onOpenInSidePanel: (id: number) => void;
  onContextMenu?: (id: number, event: React.MouseEvent<HTMLDivElement>) => void;
  /** Drag-source hooks supplied by TabList when reordering is enabled.
   * When undefined the row is non-draggable (stories without reorder
   * coverage, future read-only variants). */
  onDragStart?: (id: number) => void;
  onDragEnd?: (id: number) => void;
}

function TabRowImpl({
  id,
  active,
  removing = false,
  dragging = false,
  indent = false,
  selected = false,
  onActivate,
  onClose,
  onOpenInSidePanel,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: TabRowProps) {
  const liveTab = useTab(id);
  // Cache the last seen tab data so we can keep rendering after the store
  // drops the entry. The TabList delayed-removal hook keeps this row mounted
  // for a brief window after the store removes the tab so the
  // bento-tab-row--removing CSS transition can fade it out — but useTab(id)
  // returns undefined the moment the store entry is gone, which would
  // unmount the row's DOM and skip the fade. Falling back to the cached
  // snapshot lets the fade actually run.
  const lastSeenRef = useRef<TabSnapshot | undefined>(liveTab);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const renameRequest = useUiStore((state) => state.renameRequest);
  const clearRenameRequest = useUiStore((state) => state.clearRenameRequest);
  const convertToPanelDescriptionId = useId();
  const closeTabDescriptionId = useId();
  if (liveTab) lastSeenRef.current = liveTab;
  const tab = liveTab ?? lastSeenRef.current;
  if (!tab) return null;

  const loading = tab.loading ?? false;
  const discarded = tab.discarded ?? false;
  const audible = tab.audible;
  const muted = tab.muted ?? false;
  const showAudioControl = audible || muted;
  const displayTitle = tab.customTitle || tab.title || 'Untitled';
  const convertToPanelLabel = 'Convert to panel';
  const closeTabLabel = 'Close tab';
  const audioLabel = muted ? 'Unmute tab' : 'Mute tab';

  const draggable = onDragStart !== undefined;

  const beginRename = () => {
    if (removing || dragging) return;
    setDraftTitle(displayTitle);
    setRenaming(true);
  };
  const commitRename = () => {
    if (!renaming) return;
    const nextTitle = draftTitle.trim();
    if (nextTitle.length === 0) {
      if (tab.customTitle) dispatch({ type: 'tab/rename', id, title: '' });
    } else if (nextTitle !== displayTitle.trim()) {
      dispatch({ type: 'tab/rename', id, title: nextTitle });
    }
    setRenaming(false);
  };
  const cancelRename = () => {
    setDraftTitle(displayTitle);
    setRenaming(false);
  };

  useEffect(() => {
    if (renameRequest?.kind !== 'tab' || renameRequest.id !== id) return;
    if (!removing && !dragging) {
      setDraftTitle(displayTitle);
      setRenaming(true);
    }
    clearRenameRequest();
  }, [clearRenameRequest, displayTitle, dragging, id, removing, renameRequest]);

  return (
    <div
      className={
        'bento-tab-row' +
        (active ? ' bento-tab-row--active' : '') +
        (selected ? ' bento-tab-row--selected' : '') +
        (removing ? ' bento-tab-row--removing' : '') +
        (discarded ? ' bento-tab-row--discarded' : '') +
        (showAudioControl ? ' bento-tab-row--has-audio-control' : '') +
        (muted ? ' bento-tab-row--muted' : '') +
        (dragging ? ' bento-tab-row--dragging' : '') +
        (indent ? ' bento-tab-row--indented' : '')
      }
      draggable={draggable && !renaming}
      onDragStart={
        draggable
          ? (e) => {
              // dataTransfer.effectAllowed='move' tells Firefox the drag is
              // a reorder (no copy variant), which matches the cursor
              // affordance and the drop-effect we'll set in TabList's
              // onDragOver. Setting a small marker on the bento namespace
              // lets future cross-pane drops (workspace → workspace) tell
              // sidebar drags apart from arbitrary external drags.
              e.dataTransfer.effectAllowed = 'move';
              try {
                e.dataTransfer.setData('application/x-bento-tab-id', String(id));
              } catch {
                // setData can throw in some sandbox contexts; the drag
                // still works without it since TabList tracks the
                // source id via its own state.
              }
              onDragStart(id);
            }
          : undefined
      }
      onDragEnd={draggable ? () => onDragEnd?.(id) : undefined}
      onClick={(e) => renaming || removing || dragging || onActivate(id, e)}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        beginRename();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(id, e);
      }}
      onMouseDown={(e) => {
        // Middle-mouse-down triggers the autoscroll cursor — preventDefault
        // suppresses it so the click feels like a normal close action.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        onClose(id);
      }}
      title={
        loading
          ? `Loading — ${displayTitle}`
          : discarded
            ? `Sleeping — ${displayTitle}`
            : displayTitle
      }
    >
      {showAudioControl && (
        <span
          className="bento-tab-row__audio-control"
          title={audioLabel}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => e.stopPropagation()}
        >
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={audioLabel}
            onPress={() => dispatch({ type: 'tab/toggleMuted', id })}
          >
            <Icon icon={muted ? VolumeX : Volume2} />
          </IconButton>
        </span>
      )}
      {/* Loading wins the favicon slot — the throbber is the cue Firefox
       * users expect to mean "fetching". Discarded only dims the favicon
       * (handled via the row modifier in CSS). */}
      {loading ? (
        <span className="bento-tab-row__favicon bento-tab-row__favicon--loading">
          <Spinner size="sm" label="Loading" />
        </span>
      ) : tab.favIconUrl ? (
        <img className="bento-tab-row__favicon" src={tab.favIconUrl} alt="" />
      ) : (
        <span className="bento-tab-row__favicon bento-tab-row__favicon--placeholder" />
      )}
      {renaming ? (
        <input
          className="bento-tab-row__rename-input"
          value={draftTitle}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraftTitle(e.currentTarget.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelRename();
            }
          }}
          onBlur={commitRename}
        />
      ) : (
        <Text variant="text" size="s" color={active ? 'default' : 'muted'}>
          {displayTitle}
        </Text>
      )}
      <div className="bento-tab-row__actions">
        {/* The active tab renders into the main panel — moving it to a side
         * panel would leave the main panel empty. Hide the affordance so the
         * action can't be requested in the first place. */}
        {!active && (
          <span className="bento-tab-row__action-tooltip" title={convertToPanelLabel}>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={convertToPanelLabel}
              aria-describedby={convertToPanelDescriptionId}
              onPress={() => onOpenInSidePanel(id)}
            >
              <Icon icon={PanelRightOpen} />
            </IconButton>
            <span id={convertToPanelDescriptionId} className="bento-tab-row__sr-only">
              Convert this tab into a side panel
            </span>
          </span>
        )}
        <span className="bento-tab-row__action-tooltip" title={closeTabLabel}>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={closeTabLabel}
            aria-describedby={closeTabDescriptionId}
            onPress={() => onClose(id)}
          >
            <Icon icon={X} />
          </IconButton>
          <span id={closeTabDescriptionId} className="bento-tab-row__sr-only">
            Close this tab
          </span>
        </span>
      </div>
    </div>
  );
}

export const TabRow = memo(TabRowImpl, (prev, next) => {
  // Tab content (title/favicon/loading/discarded/audio) reaches TabRowImpl
  // via the useTab(id) selector — its store subscription rerenders the row
  // when those fields shift, so the memo comparator only needs to gate the
  // direct props.
  return (
    prev.id === next.id &&
    prev.active === next.active &&
    (prev.selected ?? false) === (next.selected ?? false) &&
    (prev.removing ?? false) === (next.removing ?? false) &&
    (prev.dragging ?? false) === (next.dragging ?? false) &&
    (prev.indent ?? false) === (next.indent ?? false) &&
    prev.onContextMenu === next.onContextMenu &&
    prev.onDragStart === next.onDragStart &&
    prev.onDragEnd === next.onDragEnd
  );
});
