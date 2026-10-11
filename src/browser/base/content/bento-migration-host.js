/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global customElements */
(function () {
  'use strict';

  const CLOSE_PREFIX = 'BENTO_CLOSE_EMBEDDED_IMPORT';
  const RESTART_PREFIX = 'BENTO_RESTART_EMBEDDED_IMPORT';
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

  function init() {
    const wizard = document.getElementById('wizard');
    if (!wizard) {
      console.error('[bento-migration-host] migration wizard element missing');
      return;
    }

    wizard.addEventListener('MigrationWizard:Close', signalClose);
    document.addEventListener('keydown', suppressEscape, true);

    document.getElementById('restart-profile-import')?.addEventListener('click', signalRestart);

    customElements
      .whenDefined('migration-wizard')
      .then(() => {
        installWizardBridge(wizard);
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
