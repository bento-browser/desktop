import type { TabSnapshot } from '@shared/protocol';

export const SOFTCAST_STATES = [
  'default',
  'unavailable',
  'certificate-warning',
  'blocked',
  'crashed',
  'loading',
  'sleeping',
  'internal-settings',
] as const;

export type SoftcastState = (typeof SOFTCAST_STATES)[number];

export const SOFTCAST_LABELS: Record<SoftcastState, string> = {
  default: 'Default',
  unavailable: 'Unavailable',
  'certificate-warning': 'Certificate warning',
  blocked: 'Blocked',
  crashed: 'Crashed',
  loading: 'Loading',
  sleeping: 'Sleeping',
  'internal-settings': 'Internal settings',
};

export interface SoftcastPresentation {
  state: SoftcastState;
  src: string;
  label: string;
  fixture: boolean;
  spin: boolean;
}

/** Only the shell extension's own, exact fixture URLs can simulate an error. */
export function softcastFixtureUrl(shellUrl: string, state: SoftcastState, spin = false): string {
  const shell = new URL(shellUrl);
  if (shell.protocol !== 'moz-extension:' || !shell.hostname || shell.username || shell.password) {
    throw new Error('Softcast fixtures require a moz-extension shell URL');
  }
  return new URL(
    `/dist/dev/softcast/${state}.html${state === 'loading' && spin ? '?motion=spin' : ''}`,
    shell,
  ).href;
}

export function softcastFixture(shellUrl: string, url: string | undefined) {
  for (const state of SOFTCAST_STATES) {
    if (url === softcastFixtureUrl(shellUrl, state)) return { state, spin: false };
    if (state === 'loading' && url === softcastFixtureUrl(shellUrl, state, true)) {
      return { state, spin: true };
    }
  }
  return null;
}

const SETTINGS_URLS = new Set([
  'about:config',
  'about:preferences',
  ...['general', 'home', 'search', 'privacy', 'sync', 'containers', 'experimental'].map(
    (section) => `about:preferences#${section}`,
  ),
]);

/** Presentation only. Real website favicons and the tools-owned snapshot stay intact. */
export function softcastPresentation(
  tab: Pick<TabSnapshot, 'url' | 'loading' | 'discarded' | 'favIconUrl'>,
  shellUrl: string,
  enabled: boolean,
): SoftcastPresentation | null {
  if (!enabled || !shellUrl.startsWith('moz-extension://')) return null;
  const fixture = softcastFixture(shellUrl, tab.url);
  const state =
    fixture?.state ??
    (tab.loading
      ? 'loading'
      : tab.discarded
        ? 'sleeping'
        : SETTINGS_URLS.has(tab.url ?? '')
          ? 'internal-settings'
          : tab.favIconUrl
            ? null
            : 'default');
  if (!state) return null;
  return {
    state,
    src: new URL(`${state}.svg`, softcastFixtureUrl(shellUrl, state)).href,
    label: `${SOFTCAST_LABELS[state]}${fixture ? ' (simulated appearance)' : ''}`,
    fixture: fixture !== null,
    spin: fixture?.spin ?? state === 'loading',
  };
}
