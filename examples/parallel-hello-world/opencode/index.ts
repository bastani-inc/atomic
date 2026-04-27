import { defineWorkflow } from "@bastani/atomic/workflows";

/** Compose the initial greeting prompt from the structured inputs. */
function buildGreetPrompt(inputs: Record<string, string>): string {
  const topic = inputs.topic ?? "the world";
  const tone = inputs.tone ?? "warm";
  return `Write a short ${tone} greeting about "${topic}".`;
}

export default defineWorkflow({
    name: "parallel-hello-world",
    source: import.meta.path,
    description: "Parallel hello world: greet → [formal, casual] → merge",
    inputs: [
      {
        name: "topic",
        type: "string",
        required: true,
        description: "what the greeting should be about",
        placeholder: "a new project launch",
      },
      {
        name: "tone",
        type: "enum",
        required: true,
        description: "overall tone of the seed greeting",
        values: ["warm", "neutral", "cold"],
        default: "warm",
      },
    ],
  })
  .for("opencode")
  .run(async (ctx) => {
    const seedPrompt = buildGreetPrompt(ctx.inputs);
    const greet = await ctx.stage(
      { name: "greet", description: "Generate a greeting topic" },
      {},
      { title: "greet" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [{ type: "text", text: seedPrompt }],
        });
        s.save(result.data!);
      },
    );

    const [formal, casual] = await Promise.all([
      ctx.stage(
        { name: "formal", description: "Write a formal greeting" },
        {},
        { title: "formal" },
        async (s) => {
          const prior = await s.transcript(greet);
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: `Rewrite the following as a formal greeting:\n\n${prior.content}`,
              },
            ],
          });
          s.save(result.data!);
        },
      ),
      ctx.stage(
        { name: "casual", description: "Write a casual greeting" },
        {},
        { title: "casual" },
        async (s) => {
          const prior = await s.transcript(greet);
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: `Rewrite the following as a casual greeting:\n\n${prior.content}`,
              },
            ],
          });
          s.save(result.data!);
        },
      ),
    ]);

    await ctx.stage(
      { name: "merge", description: "Combine both greetings" },
      {},
      { title: "merge" },
      async (s) => {
        const formalText = await s.transcript(formal);
        const casualText = await s.transcript(casual);
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: `Combine these two greetings into a single message:\n\n## Formal\n${formalText.content}\n\n## Casual\n${casualText.content}`,
            },
          ],
        });
        s.save(result.data!);
      },
    );
  })
  .compile();
