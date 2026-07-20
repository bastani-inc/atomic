import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runLoopUntilDone } from "./loop-until-done-runner.js";

export default workflow({
  name: "loop-until-done",
  description: "Repeat evidence-producing work and independent completion evaluation against a durable ledger until done or an inspectable iteration-limit failure.",
  inputs: {
    prompt: Type.String({ description: "Objective whose explicit completion condition controls the bounded loop." }),
    max_iterations: Type.Integer({
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Maximum work/evaluation iterations before returning an inspectable failed status (1-20).",
    }),
  },
  outputs: {
    result: Type.String({ description: "Evidence-backed completion report or deterministic exhaustion report." }),
    status: Type.Union([Type.Literal("complete"), Type.Literal("failed")], {
      description: "Complete when evidence satisfies the stop condition; failed when max_iterations is exhausted.",
    }),
    iterations_completed: Type.Integer({ description: "Number of completed work/evaluation iterations." }),
    ledger_path: Type.String({ description: "Path to the durable JSON progress ledger." }),
    iteration_artifact_paths: Type.Array(Type.String(), { description: "Ordered paths to per-iteration work artifacts." }),
    evaluation_artifact_paths: Type.Array(Type.String(), { description: "Ordered paths to structured evaluation artifacts." }),
    result_path: Type.String({ description: "Path to the final report, or the ledger on exhausted failure." }),
    remaining_work: Type.String({ description: "Actionable remaining work; empty only after proven completion." }),
    artifact_dir: Type.String({ description: "Run-specific directory containing loop artifacts." }),
  },
  run: async (ctx) => await runLoopUntilDone(ctx),
});
