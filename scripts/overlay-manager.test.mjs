import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Tests for the overlay manager in bento-shell-mount.js. The manager sits
// between @bento-overlays:begin and :end and reads nothing of Firefox's, so the
// test evaluates exactly that section with fake frames and a fake clock.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNT = fs.readFileSync(
  path.join(ROOT, 'src/browser/base/content/bento-shell-mount.js'),
  'utf8',
);
const BEGIN = '// @bento-overlays:begin';
const END = '// @bento-overlays:end';

// The section runs in its own realm, so its arrays and objects have foreign
// prototypes; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadSection() {
  const begin = MOUNT.indexOf(BEGIN);
  const end = MOUNT.indexOf(END);
  assert.ok(begin !== -1 && end > begin, 'the mount must contain one @bento-overlays section');
  assert.equal(MOUNT.indexOf(BEGIN, begin + 1), -1, 'more than one @bento-overlays section');
  const section = MOUNT.slice(begin + BEGIN.length, end);
  return vm.runInNewContext(
    `(() => {\n${section}\nreturn { createOverlayManager, OVERLAY_READY_STALL_MS,
      OVERLAY_PREWARM_IDLE_TIMEOUT_MS, OVERLAY_PREWARM_READY_WAIT_MS };\n})()`,
    {},
    { filename: 'bento-shell-mount.js#overlays' },
  );
}

const {
  createOverlayManager,
  OVERLAY_READY_STALL_MS,
  OVERLAY_PREWARM_IDLE_TIMEOUT_MS,
  OVERLAY_PREWARM_READY_WAIT_MS,
} = loadSection();

/**
 * A world of overlay frames: `specs` are {id, eager?, prewarm?, created?, handshake?,
 * onReady?, failNavigate?}. `created` entries get their frame from create(); the others have a
 * frame from the start, like the <browser> elements the browser-box patch declares.
 */
function makeWorld(specs) {
  let clock = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const idle = [];
  const warnings = [];
  const errors = [];
  const frames = new Map();
  const navigations = [];
  const hostsMissing = new Set();

  const entries = specs.map((spec) => {
    const frameId = `bento-${spec.id}-frame`;
    if (!spec.created) frames.set(frameId, { id: frameId });
    return {
      id: spec.id,
      frameId,
      eager: spec.eager === true,
      prewarm: spec.prewarm === true,
      handshake: spec.handshake,
      onReady: spec.onReady,
      setPresented: spec.setPresented,
      suspend: spec.suspend,
      frame: () => frames.get(frameId) ?? null,
      create: spec.created
        ? () => {
            if (hostsMissing.has(spec.id)) return null;
            const frame = { id: frameId };
            frames.set(frameId, frame);
            return frame;
          }
        : undefined,
      navigate: () => {
        navigations.push(spec.id);
        if (spec.failNavigate) throw new Error('navigation failed');
      },
    };
  });

  const manager = createOverlayManager({
    entries,
    now: () => clock,
    requestIdle: (callback, options) => idle.push({ callback, options }),
    setTimer: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { callback, due: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    error: (...args) => errors.push(args.map(String).join(' ')),
  });

  return {
    manager,
    frames,
    navigations,
    warnings,
    errors,
    idle,
    hostsMissing,
    /** Moves the clock and fires the timers that fall due. */
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due > clock || !timers.has(id)) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    /** Runs the oldest queued idle callback, like an idle period starting. */
    runIdle() {
      const next = idle.shift();
      assert.ok(next, 'an idle callback should be queued');
      next.callback();
      return next.options;
    },
    pendingTimers: () => timers.size,
    ready: (id) => manager.markFrameReady(`bento-${id}-frame`),
  };
}

test('nothing is created until an overlay is used', () => {
  const world = makeWorld([{ id: 'confirm' }, { id: 'welcome', created: true }]);
  assert.equal(world.manager.hasStarted('confirm'), false);
  assert.equal(world.manager.hasStarted('welcome'), false);
  assert.deepEqual(world.navigations, []);
  assert.equal(world.frames.has('bento-welcome-frame'), false);
  const { overlays, created } = plain(world.manager.stats());
  assert.deepEqual(created, []);
  assert.equal(overlays.welcome.state, 'absent');
});

