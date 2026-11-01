// Decides whether the CI `source-import` job must run for a pull request.
//
// stdin: NUL-separated repo-relative paths, as printed by
//   git diff --name-only --no-renames -z HEAD^1 HEAD
// stdout: `true` when source-import must run, `false` when every changed path is
// on the skip allowlist. Exit code is 0 for both answers.
// stderr: one line naming the first path that forced `true` (nothing for `false`).
//
// Default deny: a path is skippable only when it matches an allowlist rule below.
// Anything else, including an empty change list, runs the job.

// Exact files with no effect on the import: size and alias ratchets, and the
// CodeQL and Dependabot configs.
const SAFE_FILES = new Set([
  '.size-baseline.json',
  '.size-limit.json',
  '.legacy-alias-cap.json',
  '.github/workflows/codeql.yml',
  '.github/dependabot.yml',
]);

// Extension source is built, linted, and tested on every PR by other jobs. The
// experiments are Firefox-facing code that the import copies, so they stay unsafe.
const EXTENSION_SOURCE_ROOTS = ['extensions/bento-shell/src/', 'extensions/bento-tools/src/'];

/** True when a change to `path` cannot alter whether source-import passes. */
function isSkippable(path) {
  const segments = path.split('/');
  // Absolute, `./`-prefixed, `..`, doubled-slash, and trailing-slash paths are
  // not what git prints, so treat them as unknown.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  if (SAFE_FILES.has(path)) return true;
  if (segments.length === 1) return /^.+\.md$/.test(path);
  if (segments[0] === 'docs' || segments[0] === '.agents') return true;
  if (segments[0] === 'scripts')
    return segments.length === 2 && /^.+\.test\.mjs$/.test(segments[1]);
  return (
    EXTENSION_SOURCE_ROOTS.some((root) => path.startsWith(root)) &&
    !segments.includes('experiments')
  );
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const paths = Buffer.concat(chunks).toString('utf8').split('\0');
// `git diff -z` terminates every path with NUL, leaving one empty trailing entry.
if (paths.at(-1) === '') paths.pop();

let reason;
if (paths.length === 0) {
  reason = 'no changed paths listed';
} else {
  const forcing = paths.find((path) => !isSkippable(path));
  // JSON quoting keeps odd path bytes from forging log lines such as workflow commands.
  if (forcing !== undefined) reason = `${JSON.stringify(forcing)} is not on the skip allowlist`;
}
if (reason !== undefined) console.error(`source-import required: ${reason}`);
process.stdout.write(reason === undefined ? 'false\n' : 'true\n');
