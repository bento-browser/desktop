// Welcome overlay entry. Lives in its OWN Vite chunk + chrome <browser>
// frame so the modal scrim covers the entire browser window rather than
// being clipped to the sidebar's bounds. Mirrors src/confirm/main.tsx and
// src/edit-workspace/main.tsx.
//
// Lifecycle:
//   - App.tsx (sidebar) and this welcome frame both call requestWelcome()
//     when SettingsStore reports welcomeSeen=false. The duplicate signal
//     makes first-run opening resilient to startup title-IPC races with
//     panel/theme sync, and chrome showWelcome() is idempotent.
//   - The final finish button flips settings.welcomeSeen=true via the
//     existing tools port, then signals chrome to hide via
//     document.title = BENTO_CLOSE_WELCOME_<ts>. Esc and backdrop clicks
//     are intentionally disabled so first-run onboarding must be completed.
//   - Browser-data import is an onboarding state, not a final dismissal:
//     it stores the next onboarding step in extension storage, signals
//     chrome to open the embedded Firefox migration host, and leaves
//     onboarding mounted.
//   - Dialog stays mounted with open=true permanently — visibility is
//     purely a chrome concern (same pattern as the other overlays). React
//     state inside this page never tracks open/closed.

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, Text } from '@muxui/react';
import type { SearchEngineChoice } from '@shared/protocol';
import { PRIVACY_LEVEL_DETAILS } from '@shared/privacy-levels';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import { requestWelcome, WELCOME_CLOSE_PREFIX } from '../bridge/useWelcome';
import { useSettingsStore } from '../state/settings';
import { usePrivacyStore } from '../state/privacy';
import {
  APPEARANCE_OPTIONS,
  ImportSources,
  LAST_STEP,
  parseStoredStep,
  PRIVACY_OPTIONS,
  ReadySummary,
  searchEngineName,
  searchEngineOptions,
  startImport,
  stepAfter,
  stepIndexOf,
  TourTiles,
  WELCOME_STEPS,
  WelcomeActions,
  WelcomeOptions,
  WelcomeStage,
} from './WelcomeSurfaces';
import './welcome.css';
import { sendChromeTitle } from '../bridge/chromeTitle';
import { useOverlayReadySignal } from '../bridge/overlayReady';

initToolsPort();

const WELCOME_STEP_STORAGE_KEY = 'bento-welcome-step';
const WELCOME_STEP_HASH_KEY = 'bentoWelcomeStep';
const WELCOME_TITLE_ID = 'bento-welcome-title';
const WELCOME_DESCRIPTION_ID = 'bento-welcome-description';

type StepIndex = number;

async function readExtensionStoredStep(): Promise<StepIndex | null> {
  if (typeof browser === 'undefined' || !browser.storage?.local) return null;

  try {
    const raw = (await browser.storage.local.get(WELCOME_STEP_STORAGE_KEY)) as Record<
      string,
      unknown
    >;
    return parseStoredStep(raw[WELCOME_STEP_STORAGE_KEY]);
  } catch {
    return null;
  }
}

async function readStoredStep(): Promise<StepIndex> {
  const hashStoredStep = readHashStoredStep();
  if (hashStoredStep !== null) {
    void storeStep(hashStoredStep);
    return hashStoredStep;
  }

  const extensionStoredStep = await readExtensionStoredStep();
  if (extensionStoredStep !== null) return extensionStoredStep;

  try {
    const localStoredStep = parseStoredStep(localStorage.getItem(WELCOME_STEP_STORAGE_KEY));
    if (localStoredStep !== null) return localStoredStep;
  } catch {
    // Ignore storage failures; first-run onboarding can still start at the beginning.
  }

  return 0;
}

function readHashStoredStep(): StepIndex | null {
  try {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const params = new URLSearchParams(hash);
    return parseStoredStep(params.get(WELCOME_STEP_HASH_KEY));
  } catch {
    return null;
  }
}

async function storeStep(step: StepIndex): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.set({ [WELCOME_STEP_STORAGE_KEY]: step });
    }
  } catch {
    // Mirror to localStorage below for development shells without extension storage.
  }

  try {
    localStorage.setItem(WELCOME_STEP_STORAGE_KEY, String(step));
  } catch {
    // Non-critical. The durable first-run state is still welcomeSeen.
  }
}

async function clearStoredStep(): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.remove(WELCOME_STEP_STORAGE_KEY);
    }
  } catch {
    // Non-critical cleanup.
  }

  try {
    localStorage.removeItem(WELCOME_STEP_STORAGE_KEY);
  } catch {
    // Non-critical cleanup.
  }
}

function close() {
  // Persist the dismissal first so the overlay never reopens. Chrome
  // hide is the visual signal; the settings/update is the durable state.
  // Tools-side persistence is debounced 250ms but the in-memory snapshot
  // updates synchronously, so a fresh shell connection picks up
  // welcomeSeen=true immediately.
  void clearStoredStep();
  dispatch({ type: 'settings/update', changes: { welcomeSeen: true } });
  sendChromeTitle(`${WELCOME_CLOSE_PREFIX}_${Date.now()}`);
}

