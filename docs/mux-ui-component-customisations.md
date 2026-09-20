# Mux UI and Bento component customisations

This guide records the reusable rules for Bento's migrated UI. It complements
[CLAUDE.md](../CLAUDE.md), which owns the contributor guardrails.

## Sources

- `node_modules/@muxui/react/README.md` and its generated public declarations
  define the Mux component API.
- `extensions/bento-shell/src/components/primitives/` owns shared Bento
  layout, icon, and browser-specific adapters.
- [bento-tokens.css](../extensions/bento-shell/src/theme/bento-tokens.css)
  owns Bento-specific values and the staged legacy token surface.
- [themes.md](themes.md) covers workspace theme persistence and presentation
  scope resolution.
- [chrome-tokens.md](chrome-tokens.md) covers the native token projection.

Use the public Mux root export or a documented public subpath. Do not import
private generated files, copy package registries, or call React Aria
Components directly from a Bento composite. The primitives layer is the owner
for shared React Aria wiring and icon/layout adaptation.

## Consumer migration status

The Bento consumer migration has completed the installation, dependency,
theme, saved-theme compatibility, layout/icon adapter, and development/release
tooling work locally (B13a, B13b, B14, B11, B22, B15, B17, and B25). Proof uses
Node 24.19 with frozen developer and release installs: all 13 shell HTML entries
use the shared Mux stylesheet boundary, with 64 shell tests, 154 tools tests,
7 release-security tests, and 4 theme-selector tests passing. The production
dependency audit reported no known vulnerabilities at verification time. The
SBOM contains 706 components and validates the approved Bento shell runtime
dependency set; this policy is not a whole-lockfile package allowlist. The
bundle has a single React Aria root/chunk.

The local normal-package checks for B24 pass. The rebuilt archive and all
8,718 decompressed MAR members match the extracted application, and its shell,
tools, and native chrome assets match the migration inputs. Actual extracted
Firefox verification covers warm Default presentation, theme persistence,
native header controls, loading indicators, and the tooltip lifecycle. The
current owned source and rebuilt runtime assets contain no retired
design-system imports or branded selectors. Historical Git objects and
pre-existing local build outputs are outside this cleanup.

Both rollback variants also pass isolated 14-entry builds, shell and tools
typechecks, background bundling, and two staged backup privacy tests. The
final variant validates the restored archived native mount as JavaScript.
Disposable-profile Firefox checks cover standalone Settings, mode changes,
backup switches and number inputs, and Shortcuts search and dismissal. The
transition run also reaches `prepared-for-final` through the actual recovery
page. Its final repeat passes ten stylesheet/token checks before and after
the actions; an earlier inconsistent test profile had failed stylesheet
startup and is not used as the visual acceptance result.
See [the rollback guide](settings-consolidation-rollback.md) for its distinct
transition and final packaging contracts.

React chrome uses public Mux components and Bento-owned composites. Native
Firefox controls remain Bento-owned DOM/CSS consuming the Mux token
projection; they are not React component instances.

The matching Firefox 154 native binary was reused. This is not a fresh C++ build
or cross-platform release-CI result, and no public release has been published.
In particular, the final rollback smoke verifies its extension and native
overlay paths, not a rebuilt engine with the native-settings patch removed.
A disabled Active label painting issue also reproduces in the unchanged baseline
headed build; no migration-specific CSS workaround was added.
Rollback screenshots additionally show blank disabled backup NumberFields,
despite positive layout geometry and the expected disabled state and computed
opacity. Enabled controls render and respond correctly. There is no matching
pre-migration NumberField capture, so the provenance of that paint discrepancy
is unresolved; the runtime smoke is not complete visual release sign-off.

Bento installs the immutable local Mux candidate reproducibly. Registry
publication remains separate, and the migration ledger is updated after Bento
merges.

## Composition model

Prefer the Mux component props, variants, sizes, and documented compound parts
before adding CSS. Use Bento primitives for repeated layout and icon behavior,
then keep product-specific composition in the owning component. A trigger that
renders a button must not contain another button. Keep overlay state and focus
behavior on the documented Mux parts so dismissal and keyboard semantics stay
owned by the renderer.

Each HTML entry point imports `theme/muxui.css` once. That Bento-owned boundary
places public Mux styles and themes in the low-precedence `muxui` layer, then
the entry point loads Bento tokens and generated preset layers. Theme and mode
attributes belong on the same scope element. `themeScope.ts` resolves aliases
and unknown ids for presentation while `bento-tools` keeps persisted ids
unchanged.

## CSS and tokens

Component rules belong inside the owning CSS layer and use scoped component
selectors. Keep global selectors away from semantic elements and overlay
internals. Use public Mux semantic roles for new theme decisions and Bento
tokens for product-specific behavior. Existing CSS may use the generated
legacy aliases such as `--neutral-*`, `--color-*`, `--space-*`, `--radius-*`,
and `--shadow-*` while the native chrome and shell surfaces finish their
compatibility transition.

```css
@layer bento.components {
  .my-component {
    color: var(--neutral-90);
    background: var(--neutral-5);
    border-radius: var(--radius-s);
    box-shadow: var(--shadow-m);
  }
}
```

Add a missing reusable value to `bento-tokens.css` before using it. Avoid raw
colors, durations, easings, or unexplained dimensions. Pair a tinted surface
with its foreground role. Keep the browser-standard root contract of
`1rem = 16px`.

Firefox-owned chrome cannot import React components. Map native variables in
`bento-chrome-theme.css` to the generated aliases from
`bento-chrome-tokens.css`; keep the existing `data-bento-theme` and
`data-color-mode` hook boundary.

The prior design-system customization notes were folded into this guide during
the Mux migration. New code follows the public Mux API and the Bento-owned
layers above.
