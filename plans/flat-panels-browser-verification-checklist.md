# Flat Panels Browser Verification Checklist

Use this checklist to manually verify the browser/runtime behavior for
`plans/flat-panels-layout-containers.md`.

For each item, record:

```text
Pass / Fail / Notes / Screenshot or console output
```

Use `✅ Complete` for items that have passed manual verification so completed
items are easy to scan.

## Core Invariants

1. **Flat host DOM**
   - Surface: Browser Toolbox Console.
   - After creating a subdivided layout, paste:

     ```js
     (() => {
       const tp = gBrowser.tabpanels;
       const panels = [...document.querySelectorAll('[data-bento-panel-tab-id]')];
       return panels.map((el) => ({
         tabId: el.dataset.bentoPanelTabId,
         directChild: el.parentNode === tp,
         isSubpanel: el.hasAttribute('data-bento-subpanel'),
         parentTag: el.parentNode?.tagName,
         parentId: el.parentNode?.id,
       }));
     })();
     ```

   - Expected: every visible panel has `directChild: true`; steady-state panels should not have `isSubpanel: true`.

2. **No panel reload on layout-only changes**
   - Open a panel with obvious page state, such as scroll position or form input.
   - Subdivide, fill chooser, resize splitters, and break out.
   - Expected: existing panel content/state remains intact.

3. **No blank panel or null browser errors**
   - Surface: Browser Toolbox Console.
   - Exercise panel creation, subdivision, closing, and workspace switching.
   - Expected: no repeated `linkedBrowser is null`, `showSplitViewPanels failed`, blank panel, or stale split-view errors.

## Panel Layout

4. **Create root panels**
   - Add 2-3 panels from links or the Add-panel trailer.
   - Expected: all render as side panels; sidebar tab list excludes them.
   - Result: Pass. ✅ Complete
   - Notes: User reported the Add panels button cluster on the right of the panel strip has been removed or is no longer visible. User-provided screenshots show root side panels present, but the add-panel cluster/trailer is not visible as expected.
   - Verified: User confirmed the Add panels button cluster is visible again.
   - Fix status: Confirmed. Chrome flat-layout trailer sizing has an explicit width and measurement fallback.

5. **Subdivide root panel**
   - Open panel kebab menu, then choose `Subdivide panel`.
   - Expected: chooser appears below the original panel; menu no longer shows `Subdivide panel` for that top panel.
   - Result: Pass. ✅ Complete
   - Verified: User confirmed item 5 is working.

6. **Fill chooser as single panel**
   - Click chooser `Full panel`.
   - Expected: bottom panel appears under top panel; both are live and focusable.
   - Result: Pass. ✅ Complete
   - Reported failure: `Full panel` creates the new bottom panel at the default root-panel width instead of the existing vertical group's width.
   - Verified: User confirmed subpanel sizes are working.
   - Fix status: Confirmed. Chooser-created subdivision children now get their flat-layout rects before enter animation and fade in without width or transform animation.

7. **Fill chooser as dual split**
   - Subdivide another root panel, then click `Split panels`.
   - Expected: two bottom panels appear side-by-side under top panel.
   - Result: Pass. ✅ Complete
   - Reported failure: `Split panels` initially spawns the new panels at the default root-panel size, then transitions them to the vertical group's width.
   - Verified: User confirmed subpanel sizes are working.
   - Follow-up request: After a vertical group is created, the top panel should offer `Split this panel` so the top row can split horizontally while the bottom chooser can also create split panels.
   - Follow-up failure: Creating split panels in the bottom should produce one shared 2x2 vertical group when the top is split, not two separate 1x2 vertical groups.
   - Follow-up verified: User confirmed the top-row split and shared 2x2 group behavior is working. ✅ Complete
   - Fix status: Confirmed. Vertical groups now support a horizontal split in the top row as well as the bottom row, and the top panel menu exposes `Split this panel` for eligible unsplit top panels.

8. **Depth cap**
   - Open kebab menu on subdivision top, bottom, and split children.
   - Expected: only eligible root panels show `Subdivide panel`; nested subdivision cannot be created.

9. **Break out bottom panel**
   - On a bottom or split child kebab menu, click `Break out this panel`.
   - Expected: selected child becomes a root panel after its former group; old group normalizes correctly.

10. **Remove vertical group**
    - Use any UI path that removes or collapses the subdivision group if available.
    - Expected: bottom children close or collapse according to command; top panel remains root.

## Closing And Promotion

