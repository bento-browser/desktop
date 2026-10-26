import { RAIL_ATTRIBUTE } from './railViewport';

/**
 * The sidebar's collapse and expand choreography: while chrome slides the host and
 * counter-translates the shell frame (the document stays put and the strip's edge
 * wipes), the shell's contents move to their rail or expanded places.
 *
 * The phase is its own state, separate from the setting and from the rail visual state
 * (`data-bento-collapsed`, which follows the viewport): `data-bento-rail-transition` on
 * <html> is `collapse` or `expand` while one runs, and `measure` for the synchronous
 * reads and the settle flush around it (transitions off, no visuals; see
 * railTransition.css).
 *
 * - Collapse starts on the setting flip, which the shell learns before chrome, keeps the
 *   expanded layout and animates to the measured rail places. It ends when the viewport
 *   snaps to the rail (the end state matches the rail, so the switch is unseen), or on a
 *   timer fallback when the viewport never narrows.
 * - Expand records the rail geometry at the flip and starts when the viewport widens (in
 *   the resize-observer step, before paint): the expanded layout applies at once and
 *   every element animates from its rail place. It ends with `afterMotion`.
 * - A toggle during a phase settles it at its end state first, as chrome does. An expand
 *   during a collapse never sees a resize (chrome settles at the rail and widens in one
 *   go), so it starts at once from the rail geometry the collapse measured.
 * - Hide and show (never seen: the host leaves or enters the window), the first
 *   snapshot and reduced motion run no phase; the viewport alone switches the layout.
 */
export const RAIL_TRANSITION_ATTRIBUTE = 'data-bento-rail-transition';

export type RailPhase = 'collapse' | 'expand';

/** Moving elements' geometry in one layout; opaque to the controller. */
export type RailLayout = object;

/** Where the search square and field are when a phase is reversed; opaque to the controller. */
export type RailSeed = object;

export interface RailTransitionHost {
  /** <html>: carries the rail and phase attributes. */
  html: Element;
  /** Geometry of the current layout, or null when the shell has nothing to measure. */
  read(): RailLayout | null;
  /** Rail geometry read while the shell is expanded: one synchronous rail layout. */
  readAsRail(): RailLayout | null;
  /**
   * Where the search square and field are right now, read while the running phase still
   * animates them. A reversal passes it to the next `apply`, so those parts carry on from
   * there instead of from the phase's own start (a restart would step them).
   */
  capture?(): RailSeed | null;
  /** Writes the offsets and stagger delays for a phase (`seed`: see `capture`). */
  apply(phase: RailPhase, expanded: RailLayout, rail: RailLayout, seed?: RailSeed | null): void;
  /** Removes what `apply` wrote. */
  clear(): void;
  /** Flushes style, so a switch made with transitions off lands before they come back. */
  flush(): void;
  /** Calls `done` when the phase's motion is over (expand) or overdue (collapse). */
  wait(phase: RailPhase, done: () => void): () => void;
  reducedMotion(): boolean;
}

export interface RailSetting {
  collapsed: boolean;
  hidden: boolean;
}

export interface RailTransition {
  /** The settings mirror holds `setting` (the first call is the boot snapshot). */
  setting(setting: RailSetting): void;
  /** The viewport is (`true`) or is not the rail width; observeRailViewport's callback. */
  viewport(isRail: boolean): void;
  dispose(): void;
}

interface Running {
  phase: RailPhase;
  expanded: RailLayout;
  rail: RailLayout;
  cancelWait: () => void;
}

