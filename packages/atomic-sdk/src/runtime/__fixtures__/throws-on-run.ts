/**
 * Fixture: a workflow whose run() throws synchronously.
 * Used by run-manager.test.ts to test the error lifecycle path (run/ended=error).
 */
export default {
  run: async () => {
    throw new Error("fixture deliberate run failure");
  },
};
