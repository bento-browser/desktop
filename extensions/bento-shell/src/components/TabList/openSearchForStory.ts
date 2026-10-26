// Story helper: opens the sidebar search field and types `query` the way a user does. TabList
// owns the search state, so click the trigger, then set the input through the native setter so
// React sees an input event. Both are looked up in the incoming pane: during a workspace slide
// the outgoing pane is rendered first and its search is a no-op. Returns the cleanup.
export function openSearchForStory(query: string): () => void {
  let frame = 0;
  const open = () => {
    const pane = document.querySelector<HTMLElement>(
      '.bento-tab-list-pane:not([class*="bento-tab-list-pane--exit-"])',
    );
    const trigger = pane?.querySelector<HTMLElement>('.bento-tab-list__search-button');
    const input = pane?.querySelector<HTMLInputElement>('.bento-tab-list-search__input');
    if (!trigger || !input) {
      frame = requestAnimationFrame(open);
      return;
    }
    trigger.click();
    if (!query) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  frame = requestAnimationFrame(open);
  return () => cancelAnimationFrame(frame);
}
