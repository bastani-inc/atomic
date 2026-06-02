import { defineWorkflow, Type } from "@bastani/workflows";
import type { WorkflowSerializableObject } from "@bastani/workflows";
import contractChild from "./contract-child.js";

export default defineWorkflow("contract-parent")
  .description("Manual nesting validation workflow: calls contract-child twice and combines its declared child outputs.")
  .input("topic", Type.String({ description: "Topic passed into nested child workflows." }))
  .input("multiplier", Type.Number({ default: 2, description: "Finite number forwarded into the first child workflow." }))
  .output("result", Type.String({ description: "Parent summary string." }))
  .output(
    "children",
    Type.Array(
      Type.Object({
        workflow: Type.String(),
        runId: Type.String(),
        outputs: Type.Unsafe<WorkflowSerializableObject>(Type.Object({}, { additionalProperties: true })),
      }),
      { description: "Declared outputs from nested child workflow calls." },
    ),
  )
  .output(
    "combined",
    Type.Object(
      {
        topic: Type.String(),
        multiplier: Type.Number(),
        firstResult: Type.String(),
        secondResult: Type.String(),
        combinedScore: Type.Number(),
        parentSawOnlyDeclaredOutputs: Type.Array(Type.String()),
      },
      { description: "Combined parent object built from child outputs." },
    ),
  )
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;
    const multiplier = Math.max(1, Math.min(5, Math.floor(ctx.inputs.multiplier)));

    const first = await ctx.workflow(contractChild, {
      stageName: "child:first-pass",
      inputs: {
        topic,
        multiplier,
      },
    });

    const second = await ctx.workflow(contractChild, {
      stageName: "child:follow-up",
      inputs: {
        topic: `${topic} follow-up`,
        multiplier: multiplier + 1,
      },
    });

    const firstScore = first.outputs.score;
    const secondScore = second.outputs.score;
    const combinedScore =
      typeof firstScore === "number" && typeof secondScore === "number"
        ? firstScore + secondScore
        : 0;

    const children = [
      {
        workflow: first.workflow,
        runId: first.runId,
        outputs: first.outputs,
      },
      {
        workflow: second.workflow,
        runId: second.runId,
        outputs: second.outputs,
      },
    ];

    return {
      result: `contract-parent nested ${children.length} child runs; combined score ${combinedScore}`,
      children,
      combined: {
        topic,
        multiplier,
        firstResult: first.outputs.result,
        secondResult: second.outputs.result,
        combinedScore,
        parentSawOnlyDeclaredOutputs: Object.keys(first.outputs).sort(),
      },
    };
  })
  .compile();
