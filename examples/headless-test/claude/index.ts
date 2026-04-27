import { defineWorkflow, extractAssistantText } from "@bastani/atomic/workflows";

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
  .for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "TypeScript";

    // ── Visible stage: seed ──
    const seed = await ctx.stage(
      { name: "seed", description: "Generate a topic overview" },
      {},
      {},
      async (s) => {
        const result = await s.session.query(
          `In one short paragraph, describe what "${prompt}" is.`,
        );
        s.save(s.sessionId);
        return extractAssistantText(result, 0);
      },
    );

    // ── Three parallel headless background stages ──
    const [prosHandle, consHandle, usesHandle] = await Promise.all([
      ctx.stage(
        { name: "pros", headless: true },
        {},
        {},
        async (s) => {
          const result = await s.session.query(
            `Given this topic overview, list 3 pros:\n\n${seed.result}`,
            { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
          );
          s.save(s.sessionId);
          return extractAssistantText(result, 0);
        },
      ),
      ctx.stage(
        { name: "cons", headless: true },
        {},
        {},
        async (s) => {
          const result = await s.session.query(
            `Given this topic overview, list 3 cons:\n\n${seed.result}`,
            { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
          );
          s.save(s.sessionId);
          return extractAssistantText(result, 0);
        },
      ),
      ctx.stage(
        { name: "uses", headless: true },
        {},
        {},
        async (s) => {
          const result = await s.session.query(
            `Given this topic overview, list 3 use cases:\n\n${seed.result}`,
            { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
          );
          s.save(s.sessionId);
          return extractAssistantText(result, 0);
        },
      ),
    ]);

    // ── Visible stage: merge results from background stages ──
    const mergeHandle = await ctx.stage(
      { name: "merge", description: "Combine background results" },
      {},
      {},
      async (s) => {
        const result = await s.session.query(
          [
            "Combine these three analyses into a concise summary:\n",
            `## Pros\n${prosHandle.result}`,
            `## Cons\n${consHandle.result}`,
            `## Use Cases\n${usesHandle.result}`,
          ].join("\n\n"),
        );
        s.save(s.sessionId);
        return extractAssistantText(result, 0);
      },
    );

    // ── Final headless stage: verify the orchestrator timer stays alive ──
    await ctx.stage(
      { name: "verdict", headless: true },
      {},
      {},
      async (s) => {
        const result = await s.session.query(
          `Given this summary, write a one-sentence final verdict:\n\n${mergeHandle.result}`,
          { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
        );
        s.save(s.sessionId);
        return extractAssistantText(result, 0);
      },
    );
  })
  .compile();
