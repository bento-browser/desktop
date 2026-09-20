# Chrome design tokens

Bento's Firefox chrome and the `bento-shell` extension have separate document
trees. The native stylesheet therefore receives a generated copy of the
public Mux token surface and Bento's compatibility aliases.

## Pipeline

1. The source is the pinned `@muxui/react` artifact consumed by
   `extensions/bento-shell`. The generator reads its public `styles.css` and
   `themes.css` exports, plus the Bento token layer and generated preset index.
2. [scripts/generate-chrome-tokens.mjs](../scripts/generate-chrome-tokens.mjs)
   writes [bento-chrome-tokens.css](../src/browser/base/content/bento-chrome-tokens.css).
   Use `--output <path>` for an isolated package or proof run. This option is
   required for checks that must not write the engine source tree.
3. [scripts/import.sh](../scripts/import.sh) invokes the generator during the
   normal source import workflow.
4. The chrome layout patch registers the generated sheet in
   `browser/base/jar.mn`.
5. [src/browser/base/content/bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js)
   loads the sheet and keeps `data-bento-theme` and `data-color-mode` on the
   chrome root. No second theme controller is needed.

## Generated content

The output includes the public Mux root, light and dark mode, contrast, and
attribute-closure blocks. Mux theme selectors are adapted from
`data-muxui-*` to the native `data-bento-theme`, `data-color-mode`, and
optional `data-bento-contrast` attributes.

The Bento token layer supplies product-specific dimensions and surfaces. The
generated preset index supplies the old short aliases used by existing Bento
CSS and native chrome. The aliases are derived from public Mux declarations,
so the bridge does not depend on a private Mux compiler or catalog.

The generator omits package font-face rules because native chrome has no
package URL base. Extension entry points consume Mux's self-hosted font assets
through the package stylesheet. The native output contains no remote font or
stylesheet import.

Document and component styles are not copied into the native sheet. Chrome
continues to provide its own widget styling while sharing the token values.

## Theme behavior

The chrome hook writes the persisted presentation id to `data-bento-theme` and
the resolved light or dark mode to `data-color-mode`. The generated Mux theme
rules then select the same canonical values as the extension. Bento's Default
preset remains a scoped warm ladder with `--neutral-default-20: #e5e1dd`; the
unscoped shell fallback can keep its cool neutral family.

Custom Scale imports remain supported by
[scripts/import-theme.mjs](../scripts/import-theme.mjs). The importer preserves
foreground overrides and rewrites them to the Bento theme and mode attributes.
Run the theme sync before generating an isolated chrome stylesheet.

## Focused verification

Use the repository Node 24.19 runtime and an isolated output path:

```sh
tmp_dir="$(mktemp -d)"
/Users/admin/.vite-plus/js_runtime/node/24.19.0/bin/node scripts/sync-theme-presets.mjs
/Users/admin/.vite-plus/js_runtime/node/24.19.0/bin/node \
  scripts/generate-chrome-tokens.mjs \
  --output "$tmp_dir/bento-chrome-tokens.css"
```

The generated file should contain `--shadow-l`, `--font-size-root`, and
`[data-bento-theme='standard-harbour']`, while containing no `@import`, remote
font URL, or `data-muxui-*` selector.
