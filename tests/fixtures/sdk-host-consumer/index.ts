#!/usr/bin/env bun
import { defineWorkflow, hostLocalWorkflows, type WorkflowDefinition } from "@bastani/atomic-sdk";

const wf = defineWorkflow({
  name: "demo-wf",
  description: "Demo workflow for SDK host integration test",
  source: import.meta.path,
  inputs: [],
})
  .for("claude")
  .run(async (_ctx) => {
    // no-op run for fixture purposes
  })
  .compile() as unknown as WorkflowDefinition;

await hostLocalWorkflows([wf]);

// user main() continues here when not invoked under atomic
console.log("user main ran");
