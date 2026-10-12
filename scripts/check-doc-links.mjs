#!/usr/bin/env node
/* global process */
// Checks the relative links and #anchors in the repo's Markdown docs:
// CLAUDE.md, README.md, and every .md file under docs/. External URLs are
// not fetched. A link to a .md file must resolve to an existing file, and a
// #fragment on it must match a heading slug in that file (GitHub's rules,
// including the -1, -2 suffix for repeated headings). Links to other files
// and directories only need to exist.
//
//   node scripts/check-doc-links.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = ['CLAUDE.md', 'README.md'];
const DOCS_DIR = 'docs';

/** Markdown with fenced code blocks and inline code spans blanked out, line count preserved. */
function stripCode(text) {
  let fence = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        return '';
      }
      if (marker) {
        fence = marker[1];
        return '';
      }
      return line.replace(/(`+)(?:(?!\1).)+?\1/g, (span) => ' '.repeat(span.length));
    })
    .join('\n');
}

/** GitHub-style heading slug: inline Markdown reduced to its text, then lowercased and hyphenated. */
export function slugify(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~]+/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Anchors a Markdown file defines through its ATX headings (and explicit id attributes). */
export function headingAnchors(text) {
  const seen = new Map();
  const anchors = new Set();
  const stripped = stripCode(text);
  for (const line of stripped.split('\n')) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const base = slugify(heading[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const id of line.matchAll(/\bid="([^"]+)"/g)) anchors.add(id[1]);
  }
  return anchors;
}

/** [{ target, line }] for inline links, images, and reference definitions outside code. */
export function extractLinks(text) {
  const links = [];
  const lines = stripCode(text).split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ target: match[1], line: index + 1 });
    }
    const definition = line.match(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/);
    if (definition) links.push({ target: definition[1], line: index + 1 });
  });
  return links;
}

function collectMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Problems found in `files` (absolute paths) relative to `repoRoot`. */
export function checkLinks(files, repoRoot = REPO_ROOT) {
  const errors = [];
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, headingAnchors(fs.readFileSync(file, 'utf8')));
    return anchorCache.get(file);
  };
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    for (const { target, line } of extractLinks(fs.readFileSync(file, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, ...
      const hash = target.indexOf('#');
      const pathPart = decodeURI(hash === -1 ? target : target.slice(0, hash));
      const fragment = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
      const resolved = pathPart === '' ? file : path.resolve(path.dirname(file), pathPart);
      if (!fs.existsSync(resolved)) {
        errors.push(`${rel}:${line}: broken link, no such path: ${target}`);
        continue;
      }
      if (fragment === '' || !resolved.endsWith('.md') || !fs.statSync(resolved).isFile()) continue;
      if (!anchorsOf(resolved).has(fragment.toLowerCase())) {
        errors.push(`${rel}:${line}: broken anchor #${fragment} in ${path.relative(repoRoot, resolved)}`);
      }
    }
  }
  return errors;
}

export function docFiles(repoRoot = REPO_ROOT) {
  const files = ROOT_FILES.map((name) => path.join(repoRoot, name)).filter((file) => fs.existsSync(file));
  const docs = path.join(repoRoot, DOCS_DIR);
  if (fs.existsSync(docs)) files.push(...collectMarkdown(docs).sort());
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = docFiles();
  const errors = checkLinks(files);
  if (errors.length > 0) {
    console.error(`check-doc-links: ${errors.length} broken link(s)\n${errors.join('\n')}`);
    process.exit(1);
  }
  console.log(`check-doc-links: ${files.length} Markdown files, all relative links and anchors resolve`);
}
