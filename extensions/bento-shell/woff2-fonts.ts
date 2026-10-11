// Serve the bundled fonts as WOFF2. The public @muxui/react package ships TrueType files
// only (6 files, 2.7 MB), and its stylesheet points at them. After Vite has emitted those
// files this plugin converts each one to WOFF2 (about 45% of the size), renames the asset,
// and rewrites the stylesheet's @font-face source to match. Fonts stay local files in
// assets/: no remote font or stylesheet is introduced.
//
// WOFF2 is a Brotli-compressed container around the font's tables. This encoder keeps every
// table byte-for-byte (the spec's "null transform" for glyf and loca), so it needs nothing
// beyond Node's built-in Brotli; the optional glyf transform would save a few percent more.
//
// Shared by vite.config.ts and the archived rollback config
// (rollback/legacy-source/extensions/bento-shell/vite.config.ts). List it before
// panelNewtabCss, whose font check looks for the renamed file.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import type { Plugin } from 'vite';

/** Bump when the encoder's output changes, so cached files are rebuilt. */
const ENCODER_VERSION = 1;

// WOFF2 spec section 5.1: the 63 table tags that a directory entry can name with one index.
// prettier-ignore
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

const SFNT_VERSIONS = new Set([0x00010000, 0x74727565 /* 'true' */, 0x4f54544f /* 'OTTO' */]);
const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'
const WOFF2_HEADER_BYTES = 48;
const NULL_TRANSFORM = 3 << 6; // directory flag bits 6-7 for glyf and loca

/** WOFF2 UIntBase128: 7 bits per byte, most significant first. */
function uIntBase128(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) {
    bytes.unshift((rest & 0x7f) | 0x80);
  }
  return bytes;
}

const pad4 = (length: number) => (length + 3) & ~3;

/** Convert one TrueType or OpenType font file (not a collection) to WOFF2. */
export function ttfToWoff2(font: Uint8Array): Buffer {
  const source = Buffer.from(font.buffer, font.byteOffset, font.byteLength);
  if (source.length < 12 || !SFNT_VERSIONS.has(source.readUInt32BE(0))) {
    throw new Error('woff2-fonts: not a TrueType or OpenType font file');
  }
  const flavor = source.readUInt32BE(0);
  const numTables = source.readUInt16BE(4);
  if (numTables === 0 || source.length < 12 + 16 * numTables) {
    throw new Error('woff2-fonts: truncated font table directory');
  }

  const directory: number[] = [];
  const tableData: Buffer[] = [];
  let sfntSize = 12 + 16 * numTables;
  for (let index = 0; index < numTables; index += 1) {
    const entry = 12 + 16 * index;
    const tag = source.toString('latin1', entry, entry + 4);
    const offset = source.readUInt32BE(entry + 8);
    const length = source.readUInt32BE(entry + 12);
    if (offset + length > source.length)
      throw new Error(`woff2-fonts: table '${tag}' is truncated`);

    const known = KNOWN_TAGS.indexOf(tag);
    const transform = tag === 'glyf' || tag === 'loca' ? NULL_TRANSFORM : 0;
    directory.push((known < 0 ? 63 : known) | transform);
    if (known < 0) directory.push(...Buffer.from(tag, 'latin1'));
    directory.push(...uIntBase128(length));
    tableData.push(source.subarray(offset, offset + length));
    sfntSize += pad4(length);
  }

  const raw = Buffer.concat(tableData);
  const compressed = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: 22,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });

  const length = pad4(WOFF2_HEADER_BYTES + directory.length + compressed.length);
  const header = Buffer.alloc(WOFF2_HEADER_BYTES);
  header.writeUInt32BE(WOFF2_SIGNATURE, 0);
  header.writeUInt32BE(flavor, 4);
  header.writeUInt32BE(length, 8);
  header.writeUInt16BE(numTables, 12);
  // Offset 14 is reserved. The metadata and private-data fields (28-47) stay zero.
  header.writeUInt32BE(sfntSize, 16);
  header.writeUInt32BE(compressed.length, 20);
  header.writeUInt16BE(1, 24); // majorVersion; minorVersion stays 0
  return Buffer.concat([header, Buffer.from(directory), compressed], length);
}

/** Convert with an on-disk cache: Brotli at maximum quality takes seconds per font. */
function convertCached(font: Uint8Array, cacheDir: string): Buffer {
  const key = createHash('sha256').update(`${ENCODER_VERSION}:`).update(font).digest('hex');
  const cached = resolve(cacheDir, `${key}.woff2`);
  try {
    return readFileSync(cached);
  } catch {
    // Cache miss.
  }
  const converted = ttfToWoff2(font);
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, converted);
  } catch {
    // The cache is only a speed-up.
  }
  return converted;
}

const FONT_SOURCE = /url\((["']?)([^)"']+?)\.ttf\1\)\s*format\((["'])truetype\3\)/g;

/** The part of a Rollup output file this plugin reads and rewrites. */
interface BundleFile {
  type: string;
  fileName: string;
  source?: string | Uint8Array;
}

/**
 * Replace each .ttf asset in `bundle` with a WOFF2 file (written through `emit`) and point
 * every stylesheet's @font-face at it.
 */
export function swapFontsForWoff2(
  bundle: Record<string, BundleFile>,
  emit: (fileName: string, source: Uint8Array) => void,
  cacheDir?: string,
): void {
  const converted = new Set<string>();
  for (const [fileName, file] of Object.entries(bundle)) {
    if (file.type !== 'asset' || !fileName.endsWith('.ttf') || file.source === undefined) continue;
    const font = typeof file.source === 'string' ? Buffer.from(file.source) : file.source;
    emit(
      fileName.replace(/\.ttf$/, '.woff2'),
      cacheDir ? convertCached(font, cacheDir) : ttfToWoff2(font),
    );
    delete bundle[fileName];
    converted.add(posix.basename(fileName));
  }
  if (converted.size === 0) return;

  // @font-face is the only place Vite references these files.
  for (const file of Object.values(bundle)) {
    if (file.type !== 'asset' || !file.fileName.endsWith('.css') || file.source === undefined) {
      continue;
    }
    const css = String(file.source).replace(
      FONT_SOURCE,
      (match, quote: string, path: string, formatQuote: string) =>
        converted.has(`${posix.basename(path)}.ttf`)
          ? `url(${quote}${path}.woff2${quote}) format(${formatQuote}woff2${formatQuote})`
          : match,
    );
    if (/\.ttf\b/.test(css)) {
      throw new Error(`${file.fileName} still references a .ttf file after the WOFF2 rewrite.`);
    }
    file.source = css;
  }
}

export function woff2Fonts(): Plugin {
  const cacheDir = resolve(__dirname, 'node_modules/.cache/bento-woff2');
  return {
    name: 'bento-woff2-fonts',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      swapFontsForWoff2(
        bundle,
        (fileName, source) => void this.emitFile({ type: 'asset', fileName, source }),
        cacheDir,
      );
    },
  };
}