test('open creates the frame, navigates once, and reveals only after readiness', () => {
  const world = makeWorld([{ id: 'welcome', created: true }]);
  let revealed = 0;

  assert.equal(
    world.manager.open('welcome', 'show', () => (revealed += 1)),
    true,
  );
  assert.ok(world.frames.has('bento-welcome-frame'));
  assert.deepEqual(world.navigations, ['welcome']);
  assert.equal(revealed, 0);

  world.advance(40);
  world.ready('welcome');
  assert.equal(revealed, 1);

  // A ready overlay reveals synchronously and is not navigated again.
  world.manager.open('welcome', 'show', () => (revealed += 1));
  assert.equal(revealed, 2);
  assert.deepEqual(world.navigations, ['welcome']);
});

test('a repeated open replaces the queued one instead of stacking', () => {
  const world = makeWorld([{ id: 'welcome', created: true }]);
  const calls = [];
  world.manager.open('welcome', 'show', () => calls.push('first'));
  world.manager.open('welcome', 'show', () => calls.push('second'));
  world.ready('welcome');
  assert.deepEqual(calls, ['second']);
});

test('cancel drops a queued open so a hide that arrives first wins', () => {
  const world = makeWorld([{ id: 'confirm' }]);
  let revealed = 0;
  world.manager.open('confirm', 'show', () => (revealed += 1));
  world.manager.cancel('confirm');
  world.ready('confirm');
  assert.equal(revealed, 0);
  assert.equal(world.manager.isReady('confirm'), true);
});

test('open reports a missing host and leaves the overlay retryable', () => {
  const world = makeWorld([{ id: 'edit-workspace', created: true }]);
  world.hostsMissing.add('edit-workspace');
  assert.equal(
    world.manager.open('edit-workspace', 'show', () => {}),
    false,
  );
  assert.equal(world.manager.hasStarted('edit-workspace'), false);

  world.hostsMissing.clear();
  assert.equal(
    world.manager.open('edit-workspace', 'show', () => {}),
    true,
  );
  assert.equal(world.manager.hasStarted('edit-workspace'), true);
});

test('a failed navigation is warned about and retried by the next open', () => {
  const world = makeWorld([{ id: 'confirm', failNavigate: true }]);
  world.manager.open('confirm', 'show', () => {});
  assert.equal(world.manager.hasStarted('confirm'), false);
  assert.equal(world.warnings.length, 1);
  world.manager.open('confirm', 'show', () => {});
  assert.deepEqual(world.navigations, ['confirm', 'confirm']);
  assert.deepEqual(plain(world.manager.stats().created), []);
});

test('a document that does not announce is reported once and its open stays pending', () => {
  const world = makeWorld([{ id: 'welcome', created: true }]);
  let revealed = 0;
  world.manager.open('welcome', 'show', () => (revealed += 1));

  world.advance(OVERLAY_READY_STALL_MS - 1);
  assert.equal(world.errors.length, 0);
  world.advance(1);
  assert.equal(world.errors.length, 1);
  assert.match(world.errors[0], /welcome did not announce readiness/);

  // Nothing is revealed, however long it takes, and the open still counts as open.
  world.advance(60_000);
  assert.equal(revealed, 0);
  assert.equal(world.errors.length, 1, 'one error per wait, not one per tick');
  assert.equal(world.manager.hasPendingOpen('welcome'), true);
  assert.equal(world.manager.isReady('welcome'), false);
  const stalled = plain(world.manager.stats().overlays.welcome);
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.state, 'loading');
});

test('a late announcement after the stall report runs the open once', () => {
  const world = makeWorld([{ id: 'menu' }]);
  const events = [];
  world.manager.open('menu', 'show', () => events.push('open'));
  world.advance(OVERLAY_READY_STALL_MS + 2000);
  assert.deepEqual(events, []);

  world.ready('menu');
  assert.deepEqual(events, ['open']);
  world.ready('menu');
  assert.deepEqual(events, ['open'], 'a second announcement finds nothing queued');
  const stats = world.manager.stats().overlays.menu;
  assert.equal(stats.readyBy, 'signal');
  assert.equal(stats.firstOpenWaitMs, OVERLAY_READY_STALL_MS + 2000);
});

