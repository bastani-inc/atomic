import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("model-fallback-example")
  .description("Demonstrate workflow-native fallbackModels on a task stage.")
  .input("topic", {
    type: "text",
    required: true,
    description: "Topic to review.",
  })
  .run(async (ctx) => {
    const review = await ctx.task("reviewer", {
      prompt: `Review this topic and call out risks: ${String(ctx.inputs.topic)}`,
      model: "anthropic/claude-sonnet-4",
      fallbackModels: [
        "openai/gpt-5-mini",
        "openai-codex/gpt-5-mini",
        "github-copilot/gpt-5-mini",
      ],
    });

    return {
      review: review.text,
      model: review.model,
      attemptedModels: review.attemptedModels,
      modelAttempts: review.modelAttempts,
    };
  })
  .compile();
