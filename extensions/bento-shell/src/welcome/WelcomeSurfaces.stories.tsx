// Visual states for the welcome surfaces. The Dialog stories compose the real
// Mux Dialog exactly as welcome/main.tsx does, with local state in place of the
// tools port (selections apply to the story only). The other stories frame one
// surface on the dialog's raised surface so fills and borders read as they do there.

import { useEffect, useState, type ReactNode } from 'react';
import type { Story } from '@ladle/react';
import { Dialog, Text } from '@muxui/react';
import type { SearchEngineChoice, UiColorModePref } from '@shared/protocol';

import { applyRootTheme } from '../theme/applyRootTheme';
import { getThemeMeta } from '../theme/presets';
import { useResolvedColorScheme } from '../theme/themeScope';
import {
  APPEARANCE_OPTIONS,
  ImportSources,
  LAST_STEP,
  PRIVACY_OPTIONS,
  ReadySummary,
  searchEngineName,
  searchEngineOptions,
  StepDots,
  stepIndexOf,
  themeSummaryRow,
  ThemeChooser,
  TourTiles,
  WELCOME_STEPS,
  WelcomeActions,
  WelcomeOptions,
  WelcomeStage,
  type WelcomeOption,
} from './WelcomeSurfaces';
import { dialogClass, type DialogHandoff } from './importHandoff';
import { IMPORT_BROWSERS, importCopy, type ImportBrowser, type ImportView } from './importSources';
import './welcome.css';
import './WelcomeSurfaces.stories.css';

// Stand-ins for the favicons Firefox ships (data URLs, as the privacy experiment sends them): a
// coloured square with the engine's initial, or a white square (as Startpage and Wikipedia ship
// in dark mode) for the names in WHITE_ICON.
const WHITE_ICON: ReadonlySet<string> = new Set(['Startpage', 'Wikipedia (en)']);

