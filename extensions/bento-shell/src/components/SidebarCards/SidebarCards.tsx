import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useSidebarCardsStore } from '../../state/sidebarCards';
import { observeCardsInset } from './cardsInset';
import './SidebarCards.css';

/**
 * Holds the floating cards over the bottom of the tab list, above the footer rail, and
 * reports how much of the list they cover (the cards' measured height plus the offset
 * and gap the stylesheet puts around them) to `useSidebarCardsStore`, so the list can
 * pad its end by that much. Place it as a sibling of the list inside a positioned
 * wrapper. A card is any `.bento-sidebar-card` element; with none, the container takes
 * no space and the inset is 0.
 */
export function SidebarCards({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { setInset } = useSidebarCardsStore.getState();
    const stop = observeCardsInset(container, setInset);
    return () => {
      stop();
      setInset(0);
    };
  }, []);

  return (
    <div ref={containerRef} className="bento-sidebar-cards">
      {children}
    </div>
  );
}
