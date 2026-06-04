// Compact color-mode cycle. Independent instances drive Bento's
// UI mode (chrome + shell) and the browser's content-color-scheme
// override (web pages). Both go through settings/update — bento-tools
// persists and applies the corresponding side-effect (data-color-mode
// attribute / browserSettings API).
//
// Component name is kept as ColorModeCycle (not ColorModeToggle) to
// avoid touching every consumer; the file lives under the same path.
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import Monitor from 'lucide-react/dist/esm/icons/monitor';
import Moon from 'lucide-react/dist/esm/icons/moon';
import Sun from 'lucide-react/dist/esm/icons/sun';
import type { ColorModePref, UiColorModePref } from '@shared/protocol';

const DEFAULT_ORDER: readonly ColorModePref[] = ['light', 'dark'];

const ICON_BY_MODE = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const ARIA_LABEL_BY_MODE = {
  light: 'light',
  dark: 'dark',
  system: 'auto',
};

export interface ColorModeCycleProps<TMode extends UiColorModePref = ColorModePref> {
  /** Current value. Defaults to the first configured mode if undefined (prevents flicker
   * before the settings snapshot lands; matches the SettingsStore default). */
  value: TMode | undefined;
  /** Called with the next value in the cycle on click. */
  onChange: (next: TMode) => void;
  /** Available modes. Omit for explicit light/dark cycling. */
  modes?: readonly TMode[];
  /** Distinguishes the two instances in the aria-label tooltip — e.g.
   * "Bento UI" or "Website appearance". */
  surfaceLabel: string;
}

export function ColorModeCycle<TMode extends UiColorModePref = ColorModePref>({
  value,
  onChange,
  modes,
  surfaceLabel,
}: ColorModeCycleProps<TMode>) {
  const order = modes ?? (DEFAULT_ORDER as readonly TMode[]);
  const current = value && order.includes(value) ? value : (order[0] ?? ('light' as TMode));
  const idx = order.indexOf(current);
  const next = order[(idx + 1) % order.length] ?? current;
  const IconComponent = ICON_BY_MODE[current];
  const ariaLabel = `${surfaceLabel} color mode: ${ARIA_LABEL_BY_MODE[current]} (click to toggle)`;
  return (
    <IconButton variant="ghost" size="sm" aria-label={ariaLabel} onPress={() => onChange(next)}>
      <Icon icon={IconComponent} />
    </IconButton>
  );
}
