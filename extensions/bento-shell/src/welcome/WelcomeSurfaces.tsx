// Welcome surfaces that main.tsx shares with Ladle and the step tests. main.tsx
// runs the tools port and mounts React at import time, so a story or test cannot
// import it; everything here is side-effect free.

import { useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Button, ColorSwatch, Image, Text, ToggleButton, ToggleButtonGroup } from '@muxui/react';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import Globe from 'lucide-react/dist/esm/icons/globe';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Search from 'lucide-react/dist/esm/icons/search';
import type {
  SearchEngineChoice,
  SelectablePrivacyProtectionLevel,
  UiColorModePref,
} from '@shared/protocol';
import { PRIVACY_LEVELS } from '@shared/privacy-levels';

import { BentoIcon } from '../components/primitives/BentoIcon';
import { Row } from '../components/primitives/BentoRow';
import { BENTO_THEMES, getThemeMeta, resolveThemeId } from '../theme/presets';
import {
  getThemeScopeAttributes,
  useResolvedColorScheme,
  type ThemeColorScheme,
} from '../theme/themeScope';
import { ALL_THEME_IDS, useThemeSheets } from '../theme/themeSheets';
import { nextPreview, requestedTheme, swatchThemeId } from './themeChooser';
import { importTitle, type DialogGeometry } from './importHandoff';
import {
  firefoxZenSpan,
  firefoxZenTitle,
  IMPORT_DESCRIPTION,
  IMPORT_GRID_COLUMNS,
  IMPORT_NONE_NOTE,
  importCopy,
  type ImportBrowser,
  type ImportBrowserKey,
  type ImportCopy,
  type ImportView,
} from './importSources';

interface WelcomeStepCopy<Id extends string> {
  id: Id;
  title: string;
  description?: string;
  /** Small muted line under the step's control. */
  note?: string;
  illustration?: 'welcome' | 'ready';
}

// The index of a step is the value persisted in 'bento-welcome-step' and sent
// as the next step in BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts>.
const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Bento',
    description: 'A workspace-first browser built on Firefox. Setup takes about a minute.',
    illustration: 'welcome',
  },
  {
    id: 'appearance',
    title: 'Choose your appearance',
    description: 'Applies right away. Change it any time in Settings.',
  },
  {
    id: 'theme',
    title: 'Pick a colour theme',
    description: 'Colours your first workspace. Every workspace can have its own.',
  },
  {
    id: 'import',
    title: 'Bring your browsing with you',
    // The description of the state with browsers to pick from; importCopy has the others.
    description: IMPORT_DESCRIPTION,
  },
  {
    id: 'privacy',
    title: 'Pick a protection level',
    note: 'Protection levels can be fine-tuned in Settings',
  },
  {
    id: 'search',
    title: 'Default search engine',
    note: "Add more search engines in Firefox's search settings",
  },
  { id: 'tour', title: 'How Bento works' },
  {
    id: 'ready',
    title: 'You are set',
    description: 'Customise Bento Browser any time in Settings.',
    illustration: 'ready',
  },
] as const satisfies readonly WelcomeStepCopy<string>[];

export type WelcomeStepId = (typeof STEPS)[number]['id'];
export type WelcomeStep = WelcomeStepCopy<WelcomeStepId>;
export const WELCOME_STEPS: readonly WelcomeStep[] = STEPS;
/** Index of the last step; "Step N of LAST_STEP" counts every step after Welcome. */
export const LAST_STEP = WELCOME_STEPS.length - 1;

export function stepIndexOf(id: WelcomeStepId): number {
  return WELCOME_STEPS.findIndex((step) => step.id === id);
}

/** A persisted step (number, or string from the hash and localStorage), or null when invalid. */
export function parseStoredStep(value: unknown): number | null {
  const stored =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isInteger(stored) && stored >= 0 && stored <= LAST_STEP ? stored : null;
}

/** The step onboarding resumes on after an import started from `index`. */
export function stepAfter(index: number): number {
  return Math.min(index + 1, LAST_STEP);
}

