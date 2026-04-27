import { defineWorkflow } from "@bastani/atomic/workflows";

/**
 * Two-stage workflow that exercises the Copilot HIL (human-in-the-loop)
 * detection path. Stage 1 tells the agent to use its `ask_user` tool to
 * ask the user for their favorite color; the runtime subscribes to the
 * session's `tool.execution_start` / `tool.execution_complete` events
 * and should flip the stage's node card to the blue "awaiting_input"
 * pulse while the question is unresolved. Stage 2 reads stage 1's
 * transcript and writes a short description of the chosen color.
 */
export default defineWorkflow({
    name: "hil-favorite-color",
    source: import.meta.path,
    description:
      "Test HIL: stage 1 asks the user for their favorite color via ask_user; stage 2 describes it",
  })
  .for("copilot")
  .run(async (ctx) => {
    const askColor = await ctx.stage(
      {
        name: "ask-color",
        description: "Ask the user for their favorite color (HIL)",
      },
      {},
      {},
      async (s) => {
        await s.session.send({
          prompt: [
            "You must use the `ask_user` tool exactly once to ask the user:",
            '"What is your favorite color?"',
            "",
            "Allow a free-form text answer. Do not guess — wait for the user's response.",
            "After they answer, reply with a single sentence acknowledging their choice.",
          ].join("\n"),
        });
        s.save(await s.session.getMessages());
      },
    );

    await ctx.stage(
      {
        name: "describe-color",
        description: "Write a short description of the chosen color",
      },
      {},
      {},
      async (s) => {
        const prior = await s.transcript(askColor);
        await s.session.send({
          prompt: [
            "Below is the transcript from a prior session where the user named their favorite color.",
            "Write a short (2–3 sentence) evocative description of that color — what feelings, scenes, or objects it calls to mind.",
            "Do not ask any follow-up questions.",
            "",
            "Transcript:",
            prior.content,
          ].join("\n"),
        });
        s.save(await s.session.getMessages());
      },
    );
  })
  .compile();
