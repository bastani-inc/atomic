import { reviewDecisionSchema } from "./ralph-core.js";

// Model chains are curated from Atomic's agentic-coding benchmark
// (pass@1 / avg $ per task, 2026-07-02):
// - Placement principle: REVIEWERS get best-in-class verification quality
//   (fable-5:xhigh 70%/$13.41 leads reviewer-A and the goal reviewer);
//   EVERY OTHER stage gets the best measured performance-per-dollar
//   (gpt-5.5:xhigh 67%/$7.23 for hard stages, gpt-5.5:medium 54%/$2.75 for
//   workhorse stages, gpt-5.5:low $1.20 for retrieval).
// - Pareto frontier: gpt-5.5 low ($1.20/27%) → gpt-5.5 medium ($2.75/54%) →
//   fable-5 low ($3.76/60%) → gpt-5.5 high ($5.10/64%) → fable-5 medium
//   ($6.09/65%) → gpt-5.5 xhigh ($7.23/67%) → fable-5 high ($9.18/69%) →
//   fable-5 xhigh ($13.41/70%).
// - Dropped as strictly dominated: claude-sonnet-5 (40-54% at $4-26, up to
//   268 steps), claude-sonnet-4.6 (30%/$5.52), gemini-3.1-pro (12%/$9.48),
//   gemini-3.5-flash (37%/$7.34, 276k output tokens).
// - claude-opus-4.8 rides at :high — its value point (52%/$4.28); :xhigh
//   doubles the cost for +2pts.
// - glm-5.2 is reviewer-C's diversity primary only (third model family
//   decorrelates review errors); elsewhere it is a budget fallback. Note:
//   GLM-5.2 has only two real reasoning tiers — its thinkingLevelMap collapses
//   minimal/low/medium/high to "high" and xhigh to "max" — so chains only use
//   :high (budget tier, 36%/$2.84) or :xhigh (best tier, 44%/$3.92); the
//   openrouter/z-ai mirror maps :xhigh exclusively, so it is always :xhigh.

export const promptEngineerModelConfig = {
    model: "openai-codex/gpt-5.5:xhigh",
    fallbackModels: [
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-fable-5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):high",
      "anthropic/claude-opus-4-8:high",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
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

export const reviewerAModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):high",
      "anthropic/claude-opus-4-8:high",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
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
      "github-copilot/claude-opus-4.8 (1m):high",
      "anthropic/claude-opus-4-8:high",
      "zai/glm-5.2:xhigh",
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high",
      "openrouter/z-ai/glm-5.2:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

export const reviewerCModelConfig = {
    model: "zai/glm-5.2:xhigh",
    fallbackModels: [
      "zai-coding-cn/glm-5.2:xhigh",
      "openrouter/z-ai/glm-5.2:xhigh",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-fable-5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):high",
      "anthropic/claude-opus-4-8:high",
      "openrouter/openai/gpt-5.5:xhigh",
      "openrouter/anthropic/claude-fable-5:xhigh",
      "openrouter/anthropic/claude-opus-4-8:high"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};