/** Persists the step onboarding resumes on, then sends the title that makes chrome
 * open the migration host: BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts>, with the dialog's
 * geometry appended when it can morph into the wizard (importHandoff.ts) and the
 * browser's key when a tile chose it. The store comes first so a restart during the
 * import still resumes on nextStep. */
export async function startImport(
  nextStep: number,
  store: (step: number) => Promise<void>,
  send: (title: string) => void,
  handoff?: { token: string; geometry: DialogGeometry | null; source?: ImportBrowserKey },
): Promise<void> {
  await store(nextStep);
  send(
    importTitle(
      nextStep,
      handoff?.token ?? String(Date.now()),
      handoff?.geometry ?? undefined,
      handoff?.source,
    ),
  );
}

/** The Firefox or Zen tile: persists the resume step, then asks chrome to restart Bento into
 * Firefox's startup import (BENTO_IMPORT_FIREFOX_ZEN_<nextStep>_<ts>). Onboarding reopens on
 * nextStep afterwards, as it does for a restart from inside the wizard. */
export async function startFirefoxZenImport(
  nextStep: number,
  store: (step: number) => Promise<void>,
  send: (title: string) => void,
): Promise<void> {
  await store(nextStep);
  send(firefoxZenTitle(nextStep, String(Date.now())));
}

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// macOS-style modifier glyphs vs. spelled-out names elsewhere. Matches
// what users see printed on their keyboard.
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
export const ALT = IS_MAC ? '⌥' : 'Alt';
export const SHIFT = IS_MAC ? '⇧' : 'Shift';

function keys(...parts: string[]): string {
  return parts.join(IS_MAC ? '' : '+');
}

/** Entry delay for the index-th tile of a step, a fraction of the reveal role's duration. */
function stagger(index: number): CSSProperties {
  return {
    animationDelay: `calc(var(--muxui-semantic-motion-reveal-transition-duration) * ${index} * 0.12)`,
  };
}

/** Header, illustration, title, description, control and note of one step. The
 * body remounts per step (key) so its entry animation replays. */
export function WelcomeStage({
  step,
  index,
  titleId,
  descriptionId,
  headingRef,
  description = step.description,
  children,
}: {
  step: WelcomeStep;
  index: number;
  titleId: string;
  descriptionId: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** Replaces the step's description (the Import step's depends on what chrome found). */
  description?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <Text as="p" variant="label" size="sm" color="muted" className="bento-welcome__counter">
        {index > 0 ? `Step ${index} of ${LAST_STEP}` : null}
      </Text>
      <div className="bento-welcome__stage" key={step.id}>
        {step.illustration ? (
          <Image
            src={`./welcome/${step.illustration}.webp`}
            alt=""
            fit="contain"
            className="bento-welcome__illustration"
          />
        ) : null}
        <Text
          as="h1"
          variant="heading"
          size="sm"
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className="bento-welcome__title"
        >
          {step.title}
        </Text>
        {description ? (
          <Text as="p" color="muted" id={descriptionId} className="bento-welcome__description">
            {description}
          </Text>
        ) : null}
        {children}
        {step.note ? (
          <Text as="p" size="sm" color="muted" className="bento-welcome__description">
            {step.note}
          </Text>
        ) : null}
      </div>
    </>
  );
}

/** Presentational progress; "Step N of LAST_STEP" is the accessible progress text. */
export function StepDots({ current }: { current: number }) {
  return (
    <span className="bento-welcome__dots" aria-hidden="true">
      {WELCOME_STEPS.map((step, index) => (
        <span key={step.id} data-active={index === current ? 'true' : undefined} />
      ))}
    </span>
  );
}

/** Dialog footer: Back, the dots, and the step's actions. On the Import step
 * onNext is Skip and onImport opens the Firefox migration wizard with no browser
 * selected (the tiles open it with one). */
