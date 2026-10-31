'use strict';

/* globals ChromeUtils, ExtensionAPI, ExtensionCommon */

// The experiments of one add-on load into one shared scope, where top-level const and let names
// collide, so this file keeps its names inside a function (as bento-external-sessions does).
(function (global) {
  // The WebExtension tabs API says nothing about the page a tab shows, and Firefox shows its own
  // pages in place of a website in these cases: its crashed-tab page, and the error pages for a
  // site that cannot be reached, a bad certificate, an HTTPS-Only failure, Safe Browsing and
  // parental controls. This API reports which of those a tab shows as one `pageError`.
  //
  // The answer comes from the document the tab's browser actually shows (`browser.documentURI`),
  // never from the favicon or the tab URL: a website can declare a `chrome://global/skin/` favicon
  // (the global package is content accessible), and an error page keeps the failed address as its
  // tab URL. For a remote browser Firefox updates `documentURI` just before it notifies the
  // progress listeners of a location change, and a non-remote browser (the crashed-tab page) reads
  // it live from its document, so it follows an adopted tab to its new window as well.
  //
  // The `crashed` attribute on the <tab> element (TabCrashHandler.sendToTabCrashedPage and
  // sendToRestartRequiredPage) is a second signal for the same page. It is set before the page
  // document exists, and removing it fires no tab event (not even TabAttrModified), so a
  // MutationObserver is the only way to hear it. A moved tab does not get the attribute on its new
  // element, which is why the document counts first.
  const CRASHED_ATTRIBUTE = 'crashed';
  const WATCHER_ID_PREFIX = 'bento-tab-state-';

  // Firefox's own pages for these states, by the path of their about: URI.
  // about:restartrequired is shown after a build-ID mismatch and sets the same `crashed`
  // attribute, so it counts as crashed. about:restricted is the parental-controls block page.
  const ABOUT_PAGE_ERRORS = new Map([
    ['tabcrashed', 'crashed'],
    ['restartrequired', 'crashed'],
    ['certerror', 'certificate-warning'],
    ['httpsonlyerror', 'unavailable'],
    ['blocked', 'blocked'],
    ['restricted', 'blocked'],
  ]);
  // about:neterror covers every other load failure, told apart by its `e` parameter. Firefox gives
  // these two values its certificate-warning icon (aboutNetError.mjs: gIsCertError ||
  // nssFailure2, the same test its site identity panel uses), and titles blockedByPolicy
  // "Blocked Page" (a site an enterprise policy blocks). Every other value is "unavailable".
  const CERTIFICATE_NET_ERRORS = new Set(['nssBadCert', 'nssFailure2']);
  const BLOCKED_NET_ERRORS = new Set(['blockedByPolicy']);

  const { EveryWindow } = ChromeUtils.importESModule('resource:///modules/EveryWindow.sys.mjs');

  let watcherCount = 0;

  // The pageError an about: document stands for, or null for any other document.
  function aboutPageError(uri) {
    if (uri.scheme !== 'about') return null;
    if (uri.filePath !== 'neterror') return ABOUT_PAGE_ERRORS.get(uri.filePath) ?? null;
    const error = /(?:^|&)e=([^&]*)/.exec(uri.query)?.[1];
    if (CERTIFICATE_NET_ERRORS.has(error)) return 'certificate-warning';
    return BLOCKED_NET_ERRORS.has(error) ? 'blocked' : 'unavailable';
  }

  global.bentoTabState = class extends ExtensionAPI {
    getAPI(context) {
      const { tabManager } = context.extension;

      // The WebExtension tab id of a tab element, or null when this extension may not see the tab
      // (a private window without access, or a tab that is mid-adoption).
      const tabIdOf = (nativeTab) => tabManager.getWrapper(nativeTab)?.id ?? null;

      // The pageError of a tab right now, or null when it shows a website or an ordinary page.
      const pageErrorOf = (nativeTab) => {
        const documentURI = nativeTab.linkedBrowser?.documentURI;
        const fromDocument = documentURI ? aboutPageError(documentURI) : null;
        if (fromDocument) return fromDocument;
        return nativeTab.hasAttribute(CRASHED_ATTRIBUTE) ? 'crashed' : null;
      };

      // What this extension was last told for each tab element (by an event or by a read), so a
      // location change that leaves the state as it was fires nothing: every navigation of every
      // tab reaches the progress listener. A tab element missing here counts as null.
      const reported = new WeakMap();

      return {
        bentoTabState: {
          // Every tab that shows one of those pages now, as { tabId, pageError }. It is the starting
          // state for `onPageErrorChanged`, which reports changes only, and the way to re-read
          // after a tab moved to another window. Tabs in a window that has not finished its
          // startup are not listed; their windows report them once they have.
          async getPageErrors() {
            const errors = [];
            for (const win of EveryWindow.readyWindows) {
              for (const nativeTab of win.gBrowser.tabs) {
                const tabId = tabIdOf(nativeTab);
                if (tabId === null) continue;
                const pageError = pageErrorOf(nativeTab);
                reported.set(nativeTab, pageError);
                if (pageError) errors.push({ tabId, pageError });
              }
            }
            return errors;
          },

          // Fires (tabId, pageError) when a tab starts showing one of those pages or changes from
          // one to another, and (tabId, null) when it stops. A window that starts being watched
          // reports its tabs that already show one, so a state from before the watch is not lost.
          // The receiver ignores a repeat of the state it already has.
          onPageErrorChanged: new ExtensionCommon.EventManager({
            context,
            name: 'bentoTabState.onPageErrorChanged',
            register: (fire) => {
              const watches = new Map();
              const watchId = `${WATCHER_ID_PREFIX}${++watcherCount}`;

              // `force` re-sends a state this extension was already told about; the attach
              // reconcile uses it because the receiver may have dropped the earlier event.
              const report = (nativeTab, force = false) => {
                const tabId = tabIdOf(nativeTab);
                if (tabId === null) return;
                const pageError = pageErrorOf(nativeTab);
                if (pageError === (reported.get(nativeTab) ?? null) && !(force && pageError)) {
                  return;
                }
                reported.set(nativeTab, pageError);
                void fire.async(tabId, pageError);
              };

              // EveryWindow calls init for each open window once its startup is done and for each
              // window opened later, and uninit when a window closes or the watcher goes away.
              EveryWindow.registerCallback(
                watchId,
                (win) => {
                  if (watches.has(win)) return;
                  const { gBrowser } = win;
                  // Tabs of the window, split-view panels and tabs in groups share this strip. A
                  // tab copies the attribute onto some of its own child elements (attribute
                  // inheritance), which the observer sees too, so only a record about a <tab>
                  // counts.
                  const observer = new win.MutationObserver((records) => {
                    for (const nativeTab of new Set(records.map((record) => record.target))) {
                      if (gBrowser.isTab(nativeTab)) report(nativeTab);
                    }
                  });
                  observer.observe(gBrowser.tabContainer, {
                    attributes: true,
                    attributeFilter: [CRASHED_ATTRIBUTE],
                    subtree: true,
                  });
                  // A tabs listener hears every tab, selected or not. Only a top-level location
                  // change can change the document the tab shows.
                  const listener = {
                    onLocationChange(browser, webProgress) {
                      if (!webProgress.isTopLevel) return;
                      const nativeTab = gBrowser.getTabForBrowser(browser);
                      if (nativeTab) report(nativeTab);
                    },
                  };
                  gBrowser.addTabsProgressListener(listener);
                  watches.set(win, { gBrowser, observer, listener });
                  for (const nativeTab of gBrowser.tabs) report(nativeTab, true);
                },
                (win) => {
                  const watch = watches.get(win);
                  if (!watch) return;
                  watch.observer.disconnect();
                  watch.gBrowser.removeTabsProgressListener(watch.listener);
                  watches.delete(win);
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
