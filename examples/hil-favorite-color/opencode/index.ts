import { defineWorkflow } from "@bastani/atomic/workflows";

/**
 * Two-stage workflow that exercises the OpenCode HIL (human-in-the-loop)
 * detection path. Stage 1 tells the agent to ask the user for their
 * favorite color; the runtime subscribes to the event stream and should
 * flip the stage's node card to the blue "awaiting_input" pulse on
 * `question.asked`, then back to `running` on `question.replied` /
 * `question.rejected`. Stage 2 reads stage 1's transcript and writes
 * a short description of the chosen color.
 */
export default defineWorkflow({
    name: "hil-favorite-color",
    source: import.meta.path,
    description:
      "Test HIL: stage 1 asks the user for their favorite color; stage 2 describes it",
  })
  .for("opencode")
  .run(async (ctx) => {
    const askColor = await ctx.stage(
      {
        name: "ask-color",
        description: "Ask the user for their favorite color (HIL)",
      },
      {},
      { title: "ask-color" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: [
                "You must ask the user exactly one question using your built-in user-question tool:",
                '"What is your favorite color?"',
                "",
                "Allow a free-form text answer. Do not guess — wait for the user's response.",
                "After they answer, reply with a single sentence acknowledging their choice.",
              ].join("\n"),
            },
          ],
        });
        s.save(result.data!);
      },
    );

    await ctx.stage(
      {
        name: "describe-color",
        description: "Write a short description of the chosen color",
      },
      {},
      { title: "describe-color" },
      async (s) => {
        const prior = await s.transcript(askColor);
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: [
                "Below is the transcript from a prior session where the user named their favorite color.",
                "Write a short (2–3 sentence) evocative description of that color — what feelings, scenes, or objects it calls to mind.",
                "Do not ask any follow-up questions.",
                "",
                "Transcript:",
                prior.content,
              ].join("\n"),
            },
          ],
        });
        s.save(result.data!);
      },
    );
  })
  .compile();
