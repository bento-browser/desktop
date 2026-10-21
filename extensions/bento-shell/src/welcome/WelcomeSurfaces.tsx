// Welcome surfaces that main.tsx shares with Ladle and the step tests. main.tsx
// runs the tools port and mounts React at import time, so a story or test cannot
// import it; everything here is side-effect free.

import { useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  Button,
  ColorSwatch,
  Image,
  Tabs,
  Text,
  ToggleButton,
  ToggleButtonGroup,
} from '@muxui/react';
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
import { BENTO_THEMES, getThemeMeta, resolveThemeId, type BentoThemeMeta } from '../theme/presets';
import {
  getThemeScopeAttributes,
  useResolvedColorScheme,
  type ThemeColorScheme,
} from '../theme/themeScope';
import { ALL_THEME_IDS, useThemeSheets } from '../theme/themeSheets';
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
    note: 'Protection levels can be fine-tuned in the Settings',
  },
  {
    id: 'search',
    title: 'Default search engine',
    note: 'Add more search engines in the Settings',
  },
  { id: 'tour', title: 'How Bento works' },
  { id: 'ready', title: 'You are set', illustration: 'ready' },
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

/** The one selectable surface for Appearance, Theme, Privacy and Search: a single-select
 * Mux group whose items Bento lays out as tiles (preview above the label), cards (tiles
 * in five columns that scroll when compact), rows (one column), or a two-column grid
 * that scrolls past eight items. */
