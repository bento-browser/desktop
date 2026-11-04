# extensions/

Bundled extensions that implement Bento Browser's UI shell and privileged browser
logic, plus the content blocker Bento installs by default.

Each subdirectory is either a built-in extension with its own `manifest.json`, or a
distribution add-on: a folder with no `manifest.json` that holds one signed
`<add-on id>.xpi`.
[scripts/install-builtin-addons.mjs](../scripts/install-builtin-addons.mjs) copies these
into `engine/browser/extensions/<name>/`, generates `jar.mn` entries under
Firefox's `builtin-addons/<name>/` runtime path, generates a `moz.build` for
each extension, and appends `DIRS += [...]` to
`engine/browser/extensions/moz.build` so the extensions ship with the browser by
default.

Folders with names starting with `_` (e.g. `_shared` for shared TypeScript
sources) and folders with neither a `manifest.json` nor an XPI are skipped: they
will never be copied into the engine.

A distribution add-on is copied into the engine unchanged and packaged into the app's
`distribution/extensions/` folder. Firefox installs it into the profile at startup like
any other add-on, so the user can remove it, and a removed one is not installed again.
This is how [ublock-origin/](ublock-origin/) ships.

The Bento installer copies only runtime entries, not every source file. Bento's
default source-built extensions use this runtime entry list:
`manifest.json`, `chrome.manifest`, `dist`, `experiments`, `icons`, `_locales`,
`background.html`, `background.js`, `options.html`, and `popup.html`.

Large packaged extensions can declare `.bento-runtime-entries.json` as a JSON
string array to replace the default runtime list. `manifest.json` is always
included.

| Extension | Purpose |
| --- | --- |
| [bento-shell/](bento-shell/) | Top-level UX: sidebar, workspaces, split views, command palette |
| [bento-tools/](bento-tools/) | Tab management, session handling, keyboard shortcuts |
| [ublock-origin/](ublock-origin/) | uBlock Origin XPI, installed automatically and removable by the user |
