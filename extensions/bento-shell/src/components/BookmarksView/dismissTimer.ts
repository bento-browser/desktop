// The countdown of an undo toast. Several things can hold it (the pointer over the toast, the
// focus inside it) and each is tracked on its own: letting go of one while another still holds
// must not restart the countdown, or a toast could vanish under a focused Undo button.

export interface DismissTimer {
  hold(source: string): void;
  release(source: string): void;
  cancel(): void;
}

/** Calls `onExpire` once `ms` have passed with nothing holding the timer. Releasing the last hold
 * starts the full time again. */
export function createDismissTimer(ms: number, onExpire: () => void): DismissTimer {
  const holds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!cancelled && holds.size === 0) timer = setTimeout(onExpire, ms);
  };
  arm();

  return {
    hold(source) {
      holds.add(source);
      arm();
    },
    release(source) {
      holds.delete(source);
      arm();
    },
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}
