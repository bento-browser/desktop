import { useEffect, useMemo, useRef } from 'react';
import type { FocusEventHandler, PointerEventHandler } from 'react';
import { encodeTitlePayload, sendChromeTitle } from '../../bridge/chromeTitle';

/**
 * Asks chrome to show the panel navigator tooltip overlay beside the rail merge card
 * (`BENTO_RAIL_TOOLTIP` title IPC). The shell frame is the rail wide, so a tooltip drawn
 * in it would be clipped; the overlay is a full-window document that is not.
 * 'hover' waits the overlay's hover delay, 'focus' shows at once, 'hide' hides.
 */
export type RailTooltipAction = 'hover' | 'focus' | 'hide';

export interface RailTooltipText {
  label: string;
  detail: string | null;
}

export interface RailTooltipAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function railTooltipTitle(
  message:
    | { action: 'hide' }
    | ({ action: 'hover' | 'focus'; anchor: RailTooltipAnchor } & RailTooltipText),
  now: number = Date.now(),
): string {
  return `BENTO_RAIL_TOOLTIP:${now}:${encodeTitlePayload(message)}`;
}

/** Sends the messages, and sends 'hide' only while a tooltip may be showing. */
export function createRailTooltipSignal(send: (title: string) => void = sendChromeTitle) {
  let active = false;
  return {
    get active() {
      return active;
    },
    show(action: 'hover' | 'focus', text: RailTooltipText, anchor: RailTooltipAnchor) {
      active = true;
      send(railTooltipTitle({ action, ...text, anchor }));
    },
    hide() {
      if (!active) return;
      active = false;
      send(railTooltipTitle({ action: 'hide' }));
    },
  };
}

const anchorOf = (element: Element): RailTooltipAnchor => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
};

/**
 * Handlers for the rail card's element. Pointer hover and keyboard focus (not a click's
 * focus) ask for the tooltip; leaving, blurring, the rail expanding, the card starting
 * its exit and unmounting all hide it. Text that changes its title while the tooltip is
 * up (the stage moved on) is sent again; a changing count is not, because each send is a
 * title write on the busy chrome channel and the tooltip is a snapshot.
 */
export function useRailTooltip(
  enabled: boolean,
  text: RailTooltipText,
): {
  onPointerEnter?: PointerEventHandler;
  onPointerLeave?: PointerEventHandler;
  onFocus?: FocusEventHandler;
  onBlur?: FocusEventHandler;
} {
  const signal = useMemo(() => createRailTooltipSignal(), []);
  const element = useRef<Element | null>(null);
  const latest = useRef(text);
  latest.current = text;

  useEffect(() => {
    if (!enabled) return;
    return () => signal.hide();
  }, [enabled, signal]);

  useEffect(() => {
    if (signal.active && element.current) {
      signal.show('focus', latest.current, anchorOf(element.current));
    }
  }, [text.label, signal]);

  if (!enabled) return {};
  const show = (action: 'hover' | 'focus', target: Element) => {
    element.current = target;
    signal.show(action, latest.current, anchorOf(target));
  };
  return {
    onPointerEnter: (event) => show('hover', event.currentTarget),
    onPointerLeave: () => signal.hide(),
    onFocus: (event) => {
      if (event.target.matches(':focus-visible')) show('focus', event.currentTarget);
    },
    onBlur: () => signal.hide(),
  };
}
