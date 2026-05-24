// PanelTrailer — the row of buttons that sits at the end of the chrome
// panel strip. The "+" creates a new blank panel; each subsequent
// favicon button opens a bookmark from the "Saved panels" folder as a
// new panel.
//
// Lives inside a moz-extension iframe hosted by the chrome XUL trailer
// (see ensureAddPanelTrailer in bento-shell-mount.js). Renders inside
// the chrome window, so Tale UI tooltips can pop up freely without the
// sidebar-iframe clipping problem.
//
// CLAUDE.md / Tale UI guardrails honoured here:
//   - Buttons use Tale UI IconButton directly so the trailer shares the
//     same neutral button styling as the rest of the chrome UI.
//   - No raw design values — favicon size, gap, padding all come from
//     Tale UI / Bento token vars (see PanelTrailer.css).
//   - Each saved-panel favicon uses the tools-resolved `favIconUrl`
//     when available, and falls back to a placeholder when no icon can
//     be resolved.

import { useEffect, useState } from 'react';
import { Tooltip } from '@tale-ui/react/tooltip';
import { Icon } from '@tale-ui/react/icon';
import { IconButton } from '@tale-ui/react/icon-button';
import { SelectNative } from '@tale-ui/react/select-native';
import Plus from 'lucide-react/dist/esm/icons/plus';
import type { SavedPanelEntry } from '@shared/protocol';
import './PanelTrailer.css';

export interface PanelTrailerProps {
  items: SavedPanelEntry[];
  /** Fired when the user clicks "+" or hits Enter on it. */
  onAddBlank: () => void;
  /** Fired when the user clicks a saved-panel favicon button. */
  onOpenSaved: (url: string) => void;
}

export function PanelTrailer({ items, onAddBlank, onOpenSaved }: PanelTrailerProps) {
  const gridItems = items.slice(0, 8);
  const overflowItems = items.slice(8);
  const savedGridPositions = [0, 1, 2, 3, 5, 6, 7, 8];
  const filledGridPositions = new Set([
    4,
    ...gridItems.map((_item, index) => savedGridPositions[index] ?? 0),
  ]);

  return (
    <div className="bento-panel-trailer" role="toolbar" aria-label="Add panel">
      <div className="bento-panel-trailer__grid" aria-label="Saved panels">
        {Array.from({ length: 9 }, (_value, index) =>
          filledGridPositions.has(index) ? null : (
            <div
              key={`placeholder-${index}`}
              className="bento-panel-trailer__placeholder"
              style={{ gridArea: gridAreaForIndex(index) }}
              aria-hidden="true"
            />
          ),
        )}
        {gridItems.map((item, index) => (
          <SavedPanelButton
            key={item.id}
            item={item}
            gridIndex={savedGridPositions[index] ?? 0}
            onOpen={onOpenSaved}
          />
        ))}
        <Tooltip.Root delay={400}>
          <IconButton
            variant="neutral"
            size="sm"
            className="bento-panel-trailer__btn bento-panel-trailer__btn--add"
            style={{ gridArea: gridAreaForIndex(4) }}
            aria-label="New tab panel"
            onPress={onAddBlank}
          >
            <Icon icon={Plus} />
          </IconButton>
          <Tooltip.Popup placement="bottom" offset={8}>
            <Tooltip.Arrow />
            New tab panel
          </Tooltip.Popup>
        </Tooltip.Root>
      </div>
      {overflowItems.length > 0 ? (
        <MoreSavedPanelsSelect items={overflowItems} onOpen={onOpenSaved} />
      ) : null}
    </div>
  );
}

function gridAreaForIndex(index: number): string {
  const row = Math.floor(index / 3) + 1;
  const column = (index % 3) + 1;
  return `${row} / ${column}`;
}

interface SavedPanelButtonProps {
  item: SavedPanelEntry;
  gridIndex: number;
  onOpen: (url: string) => void;
}

function SavedPanelButton({ item, gridIndex, onOpen }: SavedPanelButtonProps) {
  // Tools resolves favicons while it still has access to the source tab.
  // The trailer iframe may not be able to dereference Firefox chrome-only
  // page-icon URLs itself, so only render an image when a concrete icon URL
  // arrived on the snapshot.
  const [iconFailed, setIconFailed] = useState(false);
  const labelText = item.title.trim().length > 0 ? item.title : item.url;
  const iconSrc = item.favIconUrl ?? '';

  useEffect(() => {
    setIconFailed(false);
  }, [iconSrc]);

  return (
    <Tooltip.Root delay={400}>
      <IconButton
        variant="neutral"
        size="sm"
        className="bento-panel-trailer__btn bento-panel-trailer__btn--saved"
        style={{ gridArea: gridAreaForIndex(gridIndex) }}
        aria-label={labelText}
        onPress={() => onOpen(item.url)}
      >
        {!iconSrc || iconFailed ? (
          <span className="bento-panel-trailer__favicon bento-panel-trailer__favicon--placeholder" />
        ) : (
          <img
            className="bento-panel-trailer__favicon"
            src={iconSrc}
            alt=""
            onError={() => setIconFailed(true)}
          />
        )}
      </IconButton>
      <Tooltip.Popup placement="bottom" offset={8}>
        <Tooltip.Arrow />
        {labelText}
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

interface MoreSavedPanelsSelectProps {
  items: SavedPanelEntry[];
  onOpen: (url: string) => void;
}

function MoreSavedPanelsSelect({ items, onOpen }: MoreSavedPanelsSelectProps) {
  return (
    <SelectNative
      size="sm"
      className="bento-panel-trailer__more"
      aria-label="More saved panels"
      defaultValue=""
      onChange={(event) => {
        const selectedId = event.currentTarget.value;
        const selected = items.find((item) => item.id === selectedId);
        event.currentTarget.value = '';
        if (selected) onOpen(selected.url);
      }}
    >
      <option value="">More saved panels</option>
      {items.map((item) => {
        const labelText = item.title.trim().length > 0 ? item.title : item.url;
        return (
          <option key={item.id} value={item.id}>
            {labelText}
          </option>
        );
      })}
    </SelectNative>
  );
}
