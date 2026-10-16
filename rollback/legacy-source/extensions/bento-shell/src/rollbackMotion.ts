// Archive-local motion timing for the archived shell; the archived chrome mount
// script carries its own copy. JS cleanup that follows a CSS transition waits on
// the resolved timing instead of mirroring a number, so a Mux motion role change
// needs no edit here.

const CEILING_MS = 1200;
const SLACK_MS = 50;

// One pending wait per element: a new call replaces the previous one.
const pending = new WeakMap<HTMLElement, () => void>();

function cssTimeMs(value: string | undefined): number {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(value ?? '');
  if (!match) return 0;
  return parseFloat(match[1] ?? '0') * (match[2] === 's' ? 1000 : 1);
}

function cssList(style: CSSStyleDeclaration, name: string): string[] {
  return style
    .getPropertyValue(name)
    .split(',')
    .map((item) => item.trim());
}

/**
 * Longest matching transition and the properties that finish last, or null when
 * the element has no computed style (detached). A short duration or delay list
 * repeats to the property count, like CSS does.
 */
function measureTransition(
  el: HTMLElement,
  properties: readonly string[],
): { ms: number; ends: Set<string> } | null {
  const style = el.isConnected ? el.ownerDocument.defaultView?.getComputedStyle(el) : null;
  if (!style) return null;
  const durations = cssList(style, 'transition-duration');
  const delays = cssList(style, 'transition-delay');
  let ms = 0;
  const ends = new Set<string>();
  cssList(style, 'transition-property')
    .filter(Boolean)
    .forEach((name, i) => {
      if (name !== 'all' && !properties.includes(name)) return;
      const total = Math.max(
        0,
        cssTimeMs(durations[i % durations.length]) + cssTimeMs(delays[i % delays.length]),
      );
      if (total > ms) {
        ms = total;
        ends.clear();
      }
      if (total === ms) ends.add(name);
    });
  return { ms, ends };
}

/**
 * Runs `done` once el's transitions on `properties` end, at the matching
 * transitionend with a timer at the measured time as the fallback, and returns
 * its cancel function. Call it after the styles that start the transition are
 * applied: measuring reads computed style. Nothing animating runs `done` on the
 * next task; a detached element has no computed style, so a ceiling timer decides.
 */
export function afterTransition(
  el: HTMLElement,
  properties: readonly string[],
  done: () => void,
): () => void {
  pending.get(el)?.();
  let settled = false;
  let timer = 0;
  let removeListener: (() => void) | undefined;
  const cancel = () => {
    settled = true;
    window.clearTimeout(timer);
    removeListener?.();
    if (pending.get(el) === cancel) pending.delete(el);
  };
  const finish = () => {
    if (settled) return;
    cancel();
    done();
  };
  pending.set(el, cancel);

  const timing = measureTransition(el, properties);
  if (!timing) {
    timer = window.setTimeout(finish, CEILING_MS);
  } else if (timing.ms <= 0) {
    timer = window.setTimeout(finish, 0);
  } else {
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el) return;
      if (timing.ends.has('all') || timing.ends.has(event.propertyName)) finish();
    };
    el.addEventListener('transitionend', onEnd);
    removeListener = () => el.removeEventListener('transitionend', onEnd);
    timer = window.setTimeout(finish, timing.ms + SLACK_MS);
  }
  return cancel;
}
