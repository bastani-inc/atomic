/**
 * Race one caller's cancellation against a shared producer without forwarding
 * cancellation to, or otherwise taking ownership of, that producer.
 */
export function waitForCaller<T>(
  getSharedPromise: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const sharedPromise = getSharedPromise();
  if (!signal) return sharedPromise;

  return new Promise<T>((resolve, reject) => {
    let callerSettled = false;
    const finishCaller = (settle: () => void): void => {
      if (callerSettled) return;
      callerSettled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = (): void => finishCaller(() => reject(signal.reason));

    signal.addEventListener("abort", onAbort, { once: true });
    void sharedPromise.then(
      (value) => finishCaller(() => resolve(value)),
      (error) => finishCaller(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * Race caller cancellation while retaining responsibility for a value that may
 * be produced after the caller has gone away.
 */
export async function waitForCallerWithLateCleanup<T>(
  getSharedPromise: () => Promise<T>,
  signal: AbortSignal | undefined,
  cleanupLate: (value: T) => void | Promise<void>,
): Promise<T> {
  const sharedPromise = getSharedPromise();
  try {
    return await waitForCaller(() => sharedPromise, signal);
  } catch (error) {
    if (signal?.aborted) {
      void sharedPromise.then(cleanupLate, () => undefined);
    }
    throw error;
  }
}
