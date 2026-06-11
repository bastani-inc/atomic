import { defineWorkflow, Type } from "@bastani/workflows";
import type { WorkflowSerializableObject } from "@bastani/workflows";
import complexComposed from "./contract-complex-composed.js";

export default defineWorkflow("contract-complex-root")
  .description("Root workflow for complex nested-import validation. Imports a composed workflow that itself imports and calls another workflow.")
  .input("topic", Type.String({ description: "Topic passed into the imported composed workflow." }))
  .input("depth", Type.Number({ default: 2, description: "Tree depth forwarded through the import chain." }))
  .input(
    "variant",
    Type.Union([Type.Literal("alpha"), Type.Literal("beta"), Type.Literal("gamma")], {
      default: "beta",
      description: "Variant forwarded through the import chain.",
    }),
  )
  .input("passes", Type.Number({ default: 2, description: "Number of leaf calls made by the imported composed workflow." }))
  .output("result", Type.String({ description: "Root summary string." }))
  .output(
    "finalReport",
    Type.Object(
      {
        topic: Type.String(),
        rootInputs: Type.Object({
          depth: Type.Number(),
          variant: Type.Union([Type.Literal("alpha"), Type.Literal("beta"), Type.Literal("gamma")]),
          passes: Type.Number(),
        }),
        composedRun: Type.Object({
          workflow: Type.String(),
          runId: Type.String(),
          outputs: Type.Unsafe<WorkflowSerializableObject>(Type.Object({}, { additionalProperties: true })),
        }),
        bundle: Type.Unsafe<WorkflowSerializableObject>(Type.Object({}, { additionalProperties: true })),
        childDigests: Type.Unsafe<readonly WorkflowSerializableObject[]>(Type.Array(Type.Unknown())),
        checks: Type.Object({
          composedWorkflowIsImported: Type.Boolean(),
          composedWorkflowImportedLeafWorkflow: Type.Boolean(),
          allValuesShouldBeJsonSerializable: Type.Boolean(),
        }),
      },
      { description: "Complex root-level report assembled from a nested imported composition." },
    ),
  )
  .output(
    "importChain",
    Type.Array(
      Type.Union([
        Type.Object({ level: Type.Number(), workflow: Type.String(), role: Type.String() }),
        Type.Object({
          level: Type.Number(),
          workflow: Type.String(),
          runId: Type.String(),
          role: Type.String(),
          declaredOutputKeys: Type.Array(Type.String()),
        }),
        Type.Object({
          level: Type.Number(),
          workflow: Type.String(),
          role: Type.String(),
          observedLeafCalls: Type.Number(),
        }),
      ]),
      { description: "Import/call chain represented as serializable objects." },
    ),
  )
  .output("totalScore", Type.Number({ description: "Finite score propagated from nested child outputs." }))
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
    if (composed.exited === true) {
      return ctx.exit({ status: composed.status, reason: composed.exitReason ?? "composed workflow stopped early" });
    }

    await ctx.stage("complex-root-final-marker", { noTools: "all" }).prompt(
      [
        `Complex root marker after composed workflow run: ${composed.runId}`,
        "Reply exactly: CONTRACT_COMPLEX_ROOT_OK",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    // composed.outputs is typed from contract-complex-composed's declared
    // output contract after the exited branch is handled, so these are read directly.
    const totalScore = composed.outputs.totalScore;
    const bundle = composed.outputs.bundle;
    const childDigests = composed.outputs.childDigests;
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
