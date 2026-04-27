import { defineWorkflow, extractAssistantText } from "@bastani/atomic/workflows";

/**
 * Headless variant of hil-favorite-color (Claude).
 *
 * Tells the agent to use its AskUserQuestion tool, but runs the stage
 * with `headless: true`. The runtime injects `disallowedTools:
 * ["AskUserQuestion"]` into the SDK options, so the tool call is
 * rejected and the agent must answer directly.
 *
 * Expected: stage completes in seconds with a written answer.
 * Regression: without the fix, the stage hangs forever waiting on a
 * human that never arrives.
 */
export default defineWorkflow({
  name: "hil-favorite-color-headless",
  source: import.meta.path,
  description:
    "Headless regression test: AskUserQuestion should be auto-denied so the stage does not hang",
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage(
      {
        name: "ask-color-headless",
        headless: true,
        description: "Headless: AskUserQuestion should be blocked",
      },
      {},
      {},
      async (s) => {
        const result = await s.session.query(
          [
            "You must use the AskUserQuestion tool exactly once to ask:",
            '"What is your favorite color?"',
            "",
            "If the tool is unavailable or denied, pick a plausible answer yourself",
            "and reply with a single sentence acknowledging the color.",
          ].join("\n"),
          {
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
          },
        );
        s.save(s.sessionId);
        return extractAssistantText(result, 0);
      },
    );
  })
  .compile();
