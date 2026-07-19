import { reviewDecisionSchema } from "./goal-schemas.js";

// Model chains are curated from Atomic's agentic-coding benchmark; see
// ralph-models.ts for frontier data and drop rationale.
export const workerModelConfig = {
    model: "openai-codex/gpt-5.6-sol:medium",
    fallbackModels: [
      "github-copilot/gpt-5.6-sol:medium",
      "openai/gpt-5.6-sol:medium",
      "openai-codex/gpt-5.5:medium",
      "github-copilot/gpt-5.5:medium",
      "openai/gpt-5.5:medium",
      "anthropic/claude-fable-5:low",
      "github-copilot/claude-opus-4.8 (1m):medium",
      "anthropic/claude-opus-4-8:medium",
      "cursor/gpt-5.6-sol:medium",
      "cursor/gpt-5.5:medium",
      "cursor/claude-fable-5:low",
      "cursor/claude-opus-4-8-thinking:medium",
      "xai/grok-4.5:high",
      "cursor/grok-4.5:high",
      "zai/glm-5.2:high",
      "zai-coding-cn/glm-5.2:high",
      "cursor/glm-5.2",
      "openrouter/openai/gpt-5.6-sol:medium",
      "openrouter/openai/gpt-5.5:medium",
      "openrouter/anthropic/claude-fable-5:low",
      "openrouter/anthropic/claude-opus-4-8:medium",
      "openrouter/x-ai/grok-4.5",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
};

// Keep this model list identical to Ralph reviewer-a while preserving an
// independent Goal configuration and Goal's richer decision schema.
// Reviewer-a leads its fallbacks with Kimi K3 so reviewer A and B decorrelate.
export const reviewerModelConfig = {
    model: "anthropic/claude-fable-5:high",
    fallbackModels: [
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "openai-codex/gpt-5.6-sol:xhigh",
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):high",
      "anthropic/claude-opus-4-8:high",
      "cursor/claude-fable-5:high",
      "cursor/gpt-5.6-sol:xhigh",
      "cursor/gpt-5.5:high",
      "cursor/claude-opus-4-8-thinking:high",
      "xai/grok-4.5:high",
      "cursor/grok-4.5:high",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "cursor/glm-5.2",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};
