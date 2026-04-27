import { defineWorkflow } from "@bastani/atomic/workflows";
import type { SessionEvent } from "@github/copilot-sdk";

/** Extract top-level assistant text from Copilot session events. */
function getAssistantText(messages: SessionEvent[]): string {
  return messages
    .filter(
      (m): m is Extract<SessionEvent, { type: "assistant.message" }> =>
        m.type === "assistant.message" && !m.data.parentToolCallId,
    )
    .map((m) => m.data.content)
    .filter((c) => c.length > 0)
    .join("\n\n");
}

export default defineWorkflow({
  name: "headless-test",
  source: import.meta.path,
  description:
    "Test headless background stages: visible → [3 headless] → visible merge → headless verdict",
  inputs: [
    {
      name: "prompt",
      type: "string",
      description: "topic to analyse",
      default: "TypeScript",
    },
  ],
})
  .for("copilot")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "TypeScript";

    // ── Visible stage: seed ──
    const seed = await ctx.stage(
      { name: "seed", description: "Generate a topic overview" },
      {},
      {},
      async (s) => {
        await s.session.send({
          prompt: `In one short paragraph, describe what "${prompt}" is.`,
        });
        const messages = await s.session.getMessages();
        s.save(messages);
        return getAssistantText(messages);
      },
    );

    // ── Three parallel headless background stages ──
    const [prosHandle, consHandle, usesHandle] = await Promise.all([
      ctx.stage(
        { name: "pros", headless: true },
        {},
        {},
        async (s) => {
          await s.session.send({
            prompt: `Given this topic overview, list 3 pros:\n\n${seed.result}`,
          });
          const messages = await s.session.getMessages();
          s.save(messages);
          return getAssistantText(messages);
        },
      ),
      ctx.stage(
        { name: "cons", headless: true },
        {},
        {},
        async (s) => {
          await s.session.send({
            prompt: `Given this topic overview, list 3 cons:\n\n${seed.result}`,
          });
          const messages = await s.session.getMessages();
          s.save(messages);
          return getAssistantText(messages);
        },
      ),
      ctx.stage(
        { name: "uses", headless: true },
        {},
        {},
        async (s) => {
          await s.session.send({
            prompt: `Given this topic overview, list 3 use cases:\n\n${seed.result}`,
          });
          const messages = await s.session.getMessages();
          s.save(messages);
          return getAssistantText(messages);
        },
      ),
    ]);

    // ── Visible stage: merge results from background stages ──
    const mergeHandle = await ctx.stage(
      { name: "merge", description: "Combine background results" },
      {},
      {},
      async (s) => {
        await s.session.send({
          prompt: [
            "Combine these three analyses into a concise summary:\n",
            `## Pros\n${prosHandle.result}`,
            `## Cons\n${consHandle.result}`,
            `## Use Cases\n${usesHandle.result}`,
          ].join("\n\n"),
        });
        const messages = await s.session.getMessages();
        s.save(messages);
        return getAssistantText(messages);
      },
    );

    // ── Final headless stage: verify the orchestrator timer stays alive ──
    await ctx.stage(
      { name: "verdict", headless: true },
      {},
      {},
      async (s) => {
        await s.session.send({
          prompt: `Given this summary, write a one-sentence final verdict:\n\n${mergeHandle.result}`,
        });
        const messages = await s.session.getMessages();
        s.save(messages);
        return getAssistantText(messages);
      },
    );
  })
  .compile();
