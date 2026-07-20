import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import { runFanOutAndSynthesize } from "./fan-out-and-synthesize-runner.js";

export default workflow({
  name: "fan-out-and-synthesize",
  description: "Partition a task, run bounded independent artifact branches, then synthesize all evidence at an explicit barrier.",
  inputs: {
    prompt: Type.String({ description: "Task to partition, investigate, and synthesize." }),
    max_branches: Type.Integer({
      minimum: 1,
      maximum: 12,
      default: 4,
      description: "Maximum number of independent partitions produced and executed.",
    }),
    max_concurrency: Type.Integer({
      minimum: 1,
      maximum: 12,
      default: 4,
      description: "Maximum number of branch agents running concurrently.",
    }),
  },
  outputs: {
    result: Type.String({ description: "Evidence-citing synthesized report." }),
    partitions: Type.Array(Type.String(), { description: "Ordered labels for executed partitions." }),
    branch_artifact_paths: Type.Array(Type.String(), { description: "Ordered branch artifact paths consumed by synthesis." }),
    synthesis_path: Type.String({ description: "Final synthesis artifact path." }),
    artifact_dir: Type.String({ description: "Per-run artifact directory." }),
    manifest_path: Type.String({ description: "Barrier manifest linking partitions to branch artifacts." }),
  },
  run: async (ctx) => await runFanOutAndSynthesize(ctx),
});
