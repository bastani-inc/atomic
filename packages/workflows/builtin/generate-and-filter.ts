import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runGenerateAndFilter } from "./generate-and-filter-runner.js";

export default workflow({
  name: "generate-and-filter",
  description: "Generate more independent candidates than needed, deduplicate and filter them by rubric, optionally judge them, and return a parent-consumable shortlist.",
  inputs: {
    prompt: Type.String({ description: "Prompt for candidate generation and selection." }),
    num_candidates: Type.Integer({ minimum: 2, maximum: 20, default: 8, description: "Number of independent candidates to generate." }),
    shortlist_size: Type.Integer({ minimum: 1, maximum: 10, default: 3, description: "Maximum number of candidates in the final shortlist." }),
    use_judge: Type.Boolean({ default: true, description: "Whether an independent judge reviews the filtered shortlist." }),
    max_concurrency: Type.Integer({ minimum: 1, maximum: 12, default: 4, description: "Maximum simultaneous generator stages." }),
  },
  outputs: {
    result: Type.String({ description: "Final human-readable shortlist report." }),
    shortlist: Type.Array(Type.String(), { description: "Ranked paths to selected candidate artifacts." }),
    candidate_artifact_paths: Type.Array(Type.String(), { description: "Paths to every generated candidate artifact." }),
    filter_path: Type.String({ description: "Path to the dedupe and filter decision." }),
    judge_path: Type.Union([Type.String(), Type.Null()], { description: "Path to the optional judge decision, or null when disabled." }),
    final_path: Type.String({ description: "Path to the final shortlist report." }),
    artifact_dir: Type.String({ description: "Directory containing run artifacts." }),
    manifest_path: Type.String({ description: "Path to the candidate artifact manifest." }),
  },
  run: runGenerateAndFilter,
});