function SearchEnginePicker({
  value,
  engines,
}: {
  value: string;
  engines: readonly SearchEngineChoice[];
}) {
  // Optimistic until the next privacy snapshot reports the stored engine.
  const [optimisticValue, setOptimisticValue] = useState<string>();

  useEffect(() => {
    setOptimisticValue(undefined);
  }, [value]);

  if (engines.length === 0) {
    return (
      <Text as="p" size="sm" color="muted">
        Loading Firefox search engines…
      </Text>
    );
  }

  return (
    <WelcomeOptions
      label="Default search engine"
      layout="grid"
      options={searchEngineOptions(engines)}
      value={optimisticValue ?? value}
      onChange={(next) => {
        setOptimisticValue(next);
        dispatch({ type: 'privacy/setDefaultSearchEngine', id: next });
      }}
    />
  );
}

function WelcomeApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const welcomeSeen = useSettingsStore((s) => s.current?.welcomeSeen);
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode) ?? 'light';
  const privacyLevel = useSettingsStore((s) => s.current?.privacyProtectionLevel) ?? 'standard';
  const storedSearchEngine = useSettingsStore((s) => s.current?.defaultSearchEngine);
  const privacy = usePrivacyStore((s) => s.settings);
  const [stepIndex, setStepIndex] = useState<StepIndex>(0);
  const [hasLoadedStoredStep, setHasLoadedStoredStep] = useState(false);
  const hasRequestedOpenRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStepRef = useRef<StepIndex | null>(null);
  const step = WELCOME_STEPS[stepIndex] ?? WELCOME_STEPS[0]!;
  const engines = privacy?.availableSearchEngines ?? [];
  const searchEngine = privacy?.defaultSearchEngine ?? storedSearchEngine ?? 'ddg';

  const setStep = (nextStep: StepIndex) => {
    const clamped = Math.max(0, Math.min(nextStep, LAST_STEP));
    void storeStep(clamped);
    setStepIndex(clamped);
  };

  const nextStep = () => {
    if (step.id === 'privacy') {
      dispatch({ type: 'privacy/setProtectionLevel', level: privacyLevel });
    }
    setStep(stepIndex + 1);
  };

  const startBrowserDataImport = () => {
    const followingStep = stepAfter(stepIndex);
    setStepIndex(followingStep);
    void startImport(followingStep, storeStep, sendChromeTitle);
  };

  useEffect(() => {
    let isActive = true;

    void readStoredStep().then((storedStep) => {
      if (!isActive) return;
      setStepIndex(storedStep);
      setHasLoadedStoredStep(true);
    });

    return () => {
      isActive = false;
    };
  }, []);

  // Focus follows the step: the new heading after a change, not on the first render.
  useEffect(() => {
    if (!hasLoadedStoredStep) return;
    if (shownStepRef.current !== null && shownStepRef.current !== stepIndex) {
      headingRef.current?.focus();
    }
    shownStepRef.current = stepIndex;
  }, [hasLoadedStoredStep, stepIndex]);

  // Chrome creates this document on the first-run open and reveals it on this signal.
  useOverlayReadySignal('welcome');

  useEffect(() => {
    if (welcomeSeen !== false || hasRequestedOpenRef.current) return;
    hasRequestedOpenRef.current = true;
    requestWelcome();
  }, [welcomeSeen]);

  useEffect(() => {
    dispatch({ type: 'privacy/requestSnapshot' });
  }, []);

  if (!hasLoadedStoredStep) return null;

  const body = (() => {
    switch (step.id) {
      case 'appearance':
        return (
          <WelcomeOptions
            label="Appearance"
            layout="tiles"
            options={APPEARANCE_OPTIONS}
            value={uiColorMode}
            onChange={(next) =>
              dispatch({ type: 'settings/update', changes: { uiColorMode: next } })
            }
          />
        );
      case 'import':
        return <ImportSources />;
      case 'privacy':
        return (
          <WelcomeOptions
            label="Protection level"
            layout="rows"
            options={PRIVACY_OPTIONS}
            value={privacyLevel}
            onChange={(level) => dispatch({ type: 'privacy/setProtectionLevel', level })}
          />
        );
      case 'search':
        return <SearchEnginePicker value={searchEngine} engines={engines} />;
      case 'tour':
        return <TourTiles />;
      case 'ready':
        return (
          <ReadySummary
            rows={[
              {
                label: 'Appearance',
                value:
                  APPEARANCE_OPTIONS.find((option) => option.id === uiColorMode)?.label ?? 'Light',
                step: stepIndexOf('appearance'),
              },
              {
                label: 'Privacy',
                value: PRIVACY_LEVEL_DETAILS[privacyLevel].label,
                step: stepIndexOf('privacy'),
              },
              {
                label: 'Search',
                value: searchEngineName(engines, searchEngine),
                step: stepIndexOf('search'),
              },
            ]}
            onChange={setStep}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <Dialog
      open={true}
      dismissable={false}
      aria-labelledby={WELCOME_TITLE_ID}
      aria-describedby={step.description ? WELCOME_DESCRIPTION_ID : undefined}
      className="bento-welcome"
      actionsClassName="bento-welcome__actions"
      actions={
        <WelcomeActions
          index={stepIndex}
          onBack={() => setStep(stepIndex - 1)}
          onNext={step.id === 'ready' ? close : nextStep}
          onImport={startBrowserDataImport}
        />
      }
    >
      <WelcomeStage
        step={step}
        index={stepIndex}
        titleId={WELCOME_TITLE_ID}
        descriptionId={WELCOME_DESCRIPTION_ID}
        headingRef={headingRef}
      >
        {body}
      </WelcomeStage>
    </Dialog>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell welcome: #root not found');

createRoot(container).render(
  <StrictMode>
    <WelcomeApp />
  </StrictMode>,
);
