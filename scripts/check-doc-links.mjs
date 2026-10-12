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

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( *)(\S?)/;

/** Strips up to `max` leading blockquote markers; reports how many were found. */
function stripQuote(line, max = Infinity) {
  let depth = 0;
  let rest = line;
  while (depth < max) {
    const match = rest.match(/^ {0,3}> ?/);
    if (!match) break;
    depth += 1;
    rest = rest.slice(match[0].length);
  }
  return { depth, rest };
}

/** Leading tabs become spaces (tab stops of 4) so indentation can be measured in columns. */
function expandLeadingTabs(line) {
  let column = 0;
  let index = 0;
  for (; index < line.length; index += 1) {
    if (line[index] === ' ') column += 1;
    else if (line[index] === '\t') column += 4 - (column % 4);
    else break;
  }
  return ' '.repeat(column) + line.slice(index);
}

/**
 * Classifies every line of a Markdown file with a small CommonMark block scanner.
 * Returns [{ code, text, heading }] per line: `code` is true for fenced and indented
 * code (and fence lines), `text` is the line without blockquote markers (empty for
 * code), and `heading` is the raw text of an ATX heading. Covered rules: fences are
 * indented 0 to 3 columns (also inside blockquotes and list items), a closing fence
 * repeats the opening character at least as many times, a backtick fence info string
 * has no backticks, an unclosed fence ends with its blockquote or list item, and a line indented 4
 * or more columns past its list item content is indented code unless it continues a
 * paragraph. Setext headings and HTML blocks are not recognized.
 */
export function scanBlocks(text) {
  const result = [];
  const lists = []; // content columns of the open list items, outermost first
  let fence = null; // { char, length, depth, base }
  let previous = 'blank'; // blank | paragraph | other | code
  for (const raw of text.split('\n')) {
    if (fence) {
      const quote = stripQuote(raw, fence.depth);
      const inner = expandLeadingTabs(quote.rest);
      const blank = inner.trim() === '';
      // A line indented less than the list item that holds the fence ends the fence.
      if (quote.depth === fence.depth && (blank || inner.length - inner.trimStart().length >= fence.base)) {
        const closing = inner.slice(fence.base).match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
          fence = null;
          previous = 'other';
        }
        result.push({ code: true, text: '' });
        continue;
      }
      fence = null;
    }

    const { depth, rest } = stripQuote(raw);
    const line = expandLeadingTabs(rest);
    if (line.trim() === '') {
      result.push({ code: false, text: '' });
      previous = 'blank';
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (previous === 'blank') while (lists.length > 0 && indent < lists[lists.length - 1]) lists.pop();
    const base = lists.length > 0 ? lists[lists.length - 1] : 0;

    if (previous !== 'paragraph' && indent >= base + 4) {
      result.push({ code: true, text: '' });
      previous = 'code';
      continue;
    }

    const relative = indent >= base ? line.slice(base) : line;
    const open = relative.match(FENCE_OPEN);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length, depth, base };
      result.push({ code: true, text: '' });
      previous = 'code';
      continue;
    }

    const entry = { code: false, text: rest };
    const heading = relative.match(HEADING);
    if (heading) {
      if (heading[1] !== undefined) entry.heading = heading[1];
      previous = 'other';
    } else if (THEMATIC_BREAK.test(relative)) {
      previous = 'other';
    } else {
      const item = indent < base + 4 ? line.match(LIST_ITEM) : null;
      if (item && (item[3].length > 0 || item[4] === '')) {
        while (lists.length > 0 && lists[lists.length - 1] > indent) lists.pop();
        const markerEnd = item[1].length + item[2].length;
        const spaces = item[4] === '' || item[3].length > 4 ? 1 : item[3].length;
        lists.push(markerEnd + spaces);
      }
      previous = 'paragraph';
    }
    result.push(entry);
  }
  return result;
}

/** A line with its inline code spans blanked, so their contents are never read as links or ids. */
function blankInlineCode(line) {
  return line.replace(/(`+)(?:(?!\1).)+?\1/g, (span) => ' '.repeat(span.length));
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

/**
 * Anchors a Markdown file defines through its ATX headings (and explicit id attributes).
 * Repeated slugs get -1, -2, ... like GitHub's slugger: every slug handed out is
 * reserved, so a later heading cannot reuse a suffixed slug an earlier one produced.
 */
export function headingAnchors(text) {
  const occurrences = new Map();
  const anchors = new Set();
  for (const { code, text: line, heading } of scanBlocks(text)) {
    if (code) continue;
    if (heading !== undefined) {
      const original = slugify(heading);
      let slug = original;
      while (occurrences.has(slug)) {
        occurrences.set(original, occurrences.get(original) + 1);
        slug = `${original}-${occurrences.get(original)}`;
      }
      occurrences.set(slug, 0);
      anchors.add(slug);
    }
    for (const id of blankInlineCode(line).matchAll(/\bid="([^"]+)"/g)) anchors.add(id[1]);
  }
  return anchors;
}

/** [{ target, line }] for inline links, images, and reference definitions outside code. */
export function extractLinks(text) {
  const links = [];
  scanBlocks(text).forEach(({ code, text: raw }, index) => {
    if (code) return;
    const line = blankInlineCode(raw);
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
