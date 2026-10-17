import fs from 'node:fs';
import path from 'node:path';

/**
 * Paths named by the patch series, read from the `diff --git` headers of the
 * patches listed in patches/series.json.
 * - touched: every pre- and post-image path, mapped to the first patch naming it.
 * - created: files that exist after the whole series (new files, renames and
 *   copies, minus anything a later patch deletes), sorted.
 */
export function readSeriesPaths(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'patches', 'series.json'), 'utf8'));
  const touched = new Map();
  const created = new Set();
  for (const entry of manifest.series) {
    const text = fs.readFileSync(path.join(root, entry.path), 'utf8');
    // Hunk lines start with ' ', '+', '-' or '\', so a keyword at column 0 is a diff header.
    const sections = text.split(/^diff --git /m).slice(1);
    if (sections.length === 0) throw new Error(`${entry.path} contains no diff --git section`);
    for (const section of sections) {
      const firstLine = section.split('\n', 1)[0];
      const names = /^a\/(\S+) b\/(\S+)\s*$/.exec(firstLine);
      if (!names)
        throw new Error(`${entry.path} has an unsupported header: diff --git ${firstLine}`);
      const [, from, to] = names;
      for (const file of [from, to]) if (!touched.has(file)) touched.set(file, entry.path);
      if (/^(?:deleted file mode|rename from) /m.test(section)) created.delete(from);
      if (/^(?:new file mode|rename to|copy to) /m.test(section)) created.add(to);
    }
  }
  return { touched, created: [...created].sort() };
}
