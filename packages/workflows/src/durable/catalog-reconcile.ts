/**
 * In-process coalescing scheduler for background catalog reconciliation.
 *
 * Out-of-band directory changes (external additions / deletions / in-place
 * edits the catalog did not perform) are reconciled asynchronously, off the
 * picker/render turn. This scheduler guarantees:
 *
 *  - At most one reconcile runs at a time in this process.
 *  - Drift observed while one is in flight sets a single follow-up flag, so a
 *    burst of drift observations coalesces to at most one extra run — never one
 *    scan per observation.
 *  - The reconcile body is deferred to a macrotask (`setImmediate`) so the
 *    scanner is NEVER invoked synchronously inside `list()` / `prepare()`; the
 *    picker path stays scan-free (contract §1, §3, §4).
 *
 * The coalescer holds no OS lock and cannot deadlock. Cross-process publication
 * safety is provided inside the reconcile body itself, which takes the same
 * rebuild → publish lock nest as a cold rebuild.
 */
export class ReconcileCoalescer {
  private inFlight: Promise<void> | undefined;
  private again = false;

  constructor(private readonly run: () => Promise<void>) {}

  /**
   * Schedule a coalesced background reconcile and return immediately. Safe to
   * call from a synchronous read path: the wrapped `run` never executes before
   * the current turn yields.
   */
  schedule(): void {
    if (this.inFlight !== undefined) {
      this.again = true;
      return;
    }
    this.startLoop();
  }

  /**
   * Await the currently-scheduled reconcile burst (including any coalesced
   * follow-up) to fully drain. Resolves immediately when nothing is scheduled.
   * Test/consistency seam only — the hot path never awaits this.
   */
  async drain(): Promise<void> {
    while (this.inFlight !== undefined) {
      await this.inFlight;
    }
  }

  private startLoop(): void {
    const loop = this.loop();
    this.inFlight = loop;
    void loop.finally(() => {
      if (this.inFlight === loop) this.inFlight = undefined;
    });
  }

  private async loop(): Promise<void> {
    await deferToMacrotask();
    do {
      this.again = false;
      try {
        await this.run();
      } catch {
        // The authoritative durable state files remain the source of truth; a
        // failed background reconcile is retried on the next drift observation.
      }
    } while (this.again);
  }
}

function deferToMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
