import { defineWorkflow } from "@bastani/atomic/workflows";

/**
 * Headless variant of hil-favorite-color (OpenCode).
 *
 * Tells the agent to ask the user a question, but runs the stage with
 * `headless: true`. The runtime scopes `OPENCODE_CLIENT=sdk` around the
 * SDK spawn so OpenCode excludes its `question` tool from the registry
 * (upstream only registers it when OPENCODE_CLIENT is "app"/"cli"/"desktop").
 * With no question tool available, the agent must answer directly.
 *
 * Expected: stage completes in seconds with a written answer.
 * Regression: without the fix, the stage hangs forever on the
 * `question.asked` event that no human will ever reply to.
 */
export default defineWorkflow({
  name: "hil-favorite-color-headless",
  source: import.meta.path,
  description:
    "Headless regression test: user-question should be disabled so the stage does not hang",
})
  .for("opencode")
  .run(async (ctx) => {
    await ctx.stage(
      {
        name: "ask-color-headless",
        headless: true,
        description: "Headless: user-question should be disabled",
      },
      {},
      { title: "ask-color-headless" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: [
                "You must use your built-in question tool exactly once to ask:",
                '"What is your favorite color?"',
                "",
                "If the tool is unavailable or disabled, pick a plausible answer yourself",
                "and reply with a single sentence acknowledging the color.",
              ].join("\n"),
            },
          ],
        });
        s.save(result.data!);
      },
    );
  })
  .compile();
