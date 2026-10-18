// Timing for code that must act when CSS motion ends. CSS owns every duration
// (the Mux --muxui-semantic-motion-* tokens); this reads the time from the
// element's computed style instead of mirroring it as a number in script.
// bento-shell-mount.js carries the same contract as measureMotion and
// afterMotion; keep the two in step.

export interface MotionFilter {
  /**
   * Transition properties to count. Each takes its timing from the last
   * `transition-property` entry that names it, explicitly or through `all`.
   */
  properties?: readonly string[];
  /** Animation names to count. */
  animations?: readonly string[];
}

export interface MotionMeasure {
  /** Longest remaining run time in ms. 0 means nothing matching runs. */
  ms: number;
  /**
   * Transition (`t:<property>`) and animation (`a:<name>`) entries that end last. With a
   * property filter the transition entries are requested properties only.
   */
  ending: ReadonlySet<string>;
}

/** Added to a measured time before the timer fallback fires. */
export const MOTION_SLACK_MS = 50;
/** Fallback wait for an element with no computed style (not connected). */
export const MOTION_UNAVAILABLE_CEILING_MS = 1000;

const list = (value: string) => value.split(',').map((part) => part.trim());

/** Computed times are `<number>s` or `<number>ms`; anything else counts as 0. */
function timeMs(text: string | undefined): number {
  const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(ms|s)$/i.exec(text ?? '');
  if (!match) return 0;
  return Number(match[1]) * (match[2]!.toLowerCase() === 's' ? 1000 : 1);
}

/**
 * Longest time the transitions and animations on `el` that match `filter` take, from
 * its computed style: delay plus duration, times the iteration count for an animation.
 * Repeated duration and delay lists are expanded to the number of properties or names.
 * A requested property takes its timing from the LAST `transition-property` entry that names
 * it, explicitly or through `all` (CSS Transitions), so `all, opacity` with `0.2s, 0s`
 * measures 0 for opacity; without a property filter each entry that no later entry overrides
 * counts on its own. An infinite animation never ends and is skipped. Call it after the
 * styles that start the motion are applied. Returns null when the element has no computed
 * style, which is the case for a disconnected element; `display: none` still reports its
 * configured times.
 */
export function measureMotion(el: Element, filter: MotionFilter = {}): MotionMeasure | null {
  const view = el.ownerDocument?.defaultView;
  if (!el.isConnected || !view) return null;
  const style = view.getComputedStyle(el);
  if (!style || (style.transitionDuration === '' && style.animationDuration === '')) return null;

  let ms = 0;
  let ending = new Set<string>();
  const note = (entry: string, end: number) => {
    if (end > ms) {
      ms = end;
      ending = new Set([entry]);
    } else if (end === ms && end > 0) {
      ending.add(entry);
    }
  };

  const properties = list(style.transitionProperty);
  const durations = list(style.transitionDuration);
  const delays = list(style.transitionDelay);
  const noteTransition = (property: string, i: number) =>
    note(
      `t:${property}`,
      timeMs(durations[i % durations.length]) + timeMs(delays[i % delays.length]),
    );
  const lastEntryFor = (property: string) => {
    let last = -1;
    properties.forEach((entry, i) => {
      if (entry === 'all' || entry === property) last = i;
    });
    return last;
  };
  if (filter.properties) {
    for (const property of filter.properties) {
      const i = lastEntryFor(property);
      if (i !== -1) noteTransition(property, i);
    }
  } else {
    properties.forEach((property, i) => {
      if (property === 'none' || property === '' || lastEntryFor(property) !== i) return;
      noteTransition(property, i);
    });
  }

  const names = list(style.animationName);
  const animationDurations = list(style.animationDuration);
  const animationDelays = list(style.animationDelay);
  const counts = list(style.animationIterationCount);
  names.forEach((name, i) => {
    if (name === 'none' || name === '') return;
    if (filter.animations && !filter.animations.includes(name)) return;
    const count = counts[i % counts.length];
    if (count === 'infinite') return;
    const iterations = Number(count);
    note(
      `a:${name}`,
      timeMs(animationDelays[i % animationDelays.length]) +
        timeMs(animationDurations[i % animationDurations.length]) *
          (Number.isFinite(iterations) ? iterations : 1),
    );
  });

  return { ms, ending };
}

/**
 * Runs `done` once when the motion on `el` that matches `filter` has finished, and
 * returns a function that cancels the wait (its timer and listeners). `done` runs at
 * most once. Nothing to wait for (0 ms) runs it now. The time comes from measureMotion
 * and the wait ends on the end event of whatever finishes last, or on a timer a little
 * after the measured time; an element with no computed style waits for the fallback
 * ceiling. Call it after the styles that start the motion are applied.
 */
export function afterMotion(el: Element, filter: MotionFilter, done: () => void): () => void {
  const measured = measureMotion(el, filter);
  if (measured?.ms === 0) {
    done();
    return () => {};
  }

  let finished = false;
  const stop = () => {
    clearTimeout(timer);
    el.removeEventListener('transitionend', onEnd);
    el.removeEventListener('animationend', onEnd);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    stop();
    done();
  };
  const onEnd = (event: Event) => {
    if (event.target !== el || !measured) return;
    const { propertyName = '', animationName = '' } = event as Partial<
      TransitionEvent & AnimationEvent
    >;
    // With a property filter `ending` names requested properties only, so an unrelated
    // property's transitionend never finishes the wait.
    const ends =
      event.type === 'transitionend'
        ? measured.ending.has(`t:${propertyName}`) ||
          (!filter.properties && measured.ending.has('t:all'))
        : measured.ending.has(`a:${animationName}`);
    if (ends) finish();
  };

  const timer = setTimeout(
    finish,
    measured ? measured.ms + MOTION_SLACK_MS : MOTION_UNAVAILABLE_CEILING_MS,
  );
  if (measured) {
    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);
  }
  return () => {
    finished = true;
    stop();
  };
}