export function WelcomeActions({
  index,
  onBack,
  onNext,
  onImport,
  importAction = importCopy({ kind: 'detecting' }).action,
}: {
  index: number;
  onBack: () => void;
  onNext: () => void;
  onImport: () => void;
  importAction?: ImportCopy['action'];
}) {
  const id = WELCOME_STEPS[index]?.id;
  return (
    <>
      <div>
        {index > 0 ? (
          <Button variant="neutral" onActivate={onBack}>
            Back
          </Button>
        ) : null}
      </div>
      <StepDots current={index} />
      {/* Keyed so React never reuses the primary next button as Skip (or back), which would
          animate its fill between variants as the step changes. */}
      <Row gap="xs" justify="end" wrap className="bento-welcome__next">
        {id === 'import' ? (
          <>
            <Button key="skip" variant="neutral" onActivate={onNext}>
              Skip
            </Button>
            <Button
              key="import"
              variant={importAction.primary ? 'primary' : 'neutral'}
              onActivate={onImport}
            >
              {importAction.label}
            </Button>
          </>
        ) : (
          <Button key="next" variant="primary" onActivate={onNext}>
            {id === 'welcome' ? 'Get started' : id === 'ready' ? 'Start browsing' : 'Continue'}
          </Button>
        )}
      </Row>
    </>
  );
}

export interface WelcomeOption<Id extends string> {
  id: Id;
  label: string;
  description?: string;
  tag?: string;
  preview?: ReactNode;
  /** Mark before the label, on the same line (search engines). */
  icon?: ReactNode;
}

/** The one selectable surface for Appearance, Privacy and Search: a single-select
 * Mux group whose items Bento lays out as tiles (preview above the label), rows
 * (one column), or a two-column grid that scrolls past eight items. */
