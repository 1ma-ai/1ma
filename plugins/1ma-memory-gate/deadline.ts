/**
 * Starts a call that is aborted when `outer` aborts or after `ms`, by the
 * plugin's own timer, whether or not the call honours its signal. `answer`
 * settles by then at the latest; `call` settles whenever the call itself does.
 */
export function withDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal,
  ms: number,
): { call: Promise<T>; answer: Promise<T> } {
  const controller = new AbortController();
  const call = Promise.resolve().then(() => start(controller.signal));
  let release = () => {};
  const answer = new Promise<T>((resolve, reject) => {
    const giveUp = (why: string) => {
      reject(new Error(why));
      controller.abort();
    };
    const stopped = () => giveUp("stopped");
    const timer = setTimeout(() => giveUp(`no answer in ${String(ms / 1000)} s`), ms);
    outer.addEventListener("abort", stopped, { once: true });
    release = () => {
      clearTimeout(timer);
      outer.removeEventListener("abort", stopped);
    };
    if (outer.aborted) stopped();
    call.then(resolve, reject);
  }).finally(() => release());
  return { call, answer };
}
