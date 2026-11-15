/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Puts the window's workspace theme and UI mode on an in-scope about: page's root
// (data-bento-theme, data-color-mode), which is what the registered USER sheet
// bento-about-themes.css selects on. Child only and read-only: bento-shell-mount.js
// publishes { [browserId]: [themeId, mode] } through Services.ppmm.sharedData, and this
// reads it for the page's top-level browser.
//
// DOMDocElementInserted fires before the page's first style flush, so the first paint
// already has the right theme. A change to the shared map re-applies the attributes to every
// live page; that only invalidates style, it does not flush it. sharedData.get() deserializes
// the whole map, so the process reads it once per change and every page reads that copy.

const SHARED_KEY = 'BentoAboutTheme';
const MODES = new Set(['light', 'dark']);
const THEME_ID = /^[a-z][a-z0-9-]*$/;

const live = new Set();
// This process's copy of the shared map, refreshed on each change. The child map changes only
// just before its change event, so the copy is never stale.
let entries;
let listening = false;

/** The [themeId, mode] that `entries` has for `browserId`, or null. An unknown theme shows Default. */
export function lookupAboutTheme(entries, browserId) {
  const entry = entries?.[browserId];
  if (!Array.isArray(entry) || !MODES.has(entry[1])) return null;
  return [typeof entry[0] === 'string' && THEME_ID.test(entry[0]) ? entry[0] : 'default', entry[1]];
}

function onSharedDataChange(event) {
  if (!event.changedKeys.includes(SHARED_KEY)) return;
  entries = Services.cpmm.sharedData.get(SHARED_KEY);
  for (const actor of live) actor.apply();
}

export class BentoAboutThemeChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== 'DOMDocElementInserted' || event.target !== this.document) return;
    if (!listening) {
      Services.cpmm.sharedData.addEventListener('change', onSharedDataChange);
      entries = Services.cpmm.sharedData.get(SHARED_KEY);
      listening = true;
    }
    live.add(this);
    this.apply();
  }

  apply() {
    const root = this.document?.documentElement;
    const browserId = this.browsingContext?.top?.browserId;
    if (!root || !browserId) return;
    const theme = lookupAboutTheme(entries, browserId);
    // A browser no window published for (not a tab) keeps Firefox's own look.
    if (!theme) return;
    if (root.getAttribute('data-bento-theme') !== theme[0]) {
      root.setAttribute('data-bento-theme', theme[0]);
    }
    if (root.getAttribute('data-color-mode') !== theme[1]) {
      root.setAttribute('data-color-mode', theme[1]);
    }
  }

  didDestroy() {
    live.delete(this);
  }
}
