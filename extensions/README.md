# extensions/

Bundled built-in extensions that implement Bento Browser's UI shell,
privileged browser logic, and default content blocking.

Each subdirectory is a single extension with its own `manifest.json`. The
The Bento Surfer fork's `extensions-copy` patch step (see
[../docs/maintaining-surfer.md](../docs/maintaining-surfer.md)) copies these
into `engine/browser/extensions/<name>/`, generates `jar.mn` entries under
Firefox's `builtin-addons/<name>/` runtime path, generates a `moz.build` for
each extension, and appends `DIRS += [...]` to
`engine/browser/extensions/moz.build` so the extensions ship with the browser by
default.

Folders with names starting with `_` (e.g. `_shared` for shared TypeScript
sources) and folders without a `manifest.json` are skipped — they will never
be copied into the engine.

Surfer copies only runtime entries, not every source file. Bento's default
source-built extensions use the fork's default runtime entry list:
`manifest.json`, `chrome.manifest`, `dist`, `experiments`, `icons`, `_locales`,
`background.html`, `background.js`, `options.html`, and `popup.html`.

Large packaged extensions can declare `.bento-runtime-entries.json` as a JSON
string array to replace the default runtime list. `manifest.json` is always
included. [ublock-origin/](ublock-origin/) uses this file to include uBlock
Origin's required `js/`, `css/`, `lib/`, `assets/`, locale, and HTML runtime
files without copying source metadata or downloaded XPI packaging such as
`META-INF/`.

| Extension | Purpose |
| --- | --- |
| [bento-shell/](bento-shell/) | Top-level UX: sidebar, workspaces, split views, command palette |
| [bento-tools/](bento-tools/) | Tab management, session handling, keyboard shortcuts |
| [ublock-origin/](ublock-origin/) | Bundled uBlock Origin WebExtension, enabled by default |
