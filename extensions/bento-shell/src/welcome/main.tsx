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
//   - Dialog stays mounted with isOpen=true permanently — visibility is
//     purely a chrome concern (same pattern as the other overlays). React
//     state inside this page never tracks open/closed.

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '@tale-ui/react/dialog';
import { Button } from '@tale-ui/react/button';
import { Select } from '@tale-ui/react/select';
import { ToggleButtonGroup } from '@tale-ui/react/toggle-group';
import { ToggleButton } from '@tale-ui/react/toggle-button';
import { Text } from '@tale-ui/react/text';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Icon } from '@tale-ui/react/icon';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import ArrowRight from 'lucide-react/dist/esm/icons/arrow-right';
import Check from 'lucide-react/dist/esm/icons/check';
import Download from 'lucide-react/dist/esm/icons/download';
import Grid3X3 from 'lucide-react/dist/esm/icons/grid-3x3';
import Monitor from 'lucide-react/dist/esm/icons/monitor';
import Moon from 'lucide-react/dist/esm/icons/moon';
import PanelsTopLeft from 'lucide-react/dist/esm/icons/panels-top-left';
import Search from 'lucide-react/dist/esm/icons/search';
import Shield from 'lucide-react/dist/esm/icons/shield';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import Sun from 'lucide-react/dist/esm/icons/sun';
import Workflow from 'lucide-react/dist/esm/icons/workflow';
import type {
  SearchEngineId,
  SelectablePrivacyProtectionLevel,
  UiColorModePref,
} from '@shared/protocol';
import { PRIVACY_LEVELS, PRIVACY_LEVEL_DETAILS } from '@shared/privacy-levels';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/select';
import '@tale-ui/react-styles/toggle-button';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/dialog';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import {
  requestWelcome,
  WELCOME_CLOSE_PREFIX,
  WELCOME_IMPORT_BROWSER_DATA_PREFIX,
} from '../bridge/useWelcome';
import { useSettingsStore } from '../state/settings';
import { usePrivacyStore } from '../state/privacy';
import './welcome.css';

initToolsPort();

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// macOS-style modifier glyphs vs. spelled-out names elsewhere. Matches
// what users see printed on their keyboard.
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

// Tip rows — kept in sync with ShortcutsDialog and the chrome bindings.
// Workspaces: bento-tools manifest binds Ctrl+Alt+N → workspace-N.
// Palette: bento-shell-mount.js binds Cmd/Ctrl+Alt+P.
const TIPS: Array<{ shortcut: string; description: string }> = [
  { shortcut: `${MOD}${ALT}1-${MOD}${ALT}9`, description: 'Switch workspaces' },
  { shortcut: `${MOD}${ALT}P`, description: 'Open the command palette' },
  { shortcut: 'Tab panel icon', description: 'Pin a tab as a side panel' },
  { shortcut: 'Left / Right', description: 'Cycle between panels' },
];

const WELCOME_STEP_STORAGE_KEY = 'bento-welcome-step';
const WELCOME_STEP_HASH_KEY = 'bentoWelcomeStep';

type BentoBox = readonly [string, string];
type ThemeModeOption = {
  value: UiColorModePref;
  label: string;
  icon: typeof Sun;
};
type OnboardingStep = {
  id: 'intro' | 'import' | 'privacy' | 'search' | 'workspaces' | 'panels' | 'finish';
  eyebrow: string;
  title: string;
  description: string;
  icon: typeof Sun;
  boxes: readonly BentoBox[];
};

const TIP_BOXES: readonly BentoBox[] = TIPS.map((tip) => [tip.shortcut, tip.description]);

const UI_COLOR_MODE_OPTIONS: readonly ThemeModeOption[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Auto', icon: Monitor },
];

