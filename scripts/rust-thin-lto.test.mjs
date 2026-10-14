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

test('hosted ThinLTO option propagates from Firefox configure to rust.mk', () => {
  const patch = fs.readFileSync(patchPath, 'utf8');

  // This exported-patch invariant is the lightweight fallback for a full
  // configure run: it catches a mozconfig-only opt-in that rust.mk cannot see.
  assert.match(patch, /diff --git a\/browser\/moz\.configure b\/browser\/moz\.configure/);
  assert.match(patch, /\+ {4}env="BENTO_RUST_LTO",/);
  assert.match(patch, /\+ {4}choices=\("thin",\),/);
  assert.match(patch, /\+set_config\("BENTO_RUST_LTO", depends_if\("BENTO_RUST_LTO"\)/);

  assert.match(patch, /diff --git a\/config\/makefiles\/rust\.mk b\/config\/makefiles\/rust\.mk/);
  // Firefox 158 enables Rust LTO per library (RUST_LIBRARY_LTO) with a plain -Clto,
  // which stays the fallback when the opt-in is absent.
  assert.match(
    patch,
    /\+cargo_rustc_flags \+= \$\(if \$\(filter thin,\$\(BENTO_RUST_LTO\)\),-Clto=thin,-Clto\)/,
  );
  assert.match(patch, /^-cargo_rustc_flags \+= -Clto$/m);
});