function engineIcon(name: string, hue: number): string {
  const white = WHITE_ICON.has(name);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    `<rect width="32" height="32" rx="6" fill="${white ? 'white' : `hsl(${hue} 60% 45%)`}"/>` +
    `<text x="16" y="23" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="700" fill="${white ? `hsl(${hue} 60% 45%)` : 'white'}">${name[0]}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Engines named in `names`, each with an icon except those named in `withoutIcon`. */
function engines(
  names: readonly string[],
  withoutIcon: readonly string[] = [],
): SearchEngineChoice[] {
  return names.map((name, index) => ({
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    isDefault: name === 'DuckDuckGo',
    ...(withoutIcon.includes(name) ? {} : { iconUrl: engineIcon(name, index * 47) }),
  }));
}

const ENGINES = engines(
  ['DuckDuckGo', 'Google', 'Startpage', 'Bing', 'Ecosia', 'Wikipedia (en)', 'Kagi'],
  ['Kagi'],
);
const MANY_ENGINES = engines(
  [
    'DuckDuckGo',
    'Google',
    'Startpage',
    'Bing',
    'Ecosia',
    'Qwant',
    'Brave Search',
    'Wikipedia (en)',
    'Amazon.com',
    'eBay',
    'Perplexity',
    'Kagi',
    'Mojeek',
    'Yahoo! JAPAN',
  ],
  ['Kagi'],
);

// Stand-ins for the logos chrome sends (PNG data URLs read from Firefox's brand images).
function placeholderLogo(hue: number): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    `<circle cx="24" cy="24" r="22" fill="hsl(${hue} 60% 50%)"/>` +
    '<circle cx="24" cy="24" r="9" fill="white"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const BROWSERS: ImportBrowser[] = IMPORT_BROWSERS.map(({ key, name }, index) => ({
  key,
  name,
  logo: placeholderLogo(index * 55),
}));

/** The states of the Import step, by what chrome reported. */
const IMPORT_VIEWS = {
  'six found': { kind: 'tiles', browsers: BROWSERS, firefoxZen: true },
  'two found': { kind: 'tiles', browsers: BROWSERS.slice(0, 2), firefoxZen: true },
  'three found, no Firefox or Zen': {
    kind: 'tiles',
    browsers: BROWSERS.slice(0, 3),
    firefoxZen: false,
  },
  'only Firefox or Zen': { kind: 'tiles', browsers: [], firefoxZen: true },
  'a logo chrome could not read': {
    kind: 'tiles',
    browsers: BROWSERS.slice(0, 3).map((browser, index) =>
      index === 1 ? { ...browser, logo: null } : browser,
    ),
    firefoxZen: true,
  },
  detecting: { kind: 'detecting' },
  'none found': { kind: 'none' },
  'detection failed': { kind: 'fallback' },
} satisfies Record<string, ImportView>;

type ImportViewName = keyof typeof IMPORT_VIEWS;
const IMPORT_VIEW_NAMES = Object.keys(IMPORT_VIEWS) as ImportViewName[];

type FrameWidth = 240 | 320 | 600 | 720;

function Frame({ width, children }: { width: FrameWidth; children: ReactNode }) {
  return (
    <div className="bento-welcome welcome-story-frame" data-width={width}>
      {children}
    </div>
  );
}

/** Shows `themeId` on the story's <html>, as the welcome page does for the active workspace's theme
 * (useWorkspaceTheme), so the dialog's accents and controls follow the swatch chosen. */
function useStoryRootTheme(themeId: string) {
  const colorScheme = useResolvedColorScheme();
  useEffect(() => {
    void applyRootTheme(themeId, colorScheme, true);
    return () => {
      void applyRootTheme('default', colorScheme, true);
    };
  }, [themeId, colorScheme]);
}

function ThemeDemo({ initial }: { initial: string }) {
  const [themeId, setThemeId] = useState(initial);
  return <ThemeChooser value={themeId} onChange={setThemeId} />;
}

function OptionsDemo<Id extends string>({
  layout,
  label,
  options,
  initial,
}: {
  layout: 'tiles' | 'rows' | 'grid';
  label: string;
  options: readonly WelcomeOption<Id>[];
  initial: Id;
}) {
  const [value, setValue] = useState(initial);
  return (
    <WelcomeOptions
      label={label}
      layout={layout}
      options={options}
      value={value}
      onChange={setValue}
    />
  );
}

/** The whole onboarding dialog at one step; the footer and Change actions navigate. */
function WelcomeDialog({
  initialStep,
  searchEngines,
  handoff = 'idle',
  importView = IMPORT_VIEWS['six found'],
  initialTheme = 'default',
}: {
  initialStep: number;
  searchEngines: readonly SearchEngineChoice[];
  handoff?: DialogHandoff;
  importView?: ImportView;
  initialTheme?: string;
}) {
  const [index, setIndex] = useState(initialStep);
  const [mode, setMode] = useState<UiColorModePref>('light');
  const [themeId, setThemeId] = useState(initialTheme);
  const colorScheme = useResolvedColorScheme();
  useStoryRootTheme(themeId);
  const [level, setLevel] = useState(PRIVACY_OPTIONS[0]!.id);
  const [engine, setEngine] = useState(searchEngines[0]?.id ?? 'ddg');
  const step = WELCOME_STEPS[index] ?? WELCOME_STEPS[0]!;
  const go = (next: number) => setIndex(Math.max(0, Math.min(next, LAST_STEP)));

  const body = {
    welcome: null,
    appearance: (
      <WelcomeOptions
        label="Appearance"
        layout="tiles"
        options={APPEARANCE_OPTIONS}
        value={mode}
        onChange={setMode}
      />
    ),
    theme: <ThemeChooser value={getThemeMeta(themeId).id} onChange={setThemeId} />,
    import: (
      <ImportSources view={importView} onBrowser={() => go(index + 1)} onFirefoxZen={() => {}} />
    ),
    privacy: (
      <WelcomeOptions
        label="Protection level"
        layout="rows"
        options={PRIVACY_OPTIONS}
        value={level}
        onChange={setLevel}
      />
    ),
    search: (
      <WelcomeOptions
        label="Default search engine"
        layout="grid"
        options={searchEngineOptions(searchEngines)}
        value={engine}
        onChange={setEngine}
      />
    ),
    tour: <TourTiles />,
    ready: (
      <ReadySummary
        rows={[
          {
            label: 'Appearance',
            value: APPEARANCE_OPTIONS.find((o) => o.id === mode)?.label ?? '',
            step: stepIndexOf('appearance'),
          },
          themeSummaryRow(themeId, colorScheme),
          {
            label: 'Privacy',
            value: PRIVACY_OPTIONS.find((o) => o.id === level)?.label ?? '',
            step: stepIndexOf('privacy'),
          },
          {
            label: 'Search',
            value: searchEngineName(searchEngines, engine),
            step: stepIndexOf('search'),
          },
        ]}
        onChange={go}
      />
    ),
  }[step.id];

  return (
    <Dialog
      open={true}
      dismissable={false}
      aria-labelledby="story-welcome-title"
      className={dialogClass(handoff)}
      actionsClassName="bento-welcome__actions"
      actions={
        <WelcomeActions
          index={index}
          onBack={() => go(index - 1)}
          onNext={() => go(index + 1)}
          onImport={() => go(index + 1)}
          importAction={importCopy(importView).action}
        />
      }
    >
      <WelcomeStage
        step={step}
        index={index}
        titleId="story-welcome-title"
        descriptionId="story-welcome-description"
        description={step.id === 'import' ? importCopy(importView).description : step.description}
      >
        {body}
      </WelcomeStage>
    </Dialog>
  );
}

type DialogArgs = { step: number };

export const DialogSteps: Story<DialogArgs> = ({ step }) => (
  // Remount per step so the control resets the story's local state.
  <WelcomeDialog key={step} initialStep={step} searchEngines={ENGINES} />
);
DialogSteps.storyName = 'Dialog (every step)';
DialogSteps.args = { step: 0 };
DialogSteps.argTypes = {
  step: { options: WELCOME_STEPS.map((_, index) => index), control: { type: 'radio' } },
};

type HandoffArgs = { state: DialogHandoff };

export const DialogImportHandoff: Story<HandoffArgs> = ({ state }) => (
  // On the Import step; the state is the one the dialog takes while the import wizard is up.
  <WelcomeDialog
    key={state}
    initialStep={stepIndexOf('import')}
    searchEngines={ENGINES}
    handoff={state}
  />
);
DialogImportHandoff.storyName = 'Dialog (import handoff states)';
DialogImportHandoff.args = { state: 'out' };
DialogImportHandoff.argTypes = {
  state: {
    options: ['idle', 'out', 'hidden', 'restoring', 'faded'] satisfies DialogHandoff[],
    control: { type: 'radio' },
  },
};

type ImportArgs = { state: ImportViewName };

export const DialogImportStates: Story<ImportArgs> = ({ state }) => (
  // The Import step by what chrome reported: tiles, placeholders while it looks, nothing found, a failure.
  <WelcomeDialog
    key={state}
    initialStep={stepIndexOf('import')}
    searchEngines={ENGINES}
    importView={IMPORT_VIEWS[state]}
  />
);
DialogImportStates.storyName = 'Dialog (import step states)';
DialogImportStates.args = { state: 'six found' };
DialogImportStates.argTypes = {
  state: { options: IMPORT_VIEW_NAMES, control: { type: 'radio' } },
};

export const DialogImportNarrow: Story<ImportArgs> = ({ state }) => (
  <WelcomeDialog
    key={state}
    initialStep={stepIndexOf('import')}
    searchEngines={ENGINES}
    importView={IMPORT_VIEWS[state]}
  />
);
DialogImportNarrow.storyName = 'Dialog (import step, narrow viewport: two columns)';
DialogImportNarrow.args = { state: 'three found, no Firefox or Zen' };
DialogImportNarrow.argTypes = DialogImportStates.argTypes;
DialogImportNarrow.meta = { width: 'small' };

export const DialogLongEngineList = () => (
  <WelcomeDialog initialStep={stepIndexOf('search')} searchEngines={MANY_ENGINES} />
);
DialogLongEngineList.storyName = 'Dialog (search, 14 engines scroll)';

export const DialogLoadingEngines = () => <LoadingSearchDialog />;
DialogLoadingEngines.storyName = 'Dialog (search, engines loading)';

function LoadingSearchDialog() {
  const step = WELCOME_STEPS[stepIndexOf('search')]!;
  return (
    <Dialog
      open={true}
      dismissable={false}
      aria-labelledby="story-loading-title"
      className="bento-welcome"
      actionsClassName="bento-welcome__actions"
      actions={
        <WelcomeActions
          index={stepIndexOf('search')}
          onBack={() => {}}
          onNext={() => {}}
          onImport={() => {}}
        />
      }
    >
      <WelcomeStage
        step={step}
        index={stepIndexOf('search')}
        titleId="story-loading-title"
        descriptionId="story-loading-description"
      >
        <Text as="p" size="sm" color="muted">
          Loading Firefox search engines…
        </Text>
      </WelcomeStage>
    </Dialog>
  );
}

export const DialogNarrow: Story<DialogArgs> = ({ step }) => (
  <WelcomeDialog key={step} initialStep={step} searchEngines={ENGINES} />
);
DialogNarrow.storyName = 'Dialog (narrow viewport, grids collapse, tour tiles as rows)';
DialogNarrow.args = { step: stepIndexOf('tour') };
DialogNarrow.argTypes = DialogSteps.argTypes;
DialogNarrow.meta = { width: 'small' };

export const DialogTheme: Story<{ theme: string }> = ({ theme }) => (
  // The Theme step. Choosing a swatch repaints the dialog in that theme, as the workspace's theme does
  // in the welcome page; light and dark follow the toolbar toggle.
  <WelcomeDialog
    key={theme}
    initialStep={stepIndexOf('theme')}
    searchEngines={ENGINES}
    initialTheme={theme}
  />
);
DialogTheme.storyName = 'Dialog (theme step)';
DialogTheme.args = { theme: 'default' };
DialogTheme.argTypes = {
  theme: {
    options: ['default', 'standard-blueprint', 'standard-wildflower', 'monochrome-teal'],
    control: { type: 'radio' },
  },
};

export const DialogThemeNarrow: Story<{ theme: string }> = ({ theme }) => (
  <WelcomeDialog
    key={theme}
    initialStep={stepIndexOf('theme')}
    searchEngines={ENGINES}
    initialTheme={theme}
  />
);
DialogThemeNarrow.args = DialogTheme.args;
DialogThemeNarrow.argTypes = DialogTheme.argTypes;
DialogThemeNarrow.storyName =
  'Dialog (theme step, narrow viewport, shorter preview and wrapped rows)';
DialogThemeNarrow.meta = { width: 'small' };

export const Dots = () => (
  <Frame width={240}>
    {WELCOME_STEPS.map((step, index) => (
      <StepDots key={step.id} current={index} />
    ))}
  </Frame>
);
Dots.storyName = 'Step dots (each step)';

export const AppearanceTiles = () => (
  <Frame width={600}>
    <OptionsDemo layout="tiles" label="Appearance" options={APPEARANCE_OPTIONS} initial="dark" />
  </Frame>
);
AppearanceTiles.storyName = 'Options: appearance tiles (Dark selected)';

export const ThemeChooserDefault = () => (
  <Frame width={720}>
    <ThemeDemo initial="default" />
  </Frame>
);
ThemeChooserDefault.storyName =
  'Theme chooser (Default selected; hover or focus a swatch to preview)';

export const ThemeChooserMonochrome = () => (
  <Frame width={720}>
    <ThemeDemo initial="monochrome-teal" />
  </Frame>
);
ThemeChooserMonochrome.storyName = 'Theme chooser (a monochrome theme selected)';

export const PrivacyRows = () => (
  <Frame width={600}>
    <OptionsDemo
      layout="rows"
      label="Protection level"
      options={PRIVACY_OPTIONS}
      initial="standard"
    />
  </Frame>
);
PrivacyRows.storyName = 'Options: privacy rows (description, tag)';

export const PrivacyRowsNarrow = () => (
  <Frame width={320}>
    <OptionsDemo
      layout="rows"
      label="Protection level"
      options={PRIVACY_OPTIONS}
      initial="hardened"
    />
  </Frame>
);
PrivacyRowsNarrow.storyName = 'Options: privacy rows (narrow, text wraps)';

export const SearchGrid = () => (
  <Frame width={600}>
    <OptionsDemo
      layout="grid"
      label="Default search engine"
      options={searchEngineOptions(ENGINES)}
      initial="startpage"
    />
  </Frame>
);
SearchGrid.storyName = 'Options: search grid (icons, Private tags, one without an icon)';

export const SearchGridLong = () => (
  <Frame width={600}>
    <OptionsDemo
      layout="grid"
      label="Default search engine"
      options={searchEngineOptions(MANY_ENGINES)}
      initial="duckduckgo"
    />
  </Frame>
);
SearchGridLong.storyName = 'Options: search grid (14 engines, scrolls)';

export const ImportSourceList: Story<ImportArgs> = ({ state }) => (
  <Frame width={600}>
    <ImportSources view={IMPORT_VIEWS[state]} onBrowser={() => {}} onFirefoxZen={() => {}} />
  </Frame>
);
ImportSourceList.storyName = 'Import sources (tiles)';
ImportSourceList.args = { state: 'two found' };
ImportSourceList.argTypes = DialogImportStates.argTypes;

export const ImportSourceListNarrow: Story<ImportArgs> = ({ state }) => (
  <Frame width={320}>
    <ImportSources view={IMPORT_VIEWS[state]} onBrowser={() => {}} onFirefoxZen={() => {}} />
  </Frame>
);
ImportSourceListNarrow.storyName = 'Import sources (narrow container)';
ImportSourceListNarrow.args = { state: 'six found' };
ImportSourceListNarrow.argTypes = DialogImportStates.argTypes;

export const Tour = () => (
  <Frame width={720}>
    <TourTiles />
  </Frame>
);
Tour.storyName = 'Tour tiles';

function SummaryDemo() {
  const colorScheme = useResolvedColorScheme();
  return (
    <Frame width={600}>
      <ReadySummary
        rows={[
          { label: 'Appearance', value: 'Auto', step: 1 },
          themeSummaryRow('monochrome-mountain-meadow', colorScheme),
          { label: 'Privacy', value: 'Enhanced', step: 4 },
          { label: 'Search', value: 'A search engine with a very long display name', step: 5 },
        ]}
        onChange={() => {}}
      />
    </Frame>
  );
}

export const Summary = () => <SummaryDemo />;
Summary.storyName = 'Ready summary (Theme row, long value)';
