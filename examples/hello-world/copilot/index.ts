import { defineWorkflow } from "@bastani/atomic/workflows";

/**
 * Build the greeting prompt from the structured inputs. The picker and
 * CLI flag parser both populate `ctx.inputs` — this workflow exercises
 * the full structured-input pipeline end to end.
 */
function buildHelloPrompt(inputs: Record<string, string>): string {
  const greeting = inputs.greeting ?? "Hello";
  const style = inputs.style ?? "casual";
  const notes = inputs.notes?.trim() ?? "";
  const base = `${greeting} Please respond with a ${style} hello-world greeting.`;
  return notes ? `${base}\n\nAdditional guidance:\n${notes}` : base;
}

export default defineWorkflow({
    name: "hello-world",
    source: import.meta.path,
    description: "A simple single-session hello world workflow",
    inputs: [
      {
        name: "greeting",
        type: "string",
        required: true,
        description: "the opening phrase the agent should echo back",
        placeholder: "Hello, world!",
      },
      {
        name: "style",
        type: "enum",
        required: true,
        description: "tone of the response",
        values: ["formal", "casual", "robotic"],
        default: "casual",
      },
      {
        name: "notes",
        type: "text",
        description: "extra guidance for the agent (optional)",
        placeholder: "anything you want to add…",
      },
    ],
  })
  .for("copilot")
  .run(async (ctx) => {
    const prompt = buildHelloPrompt(ctx.inputs);
    await ctx.stage(
      { name: "hello", description: "Say hello to the world" },
      {},
      {},
      async (s) => {
        await s.session.send({ prompt });
        s.save(await s.session.getMessages());
      },
    );
  })
  .compile();
