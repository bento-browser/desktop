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

Tab rows present their state (crashed, sleeping, unreachable, certificate or blocked
error pages, internal settings) with an icon and a status tint, each switchable under
Settings, Tab appearance. The detection is `src/components/TabRow/tabState.ts` and the
SVG icons are `src/components/TabRow/assets/`; see
[Tab appearance preferences](../../docs/technical/theming.md#tab-appearance-preferences).