export function WelcomeOptions<Id extends string>({
  label,
  layout,
  columns,
  options,
  value,
  onChange,
}: {
  label: string;
  layout: 'tiles' | 'cards' | 'rows' | 'grid';
  /** Cards only: the column count of the wide layout (the compact layout always has three). */
  columns?: number;
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
      data-columns={columns}
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

/** The Theme step's two collections: Default and the standard themes, then the monochrome ones. */
export const THEME_GROUPS = [
  {
    id: 'colourful',
    label: 'Colourful',
    // Nine cards in two rows of five.
    columns: 5,
    themes: BENTO_THEMES.filter((theme) => theme.collection !== 'monochrome'),
  },
  {
    id: 'monochrome',
    label: 'Monochrome',
    // Seven cards in two rows of four: wide enough for 'Mountain Meadow' on one line.
    columns: 4,
    themes: BENTO_THEMES.filter((theme) => theme.collection === 'monochrome'),
  },
] as const;

export type ThemeGroupId = (typeof THEME_GROUPS)[number]['id'];

/** The collection holding `themeId` (an alias or unknown id resolves first). */
export function themeGroupOf(themeId: string | undefined | null): ThemeGroupId {
  return getThemeMeta(themeId).collection === 'monochrome' ? 'monochrome' : 'colourful';
}

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

/** Mini Bento window for a theme card: workspace dots and tab bars (the active tab marked) in a
 * sidebar beside a content panel with an accent button. The pane carries the theme's own scope, so
 * only public Mux tokens colour it; the sheet for that scope must be loaded (ThemeChooser). */
export function ThemePreview({
  themeId,
  colorScheme,
}: {
  themeId: string;
  colorScheme: ThemeColorScheme;
}) {
  return (
    <span className="bento-welcome__preview" aria-hidden="true">
      <span
        className="bento-welcome__preview-pane bento-welcome__preview-pane--theme"
        {...getThemeScopeAttributes(themeId, colorScheme)}
      >
        <span className="bento-welcome__preview-sidebar">
          <span className="bento-welcome__preview-workspaces">
            <span data-active="true" />
            <span />
            <span />
          </span>
          <span />
          <span data-active="true" />
          <span />
        </span>
        <span className="bento-welcome__preview-lines">
          <span />
          <span />
          <span />
          <span className="bento-welcome__preview-button" />
        </span>
      </span>
    </span>
  );
}

/** One card per theme, each previewing the theme in `colorScheme`. */
export function themeOptions(
  themes: readonly BentoThemeMeta[],
  colorScheme: ThemeColorScheme,
): WelcomeOption<string>[] {
  return themes.map((theme) => ({
    id: theme.id,
    label: theme.name,
    preview: <ThemePreview themeId={theme.id} colorScheme={colorScheme} />,
  }));
}

/** The Theme step's body: a Colourful or Monochrome switch over that collection's preview cards.
 * It shows the collection holding `value` until the user picks the other one (so a workspace that
 * reaches this document after it mounted still lands on its theme). Every card renders its own
 * theme scope, so every theme's sheet is kept loaded while the step shows (as the workspace theme
 * picker does): a collection switch never paints a card in the dialog's own tokens. */
export function ThemeChooser({
  value,
  onChange,
}: {
  value: string;
  onChange: (themeId: string) => void;
}) {
  const colorScheme = useResolvedColorScheme();
  const [pickedGroup, setPickedGroup] = useState<ThemeGroupId>();
  const groupId = pickedGroup ?? themeGroupOf(value);
  useThemeSheets(ALL_THEME_IDS);

  return (
    <Tabs
      aria-label="Theme collection"
      variant="segment"
      size="sm"
      className="bento-welcome__theme-tabs"
      value={groupId}
      onChange={(next) => setPickedGroup(THEME_GROUPS.find((group) => group.id === next)?.id)}
      // Mux mounts only the selected panel, so a collection's cards measure once visible.
      items={THEME_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        panel: (
          <WelcomeOptions
            label={`${group.label} themes`}
            layout="cards"
            columns={group.columns}
            options={themeOptions(group.themes, colorScheme)}
            value={value}
            onChange={onChange}
          />
        ),
      }))}
    />
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

// Firefox's default engine ids, for the Ready summary before the engine list loads.
const DEFAULT_ENGINE_NAMES: ReadonlyMap<string, string> = new Map([
  ['ddg', 'DuckDuckGo'],
  ['google', 'Google'],
  ['bing', 'Bing'],
  ['wikipedia', 'Wikipedia'],
  ['ebay', 'eBay'],
  ['perplexity', 'Perplexity'],
]);

/** Display name of the chosen engine: from the loaded list, else a known default's
 * name, else the id itself. */
export function searchEngineName(engines: readonly SearchEngineChoice[], id: string): string {
  return engines.find((engine) => engine.id === id)?.name ?? DEFAULT_ENGINE_NAMES.get(id) ?? id;
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

export interface SummaryRow {
  label: string;
  value: string;
  step: number;
  /** Mark before the value (the theme's swatch). */
  leading?: ReactNode;
}

/** The Ready summary's Theme row: the theme's name led by its swatch, as the theme picker draws it. */
export function themeSummaryRow(themeId: string, colorScheme: ThemeColorScheme): SummaryRow {
  const theme = getThemeMeta(themeId);
  return {
    label: 'Theme',
    value: theme.name,
    step: stepIndexOf('theme'),
    leading: (
      <ColorSwatch
        {...getThemeScopeAttributes(theme.id, colorScheme)}
        color={theme.brand60}
        secondaryColor={theme.neutral20}
        shape="circle"
        className="bento-welcome__summary-swatch"
      />
    ),
  };
}

/** Ready-step summary; each Change action jumps back to the step that owns the value. */
export function ReadySummary({
  rows,
  onChange,
}: {
  rows: readonly SummaryRow[];
  onChange: (step: number) => void;
}) {
  return (
    <dl className="bento-welcome__summary">
      {rows.map((row, index) => (
        <div key={row.label} style={stagger(index)}>
          <dt>
            <Text size="sm" color="muted">
              {row.label}
            </Text>
          </dt>
          <dd className="bento-welcome__summary-value">
            {row.leading}
            <Text variant="label" size="md">
              {row.value}
            </Text>
          </dd>
          <dd>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Change ${row.label.toLowerCase()}`}
              onActivate={() => onChange(row.step)}
            >
              Change
            </Button>
          </dd>
        </div>
      ))}
    </dl>
  );
}
