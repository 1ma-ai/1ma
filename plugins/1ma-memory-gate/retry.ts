/**
 * Wakes the plugin's own held turns. Core keeps only one waiter's `sendAt`
 * when several plugins hold a turn, so the plugin books its own time too.
 *
 * It fires at the earliest booked time and again at the latest one: core
 * passes over a turn it queued again less than a second ago, so an earlier
 * firing does not stand in for a time booked shortly before it. A turn that is
 * tried again and still waits books a new time. `now` is monotonic
 * milliseconds.
 */
export function createRetryTimer(now: () => number, fire: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let due = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let disposed = false;

  function arm(at: number): void {
    if (timer !== null) clearTimeout(timer);
    due = at;
    timer = setTimeout(
      () => {
        timer = null;
        due = Number.POSITIVE_INFINITY;
        fire();
        if (!disposed && timer === null && latest > now()) arm(latest);
      },
      Math.max(0, at - now()),
    );
  }

  return {
    book(delayMs: number): void {
      if (disposed) return;
      const at = now() + delayMs;
      latest = Math.max(latest, at);
      if (at < due) arm(at);
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
