#!/usr/bin/env node

/**
 * Local Mux UI development loops (docs/build-tooling.md, "Local Mux UI").
 *
 *   node scripts/muxui-dev.mjs ladle    Ladle against local Mux
 *   node scripts/muxui-dev.mjs dev      shell Vite dev server against local Mux
 *   node scripts/muxui-dev.mjs import   one-shot: generate Mux, type-check, build the
 *                                       shell, and run `pnpm run import`
 *
 * MUXUI_LOCAL defaults to ~/Projects/muxui/packages/react, so every Bento checkout
 * and worktree uses the same Mux checkout. It is
 * set only for the child processes started here, and release builds are refused.
 * The ladle and dev loops regenerate Mux whenever a file Mux generate reads changes.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  muxLocalRoot,
  muxLocalTsconfig,
  resolveMuxLocal,
} from '../extensions/bento-shell/muxui-local.mjs';
import { createRegenerator } from './muxui-regenerator.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const shellDir = path.join(repoRoot, 'extensions', 'bento-shell');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const log = (message) => console.log(`[mux] ${message}`);

/**
 * Owns everything this process started. `close()` is the one cleanup path for
 * signals, spawn errors, and server exit: it runs the registered cleanups
 * (regenerator, watchers), then signals every child, including an active
 * generate. The first caller's exit code wins.
 */
function createSession() {
  const children = new Set();
  const cleanups = [];
  let exitCode;
  const kill = (signal) => children.forEach((child) => child.kill(signal));
  process.once('exit', () => kill('SIGTERM'));
  return {
    get exitCode() {
      return exitCode;
    },
    get closing() {
      return exitCode !== undefined;
    },
    track(child) {
      children.add(child);
      child.once('exit', () => children.delete(child));
      return child;
    },
    onClose(cleanup) {
      cleanups.push(cleanup);
    },
    close(code, signal = 'SIGTERM') {
      if (exitCode !== undefined) return;
      exitCode = code;
      cleanups.splice(0).forEach((cleanup) => cleanup());
      kill(signal);
    },
    kill,
  };
}

const session = createSession();

