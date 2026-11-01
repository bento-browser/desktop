// Small parts the bookmark popup and the bookmarks toolbar share: a colour dot, a link's icon,
// the invisible button a popup anchors to, and the ways a popup is dismissed without a press on it
// (Esc with no focus inside it, chrome hiding the overlay).

import { useEffect, useRef, useState } from 'react';
import { Button, Menu } from '@muxui/react';
import type { BookmarkColor } from '@shared/protocol';
import Globe from 'lucide-react/dist/esm/icons/globe';

import type { PopupRect } from '../../bridge/bookmarkPopup';
import { hostHiddenSinceOpen, subscribeToHostHidden } from '../../bridge/hostPresentation';
import { BentoIcon } from '../primitives';

/** A space's or group's colour, drawn the way the Bookmarks view draws it. */
export function ColorDot({ color }: { color: BookmarkColor }) {
  return <span className="bento-bookmark-dot" data-bm-color={color} aria-hidden="true" />;
}

/** A link's icon, or a globe when it has none or it does not load. */
export function LinkIcon({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="bento-bookmark-favicon bento-bookmark-favicon--fallback" aria-hidden="true">
        <BentoIcon icon={Globe} size="sm" />
      </span>
    );
  }
  return (
    <img
      className="bento-bookmark-favicon"
      src={src}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function anchorBox(anchor: PopupRect) {
  return { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height };
}

/** The `trigger` of a Popover: invisible, at the rect of the button that asked, so Mux places the
 * popover against it. The overlay frame covers the window, so its coordinates are the window's. */
export function PopoverAnchor({ anchor }: { anchor: PopupRect }) {
  return (
    <Button
      className="bento-bookmark-popup__anchor"
      aria-hidden
      tabIndex={-1}
      style={anchorBox(anchor)}
    />
  );
}

/** The `Menu.Trigger` of a menu, at the rect of the button that asked (see PopoverAnchor). */
export function MenuAnchor({ anchor }: { anchor: PopupRect }) {
  return (
    <Menu.Trigger
      className="bento-bookmark-popup__anchor"
      aria-hidden
      tabIndex={-1}
      style={anchorBox(anchor)}
    />
  );
}

/** Runs `onEscape` on an Esc that nothing inside the popup handled. Mux closes a popup on Esc
 * while the focus is inside it (and stops the event there); the focus can still be on the page
 * behind the transparent overlay, and this closes the popup then. */
export function useEscape(onEscape: () => void): void {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        latest.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Runs `onHidden` when chrome hides the overlay on its own (a resize, a tab change, another
 * overlay). The popup then gets no click or key, so this is its only chance to keep unfinished
 * work and to report that it is gone. A hide that came before this subscribed (chrome hid the
 * host while the open was on its way) runs it as soon as the popup mounts. */
export function useHostHidden(onHidden: () => void): void {
  const latest = useRef(onHidden);
  useEffect(() => {
    latest.current = onHidden;
  });
  useEffect(() => {
    if (hostHiddenSinceOpen()) latest.current();
    return subscribeToHostHidden(() => latest.current());
  }, []);
}
