import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runAdversarialVerification } from "./adversarial-verification-runner.js";

export default workflow({
  name: "adversarial-verification",
  description: "Produce a candidate, challenge it with fresh-context rubric-based verifiers, and reduce their evidence through a bounded repair loop.",
  inputs: {
    task: Type.String({ description: "Task whose candidate result must be independently verified." }),
    verifier_count: Type.Integer({ minimum: 1, maximum: 5, default: 3, description: "Number of independent verifiers per review round." }),
    max_repairs: Type.Integer({ minimum: 0, maximum: 5, default: 2, description: "Maximum candidate repair rounds before rejection." }),
  },
  outputs: {
    result: Type.String({ description: "Final reducer rationale." }),
    approved: Type.Boolean({ description: "Whether verification accepted the candidate." }),
    repairs_completed: Type.Integer({ description: "Number of repair rounds performed." }),
    candidate_path: Type.String({ description: "Path to the final candidate artifact." }),
    review_report_path: Type.String({ description: "Path to the final reducer report." }),
    verifier_artifact_paths: Type.Array(Type.String(), { description: "Paths to final-round verifier reports." }),
    artifact_dir: Type.String({ description: "Directory containing run artifacts." }),
    remaining_work: Type.Array(Type.String(), { description: "Unresolved blocking findings when not approved." }),
  },
  run: runAdversarialVerification,
});
