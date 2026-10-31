# bento-tools

Privileged built-in extension for Bento's background logic, written in plain
TypeScript: the source of truth for persistent state (tabs, workspaces, panels,
settings), keyboard handling, backup and import, and external session merge.
`bento-shell` mirrors this state and sends it port messages; it never mutates
persistent state itself.

- `src/` holds the background script and its stores; tests run with
  `pnpm --filter @bento/tools test`.
- `experiments/` holds the privileged WebExtension experiment APIs
  (`bentoPrivacy`, `bentoExternalSessions`, `bentoTabState`).

Build with `pnpm --filter @bento/tools build`, then `pnpm run import`; see
[docs/build-tooling.md](../../docs/build-tooling.md).
