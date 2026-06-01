import { defineWorkflow } from "@bastani/workflows";
import type {
  WorkflowSerializableObject,
  WorkflowSerializableValue,
} from "@bastani/workflows";
import complexComposed from "./contract-complex-composed.js";

const VARIANTS = ["alpha", "beta", "gamma"] as const;

function objectOrEmpty(value: WorkflowSerializableValue | undefined): WorkflowSerializableObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function arrayOrEmpty(value: WorkflowSerializableValue | undefined): readonly WorkflowSerializableValue[] {
  return Array.isArray(value) ? value : [];
}

function numberOrZero(value: WorkflowSerializableValue | undefined): number {
  return typeof value === "number" ? value : 0;
}

export default defineWorkflow("contract-complex-root")
  .description("Root workflow for complex nested-import validation. Imports a composed workflow that itself imports and calls another workflow.")
  .input("topic", {
    type: "text",
    required: true,
    description: "Topic passed into the imported composed workflow.",
  })
  .input("depth", {
    type: "number",
    default: 2,
    description: "Tree depth forwarded through the import chain.",
  })
  .input("variant", {
    type: "select",
    choices: VARIANTS,
    default: "beta",
    description: "Variant forwarded through the import chain.",
  })
  .input("passes", {
    type: "number",
    default: 2,
    description: "Number of leaf calls made by the imported composed workflow.",
  })
  .output("result", {
    type: "text",
    required: true,
    description: "Root summary string.",
  })
  .output("finalReport", {
    type: "object",
    required: true,
    description: "Complex root-level report assembled from a nested imported composition.",
  })
  .output("importChain", {
    type: "array",
    required: true,
    description: "Import/call chain represented as serializable objects.",
  })
  .output("totalScore", {
    type: "number",
    required: true,
    description: "Finite score propagated from nested child outputs.",
  })
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;

    const composed = await ctx.workflow(complexComposed, {
      stageName: "complex-composed:imported-composition",
      inputs: {
        topic,
        depth: ctx.inputs.depth,
        variant: ctx.inputs.variant,
        passes: ctx.inputs.passes,
      },
    });

    await ctx.stage("complex-root-final-marker", { noTools: "all" }).prompt(
      [
        `Complex root marker after composed workflow run: ${composed.runId}`,
        "Reply exactly: CONTRACT_COMPLEX_ROOT_OK",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    const totalScore = numberOrZero(composed.outputs.totalScore);
    const bundle = objectOrEmpty(composed.outputs.bundle);
    const childDigests = arrayOrEmpty(composed.outputs.childDigests);
    const importChain = [
      {
        level: 0,
        workflow: "contract-complex-root",
        role: "manual entrypoint",
      },
      {
        level: 1,
        workflow: composed.workflow,
        runId: composed.runId,
        role: "imported composed workflow",
        declaredOutputKeys: Object.keys(composed.outputs).sort(),
      },
      {
        level: 2,
        workflow: "contract-complex-leaf",
        role: "workflow imported and called by contract-complex-composed",
        observedLeafCalls: childDigests.length,
      },
    ];

    return {
      result: `complex root imported a composed workflow; nested total score ${totalScore}`,
      finalReport: {
        topic,
        rootInputs: {
          depth: ctx.inputs.depth,
          variant: ctx.inputs.variant,
          passes: ctx.inputs.passes,
        },
        composedRun: {
          workflow: composed.workflow,
          runId: composed.runId,
          outputs: composed.outputs,
        },
        bundle,
        childDigests,
        checks: {
          composedWorkflowIsImported: true,
          composedWorkflowImportedLeafWorkflow: true,
          allValuesShouldBeJsonSerializable: true,
        },
      },
      importChain,
      totalScore,
    };
  })
  .compile();
