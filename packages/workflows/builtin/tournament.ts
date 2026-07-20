import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runTournament } from "./tournament-runner.js";

export default workflow({
  name: "tournament",
  description: "Run several independent whole-task attempts through a balanced pairwise judging bracket and return an auditable winner.",
  inputs: {
    prompt: Type.String({ description: "Task every competing agent must attempt independently." }),
    num_attempts: Type.Integer({
      minimum: 2,
      maximum: 8,
      default: 4,
      description: "Number of independent whole-task attempts (2-8).",
    }),
    max_concurrency: Type.Integer({
      minimum: 1,
      maximum: 8,
      default: 4,
      description: "Maximum simultaneously active attempts or pairwise judges (1-8).",
    }),
  },
  outputs: {
    result: Type.String({ description: "Final reducer report containing the winning solution and decision trail." }),
    winner: Type.String({ description: "Stable attempt label selected as the tournament winner." }),
    winner_artifact_path: Type.String({ description: "Path to the original winning attempt artifact." }),
    result_path: Type.String({ description: "Path to the final reducer report artifact." }),
    attempt_artifact_paths: Type.Array(Type.String(), { description: "Paths to every independent attempt artifact." }),
    judge_artifact_paths: Type.Array(Type.String(), { description: "Paths to all structured pairwise judge artifacts." }),
    bracket_path: Type.String({ description: "Path to the durable JSON bracket with matches, byes, rationales, and winner." }),
    artifact_dir: Type.String({ description: "Run-specific directory containing tournament artifacts." }),
  },
  run: async (ctx) => await runTournament(ctx),
});
