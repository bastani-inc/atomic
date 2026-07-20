import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runClassifyAndAct } from "./classify-and-act-runner.js";

export const DEFAULT_ACTION_CATEGORIES = ["analysis", "implementation", "research"] as const;

export default workflow({
  name: "classify-and-act",
  description: "Classify a task with structured confidence, route deterministically to an isolated category action, and ask for human selection when confidence is low.",
  inputs: {
    prompt: Type.String({ description: "Task to classify and execute." }),
    categories: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 8,
      default: [...DEFAULT_ACTION_CATEGORIES],
      description: "Ordered action categories available to the classifier and fallback chooser.",
    }),
    confidence_threshold: Type.Number({
      minimum: 0.5,
      maximum: 0.99,
      default: 0.75,
      description: "Minimum structured confidence required to route without human selection.",
    }),
  },
  outputs: {
    result: Type.String({ description: "Category-specific action report." }),
    category: Type.String({ description: "Selected category, including any human fallback selection." }),
    confidence: Type.Number({ minimum: 0, maximum: 1, description: "Classifier confidence before fallback." }),
    action: Type.String({ description: "Executed category-specific action stage name." }),
    classification_path: Type.String({ description: "Structured classification artifact path." }),
    action_path: Type.String({ description: "Category action report artifact path." }),
    artifact_dir: Type.String({ description: "Per-run artifact directory." }),
  },
  run: async (ctx) => await runClassifyAndAct(ctx),
});
