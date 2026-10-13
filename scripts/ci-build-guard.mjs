// Pattern guard behind `pnpm run security:check`: CI must never build the
// application. Bento targets macOS only for now, and application builds run
// locally on the maintainer's Mac. This is a text scan of workflow and composite
// action files, not a YAML policy engine.

import fs from 'node:fs';
import path from 'node:path';

// bento-env.sh and bento-build.mjs subcommands that bootstrap, build, or package.
// `download` is deliberately absent: the source-import job runs it.
const NATIVE_SUBCOMMAND = '(?:bootstrap|build|package|updates-browser|updates-addons)';

// Direct native entry points: scripts, subcommands, mach, and release creation.
const nativeCommands = [
  {
    description: 'a Bento native build command',
    pattern: new RegExp(`\\bbento-(?:env\\.sh|build\\.mjs)["']?\\s+${NATIVE_SUBCOMMAND}\\b`),
  },
  {
    description: 'a native build script',
    pattern: /\b(?:build-bento|build-release|mach-raw|sync-firefox-upstream)\.sh\b/,
  },
  {
    description: 'a rollback variant build',
    pattern: /\bbuild-rollback-variant\.mjs["']?\s+\S+\s+(?:build|package|release|updates)\b/,
  },
  {
    description: 'a mach command',
    pattern: /(?:^|[\s;&|(/"'])mach\s+(?:bootstrap|build|package|configure|run)\b/m,
  },
  { description: 'a GitHub release command', pattern: /\bgh\s+release\b/ },
];

// Triggers, artifact uploads, and release steps that have no place in CI.
const forbiddenText = [
  {
    description: 'a manual or privileged trigger',
    pattern: /workflow_dispatch|workflow_run|pull_request_target/,
  },
  {
    description: 'an artifact upload, release, or attestation step',
    pattern: /upload-artifact|action-gh-release|actions\/attest@/,
  },
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `pnpm <name>`, `pnpm run <name>`, and the same with leading flags such as
// `pnpm -r run <name>`. `--filter` and `-F` are not skipped, so a package build
// such as `pnpm --filter @bento/shell build` does not match.
function invocationPattern(names) {
  const flags = '(?:\\s+(?!--?(?:filter|F)\\b)-{1,2}[\\w-]+(?:=\\S+)?)*';
  const alternatives = [...names].map(escapeRegExp).join('|');
  return new RegExp(
    `\\b(?:pnpm|npm|yarn)${flags}\\s+(?:run(?:-script)?${flags}\\s+)?(?:${alternatives})(?![\\w:.-])`,
  );
}

/**
 * Names of root package.json scripts that reach a native bootstrap, build, or
 * package step, directly or through another script.
 */
export function nativeScriptNames(scripts) {
  const names = new Set();
  for (const [name, body] of Object.entries(scripts)) {
    if (nativeCommands.some(({ pattern }) => pattern.test(body))) names.add(name);
  }
  for (let grew = names.size > 0; grew; ) {
    grew = false;
    const invokesNative = invocationPattern(names);
    for (const [name, body] of Object.entries(scripts)) {
      if (!names.has(name) && invokesNative.test(body)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

function stripLineComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === '\\' && quote === '"') i += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Drops full-line and trailing ` #` comments that sit outside quotes. */
export function stripYamlComments(text) {
  return text.split('\n').map(stripLineComment).join('\n');
}

/** Descriptions and matched text for every native-build pattern found in `text`. */
export function nativeBuildMatches(text, nativeNames) {
  const checks = [...nativeCommands, ...forbiddenText];
  if (nativeNames.size > 0) {
    checks.push({
      description: 'a package script that runs a native build',
      pattern: invocationPattern(nativeNames),
    });
  }
  const code = stripYamlComments(text);
  return checks.flatMap(({ description, pattern }) => {
    const match = code.match(pattern);
    return match ? [{ description, match: match[0].trim() }] : [];
  });
}

/** Workflow files plus every local composite action definition, relative to `root`. */
export function ciConfigFiles(root) {
  const isYaml = (file) => /\.ya?ml$/.test(file);
  const workflows = path.join(root, '.github/workflows');
  const actions = path.join(root, '.github/actions');
  const files = [];
  if (fs.existsSync(workflows)) {
    for (const file of fs.readdirSync(workflows).filter(isYaml)) {
      files.push(`.github/workflows/${file}`);
    }
  }
  if (fs.existsSync(actions)) {
    for (const entry of fs.readdirSync(actions, { recursive: true })) {
      if (/^action\.ya?ml$/.test(path.basename(entry))) {
        files.push(`.github/actions/${entry.split(path.sep).join('/')}`);
      }
    }
  }
  return files.sort();
}

/** Every native-build pattern found in the repository's workflows and actions. */
export function findCiBuildViolations(root) {
  const { scripts = {} } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const nativeNames = nativeScriptNames(scripts);
  return ciConfigFiles(root).flatMap((file) =>
    nativeBuildMatches(fs.readFileSync(path.join(root, file), 'utf8'), nativeNames).map(
      (hit) => ({ file, ...hit }),
    ),
  );
}
