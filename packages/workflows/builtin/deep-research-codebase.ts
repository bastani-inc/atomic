/**
 * Builtin workflow: deep-research-codebase
 *
 * Re-implements the Atomic SDK builtin topology with the pi workflow task
 * primitives: scout + research-history chain, two parallel specialist waves,
 * and a final aggregator. The local SDK does not expose Atomic's Claude-only
 * callback stage API, so the workflow models that design with ctx.task(),
 * ctx.parallel(), and ctx.chain().
 */

import { Type } from "typebox";
import { workflow } from "../src/authoring/workflow.js";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_PARTITIONS,
} from "./deep-research-codebase-utils.js";
import { runDeepResearchCodebase } from "./deep-research-codebase-runner.js";

export default workflow({
  name: "deep-research-codebase",
  description: "Heavy research for tasks requiring comprehensive, whole-repository context.",
  inputs: {
    prompt: Type.String({ description: "Research question or investigation focus for the codebase." }),
    max_partitions: Type.Number({
      default: DEFAULT_MAX_PARTITIONS,
      description:
        "Maximum number of codebase partitions to explore in parallel. Actual partitions scale by one per 10K LoC, capped by this value.",
    }),
    max_concurrency: Type.Number({
      default: DEFAULT_MAX_CONCURRENCY,
      description: "Maximum number of workflow stages to run concurrently during deep research.",
    }),
  },
  outputs: {
    result: Type.Optional(Type.String({ description: "Final Markdown research report text, matching findings." })),
    findings: Type.Optional(Type.String({ description: "Final Markdown research report text." })),
    research_doc_path: Type.Optional(Type.String({ description: "Public report path under research/<date>-<topic>.md." })),
    artifact_dir: Type.Optional(Type.String({ description: "Hidden per-run handoff directory containing deep-research artifacts." })),
    manifest_path: Type.Optional(Type.String({ description: "Manifest JSON path inside the hidden artifact directory." })),
    partitions: Type.Optional(Type.Array(Type.String(), { description: "Codebase partitions the specialists explored." })),
    explorer_count: Type.Optional(Type.Number({ description: "Number of partition explorer groups used." })),
    specialist_count: Type.Optional(Type.Number({ description: "Number of specialist stages run across the research waves." })),
    max_concurrency: Type.Optional(Type.Number({ description: "Concurrency limit used for the run." })),
    history: Type.Optional(Type.String({ description: "Prior-research/history overview included in the final synthesis." })),
  },
  run: async (ctx) => await runDeepResearchCodebase(ctx),
});
