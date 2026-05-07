/**
 * Fixture: a workflow file that exports the compiled definition as the
 * module default and does NOT call `hostWorkflows([…])`. Used by
 * `orchestrator-entry.resolve.test.ts` to confirm the legacy
 * `runWorkflow`-direct pattern (e.g. `examples/hello-world/claude/index.ts`)
 * still resolves correctly.
 */
import { defineWorkflow } from "../../define-workflow.ts";

export default defineWorkflow({
  name: "default-only-wf",
  description: "fixture: only export default, no hostWorkflows",
  source: import.meta.path,
  inputs: [],
})
  .for("claude")
  .run(async () => {})
  .compile();
