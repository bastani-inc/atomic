import { defineWorkflow } from "@bastani/atomic/workflows";

export default defineWorkflow({
  name: "goodbye",
  source: import.meta.path,
  description: "Bid farewell in a chosen tone",
  inputs: [
    {
      name: "tone",
      type: "enum",
      values: ["formal", "casual", "melodramatic"],
      default: "casual",
      description: "tone of the farewell",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage({ name: "farewell" }, {}, {}, async (s) => {
      await s.session.query(
        `Say a one-line ${ctx.inputs.tone ?? "casual"} goodbye.`,
      );
      s.save(s.sessionId);
    });
  })
  .compile();