test('a stall is not reported when the open was cancelled or the document announced', () => {
  const world = makeWorld([{ id: 'confirm' }, { id: 'menu' }]);
  world.manager.open('confirm', 'show', () => {});
  world.manager.cancel('confirm');
  world.manager.open('menu', 'show', () => {});
  world.advance(OVERLAY_READY_STALL_MS - 1);
  world.ready('menu');
  world.advance(OVERLAY_READY_STALL_MS);
  assert.deepEqual(world.errors, []);
  assert.equal(world.manager.isReady('confirm'), false, 'a stall timer never marks ready');
  assert.equal(world.pendingTimers(), 0);
});

test('a repeated open does not restart the stall clock', () => {
  const world = makeWorld([{ id: 'welcome', created: true }]);
  world.manager.open('welcome', 'show', () => {});
  world.advance(OVERLAY_READY_STALL_MS - 1000);
  world.manager.open('welcome', 'show', () => {});
  world.advance(1000);
  assert.equal(world.errors.length, 1);
});

test('an overlay without a handshake is ready as soon as it exists', () => {
  const world = makeWorld([{ id: 'embedded-import', created: true, handshake: false }]);
  let revealed = 0;
  world.manager.open('embedded-import', 'show', () => (revealed += 1));
  assert.equal(revealed, 1);
  assert.equal(world.manager.stats().overlays['embedded-import'].readyBy, 'no-handshake');
});

test('onReady runs for every announcement', () => {
  let announced = 0;
  const world = makeWorld([
    { id: 'panel-navigator-tooltip', created: true, onReady: () => (announced += 1) },
  ]);
  world.manager.ensure('panel-navigator-tooltip', 'hover');
  world.ready('panel-navigator-tooltip');
  world.ready('panel-navigator-tooltip');
  assert.equal(announced, 2);
});

test('a callback that throws does not stop the others waiting on other overlays', () => {
  const world = makeWorld([{ id: 'confirm' }, { id: 'menu' }]);
  const calls = [];
  world.manager.open('confirm', 'show', () => {
    throw new Error('boom');
  });
  world.manager.open('menu', 'show', () => calls.push('menu'));
  world.ready('confirm');
  world.ready('menu');
  assert.deepEqual(calls, ['menu']);
  assert.equal(world.warnings.length, 1);
});

test('reset holds opens until a reloaded document announces again', () => {
  const world = makeWorld([{ id: 'menu' }]);
  world.manager.ensure('menu', 'show');
  world.ready('menu');
  world.manager.reset('menu');
  assert.equal(world.manager.isReady('menu'), false);

  const sent = [];
  world.manager.open('menu', 'show', () => sent.push('open'));
  assert.deepEqual(sent, []);
  world.ready('menu');
  assert.deepEqual(sent, ['open']);
});

test('idForFrame maps frames to overlays and ignores the rest', () => {
  const world = makeWorld([{ id: 'menu' }]);
  assert.equal(world.manager.idForFrame('bento-menu-frame'), 'menu');
  assert.equal(world.manager.idForFrame('bento-shell-frame'), null);
  world.manager.markFrameReady('bento-shell-frame');
  assert.equal(world.manager.isReady('menu'), false);
});

test('prewarm waits for the veil, then warms one overlay per idle period in order', () => {
  const world = makeWorld([
    { id: 'addrbar', prewarm: true, created: true },
    { id: 'palette', prewarm: true },
    { id: 'confirm' },
    { id: 'menu', prewarm: true },
  ]);
  assert.equal(world.idle.length, 0, 'nothing is scheduled before the veil lifts');

  world.advance(500);
  world.manager.onVeilLifted();
  world.manager.onVeilLifted();
  assert.equal(world.idle.length, 1, 'the veil lift is handled once');

  const options = world.runIdle();
  assert.deepEqual(plain(options), { timeout: OVERLAY_PREWARM_IDLE_TIMEOUT_MS });
  assert.deepEqual(world.navigations, ['addrbar']);
  assert.equal(world.idle.length, 0, 'the next one waits for the first to announce');

  world.advance(120);
  world.ready('addrbar');
  world.runIdle();
  assert.deepEqual(world.navigations, ['addrbar', 'palette']);

  world.ready('palette');
  world.runIdle();
  assert.deepEqual(world.navigations, ['addrbar', 'palette', 'menu']);
  assert.equal(world.manager.hasStarted('confirm'), false, 'on-demand overlays stay absent');

  const { created, overlays, veilLiftedMs } = plain(world.manager.stats());
  assert.deepEqual(created, ['addrbar', 'palette', 'menu']);
  assert.equal(veilLiftedMs, 1500);
  assert.equal(overlays.addrbar.reason, 'idle');
  assert.equal(overlays.addrbar.strategy, 'idle');
  assert.equal(overlays.confirm.strategy, 'demand');
  assert.equal(overlays.addrbar.createdSinceVeilMs, 0);
  assert.equal(overlays.addrbar.loadMs, 120);
  assert.equal(overlays.addrbar.readySinceVeilMs, 120);
});

