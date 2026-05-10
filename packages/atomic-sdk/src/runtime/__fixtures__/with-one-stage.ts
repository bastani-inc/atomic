/**
 * Fixture: a workflow that calls ctx.stage("step-1") once.
 * Used by run-manager.test.ts integration tests to verify that RunManager
 * wires DaemonWorkflowContext + ISupervisor correctly end-to-end.
 */
export default {
  run: async (ctx: { stage: (name: string) => Promise<unknown> }) => {
    await ctx.stage("step-1");
  },
};
