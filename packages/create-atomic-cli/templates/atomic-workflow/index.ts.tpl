#!/usr/bin/env bun
/**
 * {{name}} — atomic-managed workflow.
 *
 * The atomic CLI spawns this file via `bunx <path>` with a token-gated
 * sub-command (`_emit-workflow-meta` or `_atomic-run`). The trailing
 * `await hostLocalWorkflows([…])` is what handles those tokens; without
 * it `atomic workflow refresh` will time out and report this workflow
 * as broken.
 */
import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic-sdk";

const workflow = defineWorkflow({
  name: "{{name}}",
  source: import.meta.path,
  description: "{{description}}",
  inputs: [
    {
      name: "prompt",
      type: "text",
      required: true,
      description: "what you want this workflow to work on",
    },
  ],
})
  .for("{{agent}}")
  .run(async (ctx) => {
    await ctx.stage(
      { name: "main", description: "single agent session" },
      {},
      {},
      async (s) => {
        {{sessionCall}}
        s.save(s.sessionId);
      },
    );
  })
  .compile();

await hostLocalWorkflows([workflow]);
