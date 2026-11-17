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

export const reviewerAModelConfig = {
    model: "auto",
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};

export const reviewerBModelConfig = {
    model: "auto",
    excludedTools: ["ask_user_question"],
    schema: reviewDecisionSchema,
};
