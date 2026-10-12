# Panel traversal and focus

Part of the [technical notes index](../core-functionality-technical.md).

Panel traversal is split between chrome focus tracking and a JSWindowActor pair:

- `src/browser/actors/BentoKeyChild.sys.mjs` listens in content documents.
- `src/browser/actors/BentoKeyParent.sys.mjs` dispatches a chrome
  `BentoKey:Cycle` or `BentoKey:PanelHistory` event.
- `bento-shell-mount.js` registers the actor with `ChromeUtils.registerWindowActor`
  and handles the custom events by calling the private `navigatePanels` closure
  or the focused panel browser's `goBack()` / `goForward()` methods. The
  registration is process-wide, so every window after the first gets Firefox
  154's `NotSupportedError` ("'BentoKey' actor is already registered");
  `registerContentKeyActor()` ignores it.

The actor forwards `Cmd/Ctrl+Shift+ArrowLeft` and
`Cmd/Ctrl+Shift+ArrowRight` for panel cycling and `Cmd/Ctrl+ArrowLeft` /
`Cmd/Ctrl+ArrowRight` for panel-local history navigation. It skips editable
targets and already-handled events. Plain Left/Right arrows stay in content for
video scrubbing and page-local keyboard behavior. Other page keys pass
through so keyboard extensions like Vimium still receive normal content key
events.

Panel header Back and Forward buttons left-click the target panel browser's
`goBack()` / `goForward()` methods. Their right-click menu is built in
`bento-shell-mount.js` from that same browser's
`browsingContext.sessionHistory`, falling back to
`SessionStore.getSessionHistory(tab, callback)` when parent-process session
history is not populated. Menu commands call `browser.gotoIndex(index)` for the
panel browser. Do not call Firefox's stock `FillHistoryMenu` or
`BrowserCommands.gotoHistoryIndex` for this surface: both are hard-wired to
`gBrowser.selectedBrowser` / `gBrowser.selectedTab` and would show or navigate
the main tab instead of the panel.

`setActiveByIndex` focuses the panel's `<browser>` for panel targets, not the
chrome notificationbox. The add-panel trailer is the exception: cycle focus
stays on the outer XUL `vbox` so Enter/Space creates a blank panel.

`bento-shell-mount.js` uses `.bento-panel--focused` and
`.bento-panel--cycle-focused` as the source of truth for visible panel focus.
Those classes paint the existing panel ring while keeping the panel header
surface neutral-5 with the standard neutral icon treatment.
DevTools/content partner panels receive the same classes through
`getDevtoolsFocusPartnerElement`, so focusing either side of a pair highlights
both rings.
Cycle navigation applies both classes immediately: `.bento-panel--cycle-focused`
is the short-lived traversal flash, while `.bento-panel--focused` persists on the
actual content slot until focus moves elsewhere. The chrome focus tracker also
re-applies `.bento-panel--focused` when the focus event belongs to the already
active cycle index, because privileged `about:*` pages can move focus into the
main browser while `currentActiveIdx` is already `0`.

Clicking into panel content runs through `updatePanelActivationFromChromeTarget`.
Chrome `focusin` remains the normal signal, but each reconciled split-view
`.browserContainer` and `<browser>` also has a Bento-owned capture-phase `click`
fallback attached after Firefox's native split-view click listener is removed.
This fixes privileged internal pages such as `about:preferences` and
`about:addons`, where the click can focus content without producing the chrome
`focusin` path Bento previously depended on. The fallback updates
`currentActiveIdx`, the favicon navigator marker, the persistent focus ring, and
the minimal strip reveal without calling `setActiveByIndex`, so it does not
promote the panel to `gBrowser.selectedTab` or steal focus from the clicked
control.

Cmd/Ctrl+Shift+arrow and Shift-wheel traversal must use minimal reveal
scrolling. If the next cycle target is already fully visible, the strip should
not scroll. When the target reaches an edge, call `scrollPanelIntoViewFromRight`
so the strip only nudges enough to reveal the target instead of snapping the
target to the leftmost slot. Navigator favicon clicks are the explicit
left-align affordance and still use `scrollPanelToLeftmost`.

The `Wrap panel shortcut cycling at the ends` setting applies to shortcut
traversal only. Shift-wheel panel cycling must always clamp at the first and
last cycle targets; do not let scroll gestures loop back to the start or end.
When the Add-panel trailer receives focus, the `focusin` auto-scroll listener
must call `scrollPanelIntoViewFromRight` for `#bento-add-panel-trailer`, then
return before panel-index bookkeeping. The capture-phase focus tracker must
still ignore trailer focus. The trailer sits under an ancestor with
`data-bento-main-panel`, so an unguarded `closest()` lookup can misidentify
trailer focus as main-panel focus and reset `currentActiveIdx` to 0. That makes
the next scroll gesture appear to loop back to the main content slot even when
wheel traversal is clamped.

