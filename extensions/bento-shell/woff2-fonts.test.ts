import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { swapFontsForWoff2, ttfToWoff2 } from './woff2-fonts';

/** A minimal sfnt: the given tables, 4-byte padded, behind a sorted directory. */
function buildSfnt(tables: Record<string, Buffer>): Buffer {
  const tags = Object.keys(tables).sort();
  const header = Buffer.alloc(12 + 16 * tags.length);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(tags.length, 4);
  const parts: Buffer[] = [header];
  let offset = header.length;
  tags.forEach((tag, index) => {
    const table = tables[tag]!;
    const entry = 12 + 16 * index;
    header.write(tag, entry, 'latin1');
    header.writeUInt32BE(offset, entry + 8);
    header.writeUInt32BE(table.length, entry + 12);
    const padded = Buffer.alloc((table.length + 3) & ~3);
    table.copy(padded);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
}

// The first indexed tags of the WOFF2 spec's table; enough for these fixtures.
const INDEXED_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
];

/** Independent reader for the WOFF2 container, without any table transform support. */
function readWoff2(file: Buffer) {
  expect(file.toString('latin1', 0, 4)).toBe('wOF2');
  expect(file.readUInt32BE(8)).toBe(file.length);
  expect(file.length % 4).toBe(0);
  const numTables = file.readUInt16BE(12);
  let cursor = 48;
  const entries: { tag: string; flags: number; length: number }[] = [];
  for (let index = 0; index < numTables; index += 1) {
    const flags = file[cursor++]!;
    let tag: string;
    if ((flags & 0x3f) === 0x3f) {
      tag = file.toString('latin1', cursor, cursor + 4);
      cursor += 4;
    } else {
      tag = INDEXED_TAGS[flags & 0x3f] ?? `index${flags & 0x3f}`;
    }
    let length = 0;
    let byte: number;
    do {
      byte = file[cursor++]!;
      length = length * 128 + (byte & 0x7f);
    } while (byte & 0x80);
    entries.push({ tag, flags, length });
  }
  const compressedLength = file.readUInt32BE(20);
  const raw = brotliDecompressSync(file.subarray(cursor, cursor + compressedLength));
  let offset = 0;
  const tables = new Map<string, Buffer>();
  for (const entry of entries) {
    tables.set(entry.tag, raw.subarray(offset, offset + entry.length));
    offset += entry.length;
  }
  expect(offset).toBe(raw.length);
  return { entries, tables, sfntSize: file.readUInt32BE(16), flavor: file.readUInt32BE(4) };
}

describe('ttfToWoff2', () => {
  const tables = {
    cmap: Buffer.from('cmap table'),
    glyf: Buffer.from('glyph data that is not a multiple of four'),
    head: Buffer.alloc(54, 7),
    loca: Buffer.from('loca'),
    // Not one of the 63 indexed tags, and long enough for a two-byte length.
    ZZZZ: Buffer.alloc(300, 9),
  };
  const woff2 = ttfToWoff2(buildSfnt(tables));
  const read = readWoff2(woff2);

  it('keeps every table byte for byte', () => {
    // The directory keeps the font's own (byte-wise sorted) table order.
    expect([...read.tables.keys()]).toEqual(Object.keys(tables).sort());
    for (const [tag, table] of Object.entries(tables)) {
      expect(read.tables.get(tag)).toEqual(table);
    }
    expect(read.flavor).toBe(0x00010000);
  });

  it('marks glyf and loca as untransformed and indexes known tags', () => {
    const flags = Object.fromEntries(read.entries.map((entry) => [entry.tag, entry.flags]));
    expect(flags.glyf).toBe(10 | (3 << 6));
    expect(flags.loca).toBe(11 | (3 << 6));
    expect(flags.cmap).toBe(0);
    expect(flags.head).toBe(1);
    expect(flags.ZZZZ).toBe(63);
  });

  it('records the padded sfnt size and shrinks compressible data', () => {
    const padded = (length: number) => (length + 3) & ~3;
    expect(read.sfntSize).toBe(
      12 + 16 * 5 + Object.values(tables).reduce((sum, table) => sum + padded(table.length), 0),
    );
    expect(woff2.length).toBeLessThan(read.sfntSize);
  });

  it('rejects data that is not a single sfnt font', () => {
    expect(() => ttfToWoff2(Buffer.from('not a font at all'))).toThrow(/not a TrueType/);
    expect(() =>
      ttfToWoff2(Buffer.from('ttcf\u0000\u0001\u0000\u0000\u0000\u0000\u0000\u0002')),
    ).toThrow();
  });
});

describe('swapFontsForWoff2', () => {
  const font = buildSfnt({ head: Buffer.alloc(54), cmap: Buffer.from('cmap') });
  const ttf = (fileName: string) => ({ type: 'asset', fileName, source: font });
  const css = (source: string) => ({ type: 'asset', fileName: 'assets/style.css', source });

  /** Run the swap the way Rollup does: emitted files join the bundle. */
  const run = (
    bundle: Record<string, { type: string; fileName: string; source?: string | Uint8Array }>,
  ) => {
    const emitted: string[] = [];
    swapFontsForWoff2(bundle, (fileName, source) => {
      emitted.push(fileName);
      bundle[fileName] = { type: 'asset', fileName, source };
    });
    return emitted;
  };

  it('swaps each font asset for a WOFF2 file and rewrites the stylesheet', () => {
    const bundle = {
      'assets/Inter_wght_.ttf': ttf('assets/Inter_wght_.ttf'),
      'assets/style.css': css(
        '@font-face{font-family:Inter;src:url(./Inter_wght_.ttf) format("truetype")}a{color:red}',
      ),
    };
    expect(run(bundle)).toEqual(['assets/Inter_wght_.woff2']);
    expect(bundle).not.toHaveProperty('assets/Inter_wght_.ttf');
    expect(bundle['assets/style.css']?.source).toBe(
      '@font-face{font-family:Inter;src:url(./Inter_wght_.woff2) format("woff2")}a{color:red}',
    );
  });

  it('fails when a stylesheet still names a TrueType file', () => {
    const bundle = {
      'assets/Inter_wght_.ttf': ttf('assets/Inter_wght_.ttf'),
      'assets/style.css': css('@font-face{src:url(./Other.ttf) format("truetype")}'),
    };
    expect(() => run(bundle)).toThrow(/still references a \.ttf/);
  });

  it('leaves builds without font assets alone', () => {
    const bundle = { 'assets/style.css': css('a{}') };
    expect(run(bundle)).toEqual([]);
    expect(bundle['assets/style.css']?.source).toBe('a{}');
  });
});