export function createRailTransition(host: RailTransitionHost): RailTransition {
  const { html } = host;
  let previous: RailSetting | null = null;
  let running: Running | null = null;
  // Rail geometry recorded at an expand flip, waiting for the viewport to widen.
  let pendingExpand: RailLayout | null = null;
  // Where the search parts were when a running phase was reversed, for the next `begin`.
  let seed: RailSeed | null = null;
  // The last width report; the collapse fallback settles to it.
  let viewportRail = html.getAttribute(RAIL_ATTRIBUTE) === 'true';

  const isRail = () => html.getAttribute(RAIL_ATTRIBUTE) === 'true';
  const setRail = (rail: boolean) => {
    if (rail) html.setAttribute(RAIL_ATTRIBUTE, 'true');
    else html.removeAttribute(RAIL_ATTRIBUTE);
  };

  // Ends the running phase at its end state. `rail` is the layout to settle into.
  // The rail and offset switch happens with transitions off ('measure'), flushed,
  // so no property transitions from the phase's styles to the settled ones.
  const settle = (rail: boolean) => {
    if (!running) {
      setRail(rail);
      return;
    }
    running.cancelWait();
    running = null;
    html.setAttribute(RAIL_TRANSITION_ATTRIBUTE, 'measure');
    host.clear();
    setRail(rail);
    host.flush();
    html.removeAttribute(RAIL_TRANSITION_ATTRIBUTE);
  };

  const begin = (phase: RailPhase, expanded: RailLayout, rail: RailLayout) => {
    host.apply(phase, expanded, rail, seed);
    seed = null;
    html.setAttribute(RAIL_TRANSITION_ATTRIBUTE, phase);
    const current: Running = { phase, expanded, rail, cancelWait: () => {} };
    running = current;
    current.cancelWait = host.wait(phase, () => {
      if (running !== current) return;
      settle(phase === 'collapse' ? viewportRail : false);
    });
  };

  const startCollapse = () => {
    html.setAttribute(RAIL_TRANSITION_ATTRIBUTE, 'measure');
    const expanded = host.read();
    const rail = expanded && host.readAsRail();
    if (!expanded || !rail) {
      html.removeAttribute(RAIL_TRANSITION_ATTRIBUTE);
      return;
    }
    begin('collapse', expanded, rail);
  };

  const startExpand = (rail: RailLayout) => {
    html.setAttribute(RAIL_TRANSITION_ATTRIBUTE, 'measure');
    setRail(false);
    const expanded = host.read();
    if (!expanded) {
      html.removeAttribute(RAIL_TRANSITION_ATTRIBUTE);
      return;
    }
    begin('expand', expanded, rail);
  };

  return {
    setting(next) {
      const was = previous;
      previous = next;
      if (!was) return;
      const wasCollapsed = was.collapsed || was.hidden;
      const nowCollapsed = next.collapsed || next.hidden;
      if (wasCollapsed === nowCollapsed) return;
      pendingExpand = null;
      if (was.hidden || next.hidden || host.reducedMotion()) {
        settle(viewportRail);
        return;
      }
      if (nowCollapsed) {
        if (running) {
          seed = host.capture?.() ?? null;
          settle(false);
        }
        if (!isRail()) startCollapse();
        seed = null;
        return;
      }
      if (running?.phase === 'collapse') {
        // Chrome settles the slide at the rail and widens in one go, so no resize
        // arrives: start from the rail the collapse measured.
        const { rail } = running;
        seed = host.capture?.() ?? null;
        settle(false);
        startExpand(rail);
        seed = null;
        return;
      }
      if (isRail()) pendingExpand = host.read();
    },

    viewport(rail) {
      viewportRail = rail;
      if (running?.phase === 'collapse') {
        if (rail) settle(true);
        return;
      }
      if (running?.phase === 'expand') {
        if (!rail) return;
        // Chrome narrowed again before the expand settled (its collapse ended late):
        // show the rail and expand again from it when the viewport widens.
        settle(true);
        if (previous && !previous.collapsed && !previous.hidden) pendingExpand = host.read();
        return;
      }
      if (pendingExpand && !rail) {
        const from = pendingExpand;
        pendingExpand = null;
        startExpand(from);
        return;
      }
      setRail(rail);
    },

    dispose() {
      pendingExpand = null;
      if (running) settle(isRail());
      html.removeAttribute(RAIL_TRANSITION_ATTRIBUTE);
    },
  };
}
