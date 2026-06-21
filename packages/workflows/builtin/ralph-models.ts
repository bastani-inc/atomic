import { reviewDecisionSchema } from "./ralph-core.js";

export const promptEngineerModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh"
    ],
    noTools: "all" as const,
};

export const researchModelConfig = {
    model: "openai-codex/gpt-5.5:medium",
    fallbackModels: [
        "github-copilot/gpt-5.5:medium",
        "openai/gpt-5.5:medium",
        "github-copilot/claude-opus-4.8 (1m):medium",
        "anthropic/claude-opus-4-8:medium",
    ],
    excludedTools: ["ask_user_question"],
};

export const orchestratorModelConfig = {
    model: "openai-codex/gpt-5.5:medium",
    fallbackModels: [
        "github-copilot/gpt-5.5:medium",
        "openai/gpt-5.5:medium",
        "github-copilot/claude-opus-4.8 (1m):medium",
        "anthropic/claude-opus-4-8:medium",
    ],
    excludedTools: ["ask_user_question"],
};

export const reviewerAModelConfig = {
    model: "anthropic/claude-fable-5:xhigh",
    fallbackModels: [
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh"
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
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

export const reviewerCModelConfig = {
    model: "github-copilot/gemini-3.1-pro-preview (1m):high",
    fallbackModels: [
      "google/gemini-3.1-pro-preview:high",
      "google-vertex/gemini-3.1-pro-preview:high",
      "openai-codex/gpt-5.5:xhigh",
      "github-copilot/gpt-5.5:xhigh",
      "openai/gpt-5.5:xhigh",
      "anthropic/claude-fable-5:xhigh",
      "github-copilot/claude-opus-4.8 (1m):xhigh",
      "anthropic/claude-opus-4-8:xhigh"
    ],
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

