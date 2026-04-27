import { defineWorkflow } from "@bastani/atomic/workflows";

/**
 * Headless variant of hil-favorite-color (Copilot).
 *
 * Tells the agent to use its `ask_user` tool, but runs the stage with
 * `headless: true`. The runtime appends `ask_user` to the session's
 * `excludedTools`, so the tool is unavailable and the agent must
 * answer directly.
 *
 * Expected: stage completes in seconds with a written answer.
 * Regression: without the fix, the stage hangs forever waiting on a
 * human that never arrives.
 */
export default defineWorkflow({
  name: "hil-favorite-color-headless",
  source: import.meta.path,
  description:
    "Headless regression test: ask_user should be excluded so the stage does not hang",
})
  .for("copilot")
  .run(async (ctx) => {
    await ctx.stage(
      {
        name: "ask-color-headless",
        headless: true,
        description: "Headless: ask_user should be excluded",
      },
      {},
      {},
      async (s) => {
        await s.session.send({
          prompt: [
            "You must use the `ask_user` tool exactly once to ask:",
            '"What is your favorite color?"',
            "",
            "If the tool is unavailable or excluded, pick a plausible answer yourself",
            "and reply with a single sentence acknowledging the color.",
          ].join("\n"),
        });
        s.save(await s.session.getMessages());
      },
    );
  })
  .compile();
