import { useMemo, useRef, useState } from 'react';
import { Card, ColorSwatch, Popover, SearchField, Text, Tooltip } from '@muxui/react';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';

import {
  BENTO_THEMES,
  getThemeMeta,
  type BentoThemeCollection,
  type BentoThemeMeta,
} from '../../theme/presets';
import { getThemeScopeAttributes, useResolvedColorScheme } from '../../theme/themeScope';
import { BentoIcon, Column } from '../primitives';
import './WorkspaceThemePicker.css';

interface ThemePickerItem {
  id: string;
  name: string;
  description: string;
  collection: BentoThemeCollection;
  brand60: string;
  neutral20: string;
  keywords: string[];
}

export interface WorkspaceThemePickerProps {
  workspaceName: string;
  selectedThemeId: string | undefined | null;
  onThemeChange: (themeId: string) => void;
  className?: string | undefined;
}

const THEME_COLLECTIONS: ReadonlyArray<{
  id: BentoThemeCollection;
  label: string;
}> = [
  { id: 'bento', label: 'Bento' },
  { id: 'standard', label: 'Standard' },
  { id: 'monochrome', label: 'Monochromatic' },
];

function getCollectionLabel(collection: BentoThemeCollection): string {
  return THEME_COLLECTIONS.find((entry) => entry.id === collection)?.label ?? collection;
}

const THEME_PICKER_ITEMS: ThemePickerItem[] = BENTO_THEMES.map((theme) => ({
  id: theme.id,
  name: theme.name,
  description: theme.description,
  collection: theme.collection,
  brand60: theme.brand60,
  neutral20: theme.neutral20,
  keywords: normalizeThemeKeywords(theme),
}));

function normalizeThemeKeywords(theme: BentoThemeMeta): string[] {
  return Array.from(
    new Set(
      [
        theme.id,
        theme.name,
        theme.description,
        theme.collection,
        getCollectionLabel(theme.collection),
        ...(theme.collection === 'monochrome' ? ['monochrome'] : []),
        ...theme.id.split(/[-_\s]+/),
        ...theme.name.split(/\s+/),
      ]
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function themeMatchesQuery(theme: ThemePickerItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [theme.id, theme.name, ...theme.keywords].join(' ').toLowerCase().includes(needle);
}

export function WorkspaceThemePicker({
  workspaceName,
  selectedThemeId,
  onThemeChange,
  className,
}: WorkspaceThemePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedTheme = getThemeMeta(selectedThemeId);
  const colorScheme = useResolvedColorScheme();

  const filteredThemes = useMemo(
    () => THEME_PICKER_ITEMS.filter((theme) => themeMatchesQuery(theme, query)),
    [query],
  );
  const filteredThemeGroups = useMemo(
    () =>
      THEME_COLLECTIONS.map((collection) => ({
        ...collection,
        themes: filteredThemes.filter((theme) => theme.collection === collection.id),
      })).filter((collection) => collection.themes.length > 0),
    [filteredThemes],
  );

  function closePicker() {
    setIsOpen(false);
    setQuery('');
  }

  function handleOpenChange(next: boolean) {
    setIsOpen(next);
    if (!next) {
      setQuery('');
      return;
    }
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }

  function selectTheme(themeId: string) {
    if (!THEME_PICKER_ITEMS.some((theme) => theme.id === themeId)) return;
    onThemeChange(themeId);
    closePicker();
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={handleOpenChange}
      aria-label={`Choose theme for ${workspaceName}`}
      trigger={
        <button
          type="button"
          className={`muxui-button bento-workspace-theme-picker__trigger${className ? ` ${className}` : ''}`}
          data-variant="neutral"
          data-size="sm"
          aria-label={`Theme for ${workspaceName}: ${selectedTheme.name}`}
        >
          <ColorSwatch
            {...getThemeScopeAttributes(selectedTheme.id, colorScheme)}
            color={selectedTheme.brand60}
            secondaryColor={selectedTheme.neutral20}
            shape="circle"
            className="bento-workspace-theme-picker__trigger-swatch"
          />
          <Text variant="body" size="s" className="bento-workspace-theme-picker__trigger-label">
            {selectedTheme.name}
          </Text>
          <BentoIcon
            icon={ChevronDown}
            size="sm"
            className="bento-workspace-theme-picker__chevron"
          />
        </button>
      }
      placement="bottom-start"
      offset={8}
      className="bento-workspace-theme-picker__popover"
    >
      <Column
        gap="2xs"
        className="bento-workspace-theme-picker__panel"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Column gap="4xs" className="bento-workspace-theme-picker__search">
          <SearchField
            aria-label="Search themes"
            value={query}
            onChange={setQuery}
            onClear={() => setQuery('')}
            inputRef={searchInputRef}
            className="bento-workspace-theme-picker__search-field"
            inputProps={{ placeholder: 'Search themes...' }}
          />
        </Column>
        {filteredThemes.length > 0 ? (
          <Column
            gap="3xs"
            role="group"
            aria-label="Theme results"
            className="bento-workspace-theme-picker__list"
          >
            {filteredThemeGroups.map((collection) => (
              <Column key={collection.id} gap="3xs" className="bento-workspace-theme-picker__group">
                <Text
                  as="div"
                  variant="label"
                  size="xs"
                  color="muted"
                  className="bento-workspace-theme-picker__group-label"
                >
                  {collection.label}
                </Text>
                <Column
                  gap="3xs"
                  role="group"
                  aria-label={`${collection.label} themes`}
                  className="bento-workspace-theme-picker__grid"
                >
                  {collection.themes.map((theme) => {
                    const isSelected = theme.id === selectedTheme.id;
                    const accessibleName = `${theme.name}, ${collection.label}`;
                    return (
                      <Tooltip
                        key={theme.id}
                        delay={400}
                        placement="top"
                        offset={8}
                        content={`${theme.name}: ${theme.description}`}
                        trigger={
                          <Card.Button
                            aria-label={isSelected ? `${accessibleName}, selected` : accessibleName}
                            selected={isSelected}
                            padding="sm"
                            className="bento-workspace-theme-picker__option"
                            onActivate={() => selectTheme(theme.id)}
                          >
                            <ColorSwatch
                              {...getThemeScopeAttributes(theme.id, colorScheme)}
                              color={theme.brand60}
                              secondaryColor={theme.neutral20}
                              shape="circle"
                              className="bento-workspace-theme-picker__option-swatch"
                            />
                            <Text
                              variant="body"
                              size="xs"
                              className="bento-workspace-theme-picker__option-name"
                            >
                              {theme.name}
                            </Text>
                          </Card.Button>
                        }
                      />
                    );
                  })}
                </Column>
              </Column>
            ))}
          </Column>
        ) : (
          <Text as="div" color="muted" className="bento-workspace-theme-picker__empty">
            No matching themes.
          </Text>
        )}
      </Column>
    </Popover>
  );
}
