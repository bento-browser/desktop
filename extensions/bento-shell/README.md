# bento-shell

Privileged built-in extension that renders Bento Browser's UI: vertical tabs,
workspaces, panel layouts, the command palette, and the other shell surfaces.
React and Mux UI front end under `src/`, built with Vite (`pnpm --filter
@bento/shell build`).

- `src/` holds the React UI, Zustand mirrors of the state owned by `bento-tools`,
  and the background script.
- `experiments/chrome-bridge/api.js` is the only file that reaches into Firefox
  chrome XHTML (`bentoChrome.*`).
- `*.html` at this level are the Vite entry points; `public/` holds the external
  `boot.js` bootstrap and the generated theme sheets.
- `pnpm --filter @bento/shell ladle:serve` runs component stories.

See [docs/build-tooling.md](../../docs/build-tooling.md) for build and import,
and [CLAUDE.md](../../CLAUDE.md) for the UI and state rules.

Developer demo: `BENTO_BUILD_MODE=dev BENTO_SOFTCAST_DEMO=1 pnpm --filter @bento/shell build`
includes the selected Softcast icons and eight local fixture pages. Stage only into an
isolated app with a fresh profile. The sidebar opens missing fixtures once after tools
and workspace readiness; error icons are simulated only on those exact fixture URLs.
Loading starts still and its fixture page links to an opt-in spin. The flag defaults
off and release builds reject it. This is a shell presentation demo, not error detection.

A Quiet gives unavailable, certificate-warning, blocked, crashed, and internal-settings
Softcast rows Mux token tints at 10% in light mode and 14% in resolved dark mode.
Active/selected fills take precedence; default, loading, and sleeping stay untinted.

In the demo, the category-only Settings root adds Tab appearance after Appearance
and before Performance. Open it to reach its two controls.
Show tab state tints and Use custom tab state icons are independent switches, both
On by default and persisted profile-wide through `bento-tools`. Tint Off removes
only Quiet backgrounds. Custom icons Off restores the existing loading indicator,
website favicon or placeholder, while actual sleeping styling and titles remain.
Both preferences participate in reset and backups. The controls and their command
search entries are absent from ordinary builds.