test('prewarm moves on after a timeout when a document does not announce', () => {
  const world = makeWorld([
    { id: 'addrbar', prewarm: true },
    { id: 'palette', prewarm: true },
  ]);
  world.manager.onVeilLifted();
  world.runIdle();
  assert.equal(world.idle.length, 0);

  world.advance(OVERLAY_PREWARM_READY_WAIT_MS);
  assert.equal(world.idle.length, 1);
  // The timeout only continues the queue; it does not claim the document is ready.
  assert.equal(world.manager.isReady('addrbar'), false);
  world.runIdle();
  assert.deepEqual(world.navigations, ['addrbar', 'palette']);
});

test('prewarm skips an overlay that was already opened on demand', () => {
  const world = makeWorld([
    { id: 'addrbar', prewarm: true },
    { id: 'palette', prewarm: true },
  ]);
  world.manager.open('addrbar', 'show', () => {});
  world.manager.onVeilLifted();
  world.runIdle(); // addrbar is already open: skipped
  assert.deepEqual(world.navigations, ['addrbar']);
  world.runIdle();
  assert.deepEqual(world.navigations, ['addrbar', 'palette']);
  assert.equal(world.manager.stats().overlays.addrbar.reason, 'show');
});

test('opens record how long they waited', () => {
  const world = makeWorld([{ id: 'welcome', created: true }]);
  world.manager.open('welcome', 'show', () => {});
  world.advance(300);
  world.ready('welcome');
  world.manager.open('welcome', 'show', () => {});

  const stats = world.manager.stats().overlays.welcome;
  assert.equal(stats.opens, 2);
  assert.equal(stats.firstOpenWaitMs, 300);
  assert.equal(stats.maxOpenWaitMs, 300);
});

test('a disposed manager creates nothing and runs no queued work', () => {
  const world = makeWorld([{ id: 'addrbar', prewarm: true }, { id: 'confirm' }]);
  let revealed = 0;
  world.manager.open('confirm', 'show', () => (revealed += 1));
  world.manager.onVeilLifted();
  world.manager.dispose();

  world.ready('confirm');
  assert.equal(revealed, 0);
  world.runIdle();
  assert.equal(world.manager.hasStarted('addrbar'), false);
  assert.equal(world.manager.ensure('addrbar', 'show'), null);
});

test('hasPendingOpen is true while an open waits and false once it ran or was cancelled', () => {
  const world = makeWorld([{ id: 'palette' }, { id: 'confirm' }]);
  assert.equal(world.manager.hasPendingOpen('palette'), false);

  world.manager.open('palette', 'show', () => {});
  assert.equal(world.manager.hasPendingOpen('palette'), true);
  world.ready('palette');
  assert.equal(world.manager.hasPendingOpen('palette'), false);

  world.manager.open('confirm', 'show', () => {});
  assert.equal(world.manager.hasPendingOpen('confirm'), true);
  world.manager.cancel('confirm');
  assert.equal(world.manager.hasPendingOpen('confirm'), false);
  assert.equal(world.manager.hasPendingOpen('unknown'), false);
});

test('cancel drops a queued open so a late announcement runs nothing', () => {
  const world = makeWorld([{ id: 'menu' }]);
  const events = [];
  world.manager.open('menu', 'show', () => events.push('open'));
  world.advance(OVERLAY_READY_STALL_MS + 1);
  world.manager.cancel('menu');
  world.ready('menu');
  assert.deepEqual(events, []);
  assert.equal(world.manager.hasPendingOpen('menu'), false);
});

test('the newest open is the one that runs', () => {
  const world = makeWorld([{ id: 'merge-palette' }]);
  const sent = [];
  world.manager.open('merge-palette', 'show', () => sent.push('first'));
  world.manager.open('merge-palette', 'show', () => sent.push('second'));
  world.ready('merge-palette');
  assert.deepEqual(sent, ['second']);
});

