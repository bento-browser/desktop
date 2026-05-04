// The Bento sidebar pins to dark mode regardless of OS prefs (matches the
// brand). data-color-mode + data-theme are set in boot.js before any CSS
// loads, and we don't want to flip them at runtime. This hook is kept as
// a no-op so callers don't have to refactor — it'll grow real behavior
// (per-workspace data-workspace-color binding) when workspaces land in
// M1-PR-3.
export function useFirefoxTheme(): void {
  // intentionally empty
}
