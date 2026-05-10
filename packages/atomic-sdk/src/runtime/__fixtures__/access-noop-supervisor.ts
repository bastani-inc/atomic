/**
 * Fixture: accesses private supervisor methods on the DaemonWorkflowContext
 * to exercise noopSupervisor.sendInput and noopSupervisor.getScrollback.
 *
 * Used in run-manager.test.ts to cover noopSupervisor lines.
 */
export default {
  async run(ctx: { supervisor?: { sendInput: (...args: unknown[]) => void; getScrollback: (...args: unknown[]) => unknown } }) {
    // Access the private supervisor field at runtime (TypeScript private is compile-time only).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sup = (ctx as any).supervisor as {
      sendInput(...args: unknown[]): void;
      getScrollback(...args: unknown[]): unknown;
    } | undefined;

    if (sup) {
      try { sup.sendInput("run-id", "stage", "data"); } catch (_e) { /* expected: noopSupervisor throws */ }
      try { sup.getScrollback("run-id", "stage", 0); } catch (_e) { /* expected: noopSupervisor throws */ }
    }
    // Return normally — no ctx.stage() call so no spawn is needed.
  },
};
