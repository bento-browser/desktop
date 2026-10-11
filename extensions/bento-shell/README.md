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
