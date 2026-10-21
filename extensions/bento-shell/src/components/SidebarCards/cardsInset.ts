const CARD_SELECTOR = '.bento-sidebar-card';

/**
 * Calls `onInset` with how far the cards in `container` reach up from the bottom of the
 * list, now and each time the container resizes. The container's padding is the gap
 * above the cards and the offset below them (SidebarCards.css), so its measured height
 * is that reach. With no card in it, it is 0. Returns a function that stops observing.
 */
export function observeCardsInset(
  container: Element,
  onInset: (inset: number) => void,
): () => void {
  const report = () =>
    onInset(
      container.querySelector(CARD_SELECTOR)
        ? Math.ceil(container.getBoundingClientRect().height)
        : 0,
    );
  report();
  const observer = new ResizeObserver(report);
  observer.observe(container);
  return () => observer.disconnect();
}
