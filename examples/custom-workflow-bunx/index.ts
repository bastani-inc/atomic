#!/usr/bin/env bun
import { defineWorkflow, hostWorkflows } from "@bastani/atomic-sdk";

const deployWorkflow = defineWorkflow({
  name: "deploy",
  description: "Deploys the staging environment",
  source: import.meta.path,
  inputs: [],
})
  .for("claude")
  .run(async (_ctx) => {
    // Perform deployment steps here.
    // ctx.stage() / ctx.inputs available for real workflows.
  })
  .compile();

await hostWorkflows([deployWorkflow]);

// Your CLI's main() continues here if not invoked by atomic.
console.log("standalone mode: deploy workflow defined; not running anything");
