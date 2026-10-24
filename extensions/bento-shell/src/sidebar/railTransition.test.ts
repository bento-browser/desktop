import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createRailTransition,
  RAIL_TRANSITION_ATTRIBUTE,
  type RailPhase,
  type RailTransitionHost,
} from './railTransition';
import { RAIL_ATTRIBUTE } from './railViewport';

/** <html> stand-in: only the attribute calls the controller makes. */
class FakeHtml {
  attributes = new Map<string, string>();
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

function setup({ rail = false, reducedMotion = false } = {}) {
  const html = new FakeHtml();
  if (rail) html.setAttribute(RAIL_ATTRIBUTE, 'true');
  // Each read is tagged with the layout it was taken in.
  const layout = () => ({ rail: html.getAttribute(RAIL_ATTRIBUTE) === 'true' });
  const waits: { phase: RailPhase; done: () => void; cancelled: boolean }[] = [];
  const applied: { phase: RailPhase; expanded: object; rail: object }[] = [];
  const host = {
    html: html as unknown as Element,
    read: vi.fn(layout),
    readAsRail: vi.fn(() => ({ rail: true, asRail: true })),
    apply: vi.fn((phase: RailPhase, expanded: object, railLayout: object) => {
      applied.push({ phase, expanded, rail: railLayout });
    }),
    clear: vi.fn(),
    flush: vi.fn(),
    wait: vi.fn((phase: RailPhase, done: () => void) => {
      const wait = { phase, done, cancelled: false };
      waits.push(wait);
      return () => {
        wait.cancelled = true;
      };
    }),
    reducedMotion: () => reducedMotion,
  } satisfies RailTransitionHost;
  const transition = createRailTransition(host);
  const phase = () => html.getAttribute(RAIL_TRANSITION_ATTRIBUTE);
  const isRail = () => html.getAttribute(RAIL_ATTRIBUTE) === 'true';
  const expanded = { collapsed: false, hidden: false };
  const collapsed = { collapsed: true, hidden: false };
  const hidden = { collapsed: true, hidden: true };
  return { transition, host, phase, isRail, waits, applied, expanded, collapsed, hidden };
}

describe('createRailTransition', () => {
  it('collapses from the setting flip and ends on the rail snap', () => {
    const t = setup();
    t.transition.setting(t.expanded);
    t.transition.viewport(false);
    t.transition.setting(t.collapsed);
    expect(t.phase()).toBe('collapse');
    expect(t.applied[0]).toMatchObject({ expanded: { rail: false }, rail: { asRail: true } });
    // Chrome is still sliding at the expanded width: nothing changes.
    t.transition.viewport(false);
    expect(t.phase()).toBe('collapse');
    expect(t.isRail()).toBe(false);
    // The snap switches to the rail in the same callback and clears the offsets.
    t.transition.viewport(true);
    expect(t.phase()).toBeNull();
    expect(t.isRail()).toBe(true);
    expect(t.host.clear).toHaveBeenCalled();
    expect(t.waits[0]!.cancelled).toBe(true);
  });

  it('settles a collapse whose snap never comes on the timer, at the viewport width', () => {
    const t = setup();
    t.transition.setting(t.expanded);
    t.transition.viewport(false);
    t.transition.setting(t.collapsed);
    t.waits[0]!.done();
    expect(t.phase()).toBeNull();
    expect(t.isRail()).toBe(false);
  });

  it('expands when the viewport widens, from the rail recorded at the flip', () => {
    const t = setup({ rail: true });
    t.transition.setting(t.collapsed);
    t.transition.viewport(true);
    t.transition.setting(t.expanded);
    // Chrome has not widened the host yet.
    expect(t.phase()).toBeNull();
    expect(t.isRail()).toBe(true);
    t.transition.viewport(false);
    expect(t.phase()).toBe('expand');
    expect(t.isRail()).toBe(false);
    expect(t.applied[0]).toMatchObject({ expanded: { rail: false }, rail: { rail: true } });
    t.waits[0]!.done();
    expect(t.phase()).toBeNull();
    expect(t.host.clear).toHaveBeenCalled();
  });

  it('runs no phase at boot, for hide and show, or under reduced motion', () => {
    const boot = setup();
    boot.transition.setting(boot.collapsed);
    boot.transition.viewport(true);
    expect(boot.host.apply).not.toHaveBeenCalled();
    expect(boot.isRail()).toBe(true);

    const hide = setup();
    hide.transition.setting(hide.expanded);
    hide.transition.setting(hide.hidden);
    hide.transition.viewport(true);
    hide.transition.setting(hide.expanded);
    hide.transition.viewport(false);
    expect(hide.host.apply).not.toHaveBeenCalled();
    expect(hide.isRail()).toBe(false);

    const reduced = setup({ reducedMotion: true });
    reduced.transition.setting(reduced.expanded);
    reduced.transition.setting(reduced.collapsed);
    reduced.transition.viewport(true);
    reduced.transition.setting(reduced.expanded);
    reduced.transition.viewport(false);
    expect(reduced.host.apply).not.toHaveBeenCalled();
    expect(reduced.phase()).toBeNull();
  });

  it('expands at once from the collapse it interrupts, with no resize', () => {
    const t = setup();
    t.transition.setting(t.expanded);
    t.transition.viewport(false);
    t.transition.setting(t.collapsed);
    const collapseRail = t.applied[0]!.rail;
    t.transition.setting(t.expanded);
    expect(t.phase()).toBe('expand');
    expect(t.applied[1]!.rail).toBe(collapseRail);
    expect(t.waits[0]!.cancelled).toBe(true);
    // The viewport stayed wide throughout.
    t.transition.viewport(false);
    expect(t.phase()).toBe('expand');
  });

  it('collapses from the end state of the expand it interrupts', () => {
    const t = setup({ rail: true });
    t.transition.setting(t.collapsed);
    t.transition.setting(t.expanded);
    t.transition.viewport(false);
    expect(t.phase()).toBe('expand');
    t.transition.setting(t.collapsed);
    expect(t.phase()).toBe('collapse');
    expect(t.waits[0]!.cancelled).toBe(true);
    expect(t.applied[1]).toMatchObject({ phase: 'collapse', expanded: { rail: false } });
    t.transition.viewport(true);
    expect(t.phase()).toBeNull();
    expect(t.isRail()).toBe(true);
  });

  it('clears the offsets with transitions held off until the settled style is flushed', () => {
    const t = setup();
    const seen: (string | null)[] = [];
    t.host.flush.mockImplementation(() => seen.push(t.phase()));
    t.transition.setting(t.expanded);
    t.transition.viewport(false);
    t.transition.setting(t.collapsed);
    t.transition.viewport(true);
    expect(seen).toEqual(['measure']);
    expect(t.host.clear).toHaveBeenCalledTimes(1);
    expect(t.phase()).toBeNull();
  });
});

describe('footer backdrop colour', () => {
  // A pseudo-element made at the phase start that inherits a transitioning background-color
  // stays at its creation-time colour in real-time playback, so the backdrop paints a
  // registered inherited property that the footer fades instead.
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

  it('fades the footer fill the backdrop paints, not an inherited background-color', () => {
    const rail = read('./railTransition.css');
    const app = read('../app.css');
    expect(app).toMatch(/@property\s+--bento-footer-fill\s*\{[^}]*inherits:\s*true/);
    expect(rail).toMatch(/\.bento-shell-app__footer\s*\{\s*transition:\s*--bento-footer-fill\b/);
    const backdrop = /\.bento-shell-app__footer::before\s*\{([^}]*height:[^}]*)\}/.exec(rail);
    expect(backdrop?.[1]).toMatch(/background-color:\s*var\(--bento-footer-fill\)/);
    expect(backdrop?.[1]).not.toMatch(/background-color:\s*inherit/);
  });
});