function run(command, args, { cwd = repoRoot, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = session.track(
      spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' }),
    );
    child.on('error', (error) => {
      console.error(`[mux] cannot start ${command}: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Mux generate for Bento: the schema projection that package generate imports,
 * then packages/react. Mux's `generate` script also writes an advisory status
 * file that is not part of `generated/` and that Bento does not read.
 */
async function generateMux(muxRoot, reason) {
  const muxRepo = path.resolve(muxRoot, '..', '..');
  const started = performance.now();
  if (session.closing) return false;
  log(`generate: start${reason ? ` (${reason})` : ''}`);
  for (const packageDir of [path.join(muxRepo, 'packages', 'schema'), muxRoot]) {
    const code = await run(process.execPath, [path.join('src', 'generate.mjs')], {
      cwd: packageDir,
    });
    if (session.closing) {
      log('generate: cancelled');
      return false;
    }
    if (code !== 0) {
      log(
        `generate: failed (exit ${code}) in ${((performance.now() - started) / 1000).toFixed(1)}s`,
      );
      return false;
    }
  }
  log(`generate: finished in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return true;
}

/**
 * Everything Mux generate reads, as [directory, recursive, file filter].
 * Found by tracing the schema and react generate runs; generated/ is excluded.
 */
function muxGenerateInputs(muxRoot) {
  const muxRepo = path.resolve(muxRoot, '..', '..');
  const at = (...segments) => path.join(muxRepo, ...segments);
  const artifact = (file) => path.basename(file) === 'artifact.json';
  return [
    [path.join(muxRoot, 'src'), true],
    [muxRoot, false, (file) => file === 'package.json'],
    [at('packages', 'tokens', 'src'), true],
    [at('packages', 'schema', 'src'), true],
    [at('packages', 'schema', 'schemas'), true],
    [at('strategy'), false, (file) => file === 'platform-safety-contract.json'],
    [
      at('tooling', 'audits', 'repository-policy'),
      true,
      (file) => /policy\.(mjs|json)$/.test(file),
    ],
    [at('catalog', 'tokens'), true],
    [at('catalog', 'react-r1-0'), true],
    [at('catalog', 'react-r1-5'), true],
    [at('catalog', 'react-r1-6'), true],
    [at('catalog', 'components'), true, artifact],
  ];
}

function watchMuxInputs(muxRoot, onChange) {
  const watchers = [];
  for (const [dir, recursive, accept = () => true] of muxGenerateInputs(muxRoot)) {
    if (!fs.existsSync(dir)) {
      log(`not watching ${dir}: missing`);
      continue;
    }
    const watcher = fs.watch(dir, { recursive }, (_event, file) => {
      const name = file ? String(file) : '';
      if (name && !name.startsWith('.') && !name.endsWith('~') && accept(name)) {
        onChange(path.relative(path.dirname(path.dirname(muxRoot)), path.join(dir, name)));
      }
    });
    watcher.on('error', (error) => log(`watcher error on ${dir}: ${error.message}`));
    watchers.push(watcher);
  }
  return () => watchers.forEach((watcher) => watcher.close());
}

/** Generate Mux, then run a shell package script while watching Mux inputs. */
async function serve(env, scriptName) {
  const muxRoot = muxLocalRoot(env);
  if (!(await generateMux(muxRoot))) return 1;
  resolveMuxLocal(env);
  if (session.closing) return 1;

  const regenerator = createRegenerator((reason) => generateMux(muxRoot, reason));
  session.onClose(() => regenerator.close());
  session.onClose(watchMuxInputs(muxRoot, (file) => regenerator.trigger(file)));
  const child = session.track(
    spawn(pnpm, ['--filter', '@bento/shell', 'run', scriptName], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    }),
  );
  return new Promise((resolve) => {
    child.on('error', (error) => {
      console.error(`[mux] cannot start ${pnpm}: ${error.message}`);
      session.close(1);
      resolve(1);
    });
    child.on('exit', (code) => {
      session.close(code ?? 1);
      resolve(session.exitCode);
    });
  });
}

/** One-shot loop for real Bento; mirrors the shell `build` script after tsc. */
async function importIntoBento(env) {
  const muxRoot = muxLocalRoot(env);
  if (!(await generateMux(muxRoot))) return 1;
  const mux = resolveMuxLocal(env);

  const tsconfig = 'tsconfig.muxui-local.json';
  fs.writeFileSync(
    path.join(shellDir, tsconfig),
    `${JSON.stringify(muxLocalTsconfig(mux), null, 2)}\n`,
  );
  // pnpm import must not see MUXUI_LOCAL: it only copies the built dist, and
  // the theme and token scripts it runs stay on the npm package.
  const importEnv = { ...env };
  delete importEnv.MUXUI_LOCAL;
  const steps = [
    [
      'type check against local Mux',
      ['--filter', '@bento/shell', 'exec', 'tsc', '-p', tsconfig, '--noEmit'],
      env,
    ],
    ['shell vite build', ['--filter', '@bento/shell', 'exec', 'vite', 'build'], env],
    ['shell background build', ['--filter', '@bento/shell', 'run', 'build:background'], env],
    ['pnpm run import', ['run', 'import'], importEnv],
  ];
  for (const [name, args, stepEnv] of steps) {
    if (session.closing) return 1;
    log(`${name}`);
    const code = await run(pnpm, args, { env: stepEnv });
    if (code !== 0) {
      log(`${name}: failed (exit ${code})`);
      return code;
    }
  }
  log(
    'Imported. Press Alt+Shift+R in Bento to reload the shell. Quit and relaunch if background.ts changed.',
  );
  return 0;
}

const commands = {
  ladle: (env) => serve(env, 'ladle:serve'),
  dev: (env) => serve(env, 'dev'),
  import: importIntoBento,
};

const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error(`Usage: node scripts/muxui-dev.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.on(signal, () => {
    if (!session.closing) return session.close(code, signal);
    // A second signal means the server is not stopping: force it.
    session.kill('SIGKILL');
    process.exit(code);
  });
}

try {
  const env = {
    ...process.env,
    MUXUI_LOCAL:
      process.env.MUXUI_LOCAL || path.join(os.homedir(), 'Projects', 'muxui', 'packages', 'react'),
  };
  const code = await command(env);
  process.exitCode = session.exitCode ?? code;
} catch (error) {
  console.error(`[mux] ${error.message}`);
  process.exitCode = 1;
}