test('startEager creates only the eager overlays, at once, and never again', () => {
  const world = makeWorld([
    { id: 'confirm', eager: true },
    { id: 'edit-workspace', eager: true, created: true },
    { id: 'addrbar', prewarm: true },
    { id: 'welcome', created: true },
  ]);
  world.manager.startEager();
  world.manager.startEager();

  assert.deepEqual(world.navigations, ['confirm', 'edit-workspace']);
  const { created, overlays } = plain(world.manager.stats());
  assert.deepEqual(created, ['confirm', 'edit-workspace']);
  assert.equal(overlays.confirm.reason, 'startup');
  assert.equal(overlays.confirm.strategy, 'eager');
  assert.equal(overlays.addrbar.state, 'absent');
  assert.equal(overlays.welcome.strategy, 'demand');
});

test('an open of an eager overlay still waits for its announcement', () => {
  const world = makeWorld([{ id: 'confirm', eager: true }]);
  world.manager.startEager();
  const events = [];
  world.manager.open('confirm', 'show', () => events.push('open'));
  assert.deepEqual(events, []);
  assert.deepEqual(world.navigations, ['confirm'], 'no second navigation');
  world.ready('confirm');
  assert.deepEqual(events, ['open']);
});

test('stats report a waiting open', () => {
  const world = makeWorld([{ id: 'menu' }]);
  world.manager.open('menu', 'show', () => {});
  const waiting = plain(world.manager.stats().overlays.menu);
  assert.equal(waiting.pendingOpen, true);
  assert.equal(waiting.stalled, false);

  world.ready('menu');
  const done = plain(world.manager.stats().overlays.menu);
  assert.equal(done.pendingOpen, false);
  assert.equal(done.readyBy, 'signal');
});

// Drift guards between the manager's table, the title table and the shell.

