# extensions/

Bundled privileged extensions that implement Bento Browser's UI shell and
power-user features. Implemented across **Phases 3+** of the project plan.

Each subdirectory is a single extension with its own `manifest.json`. The
Bento Surfer fork's `extensions-copy` patch step (see
[../docs/maintaining-surfer.md](../docs/maintaining-surfer.md)) copies these
into `engine/browser/extensions/<name>/`, generates a `moz.build` for each
(using the gecko addon id from `manifest.json` `applications.gecko.id`),
and appends `DIRS += [...]` to `engine/browser/extensions/moz.build` so the
extensions ship with the browser by default.

Folders with names starting with `_` (e.g. `_shared` for shared TypeScript
sources) and folders without a `manifest.json` are skipped — they will never
be copied into the engine.

| Extension | Purpose |
| --- | --- |
| [bento-shell/](bento-shell/) | Top-level UX: sidebar, workspaces, split views, command palette |
| [bento-tools/](bento-tools/) | Tab management, session handling, keyboard shortcuts |
