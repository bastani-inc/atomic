import { reviewDecisionSchema } from "./goal-schemas.js";

// Keep this model list identical to Ralph's orchestrator while preserving a
// locally contained Goal configuration.
export const orchestratorModelConfig = {
    model: "openai-codex/gpt-5.6-sol:xhigh",
    fallbackModels: [
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "anthropic/claude-fable-5:high",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):high",
      "anthropic/claude-opus-4-8:high",
      "xai/grok-4.5:high",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
};

// Keep Goal's reviewer configuration independent so GPT-5.6 precedes Kimi K3
// within both the leading direct-provider group and the OpenRouter group.
export const reviewerModelConfig = {
    model: "anthropic/claude-fable-5:high",
    fallbackModels: [
      "openai-codex/gpt-5.6-sol:xhigh",
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):high",
      "anthropic/claude-opus-4-8:high",
      "xai/grok-4.5:high",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};
