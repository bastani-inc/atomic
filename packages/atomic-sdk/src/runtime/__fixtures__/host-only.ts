/**
 * Fixture: a workflow file that registers via `hostWorkflows([…])` and
 * has NO `export default`. Used by `orchestrator-entry.resolve.test.ts`
 * to confirm `resolveWorkflowDefinition` finds the workflow via the
 * host registry without falling back to `mod.default`.
 */
import { defineWorkflow } from "../../define-workflow.ts";
import { hostWorkflows } from "../../lib/host-workflows.ts";

const wf = defineWorkflow({
  name: "host-only-wf",
  description: "fixture: registered via hostWorkflows only",
  source: import.meta.path,
  inputs: [],
})
  .for("claude")
  .run(async () => {})
  .compile();

await hostWorkflows([wf], { argv: ["bun", "fixture.ts"], env: {} });
