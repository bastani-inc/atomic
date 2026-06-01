import { defineWorkflow } from "@bastani/workflows";
import contractChild from "./contract-child.js";

export default defineWorkflow("contract-parent")
  .description("Manual nesting validation workflow: calls contract-child twice and combines its declared child outputs.")
  .input("topic", {
    type: "text",
    required: true,
    description: "Topic passed into nested child workflows.",
  })
  .input("multiplier", {
    type: "number",
    default: 2,
    description: "Finite number forwarded into the first child workflow.",
  })
  .output("result", {
    type: "text",
    required: true,
    description: "Parent summary string.",
  })
  .output("children", {
    type: "array",
    required: true,
    description: "Declared outputs from nested child workflow calls.",
  })
  .output("combined", {
    type: "object",
    required: true,
    description: "Combined parent object built from child outputs.",
  })
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
