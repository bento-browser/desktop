'use strict';

/* globals ChromeUtils, ExtensionAPI, ExtensionCommon */

// The experiments of one add-on load into one shared scope, where top-level const and let names
// collide, so this file keeps its names inside a function (as bento-external-sessions does).
(function (global) {
  // Firefox shows its crashed-tab page by setting the `crashed` attribute on the tab element
  // (TabCrashHandler.sendToTabCrashedPage) and removes it when the tab is revived, starts a new load,
  // or gets a new content process. The WebExtension tabs API has no such field, and the attribute
  // change fires no tab event (not even TabAttrModified), so a MutationObserver on each window's
  // tab strip is the precise signal. Tabs of every window, split-view panels and tabs in groups
  // share that strip. A tab copies the attribute onto some of its own child elements (attribute
  // inheritance), which the observer sees too, so only a record about a <tab> counts.
  const CRASHED_ATTRIBUTE = 'crashed';
  const WATCHER_ID_PREFIX = 'bento-tab-state-';

  const { EveryWindow } = ChromeUtils.importESModule('resource:///modules/EveryWindow.sys.mjs');

  let watcherCount = 0;

  global.bentoTabState = class extends ExtensionAPI {
    getAPI(context) {
      const { tabManager } = context.extension;

      // The WebExtension tab id of a tab element, or null when this extension may not see the tab
      // (a private window without access, or a tab that is mid-adoption).
      const tabIdOf = (nativeTab) => tabManager.getWrapper(nativeTab)?.id ?? null;

      return {
        bentoTabState: {
          // Ids of the tabs whose crashed-tab page is showing now: the starting state for
          // `onCrashedChanged`, which reports only changes.
          async getCrashedTabIds() {
            const ids = [];
            for (const win of EveryWindow.readyWindows) {
              for (const nativeTab of win.gBrowser.tabs) {
                if (!nativeTab.hasAttribute(CRASHED_ATTRIBUTE)) continue;
                const id = tabIdOf(nativeTab);
                if (id !== null) ids.push(id);
              }
            }
            return ids;
          },

          // Fires (tabId, crashed) when a tab starts or stops showing the crashed-tab page. The
          // receiver ignores a repeat of the state it already has.
          onCrashedChanged: new ExtensionCommon.EventManager({
            context,
            name: 'bentoTabState.onCrashedChanged',
            register: (fire) => {
              const observers = new Map();
              const watchId = `${WATCHER_ID_PREFIX}${++watcherCount}`;
              // EveryWindow calls init for each open window once its startup is done and for each
              // window opened later, and uninit when a window closes or the watcher goes away.
              EveryWindow.registerCallback(
                watchId,
                (win) => {
                  if (observers.has(win)) return;
                  const observer = new win.MutationObserver((records) => {
                    const targets = new Set(records.map((record) => record.target));
                    for (const nativeTab of targets) {
                      if (!win.gBrowser.isTab(nativeTab)) continue;
                      const id = tabIdOf(nativeTab);
                      if (id !== null) {
                        void fire.async(id, nativeTab.hasAttribute(CRASHED_ATTRIBUTE));
                      }
                    }
                  });
                  observer.observe(win.gBrowser.tabContainer, {
                    attributes: true,
                    attributeFilter: [CRASHED_ATTRIBUTE],
                    subtree: true,
                  });
                  observers.set(win, observer);
                },
                (win) => {
                  observers.get(win)?.disconnect();
                  observers.delete(win);
                },
              );
              return () => EveryWindow.unregisterCallback(watchId);
            },
          }).api(),
        },
      };
    }
  };
})(globalThis);
