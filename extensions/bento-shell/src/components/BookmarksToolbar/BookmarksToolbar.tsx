// The bookmarks toolbar: the strip under the top bar that replaces Firefox's own while the Bento
// bookmark manager is on. It lists the groups of the current space as menus, with the Spaces menu
// at the right, and moves the groups that do not fit behind an overflow button. It holds no popup
// itself: each button sends its own rect, and the popup overlay (components/BookmarkPopup) draws
// the menu over the window. The strip is a transparent document inside a chrome frame (see
// bookmarks-toolbar/main.tsx).

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton, Text, Toolbar } from '@muxui/react';
import type { BookmarksSnapshot } from '@shared/protocol';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import ChevronsRight from 'lucide-react/dist/esm/icons/chevrons-right';

import type { BookmarkPopupKey, BookmarkPopupRequest, PopupRect } from '../../bridge/bookmarkPopup';
import { ColorDot } from '../BookmarkPopup/parts';
import { BentoIcon } from '../primitives';
import { toolbarModel, visibleGroupCount } from './model';
import './BookmarksToolbar.css';

export interface BookmarksToolbarProps {
  snapshot: BookmarksSnapshot | null;
  /** The popup this window has open, so its button reads as pressed. */
  openKey: BookmarkPopupKey | null;
  /** A button was pressed: the popup to open, anchored to the button. */
  onOpenPopup: (request: BookmarkPopupRequest) => void;
}

function rectOf(element: Element): PopupRect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

export function BookmarksToolbar({ snapshot, openKey, onOpenPopup }: BookmarksToolbarProps) {
  const model = toolbarModel(snapshot);
  const groupsRef = useRef<HTMLDivElement>(null);
  // How many group buttons fit; null until measured, which shows all of them for that first layout.
  const [fitCount, setFitCount] = useState<number | null>(null);
  const groups = model?.groups ?? [];
  const signature = groups.map((group) => `${group.id}:${group.name}`).join('\n');
  // The row of group buttons exists only while the space has a link to show.
  const hasRow = model !== null && model.linkCount > 0;

  const measure = useCallback(() => {
    const row = groupsRef.current;
    if (!row) return;
    // Buttons that are out of the row are still laid out (hidden, not removed), so they measure.
    const widths = Array.from(
      row.querySelectorAll<HTMLElement>('[data-bm-toolbar-group]'),
      (el) => el.offsetWidth,
    );
    const overflow = row.querySelector<HTMLElement>('[data-bm-toolbar-overflow]');
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    setFitCount(visibleGroupCount(widths, row.clientWidth, gap, overflow?.offsetWidth ?? 0));
  }, []);

  // Before paint, so a first layout never flashes buttons that then move to the overflow.
  useLayoutEffect(measure, [measure, signature, hasRow]);
  useLayoutEffect(() => {
    const row = groupsRef.current;
    if (!row) return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [measure, hasRow]);

  if (!model) return null;
  const { space, groups: spaceGroups } = model;
  const shown = fitCount === null ? spaceGroups.length : Math.min(fitCount, spaceGroups.length);
  const hidden = spaceGroups.slice(shown);

  return (
    <Toolbar className="bento-bookmarks-toolbar" aria-label="Bookmarks">
      {!hasRow ? (
        <Text
          variant="body"
          size="sm"
          color="muted"
          truncate
          className="bento-bookmarks-toolbar__hint"
        >
          No bookmarks in {space.name}
        </Text>
      ) : (
        <div ref={groupsRef} className="bento-bookmarks-toolbar__groups">
          {spaceGroups.map((group, index) => {
            const key: BookmarkPopupKey = `group:${group.id}`;
            const out = index >= shown;
            return (
              <Button
                key={group.id}
                variant="ghost"
                size="sm"
                className="bento-bookmarks-toolbar__button"
                data-bm-toolbar-group=""
                data-bm-out={out ? '' : undefined}
                data-bm-pressed={openKey === key ? '' : undefined}
                aria-haspopup="menu"
                aria-expanded={openKey === key}
                aria-hidden={out || undefined}
                tabIndex={out ? -1 : undefined}
                onActivate={(event) =>
                  onOpenPopup({ kind: 'group', groupId: group.id, anchor: rectOf(event.target) })
                }
              >
                <ColorDot color={group.color} />
                <span className="bento-bookmarks-toolbar__name">{group.name}</span>
                <BentoIcon
                  icon={ChevronDown}
                  size="xs"
                  className="bento-bookmarks-toolbar__chevron"
                />
              </Button>
            );
          })}
          <IconButton
            variant="ghost"
            size="sm"
            className="bento-bookmarks-toolbar__overflow"
            aria-label="More groups"
            aria-haspopup="menu"
            aria-expanded={openKey === 'overflow'}
            data-bm-toolbar-overflow=""
            data-bm-out={hidden.length === 0 ? '' : undefined}
            data-bm-pressed={openKey === 'overflow' ? '' : undefined}
            aria-hidden={hidden.length === 0 || undefined}
            tabIndex={hidden.length === 0 ? -1 : undefined}
            onActivate={(event) =>
              onOpenPopup({
                kind: 'overflow',
                groupIds: hidden.map((group) => group.id),
                anchor: rectOf(event.target),
              })
            }
          >
            <BentoIcon icon={ChevronsRight} size="sm" />
          </IconButton>
        </div>
      )}
      <div className="bento-bookmarks-toolbar__end">
        <Button
          variant="ghost"
          size="sm"
          className="bento-bookmarks-toolbar__button"
          data-bm-pressed={openKey === 'spaces' ? '' : undefined}
          aria-haspopup="menu"
          aria-expanded={openKey === 'spaces'}
          onActivate={(event) => onOpenPopup({ kind: 'spaces', anchor: rectOf(event.target) })}
        >
          <ColorDot color={space.color} />
          <span className="bento-bookmarks-toolbar__name">{space.name}</span>
          <BentoIcon icon={ChevronDown} size="xs" className="bento-bookmarks-toolbar__chevron" />
        </Button>
      </div>
    </Toolbar>
  );
}