const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'intro',
    eyebrow: 'First box',
    title: 'Welcome to Bento',
    description:
      'A workspace-first browser built on Firefox. Set up a few compartments, then start browsing.',
    icon: Sparkles,
    boxes: [
      ['Main', 'Your active page'],
      ['Panels', 'Useful pages beside it'],
      ['Workspaces', 'Task-specific boxes'],
      ['Theme', 'A visual identity per box'],
    ],
  },
  {
    id: 'import',
    eyebrow: 'Import',
    title: 'Bring your browser data',
    description:
      'Copy bookmarks, history, passwords, and compatible Firefox-family profile data before you settle in.',
    icon: Download,
    boxes: [
      ['Bookmarks', 'Saved places'],
      ['History', 'Recent trails'],
      ['Passwords', 'Logins'],
      ['Profiles', 'Firefox and Zen'],
    ],
  },
  {
    id: 'privacy',
    eyebrow: 'Privacy',
    title: 'Choose a protection level',
    description:
      "Standard is Bento's compatibility-first default. Enhanced and Hardened add stricter browser protections.",
    icon: Shield,
    boxes: [
      ['Standard', 'Compatibility-first'],
      ['Enhanced', 'HTTPS-only and RFP'],
      ['Hardened', 'Reduced persistence'],
      ['Custom', 'Detected later in Settings'],
    ],
  },
  {
    id: 'search',
    eyebrow: 'Search',
    title: 'Choose default search',
    description:
      'Fresh profiles start with DuckDuckGo. You can switch to any visible Firefox search engine now or later.',
    icon: Search,
    boxes: [
      ['Default', 'DuckDuckGo'],
      ['Providers', 'Firefox visible engines'],
      ['Names', 'From SearchService'],
      ['Settings', 'Change later'],
    ],
  },
  {
    id: 'workspaces',
    eyebrow: 'Workspaces',
    title: 'Keep each task in its own box',
    description:
      'Workspaces preserve tabs, panels, layout, and theme so each mode of work stays ready.',
    icon: Workflow,
    boxes: [
      ['Research', 'Sources and notes'],
      ['Writing', 'Draft and references'],
      ['Ops', 'Dashboards'],
      ['Personal', 'Everyday browsing'],
    ],
  },
  {
    id: 'panels',
    eyebrow: 'Panels',
    title: 'Arrange pages like compartments',
    description:
      'Promote tabs into panels, keep references nearby, and move through the layout without juggling windows.',
    icon: PanelsTopLeft,
    boxes: TIP_BOXES,
  },
  {
    id: 'finish',
    eyebrow: 'Ready',
    title: 'Your Bento is ready',
    description:
      'Start with a clean workspace. Add panels as you go and let Bento remember the arrangement.',
    icon: Check,
    boxes: [
      ['Open', 'Browse normally'],
      ['Pin', 'Keep pages close'],
      ['Split', 'Shape the workspace'],
      ['Return', 'Pick up later'],
    ],
  },
] as const;

type StepIndex = number;

function parseStoredStep(value: unknown): StepIndex | null {
  const stored =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (Number.isInteger(stored) && stored >= 0 && stored < ONBOARDING_STEPS.length) {
    return stored;
  }

  return null;
}

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
  document.title = `${WELCOME_CLOSE_PREFIX}_${Date.now()}`;
}

async function importBrowserData(nextStep: StepIndex): Promise<void> {
  await storeStep(nextStep);
  document.title = `${WELCOME_IMPORT_BROWSER_DATA_PREFIX}_${nextStep}_${Date.now()}`;
}

function BentoTray({
  activeStep,
  boxes,
}: {
  activeStep: OnboardingStep;
  boxes: readonly (readonly [string, string])[];
}) {
  return (
    <div className="bento-welcome__tray" aria-hidden="true">
      <div className="bento-welcome__tray-cell bento-welcome__tray-cell--hero">
        <span className="bento-welcome__tray-icon">
          <Icon icon={activeStep.icon} size="lg" />
        </span>
        <Text variant="label" size="m">
          {activeStep.eyebrow}
        </Text>
        <Text variant="text" size="s" color="muted">
          Bento keeps the browser surface divided into useful, durable compartments.
        </Text>
      </div>
      {boxes.map(([label, detail]) => (
        <div className="bento-welcome__tray-cell" key={`${label}-${detail}`}>
          <Text variant="label" size="s">
            {label}
          </Text>
          <Text variant="text" size="xs" color="muted">
            {detail}
          </Text>
        </div>
      ))}
    </div>
  );
}

function StepRail({ current }: { current: StepIndex }) {
  return (
    <Row gap="xs" align="center" className="bento-welcome__rail" aria-hidden="true">
      {ONBOARDING_STEPS.map((step, index) => (
        <span
          className="bento-welcome__rail-step"
          data-active={index === current ? 'true' : undefined}
          key={step.id}
        />
      ))}
    </Row>
  );
}

function ThemeModePicker({
  value,
  onChange,
}: {
  value: UiColorModePref | undefined;
  onChange: (next: UiColorModePref) => void;
}) {
  const current = value ?? 'light';

  return (
    <Column gap="xs" className="bento-welcome__theme-picker">
      <Text variant="label" size="s" color="muted">
        Theme
      </Text>
      <Row gap="xs" wrap className="bento-welcome__theme-options">
        {UI_COLOR_MODE_OPTIONS.map((option) => {
          const selected = current === option.value;
          return (
            <Button
              key={option.value}
              variant={selected ? 'primary' : 'neutral'}
              size="sm"
              aria-pressed={selected}
              onPress={() => onChange(option.value)}
              className="bento-welcome__theme-option"
            >
              <Icon icon={option.icon} size="sm" />
              {option.label}
            </Button>
          );
        })}
      </Row>
    </Column>
  );
}

