// Races a promise against a deadline, resolving to `fallback` — never
// rejecting — if either the deadline fires first or the promise itself
// rejects, before or after that deadline. The fallback lives in the
// signature rather than in a try/catch at each call site on purpose: a
// try/catch wrapping a call is easy to drop in a later edit and nothing
// would catch the regression; a fallback baked into the return value
// structurally cannot be forgotten by the caller.
//
// The inner promise gets its `.then(onFulfilled, onRejected)` attached
// synchronously, before the deadline timer can ever fire, so a rejection
// that arrives late — after the deadline already resolved this function's
// promise with the fallback — is still a promise with a handler attached.
// It can never surface as an unhandled rejection; its result is simply
// discarded once this function has already settled.
export function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
