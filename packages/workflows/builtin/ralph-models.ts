import { reviewDecisionSchema } from "./ralph-core.js";

// Model chains are curated from Atomic's agentic-coding benchmark and the
// July 2026 frontier refresh:
// - Critical synthesis/review stages prefer fable-5:xhigh, then gpt-5.5 xhigh
//   variants, openrouter fugu-ultra, long-context opus, and GLM fallbacks.
// - Research remains on gpt-5.5:medium / fable-5:low for perf-per-dollar.
// - Reviewer B keeps gpt-5.5:xhigh as an independent frontier family to
//   decorrelate review errors from reviewer A.
// - Dominated benchmark models stay out of the chains: claude-sonnet-5,
//   claude-sonnet-4.6, gemini-3.1-pro, and gemini-3.5-flash.
// - GLM-5.3 exposes reasoning without a thinkingLevelMap or reasoning-effort
//   control, so chains use the catalog-supported :high tier explicitly rather
//   than carrying the prior GLM generation's :xhigh/:max suffixes forward. OpenRouter has no
//   GLM-5.3 catalog entry, so its unavailable fallback is intentionally omitted.

export const promptEngineerModelConfig = {
    model: "anthropic/claude-opus-5:high",
    fallbackModels: [
      "github-copilot/claude-opus-5:high",
      "anthropic/claude-fable-5:high",
      "github-copilot/claude-fable-5:high",
      "openai-codex/gpt-5.6-sol:xhigh",
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-opus-4-8:high",
      "github-copilot/claude-opus-4.8:high",
      "xai/grok-4.5:high",
      "zai/glm-5.3:high",
      "zai-coding-cn/glm-5.3:high",
      "openrouter/anthropic/claude-opus-5:high",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
    ],
    excludedTools: ["ask_user_question"],
};

export const researchModelConfig = {
    model: "anthropic/claude-opus-5:high",
    fallbackModels: [
      "github-copilot/claude-opus-5:high",
      "openai-codex/gpt-5.6-sol:xhigh",
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "anthropic/claude-fable-5:high",
      "github-copilot/claude-fable-5:high",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-opus-4-8:high",
      "github-copilot/claude-opus-4.8:high",
      "xai/grok-4.5:high",
      "zai/glm-5.3:high",
      "zai-coding-cn/glm-5.3:high",
      "openrouter/anthropic/claude-opus-5:high",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
    ],
    excludedTools: ["ask_user_question"],
};

export const orchestratorModelConfig = {
    model: "anthropic/claude-opus-5:high",
    fallbackModels: [
      "github-copilot/claude-opus-5:high",
      "openai-codex/gpt-5.6-sol:xhigh",
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "anthropic/claude-fable-5:high",
      "github-copilot/claude-fable-5:high",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-opus-4-8:high",
      "github-copilot/claude-opus-4.8:high",
      "xai/grok-4.5:high",
      "zai/glm-5.3:high",
      "zai-coding-cn/glm-5.3:high",
      "openrouter/anthropic/claude-opus-5:high",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
    ],
    excludedTools: ["ask_user_question"],
};

export const reviewerAModelConfig = {
    model: "anthropic/claude-opus-5:high",
    fallbackModels: [
      "github-copilot/claude-opus-5:high",
      "anthropic/claude-fable-5:high",
      "github-copilot/claude-fable-5:high",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "openai-codex/gpt-5.6-sol:xhigh",
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-opus-4-8:high",
      "github-copilot/claude-opus-4.8:high",
      "xai/grok-4.5:high",
      "zai/glm-5.3:high",
      "zai-coding-cn/glm-5.3:high",
      "openrouter/anthropic/claude-opus-5:high",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

export const reviewerBModelConfig = {
    model: "openai-codex/gpt-5.6-sol:xhigh",
    fallbackModels: [
      "github-copilot/gpt-5.6-sol:xhigh",
      "openai/gpt-5.6-sol:xhigh",
      "anthropic/claude-opus-5:high",
      "github-copilot/claude-opus-5:high",
      "anthropic/claude-fable-5:high",
      "github-copilot/claude-fable-5:high",
      "kimi-coding/k3:max",
      "moonshotai/kimi-k3:max",
      "moonshotai-cn/kimi-k3:max",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-opus-4-8:high",
      "github-copilot/claude-opus-4.8:high",
      "xai/grok-4.5:high",
      "zai/glm-5.3:high",
      "zai-coding-cn/glm-5.3:high",
      "openrouter/openai/gpt-5.6-sol:xhigh",
      "openrouter/anthropic/claude-opus-5:high",
      "openrouter/anthropic/claude-fable-5:high",
      "openrouter/moonshotai/kimi-k3:max",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/x-ai/grok-4.5",
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

