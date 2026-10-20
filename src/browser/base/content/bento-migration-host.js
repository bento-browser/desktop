/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

(function () {
  'use strict';

  const CLOSE_PREFIX = 'BENTO_CLOSE_EMBEDDED_IMPORT';
  const RESTART_PREFIX = 'BENTO_RESTART_EMBEDDED_IMPORT';
  // Sent once the wizard shows its first state: BENTO_EMBEDDED_IMPORT_READY_<ts> with the ts of
  // this page's URL.
  const READY_PREFIX = 'BENTO_EMBEDDED_IMPORT_READY';
  const MORPH_ATTR = 'data-bento-morph';
  const WIZARD_BRIDGE_STYLESHEET = 'chrome://browser/content/bento-migration-wizard-bridge.css';

  function applyColorModeFromQuery() {
    const params = new URLSearchParams(location.search);
    const requestedMode = params.get('mode');
    const mode = requestedMode === 'dark' ? 'dark' : 'light';
    const root = document.documentElement;
    root.setAttribute('data-bento-theme', 'default');
    root.setAttribute('data-color-mode', mode);
  }

  function signalClose() {
    document.title = `${CLOSE_PREFIX}_${Date.now()}`;
  }

  function signalReady() {
    document.title = `${READY_PREFIX}_${new URLSearchParams(location.search).get('ts') ?? ''}`;
  }

  function signalRestart() {
    document.title = `${RESTART_PREFIX}_${Date.now()}`;
  }

  function suppressEscape(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function addClasses(element, classes) {
    if (!element) return;
    element.classList.add(...classes);
  }

  function classifyWizardButton(button) {
    addClasses(button, ['bento-button', 'bento-button--md']);
    if (button.classList.contains('primary')) {
      addClasses(button, ['bento-button--primary']);
      return;
    }
    addClasses(button, ['bento-button--neutral']);
  }

  function applyWizardBemClasses(wizard) {
    const root = wizard.shadowRoot;
    if (!root) return;

    root.querySelectorAll('button').forEach(classifyWizardButton);
    addClasses(root.getElementById('browser-profile-selector'), [
      'bento-button',
      'bento-button--neutral',
      'bento-button--md',
      'bento-migration-wizard__profile-trigger',
    ]);
    addClasses(root.querySelector('.resource-selection-details'), [
      'bento-card',
      'bento-card--filled',
      'bento-card--sm',
    ]);
    addClasses(root.querySelector('#resource-selection-summary'), ['bento-card__header']);
    addClasses(root.querySelector('#resource-type-list'), ['bento-list', 'bento-list--divided']);
    root.querySelectorAll('#resource-type-list > label').forEach((label) => {
      addClasses(label, ['bento-list__item']);
    });
    addClasses(root.querySelector('.resource-progress'), ['bento-list', 'bento-list--divided']);
    root.querySelectorAll('.resource-progress-group').forEach((group) => {
      addClasses(group, ['bento-list__item']);
    });
  }

  function installWizardBridge(wizard) {
    const root = wizard.shadowRoot;
    if (!root) return;

    if (!root.getElementById('bento-migration-wizard-bridge')) {
      const link = document.createElement('link');
      link.id = 'bento-migration-wizard-bridge';
      link.rel = 'stylesheet';
      link.href = WIZARD_BRIDGE_STYLESHEET;
      root.appendChild(link);
    }

    applyWizardBemClasses(wizard);

    if (wizard.__bentoMigrationClassObserver) return;
    const observer = new MutationObserver(() => applyWizardBemClasses(wizard));
    observer.observe(root, { childList: true, subtree: true });
    wizard.__bentoMigrationClassObserver = observer;
  }

  // The onboarding dialog's rectangle, 'dialog=x,y,w,h,r' on the URL (px), or null.
  function readDialogRect() {
    const parts = (new URLSearchParams(location.search).get('dialog') ?? '').split(',');
    const [x, y, w, h, r] = parts.map((part) => (part.trim() === '' ? NaN : Number(part)));
    return parts.length === 5 && [x, y, w, h, r].every(Number.isFinite) && w > 0 && h > 0
      ? { x, y, w, h, r }
      : null;
  }

  // The card's motion for the handoff with the onboarding dialog. The CSS (html[data-bento-morph])
  // owns every duration; the mount script calls these and waits with afterMotion on `card` and
  // `content`. The rectangles are measured here because only this document knows its layout.
  function createMorph(wizard, dialog) {
    const root = document.documentElement;
    const card = document.querySelector('.bento-migration-host');
    let cancelled = false;

    const setPx = (name, value) => root.style.setProperty(`--bento-morph-${name}`, `${value}px`);
    const setState = (state) => {
      if (state === null) root.removeAttribute(MORPH_ATTR);
      else root.setAttribute(MORPH_ATTR, state);
      // Flush style so the next state change starts from this one.
      void card.getBoundingClientRect();
    };
    // Runs `change` on the next frame. This page is idle while the wizard is up, and a fade
    // started from an idle page takes the clock of its last frame as its start, so the fades ran
    // ahead of the card's geometry by the idle time. Inside a frame callback the clock is current.
    let frame = 0;
    const onFrame = (change) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!cancelled) change();
      });
    };
    // The card's rectangle and its content width in normal flow, with the state restored.
    const measure = () => {
      const state = root.getAttribute(MORPH_ATTR);
      root.removeAttribute(MORPH_ATTR);
      const rect = card.getBoundingClientRect();
      setPx('card-x', rect.x);
      setPx('card-y', rect.y);
      setPx('card-w', rect.width);
      setPx('card-h', rect.height);
      setPx('content-w', wizard.getBoundingClientRect().width);
      if (state !== null) {
        root.setAttribute(MORPH_ATTR, state);
        // The next change must start from the restored state, not from the one just measured.
        void card.getBoundingClientRect();
      }
    };

    setPx('dialog-x', dialog.x);
    setPx('dialog-y', dialog.y);
    setPx('dialog-w', dialog.w);
    setPx('dialog-h', dialog.h);
    setPx('dialog-radius', dialog.r);

    return {
      card,
      content: wizard,
      // The card at the dialog's rectangle, content hidden. The mount script calls this when it
      // shows the page, so a page it gave up on never pins itself. False (the card back in normal
      // flow) when the card cannot take that rectangle, so the swap would jump.
      prepare() {
        if (cancelled) return false;
        measure();
        setState('from');
        const rect = card.getBoundingClientRect();
        const off = [rect.x - dialog.x, rect.y - dialog.y, rect.width - dialog.w, rect.height - dialog.h];
        const exact = off.every((difference) => Math.abs(difference) < 0.5);
        if (!exact) setState(null);
        return exact;
      },
      // Card to its centred rectangle, content fading in. `started` runs once the motion has begun,
      // which is when the mount script can measure it; false when the morph was cancelled.
      open(started) {
        if (cancelled) return false;
        onFrame(() => {
          measure();
          setState('open');
          started();
        });
        return true;
      },
      // Normal flow again (end of open or close).
      settle() {
        setState(null);
      },
      // Card back to the dialog's rectangle, content fading out; `started` as for open.
      close(started) {
        if (cancelled) return false;
        onFrame(() => {
          measure();
          setState('shown');
          setState('close');
          started();
        });
        return true;
      },
      // The mount script gave up on the handoff: a late ready must not pin the card, and the card
      // is at rest in normal flow at once. A running transition whose end value equals the
      // in-flow one (the width, the radius, the content's opacity) survives the state change and
      // would play on, so the transitions are ended too.
      cancel() {
        cancelled = true;
        cancelAnimationFrame(frame);
        setState(null);
        for (const animation of card.getAnimations({ subtree: true })) animation.cancel();
      },
    };
  }

  // The key of the browser an onboarding tile chose, 'migrator=<key>' on the URL, or null.
  function readPreselectedMigrator() {
    const key = new URLSearchParams(location.search).get('migrator') ?? '';
    return /^[a-z0-9-]{1,32}$/.test(key) ? key : null;
  }

  // Selects the browser an onboarding tile chose when the wizard first shows its selection page.
  // The wizard selects state.migratorKey there, but its RequestState event cannot carry one, and
  // its actor hands every state to this element's own setState (MigrationWizardChild
  // .setComponentState waives Xrays and calls it), so the first selection state gets the key added.
  // Only a key the wizard lists is added: for any other the wizard throws before it leaves its
  // loading page. One shot: a later selection page (Back after an import) is the wizard's own.
  async function preselectMigrator(wizard) {
    const key = readPreselectedMigrator();
    if (!key) return;
    let selectionPage;
    try {
      const constants = await import('chrome://browser/content/migration/migration-wizard-constants.mjs');
      selectionPage = constants.MigrationWizardConstants.PAGES.SELECTION;
    } catch (err) {
      console.warn('[bento-migration-host] cannot preselect the import source:', err);
      return;
    }
    const setState = wizard.setState;
    wizard.setState = function (state) {
      if (state?.page === selectionPage) {
        delete wizard.setState;
        const listed = Array.from(state.migrators ?? []).some((migrator) => migrator?.key === key);
        if (listed && !state.migratorKey) state.migratorKey = key;
      }
      return setState.call(wizard, state);
    };
  }

  // Calls `done` once the wizard leaves its loading skeleton (its deck's selected-view moves off
  // page-loading) and has been laid out for two frames; without a deck it waits the same frames.
  function whenWizardRendered(wizard, done) {
    const deck = wizard.shadowRoot?.getElementById('wizard-deck');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      observer?.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(done));
    };
    const rendered = () => !deck || deck.getAttribute('selected-view') !== 'page-loading';
    const observer = deck ? new MutationObserver(() => rendered() && finish()) : null;
    observer?.observe(deck, { attributes: true, attributeFilter: ['selected-view'] });
    if (rendered()) finish();
  }

  function init() {
    const wizard = document.getElementById('wizard');
    if (!wizard) {
      console.error('[bento-migration-host] migration wizard element missing');
      return;
    }

    wizard.addEventListener('MigrationWizard:Close', signalClose);
    document.addEventListener('keydown', suppressEscape, true);

    document.getElementById('restart-profile-import')?.addEventListener('click', signalRestart);

    const dialog = readDialogRect();
    const morph = dialog ? createMorph(wizard, dialog) : null;
    // The mount script finds the API here, in this in-process chrome page.
    if (morph) window.bentoImportMorph = morph;

    customElements
      .whenDefined('migration-wizard')
      .then(async () => {
        installWizardBridge(wizard);
        await preselectMigrator(wizard);
        whenWizardRendered(wizard, signalReady);
        wizard.requestState();
      })
      .catch((err) => {
        console.error('[bento-migration-host] migration wizard failed to initialize', err);
      });
  }

  applyColorModeFromQuery();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
