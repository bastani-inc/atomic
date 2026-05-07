#!/usr/bin/env bun
import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic-sdk";

const explainFile = defineWorkflow({
  name: "explain-file",
  description: "Open a Claude pane that walks through a file",
  source: import.meta.path,
  inputs: [
    {
      name: "path",
      type: "text",
      required: true,
      description: "absolute or relative path to the file to explain",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage(
      { name: "explain", description: "Read the file and walk through it" },
      {},
      {},
      async (s) => {
        await s.session.query(
          `Read ${ctx.inputs.path} and walk me through what it does. ` +
            `Highlight any non-obvious behaviour or invariants. Keep it under 10 short sentences.`,
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();

await hostLocalWorkflows([explainFile]);