11. **Close top with single bottom**
    - Create a top/bottom subdivision.
    - Close the top panel.
    - Expected: bottom panel becomes root panel; content does not reload; menu now shows `Subdivide panel`.
    - Requested behavior: Closing should fade the outgoing panel only; neighboring panels should not resize during the fade.
    - Fix status: Ready for re-verification. The close-removal class now animates opacity only and leaves width/flex/margins unchanged during the fade.

12. **Close top with dual bottom split**
    - Create top plus two bottom split children.
    - Close the top panel.
    - Expected: both bottom children become adjacent root panels, keep widths, and keep content painted.
    - Requested behavior: Closing should fade the outgoing panel only; neighboring panels should not resize during the fade.
    - Fix status: Ready for re-verification. The close-removal class now animates opacity only and leaves width/flex/margins unchanged during the fade.

13. **Close bottom child**
    - Close one bottom or split child.
    - Expected: remaining layout normalizes; no orphan chooser or blank slot remains.
    - Requested behavior: Closing should fade the outgoing panel only; neighboring panels should not resize during the fade.
    - Fix status: Ready for re-verification. The close-removal class now animates opacity only and leaves width/flex/margins unchanged during the fade.

14. **Cmd+W on panels**
    - Focus a side panel, then press `Cmd+W`.
    - Expected: closes intended panel without making a panel tab the main tab or blanking layout.
    - Result: Pass. ✅ Complete
    - Requested behavior: Closing should fade the outgoing panel only; neighboring panels should not resize during the fade.
    - Requested behavior: Closing a non-subdivided top-level panel should let surviving top-level slots transition into the closed gap after the fade.
    - Verified: User confirmed fade-only close with top-level close-gap transition is working.
    - Fix status: Confirmed. The close-removal class animates opacity only and leaves width/flex/margins unchanged during the fade; plain top-level panel closes stage a transform-only close-gap FLIP for surviving root slots after the delayed close reconcile.

## Resizing

15. **Vertical splitter drag**
    - Drag the top/bottom splitter.
    - Expected: ratio changes immediately and persists after workspace switch.
    - Result: Pass. ✅ Complete
    - Notes: User reported the splitter for resizing subdivided panels is not working.
    - Verified: User confirmed the splitter in subdivided panels is working after the live flat-layout ratio fix.
    - Follow-up failure: User reported clicking and resizing splitters can make the panel strip scroll jump instantly sometimes.
    - Earlier re-test: Fail. User confirmed the scroll jump still happened after the live scroll-preserve fix.
    - Additional observation: resizing panels appears to reset the size of other panels, which can present as a strip jump.
    - Verified: User confirmed resizing panels is now working and other panel widths are retained.
    - Fix status: Confirmed. Live layout recompute preserves existing live panel widths instead of replaying stale payload widths for panels not being actively resized.

16. **Horizontal splitter drag**
    - Drag the split-child splitter.
    - Expected: left/right ratio changes immediately and persists after workspace switch.
    - Result: Pass. ✅ Complete
    - Notes: User reported the splitter for resizing subdivided panels is not working.
    - Verified: User confirmed the splitter in subdivided panels is working after the live flat-layout ratio fix.
    - Follow-up failure: User reported clicking and resizing splitters can make the panel strip scroll jump instantly sometimes.
    - Earlier re-test: Fail. User confirmed the scroll jump still happened after the live scroll-preserve fix.
    - Additional observation: resizing panels appears to reset the size of other panels, which can present as a strip jump.
    - Verified: User confirmed resizing panels is now working and other panel widths are retained.
    - Fix status: Confirmed. Live layout recompute preserves existing live panel widths instead of replaying stale payload widths for panels not being actively resized.

17. **Root panel width resize**
    - Drag inter-panel splitter between root panels.
    - Expected: width persists after workspace switch and restart.
    - Result: Pass. ✅ Complete
    - Notes: User confirmed dragging/resizing a panel changes that panel's width, but it resizes behind adjacent panels instead of causing the other panels to conform to the new width. User also reported there is no visible gap between panels where one is expected.
    - Verified: User confirmed top-level panel resizing is working after the flat-layout geometry fix.
    - Follow-up failure: User reported clicking and resizing splitters can make the panel strip scroll jump instantly sometimes.
    - Earlier re-test: Fail. User confirmed the scroll jump still happened after the live scroll-preserve fix.
    - Additional observation: resizing panels appears to reset the size of other panels, which can present as a strip jump.
    - Verified: User confirmed resizing panels is now working and other panel widths are retained.
    - Fix status: Confirmed. Live layout recompute preserves existing live panel widths instead of replaying stale payload widths for panels not being actively resized.

## Navigator And Reorder

