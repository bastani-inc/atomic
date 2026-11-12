import { reviewDecisionSchema } from "./ralph-core.js";

export const promptEngineerModelConfig = {
    model: "auto",
    excludedTools: ["ask_user_question"],
};

export const researchModelConfig = {
    model: "auto",
    excludedTools: ["ask_user_question"],
};

export const orchestratorModelConfig = {
    model: "auto",
    excludedTools: ["ask_user_question"],
};

// The two reviewers route together: each takes a different model family, so
// their reviews do not share one model's blind spots.
export const reviewerAModelConfig = {
    model: "auto",
    parallelSlot: { index: 0, count: 2 },
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

export const reviewerBModelConfig = {
    model: "auto",
    parallelSlot: { index: 1, count: 2 },
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};
