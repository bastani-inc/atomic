/**
 * Builtin workflow: deep-research-codebase
 *
 * Re-implements the Atomic SDK builtin topology with the pi workflow task
 * primitives: scout + research-history chain, two parallel specialist waves,
 * and a final aggregator. The local SDK does not expose Atomic's Claude-only
 * callback stage API, so the workflow models that design with ctx.task(),
 * ctx.parallel(), and ctx.chain().
 */

import { defineWorkflow } from "../src/workflows/define-workflow.js";
import { Type } from "typebox";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_PARTITIONS,
} from "./deep-research-codebase-utils.js";
import { runDeepResearchCodebase } from "./deep-research-codebase-runner.js";

export default defineWorkflow("deep-research-codebase")
  .description(
    "Scout + research-history chain → parallel specialist waves → aggregator for deep codebase research.",
  )
  .input("prompt", Type.String({ description: "Research question or investigation focus for the codebase." }))
  .input("max_partitions", Type.Number({
    default: DEFAULT_MAX_PARTITIONS,
    description:
      "Maximum number of codebase partitions to explore in parallel. Actual partitions scale by one per 10K LoC, capped by this value.",
  }))
  .input("max_concurrency", Type.Number({
    default: DEFAULT_MAX_CONCURRENCY,
    description: "Maximum number of workflow stages to run concurrently during deep research.",
  }))
  .output("result", Type.Optional(Type.String({ description: "Final Markdown research report text, matching findings." })))
  .output("findings", Type.Optional(Type.String({ description: "Final Markdown research report text." })))
  .output("research_doc_path", Type.Optional(Type.String({ description: "Public report path under research/<date>-<topic>.md." })))
  .output("artifact_dir", Type.Optional(Type.String({ description: "Hidden per-run handoff directory containing deep-research artifacts." })))
  .output("manifest_path", Type.Optional(Type.String({ description: "Manifest JSON path inside the hidden artifact directory." })))
  .output("partitions", Type.Optional(Type.Array(Type.String(), { description: "Codebase partitions the specialists explored." })))
  .output("explorer_count", Type.Optional(Type.Number({ description: "Number of partition explorer groups used." })))
  .output("specialist_count", Type.Optional(Type.Number({ description: "Number of specialist stages run across the research waves." })))
  .output("max_concurrency", Type.Optional(Type.Number({ description: "Concurrency limit used for the run." })))
  .output("history", Type.Optional(Type.String({ description: "Prior-research/history overview included in the final synthesis." })))
  .run(runDeepResearchCodebase)
  .compile();
