#!/usr/bin/env node
/* global process */

// Checks Bento's firefox-compat registry: the list of upstream-private and
// upstream-internal Firefox members Bento depends on. The registry lives in
// scripts/firefox-compat-registry.mjs and is never shipped. The mount script
// carries only a compact probe list of the runtime-probable members (see the
// @bento-firefox-compat section in src/browser/base/content/bento-shell-mount.js).
//
//   node scripts/check-firefox-compat.mjs                  registry self-check
//   node scripts/check-firefox-compat.mjs --engine engine  also grep a Firefox tree
//   node scripts/check-firefox-compat.mjs --write-docs     regenerate the docs table
//
// The self-check validates entries, confirms every call site still exists in
// the repo, requires the mount probe list to equal the registry's R entries,
// requires an entry for each underscore or on_* member the mount
// script reaches on a known Firefox global, and requires the table in
// docs/firefox-core-touchpoints.md to match the registry. --engine verifies
// every entry's `at` pattern in the given source tree (run it on the imported
// engine/ after `pnpm run import`). Exit 1 on any failure, 2 on bad usage.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { registry as bundledRegistry } from './firefox-compat-registry.mjs';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MOUNT_PATH = 'src/browser/base/content/bento-shell-mount.js';
export const DOCS_PATH = 'docs/firefox-core-touchpoints.md';
const SECTION_BEGIN = '// @bento-firefox-compat:begin';
const SECTION_END = '// @bento-firefox-compat:end';
const DOCS_BEGIN = '<!-- firefox-compat:begin -->';
const DOCS_END = '<!-- firefox-compat:end -->';

const KINDS = new Set(['method', 'member', 'element', 'module', 'source']);
const PROBES = new Set(['R', 'E']);
const NATIVES = new Set(['note', 'proto']);
const HOWS = new Set([
  'wraps',
  'overrides',
  'calls',
  'reads',
  'writes',
  'queries',
  'listens',
  'dispatches',
  'imports',
]);

// Firefox globals whose underscore/on_* members must be listed in the registry
// when the mount script touches them directly.
const GUARDED_GLOBALS = [
  'gBrowser',
  'gURLBar',
  'gIdentityHandler',
  'PanelUI',
  'PanelMultiView',
  'PopupNotifications',
  'PlacesUIUtils',
  'DownloadsButton',
  'DownloadsPanel',
  'DownloadsView',
  'PrivateDownloadsSubview',
];