18. **Navigator grouped icon**
    - Create a vertical group and dual split.
    - Expected: navigator represents the group while it exists; no hidden or closed top panel remains after promotion.

19. **Header drag reorder**
    - Drag a root panel header.
    - Expected: root panels reorder; vertical group moves as one root slot.

20. **Navigator drag reorder**
    - Drag favicon/nav icon.
    - Expected: dispatches root-node reorder; grouped root remains grouped and moves as a unit.

## Focus And Keyboard

21. **Panel click does not select panel as main**
    - Click inside each side panel.
    - Expected: main tab remains the sidebar-selected tab; panel order does not change.
    - Result: Pass. ✅ Complete
    - Verified: User confirmed panel click does not select panel as main.

22. **Arrow key cycling**
    - Use left/right panel cycling.
    - Expected: cycles main to visible panels to trailer, including grouped visible leaves, without focus getting stuck.
    - Result: Pass. ✅ Complete
    - Verified: User confirmed keyboard traversal cycles through the panels.

23. **Trailer focus/add**
    - Cycle to Add-panel trailer and activate it.
    - Expected: creates a new root panel and scrolls it into view.
    - Result: Pass. ✅ Complete
    - Notes: Blocked by missing or hidden Add panels button cluster/trailer reported during manual verification.
    - Unblocked: User confirmed the Add panels button cluster is visible again.
    - Follow-up failure: Keyboard cycling reaches the Add panels button cluster, and pressing Tab then focuses into the buttons, but there is no visible focus indicator when cycling lands on the cluster.
    - Verified: User confirmed the Add panels button cluster focus indicator is working.
    - Follow-up failure: When an Add panel button is pressed, focus should move to the newly created panel.
    - Follow-up failure: Pressing Enter on a saved-panel button in the Add panels cluster creates a blank marker panel (`about:blank?bento_add_as_panel=1...`) instead of opening the saved panel URL. Mouse click opens the correct URL.
    - Verified: User confirmed saved panel buttons now open panels with the correct URL when activated from the keyboard.
    - Verified: User confirmed trailer focus/add appears to be working.
    - Fix status: Confirmed. Explicit panel-add scroll targets now also become the active/focused cycle target.

## Workspace And Session

24. **Workspace switch preserves layout**
    - Create a grouped panel layout.
    - Switch workspace away and back.
    - Expected: layout and panel content remain painted.

25. **Strip scroll restore**
    - Create enough panels to overflow horizontally.
    - Scroll strip, switch workspace away, then switch back.
    - Expected: strip restores to prior scroll position after layout applies.
    - Result: Pass. ✅ Complete
    - Notes: On a fresh `pnpm run dev` launch with the strip restored to the middle or end, clicking in browser chrome, a panel, or the address bar can abruptly focus/scroll back to the main content slot.
    - Re-test: Fail. User confirmed relaunching `pnpm run dev` still auto-scrolls to the main content panel when clicking into the browser window.
    - Verified: User confirmed the boot-time restored strip scroll no longer auto-scrolls back to the main content panel.
    - Fix status: Confirmed. Boot-time restored strip scroll suppresses both reconcile-time main auto-scroll and focus-in main auto-scroll until the user explicitly navigates back to the main slot.

26. **Restart restore**
    - Create root panels, subdivision, dual split, and pins.
    - Quit and relaunch Bento.
    - Expected: v5 layout restores with same visible structure, widths, and pins.

27. **Cmd+Shift+T restore**
    - Close a split child.
    - Press `Cmd+Shift+T`.
    - Expected: restored panel returns as a root panel near recorded root slot; no stale group is recreated.

## Persistence And Import Export

28. **Duplicate URL panels**
    - Create two panels with the same URL.
    - Give them different positions and widths.
    - Restart.
    - Expected: both restore as distinct panels.

29. **Duplicate URL pinned panels**
    - Pin one or both duplicate-URL panels.
    - Restart.
    - Expected: pins attach to intended panel entries, not just first matching URL.

30. **Backup export/import v2**
    - Export current setup.
    - Import into a clean or disposable profile/workspace.
    - Expected: panels, `panelLayout`, widths, and pinned panel refs restore.

31. **Settings import preflight**
    - Import same backup through Settings UI.
    - Expected: Settings accepts schema v2 and does not reject `panelLayout`.

## Close-Out Priority

1. Any direct-child invariant failure.
2. Any content reload or blank panel after layout mutation.
3. Any menu/status mismatch.
4. Any persistence, restart, or import mismatch.
5. Any leftover cosmetic navigator or animation issue.
