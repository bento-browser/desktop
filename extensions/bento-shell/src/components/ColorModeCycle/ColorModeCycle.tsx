// Three-state cycle button: system → light → dark → system → ...
// Independent instances drive Bento's UI mode (chrome + shell) and the
// browser's content-color-scheme override (web pages). Both go through
// settings/update — bento-tools persists and applies the corresponding
// side-effect (data-color-mode attribute / browserSettings API).
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import Sun from 'lucide-react/dist/esm/icons/sun';
import Moon from 'lucide-react/dist/esm/icons/moon';
import Monitor from 'lucide-react/dist/esm/icons/monitor';
import type { ColorModePref } from '@shared/protocol';

const ORDER: ColorModePref[] = ['system', 'light', 'dark'];

const ICON_BY_MODE = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

const ARIA_LABEL_BY_MODE = {
  system: 'follow OS',
  light: 'light',
  dark: 'dark',
};

export interface ColorModeCycleProps {
  /** Current value. Defaults to 'system' if undefined (prevents flicker
   * before the settings snapshot lands). */
  value: ColorModePref | undefined;
  /** Called with the next value in the cycle on click. */
  onChange: (next: ColorModePref) => void;
  /** Distinguishes the two instances in the aria-label tooltip — e.g.
   * "Bento UI" or "Website appearance". */
  surfaceLabel: string;
}

export function ColorModeCycle({ value, onChange, surfaceLabel }: ColorModeCycleProps) {
  const current = value ?? 'system';
  const idx = ORDER.indexOf(current);
  const next = ORDER[(idx + 1) % ORDER.length] ?? 'system';
  const IconComponent = ICON_BY_MODE[current];
  const ariaLabel = `${surfaceLabel} color mode: ${ARIA_LABEL_BY_MODE[current]} (click to cycle)`;
  return (
    <IconButton variant="ghost" size="sm" aria-label={ariaLabel} onPress={() => onChange(next)}>
      <Icon icon={IconComponent} />
    </IconButton>
  );
}