The Add-panel trailer's visible cycle indicator belongs on the outer
`#bento-add-panel-trailer` XUL host, not only inside the iframe. The host is the
actual arrow-cycle focus target; the iframe owns pointer/Tab focus for the
individual buttons.

The outer Add-panel trailer `keydown` handler is only for cycle-Enter or
cycle-Space while the outer XUL host itself is focused. When focus has moved
inside the trailer iframe, the iframe buttons own Enter/Space. Do not let saved
panel button keyboard activation bubble back to the outer host, or a saved-panel
Enter press will create a blank add-as-panel marker panel (see "Add-panel
grant") instead of opening the saved URL.

The chrome `Cmd/Ctrl+W` intercept closes the focused side panel before falling
back to main-slot close. Resolve the panel first from `document.activeElement`,
then from `Services.focus.focusedContentBrowsingContext.top.embedderElement`,
then from `currentFocusedPanelTabId` plus the visible `.bento-panel--focused`
state. Privileged `about:*` pages, especially `about:preferences` and
`about:settings`, can leave chrome `activeElement` outside the panel even while
the panel owns content focus; without the focused-browser/focused-panel fallback
the shortcut falls through to `tab/closeMain` and removes the main content tab.

Boot-time strip scroll restore uses `stripScrollLeft` from `panels/sync` and
applies it after the flat layout commits. When restoring to a nonzero scroll
position on first launch, keep `__suppressNextMainAutoScrollForWorkspace` armed
until the user explicitly navigates to the main slot. Both the reconcile-time
main auto-scroll and the `focusin` auto-scroll path must respect that guard;
otherwise the first click in chrome, the address bar, or browser content can
reinterpret Firefox's settled main-browser focus as intent to reveal the main
slot and yank the strip back to the left.

Pinned-panel rail activation dispatches `pinnedPanel/open`. Tools first checks
whether the pinned panel still exists; if so, it activates the owning workspace
and emits `scrollToPanelTabId` so chrome scrolls and focuses that exact panel.
If the panel/tab was closed, the pin remains URL-backed, tools recreates the
panel in the owning workspace, rebinds the pin to the replacement tab id, and
then emits `scrollToPanelTabId`. Recreated pinned panels use the pin's
remembered `widthPx` when present, falling back to the normal default new-panel
width only for older pins without width metadata.

Panel creation flows (`panel/add`, `panel/openAt`, and the chrome add-panel
marker path) emit `scrollToPanelReveal: 'right-edge'` with `scrollToPanelTabId`.
Chrome still focuses the new panel, but reveals it with the same minimal-scroll
path as panel cycling: if the new panel fits in the visible strip, its right
edge lands against the strip's right edge instead of snapping the panel's left
edge next to the sidebar. Wider-than-visible panels fall back to left-edge
alignment so the header and start of the content remain usable. The scheduled
reveal must retry until the target panel is fully visible; a one-shot
right-edge scroll can be clamped against stale `scrollWidth` while a saved-panel
or blank add-panel insertion is still settling.

## Traversal pitfalls

- Do not focus chrome panel containers as the normal traversal target. Content
  key extensions need DOM focus inside the page.
- Do not use `scrollPanelToLeftmost` for shortcut or Shift-wheel traversal.
  That makes focus appear locked to the left edge and hides visible context.
- Do not let Shift-wheel traversal inherit shortcut wraparound. Pass
  `allowWrap: false` when scroll gestures call `navigatePanels`.
- Do not let trailer focus update `currentActiveIdx` through ancestor
  `data-bento-main-panel` lookup.
- Do not let the persistent focus ring depend on a later chrome focus event
  after wheel/shortcut cycle. `setActiveByIndex` and `focusPanelCycleTarget`
  must update `.bento-panel--focused` directly, otherwise cycling back to main
  can leave the first side panel painted as focused while main content owns
  focus.
- Do not skip the persistent focus-ring refresh just because a chrome focus
  event resolves to the current `currentActiveIdx`. That same-index case is how
  tabbing into an already-active main `about:*` browser restores the main-slot
  focus indicator.
- Do not rely only on chrome `focusin` to detect click-into-panel activation.
  Privileged `about:*` pages can skip that path, so reconciled panel
  `.browserContainer` / `<browser>` nodes keep a Bento click fallback that
  updates the focused-panel ring, navigator marker, and strip reveal without
  forcing focus away from the clicked content control.
- Do not route `Cmd/Ctrl+W` straight to main-slot close when no active chrome
  ancestor resolves to `[data-bento-panel-tab-id]`. Check Firefox's focused
  content embedder and the persisted focused panel indicator first so focused
  `about:*` panel content closes its panel.
- Do not forward plain arrow keys, or panel shortcuts from editable targets, in
  the actor.
- Do not activate a pinned panel by setting `gBrowser.selectedTab` to the panel
  tab. That relocates the panel into the main slot.
- The actor files must live under `src/browser/actors/` and be registered into
  Firefox with `patches/chrome-layout/04-bento-key-actors.patch`. The build sync
  script also copies them into built app actor targets.
