import { defineWorkflow } from "@bastani/atomic/workflows";

export default defineWorkflow({
  name: "hello",
  source: import.meta.path,
  description: "Greet someone by name",
  inputs: [
    {
      name: "who",
      type: "string",
      default: "world",
      description: "who to greet",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage({ name: "greet" }, {}, {}, async (s) => {
      await s.session.query(`Say a one-line hello to ${ctx.inputs.who}.`);
      s.save(s.sessionId);
    });
  })
  .compile();
