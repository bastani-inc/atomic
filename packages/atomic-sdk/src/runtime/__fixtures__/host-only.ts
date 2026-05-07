/**
 * Fixture: a workflow file that registers via `hostLocalWorkflows([…])` and
 * has NO `export default`. Used by `orchestrator-entry.resolve.test.ts`
 * to confirm `resolveWorkflowDefinition` finds the workflow via the
 * host registry without falling back to `mod.default`.
 */
import { defineWorkflow } from "../../define-workflow.ts";
import { hostLocalWorkflows } from "../../lib/host-local-workflows.ts";

const wf = defineWorkflow({
  name: "host-only-wf",
  description: "fixture: registered via hostLocalWorkflows only",
  source: import.meta.path,
  inputs: [],
})
  .for("claude")
  .run(async () => {})
  .compile();

await hostLocalWorkflows([wf], { argv: ["bun", "fixture.ts"], env: {} });
