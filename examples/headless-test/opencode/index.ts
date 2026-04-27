import { defineWorkflow } from "@bastani/atomic/workflows";

/** Extract text-typed parts from an OpenCode response. */
function extractResponseText(
  parts: Array<{ type: string; [key: string]: unknown }>,
): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: string; text: string }).text)
    .join("\n");
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
  .for("opencode")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "TypeScript";

    // ── Visible stage: seed ──
    const seed = await ctx.stage(
      { name: "seed", description: "Generate a topic overview" },
      {},
      { title: "seed" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: `In one short paragraph, describe what "${prompt}" is.`,
            },
          ],
        });
        s.save(result.data!);
        return extractResponseText(result.data!.parts);
      },
    );

    // ── Three parallel headless background stages ──
    const [prosHandle, consHandle, usesHandle] = await Promise.all([
      ctx.stage(
        { name: "pros", headless: true },
        {},
        { title: "pros" },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: `Given this topic overview, list 3 pros:\n\n${seed.result}`,
              },
            ],
          });
          s.save(result.data!);
          return extractResponseText(result.data!.parts);
        },
      ),
      ctx.stage(
        { name: "cons", headless: true },
        {},
        { title: "cons" },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: `Given this topic overview, list 3 cons:\n\n${seed.result}`,
              },
            ],
          });
          s.save(result.data!);
          return extractResponseText(result.data!.parts);
        },
      ),
      ctx.stage(
        { name: "uses", headless: true },
        {},
        { title: "uses" },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: `Given this topic overview, list 3 use cases:\n\n${seed.result}`,
              },
            ],
          });
          s.save(result.data!);
          return extractResponseText(result.data!.parts);
        },
      ),
    ]);

    // ── Visible stage: merge results from background stages ──
    const mergeHandle = await ctx.stage(
      { name: "merge", description: "Combine background results" },
      {},
      { title: "merge" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: [
                "Combine these three analyses into a concise summary:\n",
                `## Pros\n${prosHandle.result}`,
                `## Cons\n${consHandle.result}`,
                `## Use Cases\n${usesHandle.result}`,
              ].join("\n\n"),
            },
          ],
        });
        s.save(result.data!);
        return extractResponseText(result.data!.parts);
      },
    );

    // ── Final headless stage: verify the orchestrator timer stays alive ──
    await ctx.stage(
      { name: "verdict", headless: true },
      {},
      { title: "verdict" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: `Given this summary, write a one-sentence final verdict:\n\n${mergeHandle.result}`,
            },
          ],
        });
        s.save(result.data!);
        return extractResponseText(result.data!.parts);
      },
    );
  })
  .compile();