/** Returns the registry section text between the marker comments. */
export function extractSection(source) {
  const begin = source.indexOf(SECTION_BEGIN);
  const end = source.indexOf(SECTION_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${MOUNT_PATH} must contain one ${SECTION_BEGIN} ... ${SECTION_END} section`);
  }
  if (
    source.indexOf(SECTION_BEGIN, begin + 1) !== -1 ||
    source.indexOf(SECTION_END, end + 1) !== -1
  ) {
    throw new Error(`${MOUNT_PATH} has more than one firefox-compat section`);
  }
  return source.slice(begin + SECTION_BEGIN.length, end);
}

/**
 * Evaluates only the compact probe section of the mount script. `globals`
 * supplies what its probes need when a test runs them (console, Services,
 * ChromeUtils, Cu, window). `entries` is the flat probe list the runner iterates.
 */
export function evaluateProbeSection(section, globals = {}) {
  const context = vm.createContext({ ...globals });
  const wrapped = `(() => {\n${section}\nreturn {
    entries: bentoCompatEntries(),
    probes: BENTO_COMPAT_PROBES,
    note: bentoCompatNoteNative,
    run: runBentoFirefoxCompat,
    probe: bentoCompatProbe,
    schedule: scheduleBentoFirefoxCompatChecks,
  };\n})()`;
  return vm.runInContext(wrapped, context, { filename: `${MOUNT_PATH}#firefox-compat` });
}

export function readMount(repoRoot = SCRIPT_ROOT) {
  return fs.readFileSync(path.join(repoRoot, MOUNT_PATH), 'utf8');
}

function splitSite(site) {
  const hash = site.indexOf('#');
  return hash === -1
    ? { file: MOUNT_PATH, token: site }
    : { file: site.slice(0, hash), token: site.slice(hash + 1) };
}

function isRegexSource(pattern) {
  try {
    new RegExp(pattern, 'm');
    return true;
  } catch {
    return false;
  }
}

/** Validates entry shape and that each call-site token still exists. */
export function validateRegistry(registry, repoRoot = SCRIPT_ROOT) {
  const errors = [];
  const ids = new Set();
  const fileCache = new Map();
  const readRepoFile = (file) => {
    if (!fileCache.has(file)) {
      const absolute = path.join(repoRoot, file);
      let text = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
      // The probe list names members, not call sites; tokens must exist outside it.
      if (text !== null && file === MOUNT_PATH) text = text.replace(extractSection(text), '');
      fileCache.set(file, text);
    }
    return fileCache.get(file);
  };

  if (typeof registry.baseline !== 'string' || !/^\d+\.\d+/.test(registry.baseline)) {
    errors.push('BASELINE must be a Firefox version string such as "154.0"');
  }
  if (!Array.isArray(registry.members) || registry.members.length === 0) {
    errors.push('MEMBERS must be a non-empty array');
    return errors;
  }

  for (const [index, entry] of registry.members.entries()) {
    const label = typeof entry?.id === 'string' ? entry.id : `entry #${index + 1}`;
    const fail = (message) => errors.push(`${label}: ${message}`);
    if (typeof entry?.id !== 'string' || entry.id === '') {
      fail('id must be a non-empty string');
      continue;
    }
    if (ids.has(entry.id)) fail('duplicate id');
    ids.add(entry.id);
    if (!KINDS.has(entry.kind)) fail(`kind must be one of ${[...KINDS].join(', ')}`);
    if (!HOWS.has(entry.how)) fail(`how must be one of ${[...HOWS].join(', ')}`);
    if (typeof entry.use !== 'string' || entry.use.trim() === '')
      fail('use must describe what Bento does');
    if (entry.kind === 'module' && !(Array.isArray(entry.exports) && entry.exports.length > 0)) {
      fail('module entries need a non-empty exports array');
    }
    if (!PROBES.has(entry.probe)) fail(`probe must be one of ${[...PROBES].join(', ')}`);
    else if ((entry.probe === 'E') !== (entry.kind === 'source')) {
      fail('probe E and kind source go together: source entries are engine-only');
    }
    if (entry.native !== undefined && !NATIVES.has(entry.native)) {
      fail(`native must be one of ${[...NATIVES].join(', ')}`);
    } else if (entry.probe === 'E' && entry.native !== undefined) {
      fail('native applies to runtime-probed entries only');
    } else if (
      entry.probe !== 'E' &&
      (entry.how === 'wraps' || entry.how === 'overrides') &&
      entry.native === undefined
    ) {
      fail('a runtime-probed wrap or override needs native: note or proto');
    }

    const at = entry.at;
    if (
      !Array.isArray(at) ||
      at.length !== 3 ||
      typeof at[0] !== 'string' ||
      typeof at[1] !== 'string' ||
      !Number.isInteger(at[2]) ||
      at[2] < 0
    ) {
      fail('at must be [file, regex, baseline line]');
    } else if (!isRegexSource(at[1])) {
      fail(`at regex does not compile: ${at[1]}`);
    }
    if (entry.reg !== undefined) {
      if (
        !Array.isArray(entry.reg) ||
        entry.reg.length !== 2 ||
        typeof entry.reg[0] !== 'string' ||
        !isRegexSource(entry.reg[1])
      ) {
        fail('reg must be [file, regex]');
      }
    }

    if (!Array.isArray(entry.sites) || entry.sites.length === 0) {
      fail('sites must list at least one call site');
      continue;
    }
    for (const site of entry.sites) {
      if (typeof site !== 'string' || site === '') {
        fail('sites must be non-empty strings');
        continue;
      }
      const { file, token } = splitSite(site);
      const text = readRepoFile(file);
      if (text === null) fail(`site file not found: ${file}`);
      else if (!text.includes(token)) fail(`site token "${token}" not found in ${file}`);
    }
  }
  return errors;
}

/**
 * Requires the mount script's probe list to equal the registry's runtime
 * entries (probe R): same ids, kinds, and module exports.
 */
export function validateProbeList(mountSource, registry) {
  let mounted;
  let probes;
  try {
    ({ entries: mounted, probes } = evaluateProbeSection(extractSection(mountSource)));
  } catch (err) {
    return [`cannot read the probe list in ${MOUNT_PATH}: ${err.message}`];
  }

  const errors = [];
  const byId = new Map();
  for (const entry of mounted) {
    if (byId.has(entry.id))
      errors.push(`${entry.id}: listed twice in the ${MOUNT_PATH} probe list`);
    byId.set(entry.id, entry);
  }
  const expected = registry.members.filter((entry) => entry.probe !== 'E');
  const expectedIds = new Set(expected.map((entry) => entry.id));

  for (const entry of expected) {
    const probe = byId.get(entry.id);
    if (!probe) {
      errors.push(`${entry.id}: registry probe ${entry.probe} but ${MOUNT_PATH} does not probe it`);
      continue;
    }
    // 'custom' probes check more than presence; the registry files them as members.
    const kindOk =
      probe.kind === 'custom'
        ? entry.kind === 'member' || entry.kind === 'method'
        : probe.kind === entry.kind;
    if (!kindOk)
      errors.push(`${entry.id}: probed as ${probe.kind} but registry kind is ${entry.kind}`);
    if (entry.kind === 'module' && !(entry.exports ?? []).includes(probe.exported)) {
      errors.push(`${entry.id}: probed export ${probe.exported} is not in the registry exports`);
    }
  }
  for (const id of byId.keys()) {
    if (!expectedIds.has(id)) {
      errors.push(`${id}: probed in ${MOUNT_PATH} but the registry has no R entry`);
    }
  }

  // Members Bento replaces must not satisfy their own probe: 'proto' ids are
  // looked up on the prototype, 'note' ids are recorded before the patch site
  // replaces them.
  const withNative = (native) =>
    new Set(expected.filter((entry) => entry.native === native).map((entry) => entry.id));
  const sameSet = (actual, wanted, describe) => {
    for (const id of wanted) if (!actual.has(id)) errors.push(`${id}: ${describe.missing}`);
    for (const id of actual) if (!wanted.has(id)) errors.push(`${id}: ${describe.extra}`);
  };
  sameSet(new Set(probes.proto), withNative('proto'), {
    missing: `registry says native: proto but the ${MOUNT_PATH} proto list lacks it`,
    extra: `in the ${MOUNT_PATH} proto list but the registry does not say native: proto`,
  });
  const code = mountSource.replace(extractSection(mountSource), '');
  const noted = new Set(
    [...code.matchAll(/bentoCompatNoteNative\(\s*'([^']+)'/g)].map((m) => m[1]),
  );
  sameSet(noted, withNative('note'), {
    missing: `registry says native: note but ${MOUNT_PATH} never calls bentoCompatNoteNative for it`,
    extra: `${MOUNT_PATH} calls bentoCompatNoteNative for it but the registry does not say native: note`,
  });
  return errors;
}

const PRIVATE_MEMBER = '(_(?!_?bento)\\w+|on_\\w+|#\\w+)';
// `const gb = window.gBrowser;` (also let/var, a trailing ?? or ||).
const ALIAS_DECLARATION = new RegExp(
  `^\\s*(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:window\\.)?(${GUARDED_GLOBALS.join('|')})\\s*(?:;|$|\\?\\?|\\|\\|)`,
);

/**
 * Finds `Global._member` / `Global.on_member` accesses on guarded Firefox
 * globals in the mount script (outside the registry section and comments)
 * that have no registry entry. Bento's own `_bento*` flags are ignored. A local
 * alias declaration such as `const gb = window.gBrowser;` stands for the
 * global until a line indented less than the declaration ends its block.
 * Destructuring, parameters, and values returned by helpers are not followed.
 */
export function findUndeclaredPrivateMembers(source, registry) {
  const section = extractSection(source);
  const code = source.replace(section, '');
  const declared = new Set(registry.members.map((entry) => entry.id));
  const direct = new RegExp(
    `\\b(?:window\\.)?(${GUARDED_GLOBALS.join('|')})\\??\\.${PRIVATE_MEMBER}`,
    'g',
  );
  const found = new Map();
  let aliases = [];
  code.split('\n').forEach((line, index) => {
    const trimmed = line.trimStart();
    if (
      trimmed === '' ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    )
      return;
    const indent = line.length - trimmed.length;
    aliases = aliases.filter((alias) => alias.indent <= indent);
    const declaration = ALIAS_DECLARATION.exec(line);
    if (declaration) aliases.push({ name: declaration[1], global: declaration[2], indent });

    const report = (global, member) => {
      const id = `${global}.${member}`;
      if (!declared.has(id) && !found.has(id)) found.set(id, index + 1);
    };
    for (const match of line.matchAll(direct)) report(match[1], match[2]);
    for (const { name, global } of aliases) {
      const viaAlias = new RegExp(`(?<![\\w.$])${name}\\??\\.${PRIVATE_MEMBER}`, 'g');
      for (const match of line.matchAll(viaAlias)) report(global, match[1]);
    }
  });
  return [...found].map(
    ([id, line]) => `${MOUNT_PATH}:${line} reaches ${id} but the registry has no entry`,
  );
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Markdown table embedded in docs/firefox-core-touchpoints.md. */
export function renderDocsTable(registry) {
  const lines = [
    `| Member | Kind | Bento use | Used in | Firefox ${registry.baseline} source |`,
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of registry.members) {
    const [file, , line] = entry.at;
    const sites = entry.sites.map((site) => `\`${escapeCell(site)}\``).join(', ');
    const probe = entry.probe === 'E' ? 'engine only' : 'runtime';
    lines.push(
      `| \`${escapeCell(entry.id)}\` | ${entry.kind} (${probe}) | ${escapeCell(entry.use)} | ${sites} | \`${escapeCell(file)}:${line}\` |`,
    );
  }
  return lines.join('\n');
}

function docsRegion(text) {
  const begin = text.indexOf(DOCS_BEGIN);
  const end = text.indexOf(DOCS_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return { begin: begin + DOCS_BEGIN.length, end };
}

export function renderDocs(docsText, registry) {
  const region = docsRegion(docsText);
  if (!region) throw new Error(`${DOCS_PATH} must contain ${DOCS_BEGIN} and ${DOCS_END}`);
  return `${docsText.slice(0, region.begin)}\n\n${renderDocsTable(registry)}\n\n${docsText.slice(region.end)}`;
}

export function checkDocs(registry, repoRoot = SCRIPT_ROOT) {
  const absolute = path.join(repoRoot, DOCS_PATH);
  if (!fs.existsSync(absolute)) return [`${DOCS_PATH} not found`];
  const text = fs.readFileSync(absolute, 'utf8');
  if (!docsRegion(text)) return [`${DOCS_PATH} must contain ${DOCS_BEGIN} and ${DOCS_END}`];
  return renderDocs(text, registry) === text
    ? []
    : [
        `${DOCS_PATH} firefox-compat table is stale; run: node scripts/check-firefox-compat.mjs --write-docs`,
      ];
}

function lineOf(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

/**
 * Greps a Firefox source tree for every entry. Returns one result per entry:
 * { id, status: 'ok' | 'missing', line, expected, reason }.
 */
export function checkEngine(registry, engineRoot) {
  const fileCache = new Map();
  const read = (file) => {
    if (!fileCache.has(file)) {
      const absolute = path.join(engineRoot, file);
      fileCache.set(file, fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null);
    }
    return fileCache.get(file);
  };
  const find = (file, pattern) => {
    const text = read(file);
    if (text === null) return { reason: `${file} does not exist` };
    const match = new RegExp(pattern, 'm').exec(text);
    if (!match) return { reason: `/${pattern}/m not found in ${file}` };
    // A leading \s+ can start the match on the blank line above the member.
    return { line: lineOf(text, match.index + Math.max(0, match[0].search(/\S/))) };
  };

  return registry.members.map((entry) => {
    const [file, pattern, expected] = entry.at;
    const located = find(file, pattern);
    if (located.reason)
      return { id: entry.id, status: 'missing', reason: located.reason, expected };
    if (entry.reg) {
      const registered = find(entry.reg[0], entry.reg[1]);
      if (registered.reason) {
        return {
          id: entry.id,
          status: 'missing',
          reason: `module is no longer registered: ${registered.reason}`,
          expected,
        };
      }
    }
    return { id: entry.id, status: 'ok', line: located.line, expected };
  });
}

function parseArgs(argv) {
  const options = { repo: SCRIPT_ROOT, engine: null, writeDocs: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--engine' || arg === '--repo') {
      const value = argv[(i += 1)];
      if (!value) throw new Error(`${arg} needs a path`);
      options[arg.slice(2)] = path.resolve(value);
    } else if (arg === '--write-docs') options.writeDocs = true;
    else if (arg === '--verbose') options.verbose = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** `registry` is injectable so tests can drive the CLI with a small fixture. */
export function main(argv, out = console, registry = bundledRegistry) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    out.error(`check-firefox-compat: ${err.message}`);
    out.error(
      'usage: check-firefox-compat.mjs [--engine <firefox-tree>] [--write-docs] [--verbose] [--repo <dir>]',
    );
    return 2;
  }

  let mountSource;
  try {
    mountSource = readMount(options.repo);
  } catch (err) {
    out.error(`check-firefox-compat: cannot read ${MOUNT_PATH}: ${err.message}`);
    return 1;
  }
  if (options.writeDocs) {
    const docs = path.join(options.repo, DOCS_PATH);
    fs.writeFileSync(docs, renderDocs(fs.readFileSync(docs, 'utf8'), registry));
    out.log(
      `check-firefox-compat: wrote the table for ${registry.members.length} members to ${DOCS_PATH}`,
    );
  }

  const problems = [
    ...validateRegistry(registry, options.repo),
    ...validateProbeList(mountSource, registry),
    ...findUndeclaredPrivateMembers(mountSource, registry),
    ...checkDocs(registry, options.repo),
  ];
  for (const problem of problems) out.error(`registry: ${problem}`);
  out.log(
    `check-firefox-compat: ${registry.members.length} members, registry ${problems.length === 0 ? 'consistent' : `has ${problems.length} problem(s)`}`,
  );

  let missing = 0;
  if (options.engine) {
    if (!fs.existsSync(path.join(options.engine, 'browser'))) {
      out.error(
        `check-firefox-compat: ${options.engine} is not a Firefox source tree (no browser/ directory)`,
      );
      return 2;
    }
    const byId = new Map(registry.members.map((entry) => [entry.id, entry]));
    const results = checkEngine(registry, options.engine);
    for (const result of results) {
      const entry = byId.get(result.id);
      if (result.status === 'missing') {
        missing += 1;
        out.error(
          `MISSING ${result.id}\n  ${result.reason}\n  Bento: ${entry.use}\n  used in: ${entry.sites.join(', ')}`,
        );
      } else if (options.verbose) {
        const moved =
          result.line === result.expected
            ? ''
            : ` (baseline ${registry.baseline}: ${result.expected})`;
        out.log(`ok      ${result.id}  ${entry.at[0]}:${result.line}${moved}`);
      }
    }
    out.log(
      `check-firefox-compat: ${results.length - missing} of ${results.length} members found in ${options.engine}` +
        (missing ? `; ${missing} missing` : ''),
    );
  }

  return problems.length > 0 || missing > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