function firstSelectedKey(keys: unknown): string | null {
  if (keys === 'all') return null;
  if (!(keys instanceof Set)) return null;
  const first = Array.from(keys)[0];
  return typeof first === 'string' ? first : null;
}

function PrivacyLevelPicker({ value }: { value: SelectablePrivacyProtectionLevel | undefined }) {
  const current = value ?? 'standard';
  const detail = PRIVACY_LEVEL_DETAILS[current];

  return (
    <Column gap="xs" className="bento-welcome__choice">
      <ToggleButtonGroup
        aria-label="Privacy protection level"
        selectionMode="single"
        selectedKeys={new Set([current])}
        onSelectionChange={(keys) => {
          const next = firstSelectedKey(keys);
          if (!next) return;
          dispatch({
            type: 'privacy/setProtectionLevel',
            level: next as SelectablePrivacyProtectionLevel,
          });
        }}
      >
        {PRIVACY_LEVELS.map((level) => (
          <ToggleButton id={level.id} key={level.id} size="md">
            {level.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Column gap="2xs" className="bento-welcome__privacy-summary">
        <Text variant="label" size="s">
          {detail.label}
        </Text>
        <Text variant="text" size="s" color="muted">
          {detail.bestFor}
        </Text>
        <Text variant="text" size="s" color="muted">
          Benefit: {detail.benefits[0]}
        </Text>
        <Text variant="text" size="s" color="muted">
          Caveat: {detail.caveats[0]}
        </Text>
      </Column>
    </Column>
  );
}

const PRIVACY_ORIENTED_SEARCH_MATCHERS = [
  'duckduckgo',
  'ddg',
  'qwant',
  'ecosia',
  'startpage',
  'brave',
] as const;

function isPrivacyOrientedSearchEngine(engine: { id: string; name: string }) {
  const haystack = `${engine.id} ${engine.name}`.toLowerCase();
  return PRIVACY_ORIENTED_SEARCH_MATCHERS.some((matcher) => haystack.includes(matcher));
}

function SearchPrivacyRecommendation({
  availableSearchEngines,
}: {
  availableSearchEngines: readonly { id: SearchEngineId; name: string }[];
}) {
  if (availableSearchEngines.length === 0) {
    return (
      <Text variant="text" size="s" color="muted">
        Loading Firefox search engines…
      </Text>
    );
  }

  const recommended = availableSearchEngines.filter(isPrivacyOrientedSearchEngine);
  if (recommended.length === 0) {
    return (
      <Text variant="text" size="s" color="muted">
        For privacy, prefer a provider with minimal profiling and clear retention limits. Bento uses
        Firefox&rsquo;s visible search engines without adding its own provider list.
      </Text>
    );
  }

  const names = recommended.map((engine) => engine.name).join(', ');
  return (
    <Text variant="text" size="s" color="muted">
      Recommended for privacy: {names}. These are generally better choices when you want less search
      profiling; choose another engine when account integration or result preference matters more.
    </Text>
  );
}

function SearchEnginePicker({
  value,
  availableSearchEngines,
}: {
  value: SearchEngineId | undefined;
  availableSearchEngines: readonly { id: SearchEngineId; name: string }[];
}) {
  const [optimisticValue, setOptimisticValue] = useState<SearchEngineId | undefined>();
  const selectedKey = optimisticValue ?? value ?? 'ddg';

  useEffect(() => {
    setOptimisticValue(undefined);
  }, [value]);

  return (
    <Column gap="xs" className="bento-welcome__choice">
      <Select.Root
        placeholder="Select search engine"
        selectedKey={selectedKey}
        onSelectionChange={(key) => {
          if (typeof key !== 'string') return;
          const next = key as SearchEngineId;
          setOptimisticValue(next);
          dispatch({ type: 'privacy/setDefaultSearchEngine', id: next });
        }}
      >
        <Select.Label>Default search engine</Select.Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Icon />
        </Select.Trigger>
        <Select.Popover>
          <Select.ListBox>
            {availableSearchEngines.map((engine) => (
              <Select.Item id={engine.id} textValue={engine.name} key={engine.id}>
                {engine.name}
              </Select.Item>
            ))}
          </Select.ListBox>
        </Select.Popover>
      </Select.Root>
      <SearchPrivacyRecommendation availableSearchEngines={availableSearchEngines} />
    </Column>
  );
}

function WelcomeApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const welcomeSeen = useSettingsStore((s) => s.current?.welcomeSeen);
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode);
  const privacyProtectionLevel = useSettingsStore((s) => s.current?.privacyProtectionLevel);
  const defaultSearchEngine = useSettingsStore((s) => s.current?.defaultSearchEngine);
  const privacy = usePrivacyStore((s) => s.settings);
  const [stepIndex, setStepIndex] = useState<StepIndex>(0);
  const [hasLoadedStoredStep, setHasLoadedStoredStep] = useState(false);
  const hasRequestedOpenRef = useRef(false);
  const activeStep = ONBOARDING_STEPS[stepIndex] ?? ONBOARDING_STEPS[0]!;
  const isIntro = stepIndex === 0;
  const isImport = activeStep.id === 'import';
  const isPrivacy = activeStep.id === 'privacy';
  const isSearch = activeStep.id === 'search';
  const isFinish = stepIndex === ONBOARDING_STEPS.length - 1;

  const setUiColorMode = (next: UiColorModePref) =>
    dispatch({ type: 'settings/update', changes: { uiColorMode: next } });

  const setStep = (nextStep: StepIndex) => {
    const clamped = Math.max(0, Math.min(nextStep, ONBOARDING_STEPS.length - 1));
    void storeStep(clamped);
    setStepIndex(clamped);
  };

  const nextStep = () => {
    if (isFinish) {
      close();
      return;
    }
    if (isPrivacy) {
      dispatch({
        type: 'privacy/setProtectionLevel',
        level: privacyProtectionLevel ?? 'standard',
      });
    }
    setStep(stepIndex + 1);
  };

  const previousStep = () => {
    setStep(stepIndex - 1);
  };

  const startBrowserDataImport = () => {
    const followingStep = Math.min(stepIndex + 1, ONBOARDING_STEPS.length - 1);
    setStepIndex(followingStep);
    void importBrowserData(followingStep);
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

  useEffect(() => {
    if (welcomeSeen !== false || hasRequestedOpenRef.current) return;
    hasRequestedOpenRef.current = true;
    requestWelcome();
  }, [welcomeSeen]);

  useEffect(() => {
    dispatch({ type: 'privacy/requestSnapshot' });
  }, []);

  if (!hasLoadedStoredStep) return null;

  return (
    <Dialog.Root isOpen={true}>
      <Dialog.Backdrop isDismissable={false} isKeyboardDismissDisabled>
        <Dialog.Popup className="bento-welcome">
          <Column gap="l">
            <Row align="center" justify="between" gap="m" className="bento-welcome__topline">
              <Row align="center" gap="xs">
                <span className="bento-welcome__brand-mark" aria-hidden="true">
                  <Icon icon={Grid3X3} />
                </span>
                <Text variant="label" size="s" color="muted">
                  Bento onboarding
                </Text>
              </Row>
              <StepRail current={stepIndex} />
            </Row>

            <div className="bento-welcome__layout">
              <BentoTray activeStep={activeStep} boxes={activeStep.boxes} />

              <Column gap="m" className="bento-welcome__copy">
                <Text variant="label" size="s" color="accent">
                  {activeStep.eyebrow}
                </Text>
                <Dialog.Title>{activeStep.title}</Dialog.Title>
                <Dialog.Description>{activeStep.description}</Dialog.Description>
                {isIntro ? <ThemeModePicker value={uiColorMode} onChange={setUiColorMode} /> : null}
                {isPrivacy ? <PrivacyLevelPicker value={privacyProtectionLevel} /> : null}
                {isSearch ? (
                  <SearchEnginePicker
                    value={privacy?.defaultSearchEngine ?? defaultSearchEngine}
                    availableSearchEngines={privacy?.availableSearchEngines ?? []}
                  />
                ) : null}
              </Column>
            </div>
          </Column>

          <Dialog.Actions className={isIntro ? 'bento-welcome__actions--intro' : undefined}>
            {!isIntro ? (
              <Button variant="neutral" onPress={previousStep}>
                <Icon icon={ArrowLeft} size="sm" />
                Back
              </Button>
            ) : null}

            {isImport ? (
              <Row gap="xs" wrap justify="end">
                <Button variant="neutral" onPress={nextStep}>
                  Skip import
                </Button>
                <Button variant="primary" onPress={startBrowserDataImport}>
                  <Icon icon={Download} size="sm" />
                  Import browser data
                </Button>
              </Row>
            ) : (
              <Button variant="primary" onPress={nextStep}>
                {isFinish ? 'Start browsing' : 'Next'}
                {!isFinish ? <Icon icon={ArrowRight} size="sm" /> : null}
              </Button>
            )}
          </Dialog.Actions>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell welcome: #root not found');

createRoot(container).render(
  <StrictMode>
    <WelcomeApp />
  </StrictMode>,
);
