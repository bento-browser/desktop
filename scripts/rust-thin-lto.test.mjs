import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchPath = path.join(
  repoRoot,
  'patches',
  'experiments',
  '02-rust-thin-lto-hosted-build.patch',
);

test('hosted ThinLTO option propagates from Firefox configure to Cargo specs', () => {
  const patch = fs.readFileSync(patchPath, 'utf8');

  // This exported-patch invariant is the lightweight fallback for a full
  // configure run: it catches a mozconfig-only opt-in that Cargo cannot see.
  assert.match(patch, /diff --git a\/browser\/moz\.configure b\/browser\/moz\.configure/);
  assert.match(patch, /\+ {4}env="BENTO_RUST_LTO",/);
  assert.match(patch, /\+ {4}choices=\("thin",\),/);
  assert.match(patch, /\+set_config\("BENTO_RUST_LTO", depends_if\("BENTO_RUST_LTO"\)/);

  assert.match(
    patch,
    /diff --git a\/python\/mozbuild\/mozbuild\/rust_commands\.py b\/python\/mozbuild\/mozbuild\/rust_commands\.py/,
  );
  // Firefox 159 serializes only declared Cargo config keys and composes final-crate
  // LTO flags in Python. A missing opt-in still selects Firefox's plain -Clto.
  assert.match(patch, /\+ {4}"BENTO_RUST_LTO": _as_str,/);
  assert.match(
    patch,
    /\+ {12}"-Clto=thin" if substs\.get\("BENTO_RUST_LTO"\) == "thin" else "-Clto"/,
  );
  assert.match(patch, /^- {8}flags\.append\("-Clto"\)$/m);
});
