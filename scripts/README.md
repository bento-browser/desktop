# scripts/

Build, packaging, and release helper scripts.

- `build-bento.sh` — runs the full Surfer pipeline (download → bootstrap → build → package).
  Equivalent to `npm run build:full`.
- `sync-firefox-upstream.sh` — updates the Firefox engine to Mozilla's latest
  release known to Surfer, syncs version metadata, imports Bento patches, and
  runs a build. Equivalent to `pnpm run firefox:sync`.

Future additions: release-channel scripts, version bump helpers, signing/notarization wrappers.
