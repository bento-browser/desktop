# bentobrowser.app

Static one-pager landing site for Bento Browser. Pure HTML + CSS, no build step. Works in any static host.

## Files

- `index.html` — single-page hero + features + about + footer.
- `styles.css` — vanilla CSS with the Bento brand palette.
- `assets/` — logo + favicon copied from `branding/bento/`. Re-copy if the brand changes:

  ```sh
  cp ../branding/bento/default512.png ./assets/logo-512.png
  cp ../branding/bento/default128.png ./assets/logo-128.png
  cp ../branding/bento/default32.png  ./assets/favicon-32.png
  ```

## Deploy

Pick whatever you've already wired up for `bentobrowser.app`:

- **GitHub Pages**: push this directory to a `gh-pages` branch (or a separate `Bento-Browser/site` repo) and point the apex domain at it.
- **Cloudflare Pages / Netlify**: connect the repo, set the build command to nothing, set the output directory to `bentobrowser-site/`.
- **Manual**: rsync the directory to whatever host you use.

Local preview while editing:

```sh
python3 -m http.server -d bentobrowser-site 8080
# → http://localhost:8080/
```

## When release artifacts land

The hero buttons currently link to <https://github.com/Bento-Browser/desktop/releases/latest>. GitHub serves the most recent published Release at that URL, so the buttons resolve to the right `.dmg` / `.zip` once the first non-draft release exists.

If you need direct links to specific assets in the latest release, GitHub also exposes:

```text
https://github.com/Bento-Browser/desktop/releases/latest/download/Bento-<version>-macos.dmg
https://github.com/Bento-Browser/desktop/releases/latest/download/Bento-<version>-windows.zip
```

These need the version baked in, so they'll bit-rot on each version bump. Prefer the `releases/latest` page link unless you have a specific reason to deep-link.

## Updating copy

Everything user-facing is in `index.html`. The features section is four `<article class="feature">` blocks — add/remove/reorder freely. The "developer preview" callout in the hero stays until release builds are signed + notarized.
