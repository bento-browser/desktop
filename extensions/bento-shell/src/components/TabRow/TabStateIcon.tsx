// `?no-inline` keeps each icon a file in dist/assets/ (the emitted URL is relative to the
// importing chunk), so none of them lands in the shell's JavaScript as a data: URI.
import blocked from './assets/tab-state-blocked.svg?no-inline';
import certificateWarning from './assets/tab-state-certificate-warning.svg?no-inline';
import crashed from './assets/tab-state-crashed.svg?no-inline';
import defaultIcon from './assets/tab-state-default.svg?no-inline';
import internalSettings from './assets/tab-state-internal-settings.svg?no-inline';
import sleeping from './assets/tab-state-sleeping.svg?no-inline';
import unavailable from './assets/tab-state-unavailable.svg?no-inline';
import { TAB_STATES, type TabState } from './tabState';

const ICONS: Record<TabState, string> = {
  default: defaultIcon,
  unavailable,
  'certificate-warning': certificateWarning,
  blocked,
  crashed,
  sleeping,
  'internal-settings': internalSettings,
};

/** The favicon-slot icon for a tab state. */
export function TabStateIcon({ state }: { state: TabState }) {
  return (
    <img
      className="bento-tab-row__favicon bento-tab-row__state-icon"
      data-tab-state={state}
      src={ICONS[state]}
      alt={TAB_STATES[state].label}
      draggable={false}
    />
  );
}
