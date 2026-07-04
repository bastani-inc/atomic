import { reviewDecisionSchema } from "./ralph-core.js";

// Model chains are curated from Atomic's agentic-coding benchmark and the
// July 2026 frontier refresh:
// - Critical synthesis/review stages prefer fable-5:xhigh, then fugu-ultra
//   and gpt-5.5 xhigh variants, before long-context opus and GLM fallbacks.
// - Research remains on gpt-5.5:medium / fable-5:low for perf-per-dollar.
// - Reviewer B keeps gpt-5.5:xhigh as an independent frontier family;
//   reviewer C leads with fugu-ultra:high and GLM xhigh fallbacks to
//   decorrelate review errors.
// - Dominated benchmark models stay out of the chains: claude-sonnet-5,
//   claude-sonnet-4.6, gemini-3.1-pro, and gemini-3.5-flash.
// - GLM-5.2 has only two real reasoning tiers — its thinkingLevelMap collapses
//   minimal/low/medium/high to "high" and xhigh to "max" — so chains only use
//   :high (budget tier, 36%/$2.84) or :xhigh (best tier, 44%/$3.92); the
//   openrouter/z-ai mirror maps :xhigh exclusively, so it is always :xhigh.

export const promptEngineerModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "sakana/fugu-ultra:high",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:xhigh",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
};

export const researchModelConfig = {
    model: "openai-codex/gpt-5.5:medium",
    fallbackModels: [
        "github-copilot/gpt-5.5:medium",
        "openai/gpt-5.5:medium",
        "anthropic/claude-fable-5:low",
        "github-copilot/claude-opus-4.8 (1m):medium",
        "anthropic/claude-opus-4-8:medium",
        "zai/glm-5.2:high",
        "zai-coding-cn/glm-5.2:high",
        "openrouter/openai/gpt-5.5:medium",
        "openrouter/anthropic/claude-fable-5:low",
        "openrouter/anthropic/claude-opus-4-8:medium",
        "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
};

export const orchestratorModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "sakana/fugu-ultra:high",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:xhigh",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
};

export const reviewerAModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "sakana/fugu-ultra:high",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:xhigh",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

export const reviewerBModelConfig = {
    model: "openai-codex/gpt-5.5:xhigh",
    fallbackModels: [
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-fable-5:xhigh",
      "sakana/fugu-ultra:high",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/anthropic/claude-opus-4-8:xhigh",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

export const reviewerCModelConfig = {
    model: "sakana/fugu-ultra:high",
    fallbackModels: [
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-fable-5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "openrouter/sakana/fugu-ultra:high",
      "openrouter/z-ai/glm-5.2:xhigh",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};
