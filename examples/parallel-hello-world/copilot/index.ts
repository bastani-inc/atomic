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
  .for("copilot")
  .run(async (ctx) => {
    const seedPrompt = buildGreetPrompt(ctx.inputs);
    const greet = await ctx.stage(
      { name: "greet", description: "Generate a greeting topic" },
      {},
      {},
      async (s) => {
        await s.session.send({ prompt: seedPrompt });
        s.save(await s.session.getMessages());
      },
    );

    const [formal, casual] = await Promise.all([
      ctx.stage(
        { name: "formal", description: "Write a formal greeting" },
        {},
        {},
        async (s) => {
          const prior = await s.transcript(greet);
          await s.session.send({
            prompt: `Rewrite the following as a formal greeting:\n\n${prior.content}`,
          });
          s.save(await s.session.getMessages());
        },
      ),
      ctx.stage(
        { name: "casual", description: "Write a casual greeting" },
        {},
        {},
        async (s) => {
          const prior = await s.transcript(greet);
          await s.session.send({
            prompt: `Rewrite the following as a casual greeting:\n\n${prior.content}`,
          });
          s.save(await s.session.getMessages());
        },
      ),
    ]);

    await ctx.stage(
      { name: "merge", description: "Combine both greetings" },
      {},
      {},
      async (s) => {
        const formalText = await s.transcript(formal);
        const casualText = await s.transcript(casual);
        await s.session.send({
          prompt: `Combine these two greetings into a single message:\n\n## Formal\n${formalText.content}\n\n## Casual\n${casualText.content}`,
        });
        s.save(await s.session.getMessages());
      },
    );
  })
  .compile();