test('every lazily created overlay frame has a title handler, and the reverse', () => {
  const tableIds = [...MOUNT.matchAll(/overlayEntry\(\{\s*id: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(tableIds.length > 0);
  assert.equal(new Set(tableIds).size, tableIds.length, 'overlay ids must be unique');

  const titleTable = MOUNT.slice(MOUNT.indexOf('const titleHandlerByFrameId = new Map(['));
  const titleBlock = titleTable.slice(
    0,
    titleTable.indexOf(']);\n    const lastSeenTitleByFrameId'),
  );
  const titleFrames = [...titleBlock.matchAll(/'bento-([a-z-]+)-frame'/g)].map((m) => m[1]);
  const eager = new Set(['shell', 'panel-trailer']);
  assert.deepEqual(
    [...new Set(titleFrames.filter((id) => !eager.has(id)))].sort(),
    [...tableIds].sort(),
  );
});

test('each overlay row points at a host or a patch-declared frame that exists', () => {
  const patch = fs.readFileSync(
    path.join(ROOT, 'patches/chrome-layout/01-bento-shell-mount.patch'),
    'utf8',
  );
  const rows = [...MOUNT.matchAll(/overlayEntry\(\{\s*id: '([a-z-]+)',([\s\S]*?)\}\)/g)].map(
    (match) => ({ id: match[1], created: /created: true/.test(match[2]) }),
  );
  assert.ok(rows.length > 0);
  for (const { id, created } of rows) {
    if (created) {
      // The mount creates the host at startup and the frame lazily inside it.
      assert.ok(
        MOUNT.includes(`hostId: 'bento-${id}-host'`),
        `${id}: no ensureOverlayHost call for its host`,
      );
    } else {
      // The browser-box patch declares the frame; the mount only navigates it.
      assert.ok(
        patch.includes(`<browser id="bento-${id}-frame"`),
        `${id}: not declared in the patch`,
      );
    }
  }
});

test('the shell announces readiness under the names the mount registers', () => {
  const tableIds = [...MOUNT.matchAll(/overlayEntry\(\{\s*id: '([a-z-]+)'/g)].map((m) => m[1]);
  const source = fs.readFileSync(
    path.join(ROOT, 'extensions/bento-shell/src/bridge/overlayReady.ts'),
    'utf8',
  );
  const union = source.slice(
    source.indexOf('export type OverlayName'),
    source.indexOf(';', source.indexOf('export type OverlayName')),
  );
  const shellNames = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  // The embedded import page is a chrome:// document with no shell side.
  assert.deepEqual(shellNames.sort(), tableIds.filter((id) => id !== 'embedded-import').sort());
});

test('the mount reads the readiness title the shell writes', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'extensions/bento-shell/src/bridge/overlayReady.ts'),
    'utf8',
  );
  const shellPrefix = /OVERLAY_READY_PREFIX = '([A-Z_]+)'/.exec(source)?.[1];
  const mountPrefix = /const OVERLAY_READY_PREFIX = '([A-Z_]+)'/.exec(MOUNT)?.[1];
  assert.ok(shellPrefix);
  assert.equal(mountPrefix, shellPrefix);
});

test('the table lists the strategies the docs promise', () => {
  const rows = [...MOUNT.matchAll(/overlayEntry\(\{\s*id: '([a-z-]+)',([\s\S]*?)\}\)/g)].map(
    (match) => ({
      id: match[1],
      eager: /eager: true/.test(match[2]),
      prewarm: /prewarm: true/.test(match[2]),
    }),
  );
  assert.deepEqual(
    rows.filter((row) => row.eager).map((row) => row.id),
    ['confirm', 'edit-workspace', 'workspace-switcher'],
  );
  // Prewarm order is table order.
  assert.deepEqual(
    rows.filter((row) => row.prewarm).map((row) => row.id),
    ['addrbar', 'palette', 'menu'],
  );
  assert.ok(rows.every((row) => !(row.eager && row.prewarm)));
});

test('presentation acknowledgement gates reveal and cancellation invalidates a stale show', async () => {
  const queries = [];
  const world = makeWorld([{ id: 'palette', setPresented: (presented, generation) =>
    new Promise((resolve) => queries.push({ presented, generation, resolve })) }]);
  let revealed = 0;
  world.manager.open('palette', 'show', () => revealed++);
  assert.equal(queries.length, 0, 'readiness comes before presentation');
  world.ready('palette');
  assert.equal(queries.length, 1);
  assert.equal(world.manager.hasPendingOpen('palette'), true);
  assert.equal(revealed, 0);
  world.manager.cancel('palette');
  world.manager.setPresented('palette', false);
  queries[0].resolve(true);
  await Promise.resolve();
  assert.equal(revealed, 0);
  world.manager.open('palette', 'show', () => revealed++);
  assert.ok(queries[2].generation > queries[1].generation);
  queries[2].resolve(true);
  await Promise.resolve();
  assert.equal(revealed, 1);
  queries[1].resolve(true);
  await Promise.resolve();
  assert.equal(revealed, 1, 'an old hide acknowledgement cannot reveal or hide the new open');
});

test('navigation invalidates old acknowledgements and replays the current open after readiness', async () => {
  const queries = [];
  let suspended = 0;
  let revealed = 0;
  const world = makeWorld([{ id: 'palette', suspend: () => suspended++,
    setPresented: (presented, generation) => new Promise((resolve) => queries.push({ presented, generation, resolve })) }]);
  world.manager.open('palette', 'show', () => revealed++);
  world.ready('palette');
  world.manager.reset('palette');
  queries[0].resolve(true);
  await Promise.resolve();
  assert.equal(revealed, 0);
  world.ready('palette');
  queries[1].resolve(true);
  await Promise.resolve();
  assert.equal(revealed, 1);
  world.manager.reset('palette');
  assert.equal(suspended, 2);
  world.ready('palette');
  queries[2].resolve(true);
  await Promise.resolve();
  assert.equal(revealed, 2, 'a shown overlay is presented again only after its new document acks');
});

test('window startup loads the shell and the eager overlays, not the others', () => {
  const startup = MOUNT.slice(MOUNT.lastIndexOf('setBentoShellSrc();'));
  assert.ok(startup.includes('overlays.startEager();'));
  for (const name of [
    'Palette',
    'WorkspacePalette',
    'MergePalette',
    'SettingsPalette',
    'Addrbar',
    'Confirm',
    'EditWorkspace',
    'Welcome',
    'WorkspaceSwitcher',
    'Menu',
    'PanelNavigatorTooltip',
  ]) {
    assert.ok(
      !startup.includes(`setBento${name}Src();`),
      `startup must not call setBento${name}Src`,
    );
  }
});
