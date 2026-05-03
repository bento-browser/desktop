/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Resolves the bento-shell extension's per-profile UUID and sets the
// <browser id="bento-shell-frame"> src to the right moz-extension URL.
//
// extensions.webextensions.uuids is not honored for built-in addons, so we
// can't pin the URL at build time. WebExtensionPolicy.getByID is the chrome-
// global API that gives us the assigned UUID once the extension has loaded.
//
// Loaded via <script src="chrome://browser/content/bento-shell-mount.js">
// from browser-box.inc.xhtml (an external file is required because the
// chrome doc's meta CSP forbids inline scripts).

(function () {
  function setBentoShellSrc() {
    const policy = WebExtensionPolicy.getByID('bento-shell@bento.app');
    if (!policy) {
      // Extension hasn't loaded yet; try again on the next tick.
      setTimeout(setBentoShellSrc, 50);
      return;
    }
    const frame = document.getElementById('bento-shell-frame');
    if (!frame) return;
    frame.setAttribute(
      'src',
      'moz-extension://' + policy.mozExtensionHostname + '/dist/index.html'
    );
  }
  setBentoShellSrc();
})();
