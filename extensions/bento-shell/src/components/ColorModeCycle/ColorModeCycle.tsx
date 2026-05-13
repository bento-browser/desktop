// Two-state toggle: light ↔ dark. Independent instances drive Bento's
// UI mode (chrome + shell) and the browser's content-color-scheme
// override (web pages). Both go through settings/update — bento-tools
// persists and applies the corresponding side-effect (data-color-mode
// attribute / browserSettings API).
//
// Component name is kept as ColorModeCycle (not ColorModeToggle) to
// avoid touching every consumer; the file lives under the same path
// and the export still cycles, just over a 2-element ORDER list now.
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import Sun from 'lucide-react/dist/esm/icons/sun';
import Moon from 'lucide-react/dist/esm/icons/moon';
import type { ColorModePref } from '@shared/protocol';

const ORDER: ColorModePref[] = ['light', 'dark'];

const ICON_BY_MODE = {
  light: Sun,
  dark: Moon,
};

const ARIA_LABEL_BY_MODE = {
  light: 'light',
  dark: 'dark',
};

export interface ColorModeCycleProps {
  /** Current value. Defaults to 'dark' if undefined (prevents flicker
   * before the settings snapshot lands; matches the SettingsStore default). */
  value: ColorModePref | undefined;
  /** Called with the next value in the cycle on click. */
  onChange: (next: ColorModePref) => void;
  /** Distinguishes the two instances in the aria-label tooltip — e.g.
   * "Bento UI" or "Website appearance". */
  surfaceLabel: string;
}

export function ColorModeCycle({ value, onChange, surfaceLabel }: ColorModeCycleProps) {
  const current = value ?? 'dark';
  const idx = ORDER.indexOf(current);
  const next = ORDER[(idx + 1) % ORDER.length] ?? 'dark';
  const IconComponent = ICON_BY_MODE[current];
  const ariaLabel = `${surfaceLabel} color mode: ${ARIA_LABEL_BY_MODE[current]} (click to toggle)`;
  return (
    <IconButton variant="ghost" size="sm" aria-label={ariaLabel} onPress={() => onChange(next)}>
      <Icon icon={IconComponent} />
    </IconButton>
  );
}
