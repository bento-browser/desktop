import { useSyncExternalStore } from 'react';
import { RAIL_TRANSITION_ATTRIBUTE } from './railTransition';

const subscribe = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [RAIL_TRANSITION_ATTRIBUTE],
  });
  return () => observer.disconnect();
};

const readRunning = () => document.documentElement.hasAttribute(RAIL_TRANSITION_ATTRIBUTE);

/**
 * True while the sidebar's collapse or expand choreography runs (`data-bento-rail-transition`
 * is `collapse`, `expand` or `measure`). The phase measures the rows at its start, and a
 * reversal starts the next one from a render that still sees the old phase, so what
 * removes the rows (the search results) waits for the attribute to go.
 */
export function useRailTransitioning(): boolean {
  return useSyncExternalStore(subscribe, readRunning);
}
