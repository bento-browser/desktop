/* global customElements */
(function () {
  'use strict';

  const CLOSE_PREFIX = 'BENTO_CLOSE_EMBEDDED_IMPORT';
  const RESTART_PREFIX = 'BENTO_RESTART_EMBEDDED_IMPORT';
  const WIZARD_BRIDGE_STYLESHEET =
    'chrome://browser/content/bento-migration-wizard-bridge.css';

  function applyColorModeFromQuery() {
    const params = new URLSearchParams(location.search);
    const requestedMode = params.get('mode');
    const mode = requestedMode === 'dark' ? 'dark' : 'light';
    const root = document.documentElement;
    root.classList.add('tale-ui');
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
    addClasses(button, ['tale-button', 'tale-button--md']);
    if (button.classList.contains('primary')) {
      addClasses(button, ['tale-button--primary']);
      return;
    }
    addClasses(button, ['tale-button--neutral']);
  }

  function applyWizardBemClasses(wizard) {
    const root = wizard.shadowRoot;
    if (!root) return;

    root.querySelectorAll('button').forEach(classifyWizardButton);
    addClasses(root.getElementById('browser-profile-selector'), [
      'tale-button',
      'tale-button--neutral',
      'tale-button--md',
      'bento-migration-wizard__profile-trigger',
    ]);
    addClasses(root.querySelector('.resource-selection-details'), [
      'tale-card',
      'tale-card--filled',
      'tale-card--sm',
    ]);
    addClasses(root.querySelector('#resource-selection-summary'), ['tale-card__header']);
    addClasses(root.querySelector('#resource-type-list'), ['tale-list', 'tale-list--divided']);
    root.querySelectorAll('#resource-type-list > label').forEach((label) => {
      addClasses(label, ['tale-list__item']);
    });
    addClasses(root.querySelector('.resource-progress'), ['tale-list', 'tale-list--divided']);
    root.querySelectorAll('.resource-progress-group').forEach((group) => {
      addClasses(group, ['tale-list__item']);
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

    document
      .getElementById('restart-profile-import')
      ?.addEventListener('click', signalRestart);

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