export function WelcomeOptions<Id extends string>({
  label,
  layout,
  options,
  value,
  onChange,
}: {
  label: string;
  layout: 'tiles' | 'rows' | 'grid';
  options: readonly WelcomeOption<Id>[];
  value: Id;
  onChange: (next: Id) => void;
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      orientation={layout === 'rows' ? 'vertical' : 'horizontal'}
      selectedIds={[value]}
      onSelectionChange={(ids) => {
        const next = options.find((option) => option.id === ids[0]);
        if (next) onChange(next.id);
      }}
      className={`bento-welcome__options bento-welcome__options--${layout}`}
    >
      {options.map((option) => (
        <ToggleButton key={option.id} id={option.id} className="bento-welcome__option">
          {option.preview}
          {option.icon}
          <Text variant="label" size="md">
            {option.label}
          </Text>
          {option.tag ? (
            <Text variant="label" size="xs" color="muted">
              {option.tag}
            </Text>
          ) : null}
          {option.description ? (
            <Text size="sm" color="muted" className="bento-welcome__option-description">
              {option.description}
            </Text>
          ) : null}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

function PreviewPane({ scheme, sidebar }: { scheme: 'light' | 'dark'; sidebar?: boolean }) {
  return (
    <span className="bento-welcome__preview-pane" data-muxui-color-scheme={scheme}>
      {sidebar ? <span /> : null}
      <span className="bento-welcome__preview-lines">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

/** Mini window for an appearance tile. Each pane forces its scheme so the Light and
 * Dark previews keep their colours whatever mode the dialog is in; Auto shows both. */
export function AppearancePreview({ mode }: { mode: UiColorModePref }) {
  return (
    <span className="bento-welcome__preview" aria-hidden="true">
      <PreviewPane scheme={mode === 'dark' ? 'dark' : 'light'} sidebar />
      {mode === 'system' ? <PreviewPane scheme="dark" /> : null}
    </span>
  );
}

export const APPEARANCE_OPTIONS = [
  { id: 'light', label: 'Light', preview: <AppearancePreview mode="light" /> },
  { id: 'dark', label: 'Dark', preview: <AppearancePreview mode="dark" /> },
  { id: 'system', label: 'Auto', preview: <AppearancePreview mode="system" /> },
] as const satisfies readonly WelcomeOption<UiColorModePref>[];

/** The Theme step's two swatch rows: Default and the standard themes, then the monochrome ones. */
export const THEME_GROUPS = [
  {
    id: 'colourful',
    label: 'Colourful',
    themes: BENTO_THEMES.filter((theme) => theme.collection !== 'monochrome'),
  },
  {
    id: 'monochrome',
    label: 'Monochrome',
    themes: BENTO_THEMES.filter((theme) => theme.collection === 'monochrome'),
  },
] as const;

/** A theme pick written to a workspace and not yet reported back by the workspace snapshot. */
export interface PendingTheme {
  workspaceId: string;
  themeId: string;
}

/** What the Theme step shows while a pick is in flight, and whether the pick is done with.
 * The pick counts only while its workspace is the active one: another workspace shows its own
 * stored theme, and the pick is done with. It is settled once that workspace's stored theme (as
 * the dialog resolves it, so an unset or unknown id is Default) equals the latest pick, so an
 * acknowledgement of an older pick leaves the newest one showing. */
export function pendingThemeView({
  pending,
  activeWorkspaceId,
  storedThemeId,
}: {
  pending: PendingTheme | null;
  activeWorkspaceId: string | null;
  storedThemeId: string | undefined;
}): { themeId: string; settled: boolean } {
  const stored = resolveThemeId(storedThemeId);
  if (!pending || pending.workspaceId !== activeWorkspaceId) {
    return { themeId: stored, settled: true };
  }
  const picked = resolveThemeId(pending.themeId);
  return picked === stored
    ? { themeId: stored, settled: true }
    : { themeId: picked, settled: false };
}

/** A low-fidelity Bento window drawn in a theme's own scope, from shapes only (no text): a titlebar
 * of dots, a sidebar (workspace switcher, address field, a New row, three tabs with the first active,
 * toolbar squares) and a content panel (a heading bar, skeleton lines, an accent button). The root
 * carries `getThemeScopeAttributes`, so only public Mux tokens colour it: the avatar and the active
 * tab take the theme's colour-60 and the button its action colour, which is how the theme reads
 * through; the bars are neutral. The sheet for that scope must be loaded (ThemeChooser).
 * Decorative: the swatches and the name line carry the meaning. */
export function ThemePreview({
  themeId,
  colorScheme,
}: {
  themeId: string;
  colorScheme: ThemeColorScheme;
}) {
  return (
    <span
      className="bento-welcome__theme-preview"
      aria-hidden="true"
      {...getThemeScopeAttributes(themeId, colorScheme)}
    >
      <span className="bento-welcome__theme-titlebar">
        <span />
        <span />
        <span />
      </span>
      <span className="bento-welcome__theme-sidebar">
        <span className="bento-welcome__theme-workspace">
          <span className="bento-welcome__theme-avatar" />
          <span className="bento-welcome__theme-bar" />
        </span>
        <span className="bento-welcome__theme-address">
          <span className="bento-welcome__theme-bar" />
        </span>
        <span className="bento-welcome__theme-new">
          <span className="bento-welcome__theme-bar" />
        </span>
        <span className="bento-welcome__theme-tab" data-active="true">
          <span className="bento-welcome__theme-icon" />
          <span className="bento-welcome__theme-bar" />
        </span>
        <span className="bento-welcome__theme-tab">
          <span className="bento-welcome__theme-icon" />
          <span className="bento-welcome__theme-bar" />
        </span>
        <span className="bento-welcome__theme-tab">
          <span className="bento-welcome__theme-icon" />
          <span className="bento-welcome__theme-bar" />
        </span>
        <span className="bento-welcome__theme-tools">
          <span />
          <span />
          <span />
          <span />
        </span>
      </span>
      <span className="bento-welcome__theme-panel">
        <span className="bento-welcome__theme-bar bento-welcome__theme-heading" />
        <span className="bento-welcome__theme-bar" />
        <span className="bento-welcome__theme-bar" />
        <span className="bento-welcome__theme-bar" />
        <span className="bento-welcome__theme-button" />
      </span>
    </span>
  );
}

/** The swatch an event came from, if any (see swatchThemeId). */
function swatchAt(target: EventTarget): string | null {
  return target instanceof Element ? swatchThemeId(target) : null;
}

/** The Theme step's body: a live preview of a theme over two rows of swatches (Colourful, then
 * Monochrome) and the theme's name and description. One selection spans both rows: each row is
 * a single-select Mux `ToggleButtonGroup` that gets `value` only when it holds that theme (Default
 * and Harbour share their colours, so the swatches are keyed by theme, not by colour). Hovering or
 * focusing a swatch shows that theme in the preview and the name line only (themeChooser.ts has
 * the rules): the pointer moving to whitespace or leaving the rows, focus leaving them, or
 * activating a swatch shows the selected theme again. Choosing a different theme calls
 * `onChange`. Every theme's sheet is kept loaded while the step shows (as the workspace theme
 * picker does), so the preview and swatches never paint in the dialog's own tokens. */
export function ThemeChooser({
  value,
  onChange,
}: {
  value: string;
  onChange: (themeId: string) => void;
}) {
  const colorScheme = useResolvedColorScheme();
  const [previewId, setPreviewId] = useState<string | null>(null);
  useThemeSheets(ALL_THEME_IDS);
  const shown = getThemeMeta(previewId ?? value);

  return (
    <div className="bento-welcome__theme-chooser">
      <ThemePreview themeId={shown.id} colorScheme={colorScheme} />
      <div
        className="bento-welcome__theme-swatches"
        onMouseOver={(event) => {
          const swatch = swatchAt(event.target);
          setPreviewId((current) => nextPreview(current, { type: 'point', swatch }));
        }}
        onMouseLeave={() => setPreviewId((current) => nextPreview(current, { type: 'leave' }))}
        onFocus={(event) => {
          const swatch = swatchAt(event.target);
          setPreviewId((current) => nextPreview(current, { type: 'focus', swatch }));
        }}
        onBlur={(event) => {
          if (!(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )) {
            setPreviewId((current) => nextPreview(current, { type: 'leave' }));
          }
        }}
      >
        {THEME_GROUPS.map((group) => (
          <ToggleButtonGroup
            key={group.id}
            aria-label={`${group.label} themes`}
            selectionMode="single"
            disallowEmptySelection
            selectedIds={group.themes.some((theme) => theme.id === value) ? [value] : []}
            onSelectionChange={(ids) => {
              setPreviewId((current) => nextPreview(current, { type: 'select' }));
              const next = requestedTheme(
                group.themes.find((theme) => theme.id === ids[0])?.id,
                value,
              );
              if (next) onChange(next);
            }}
            className="bento-welcome__swatch-row"
          >
            {group.themes.map((theme) => (
              <ToggleButton
                key={theme.id}
                id={theme.id}
                aria-label={theme.name}
                data-theme-swatch={theme.id}
                className="bento-welcome__swatch"
              >
                <ColorSwatch
                  {...getThemeScopeAttributes(theme.id, colorScheme)}
                  color={theme.brand60}
                  secondaryColor={theme.neutral20}
                  shape="circle"
                  className="bento-welcome__swatch-color"
                />
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ))}
      </div>
      <Text as="p" size="sm" color="muted" className="bento-welcome__theme-name">
        <Text as="span" variant="label" size="sm" color="default">
          {shown.name}
        </Text>{' '}
        {shown.description}
      </Text>
    </div>
  );
}

export const PRIVACY_OPTIONS: readonly WelcomeOption<SelectablePrivacyProtectionLevel>[] =
  PRIVACY_LEVELS.map((level) => ({
    id: level.id,
    label: level.label,
    description: level.summary,
    tag: level.id === 'standard' ? 'Recommended' : undefined,
  }));

const PRIVACY_ORIENTED_SEARCH_MATCHERS = [
  'duckduckgo',
  'ddg',
  'qwant',
  'ecosia',
  'startpage',
  'brave',
] as const;

/** The engine's icon as Firefox ships it: a data URL from the privacy experiment, used as is like
 * the address bar does. An engine without one gets a muted search glyph in the same box, so names
 * stay aligned. Decorative: the option's name is the engine's name. */
function SearchEngineIcon({ iconUrl }: { iconUrl?: string }) {
  return iconUrl ? (
    <Image src={iconUrl} alt="" fit="contain" className="bento-welcome__option-icon" />
  ) : (
    <BentoIcon icon={Search} size="md" className="bento-welcome__option-icon" />
  );
}

/** One option per Firefox engine, with its icon, tagged Private when it matches a
 * privacy-oriented provider. */
export function searchEngineOptions(
  engines: readonly SearchEngineChoice[],
): WelcomeOption<string>[] {
  return engines.map((engine) => {
    const haystack = `${engine.id} ${engine.name}`.toLowerCase();
    const isPrivate = PRIVACY_ORIENTED_SEARCH_MATCHERS.some((matcher) =>
      haystack.includes(matcher),
    );
    return {
      id: engine.id,
      label: engine.name,
      tag: isPrivate ? 'Private' : undefined,
      icon: <SearchEngineIcon iconUrl={engine.iconUrl} />,
    };
  });
}

function ImportTile({
  name,
  sublabel,
  leading,
  ariaLabel,
  onActivate,
}: {
  name: string;
  sublabel?: string;
  leading: ReactNode;
  ariaLabel: string;
  onActivate: () => void;
}) {
  // Spans, not Row and Column: those render divs, which a button cannot contain.
  return (
    <Button
      variant="ghost"
      className="bento-welcome__source"
      aria-label={ariaLabel}
      onActivate={onActivate}
    >
      <span className="bento-welcome__source-leading">{leading}</span>
      <span className="bento-welcome__source-label">
        <Text as="span" variant="label" size="sm">
          {name}
        </Text>
        {sublabel ? (
          <Text as="span" size="xs" color="muted">
            {sublabel}
          </Text>
        ) : null}
      </span>
      <BentoIcon icon={ChevronRight} size="sm" />
    </Button>
  );
}

function BrowserLogo({ browser }: { browser: ImportBrowser }) {
  return browser.logo ? (
    <Image src={browser.logo} alt="" fit="contain" className="bento-welcome__source-logo" />
  ) : (
    <BentoIcon icon={Globe} size="md" />
  );
}

// The tile grid is 4 columns wide, 2 when compact (welcome.css); the Firefox or Zen tile takes
// the columns left in its row at each.
function firefoxZenSpans(browserCount: number) {
  return {
    'data-span': firefoxZenSpan(browserCount, IMPORT_GRID_COLUMNS.wide),
    'data-span-compact': firefoxZenSpan(browserCount, IMPORT_GRID_COLUMNS.compact),
  };
}

/**
 * The Import step's body. One real button per browser chrome found, which opens the wizard with that
 * browser selected, and a Firefox or Zen tile (no logo ships for either) that restarts Bento into
 * Firefox's startup import. Static placeholders while chrome is still looking; nothing but a note
 * when there is nothing to import from; nothing at all when detection failed (the footer's
 * Import browser data action is the way in).
 */
export function ImportSources({
  view,
  onBrowser,
  onFirefoxZen,
}: {
  view: ImportView;
  onBrowser: (key: ImportBrowserKey) => void;
  onFirefoxZen: () => void;
}) {
  switch (view.kind) {
    case 'fallback':
      return null;
    case 'none':
      return (
        <Text as="p" size="sm" color="muted" className="bento-welcome__description">
          {IMPORT_NONE_NOTE}
        </Text>
      );
    case 'detecting':
      return (
        <ul className="bento-welcome__sources" aria-busy="true">
          {Array.from({ length: IMPORT_GRID_COLUMNS.wide }, (_, index) => (
            <li
              key={index}
              className="bento-welcome__source-placeholder"
              aria-hidden="true"
              style={stagger(index)}
            />
          ))}
        </ul>
      );
    case 'tiles':
      return (
        <ul className="bento-welcome__sources" aria-label="Import sources">
          {view.browsers.map((browser, index) => (
            <li key={browser.key} style={stagger(index)}>
              <ImportTile
                name={browser.name}
                leading={<BrowserLogo browser={browser} />}
                ariaLabel={`Import from ${browser.name}`}
                onActivate={() => onBrowser(browser.key)}
              />
            </li>
          ))}
          {view.firefoxZen ? (
            <li {...firefoxZenSpans(view.browsers.length)} style={stagger(view.browsers.length)}>
              <ImportTile
                name="Firefox or Zen"
                sublabel="Restarts Bento"
                leading={<BentoIcon icon={RotateCcw} size="md" />}
                ariaLabel="Import from Firefox or Zen, restarts Bento"
                onActivate={onFirefoxZen}
              />
            </li>
          ) : null}
        </ul>
      );
  }
}

function Shortcut({ children }: { children: ReactNode }) {
  return (
    <Row gap="2xs" justify="center" wrap className="bento-welcome__shortcut">
      {children}
    </Row>
  );
}

// Kept in sync with the native shortcut reference and chrome bindings.
// Workspaces: bento-tools manifest binds Ctrl+Alt+N -> workspace-N.
// Palette: bento-shell-mount.js binds Cmd/Ctrl+Alt+P.
// Panel cycle: bento-shell-mount.js binds Cmd/Ctrl+Shift+Left/Right.
const TOUR = [
  {
    title: 'Workspaces',
    illustration: 'workspaces',
    body: 'One box per task. Tabs, panels and theme stay together.',
    shortcut: (
      <>
        <kbd>{keys(MOD, ALT, '1')}</kbd>
        <span>to</span>
        <kbd>{keys(MOD, ALT, '9')}</kbd>
      </>
    ),
  },
  {
    title: 'Panels',
    illustration: 'panels',
    body: 'Pin a page beside the one you are reading.',
    shortcut: (
      <>
        <kbd>{keys(MOD, SHIFT, '←')}</kbd>
        <kbd>{keys(MOD, SHIFT, '→')}</kbd>
        <span>cycle</span>
      </>
    ),
  },
  {
    title: 'Command palette',
    illustration: 'command-palette',
    body: 'Find tabs, commands and sites by typing.',
    shortcut: <kbd>{keys(MOD, ALT, 'P')}</kbd>,
  },
] as const;

/** Three tiles, each with its free-standing illustration (public/welcome/<illustration>.webp,
 * decorative: the title and body carry the meaning) over the title, body and shortcut. */
export function TourTiles() {
  return (
    <ul className="bento-welcome__tiles bento-welcome__tiles--tour">
      {TOUR.map((tile, index) => (
        <li key={tile.title} style={stagger(index)}>
          <Image
            src={`./welcome/${tile.illustration}.webp`}
            alt=""
            fit="contain"
            className="bento-welcome__tour-image"
          />
          <Text variant="label" size="md" className="bento-welcome__tour-title">
            {tile.title}
          </Text>
          <Text size="sm" color="muted" className="bento-welcome__tour-body">
            {tile.body}
          </Text>
          <Shortcut>{tile.shortcut}</Shortcut>
        </li>
      ))}
    </ul>
  );
}

/** True when onboarding starts over: welcomeSeen goes from true back to false while this
 * document stays mounted (Reset Bento settings, then the sidebar reopens it). A fresh document
 * going from nothing to false is not a restart: it resumes its stored step. */
export function restartsOnboarding(previous: boolean | undefined, next: boolean | undefined) {
  return previous === true && next === false;
}

/** Ends onboarding with the one title chrome acts on: `chromeTitlePrefix` is the close title
 * (Start browsing) or the open-Settings title (Open Settings), never both, because title IPC is
 * last-write-wins. It marks the dismissal (clears the stored step, sets welcomeSeen) and sends the
 * title without waiting for persistence: SettingsStore writes storage.local before it publishes
 * the new snapshot, and the page fires and forgets. It holds no state, because this document
 * stays mounted and onboarding can show again (after Reset Bento settings); chrome ignores a
 * repeat Open Settings while the dialog fades out. */
export function finishOnboarding(
  chromeTitlePrefix: string,
  effects: { clearStep: () => void; markSeen: () => void; send: (title: string) => void },
): void {
  effects.clearStep();
  effects.markSeen();
  effects.send(`${chromeTitlePrefix}_${Date.now()}`);
}

/** The Ready step's control: finishes onboarding into Settings. Neutral, so the footer's Start
 * browsing stays the primary action. */
export function OpenSettingsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button variant="neutral" onActivate={onOpen}>
      Open Settings
    </Button>
  );
}
