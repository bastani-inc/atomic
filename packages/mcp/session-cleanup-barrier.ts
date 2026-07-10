/**
 * Retain teardown work across MCP lifecycle generations without allowing a
 * non-abortable producer to block every later generation forever.
 */
type CleanupTask = PromiseLike<object | string | void>;

const DEFAULT_CLEANUP_DEADLINE_MS = 2_000;

function observeWithin(task: CleanupTask, deadlineMs: number, onTimeout: () => void): Promise<void> {
  const observed = Promise.resolve(task).then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, deadlineMs);
    timer.unref?.();
  });
  return Promise.race([observed, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class McpSessionCleanupBarrier {
  private settled: Promise<void> = Promise.resolve();

  constructor(private readonly deadlineMs = DEFAULT_CLEANUP_DEADLINE_MS) {}

  wait(): Promise<void> {
    return this.settled;
  }

  retain(tasks: readonly (CleanupTask | null | undefined)[]): Promise<void> {
    const observed = tasks.filter((task): task is CleanupTask => task !== null && task !== undefined);
    const prior = this.settled;
    const next = Promise.all([
      observeWithin(prior, this.deadlineMs, () => console.error("MCP: prior cleanup exceeded its deadline; continuing with fenced state")),
      ...observed.map((task) => observeWithin(task, this.deadlineMs, () => console.error("MCP: cleanup task exceeded its deadline; continuing with fenced state"))),
    ]).then(() => undefined);
    this.settled = next;
    return next;
  }
}
