// Visual states for the welcome surfaces. The Dialog stories compose the real
// Mux Dialog exactly as welcome/main.tsx does, with local state in place of the
// tools port (selections apply to the story only). The other stories frame one
// surface on the dialog's raised surface so fills and borders read as they do there.

import { useState, type ReactNode } from 'react';
import type { Story } from '@ladle/react';
import { Dialog, Text } from '@muxui/react';
import type { SearchEngineChoice, UiColorModePref } from '@shared/protocol';

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
  TourTiles,
  WELCOME_STEPS,
  WelcomeActions,
  WelcomeOptions,
  WelcomeStage,
  type WelcomeOption,
} from './WelcomeSurfaces';
import './welcome.css';
import './WelcomeSurfaces.stories.css';

function engines(names: readonly string[]): SearchEngineChoice[] {
  return names.map((name) => ({
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    isDefault: name === 'DuckDuckGo',
  }));
}

const ENGINES = engines(['DuckDuckGo', 'Google', 'Startpage', 'Bing', 'Ecosia', 'Wikipedia (en)']);
const MANY_ENGINES = engines([
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
]);

type FrameWidth = 240 | 320 | 600 | 720;

function Frame({ width, children }: { width: FrameWidth; children: ReactNode }) {
  return (
    <div className="bento-welcome welcome-story-frame" data-width={width}>
      {children}
    </div>
  );
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
}: {
  initialStep: number;
  searchEngines: readonly SearchEngineChoice[];
}) {
  const [index, setIndex] = useState(initialStep);
  const [mode, setMode] = useState<UiColorModePref>('light');
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
    import: <ImportSources />,
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
      className="bento-welcome"
      actionsClassName="bento-welcome__actions"
      actions={
        <WelcomeActions
          index={index}
          onBack={() => go(index - 1)}
          onNext={() => go(index + 1)}
          onImport={() => go(index + 1)}
        />
      }
    >
      <WelcomeStage
        step={step}
        index={index}
        titleId="story-welcome-title"
        descriptionId="story-welcome-description"
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
DialogNarrow.storyName = 'Dialog (narrow viewport, grids collapse)';
DialogNarrow.args = { step: stepIndexOf('tour') };
DialogNarrow.argTypes = DialogSteps.argTypes;
DialogNarrow.meta = { width: 'small' };

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
SearchGrid.storyName = 'Options: search grid (Private tags)';

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

export const ImportSourceList = () => (
  <Frame width={600}>
    <ImportSources />
  </Frame>
);
ImportSourceList.storyName = 'Import sources';

export const ImportSourceListNarrow = () => (
  <Frame width={320}>
    <ImportSources />
  </Frame>
);
ImportSourceListNarrow.storyName = 'Import sources (narrow container)';

export const Tour = () => (
  <Frame width={720}>
    <TourTiles />
  </Frame>
);
Tour.storyName = 'Tour tiles';

export const Summary = () => (
  <Frame width={600}>
    <ReadySummary
      rows={[
        { label: 'Appearance', value: 'Auto', step: 1 },
        { label: 'Privacy', value: 'Enhanced', step: 3 },
        { label: 'Search', value: 'A search engine with a very long display name', step: 4 },
      ]}
      onChange={() => {}}
    />
  </Frame>
);
Summary.storyName = 'Ready summary (long value)';
