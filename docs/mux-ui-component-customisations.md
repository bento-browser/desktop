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
Components directly from a Bento composite. Mux owns its internal React Aria wiring. The primitives layer owns Bento
icon/layout adaptation.

## Consumer migration status

Bento consumes the exact published `@muxui/react@0.1.0-rc.1` npm release in both
frozen dependency graphs. All normal React documents and both supported
rollback variants use public Mux controls, the shared stylesheet boundary, and
Bento layout/icon primitives. The normal Settings surface is native Firefox;
the standalone React Settings and Shortcuts surfaces belong to the rollback
archive and are compiled against the same npm package. Native controls consume
the generated Mux token projection.

Text uses the public `xs`, `sm`, `md`, and `lg` size values. There is no
Bento compatibility wrapper for the old Text API. React Aria is an internal Mux
dependency; shared Vite aliases and graph overrides preserve one menu context
identity. Release SBOM validation binds the exact published version and npm
integrity and retains the approved shell runtime dependency policy.

On 2026-10-05, isolated Node 24.21 validation passed both frozen installs,
normal shell typecheck/lint/build, the active and archived Settings Ladle
builds and provider/config typecheck, 64 shell tests, 154 tools tests, six release-security tests, and four
theme-selector tests. Both rollback variants passed 14-entry builds, shell and
tools typechecks, background bundling, and two backup privacy tests each.
Theme regeneration is deterministic and chrome tokens were generated to a
scratch path. The production dependency audit reported zero known
vulnerabilities, and the release SBOM contains 709 components with the npm Mux
integrity digest. These results cover the published RC; prior alpha test counts
and screenshots are not evidence for it.

The size checker covers all 13 normal entries and includes standalone Settings
when the rollback source stages it. Existing advisory ceilings remain unchanged.
An unchanged alpha baseline built in a separate source copy measured shell
JavaScript at 386.09 KB gzipped and CSS at 91.41 KB. The RC measures 364.64 KB and
107.41 KB respectively: JavaScript decreases 21.45 KB, while CSS increases
16.00 KB. Both variants measure rollback Settings at 373.66 KB and shared CSS
at 108.00 KB. The ceilings are still exceeded; passing builds are not a claim
that those budgets pass. Public Mux styles alone are 79.92 KB gzipped, with
public themes at 30.83 KB and Bento's generated aliases at 17.54 KB; combined
compression means these source sizes do not add directly to the bundle size.
Full public component/theme coverage is retained.

Firefox validation uses a disposable app/profile and legitimate protocol fixtures
to activate the normal entries and both rollback Settings variants. Entry coverage
through those fixture/bridge-contract scenarios is separate from representative
real `moz-extension` host evidence: the populated sidebar, sidebar theme/collapse
bridge updates, the address editor, and a confirm overlay. This does not claim that every normal
overlay flow was individually exercised in the native extension host.

Fresh RC rollback checks show readable disabled dark NumberField values `30`
and `5` in both variants; enabling backups and incrementing the interval to `35`
produce the expected settings update. This resolves the old alpha-era blank-field
observation without a custom value renderer or package patch. Both variants also
pass Shortcuts filtering, nonempty-query Escape and pointer Close, plus FileTrigger
invalid/valid JSON, same-file reselection, import dispatch, and completion. Public
picker Tabs pass pointer categories and current-focus Home/End/arrows with
DOM focus following selection; Enter/Space retain that category and search typing
retains input focus. Active-panel association, inactive-panel hiding, search
fallback, emoji/theme selection, Escape, and workspace Save also pass. Normal command and merge palettes pass pointer Close with empty and
nonempty queries, and their public ClearButtons reset the controlled query.
Runtime artifacts and the per-surface `acceptance-report.md` are retained under
`/tmp/bento-mux-runtime-20261005/` for this review. No fresh native engine build or cross-platform CI was run.

## Composition model

Prefer the Mux component props, variants, sizes, and documented compound parts
before adding CSS. Use Bento primitives for repeated layout and icon behavior,
then keep product-specific composition in the owning component. A trigger that
renders a button must not contain another button. Keep overlay state and focus
behavior on the documented Mux parts. Public native Input handlers may adapt
browser-specific keyboard behavior without bypassing the component renderer. Set `placement="end-top"` explicitly on nested
`Menu.Popup` parts so chrome submenus open beside their parent item. This
preserves pointer travel and keeps the child popup clear of subsequent root
menu rows under the RC collection renderer.

Generic buttons and picker triggers use Mux `Button` or `IconButton`. Emoji
categories use public `Tabs` with controlled `value`/`onChange`; Mux owns tab
roles, panel association, selection, and arrow-key navigation. Scoped layout
keeps the existing emoji panel above its category strip. The RC can update
selection and roving `tabIndex` while leaving DOM focus on the previous tab.
A small effect uses the public Tabs root ref and standard ARIA roles to focus
its selected tab directly after the controlled update commits. Do not defer
this correction to an animation frame: Firefox can delay those callbacks in
background overlay windows. It runs only when focus already belongs to that
category tab list, so search, emoji results, and outside focus are preserved.
Mux still owns the key-to-selection algorithm; no private renderer API or
package patch is used. Recheck current-focus Home/End/arrows and
Enter/Space, plus search focus, before removing this adaptation after a package
upgrade. Inline
tab/folder rename fields, tab search, and the read-only sidebar address display
use the public `Input.Input` leaf with native input props and refs. The leaf's
optional field context allows it to occupy the existing product grid without
an extra wrapper. Sidebar address submission uses Mux `Form`, and the panel
trailer uses public `Toolbar`; scoped Bento layout rules preserve their chrome
geometry.

The virtualized tab/folder composite is browser-specific structure. Its Bento
`Row` host retains drag, multi-selection, context-menu, and middle-click events;
its inner generic controls use Mux. Semantic headings/sections, host roots,
favicon images, skeletons, and native `SelectNative` options remain ordinary
HTML. ESLint enforces public imports in all shell source, Ladle, and rollback
UI. It does not claim to ban every intrinsic JSX element.

Tab and folder labels use the row's center alignment with single-line leading.
Keep them free of relative vertical offsets: the former `top: 2px` adjustment
put Mux text below the centered favicon and folder count.

Rollback Backup import uses public `FileTrigger` around its Mux button. Mux
owns the hidden input and resets selection before reopening the picker; Bento
retains the 10 MB limit, JSON parsing, preview, and dispatch behavior. Shortcuts
uses public CommandPalette `ListBox`, `Section`, and `Item` parts with read-only
activation semantics (`closeOnSelect={false}`). Public ClearButton and Close
parts occupy separate positions in the search row in Shortcuts, the normal and
archived command palette, and merge. The scoped static Close position prevents
the sticky search row's Input/Clear/Refresh from covering the button. A native Input Escape
handler closes the controlled dialog, since the RC SearchField can otherwise
consume Escape while the controlled leaf query remains unchanged. Preserve IME
composition before handling that key.

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
