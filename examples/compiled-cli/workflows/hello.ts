/**
 * Sample workflow. Statically imported by ../mycli.ts and bundled into
 * the compiled binary.
 */
import { defineWorkflow } from "@bastani/atomic-sdk";

export default defineWorkflow({
  name: "hello",
  source: import.meta.path,
  description: "Open a single agent session and ask it something.",
  inputs: [
    {
      name: "prompt",
      type: "text",
      required: true,
      description: "what to ask the agent",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage(
      { name: "ask", description: "single agent turn" },
      {},
      {},
      async (s) => {
        await s.session.query(ctx.inputs.prompt);
        s.save(s.sessionId);
      },
    );
  })
  .compile();
