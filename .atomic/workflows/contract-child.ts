import { defineWorkflow, Type } from "@bastani/workflows";
import type { WorkflowSerializableObject } from "@bastani/workflows";

export default defineWorkflow("contract-child")
  .description("Child workflow for manual nesting validation. Returns declared serializable outputs for a parent workflow to consume.")
  .input("topic", Type.String({ description: "Topic the child workflow summarizes." }))
  .input("multiplier", Type.Number({ default: 1, description: "Finite number used to calculate child score." }))
  .output("result", Type.String({ description: "Child summary string." }))
  .output("metadata", Type.Unsafe<WorkflowSerializableObject>(Type.Object({}, { additionalProperties: true, description: "Structured child metadata." })))
  .output("checklist", Type.Unsafe<readonly WorkflowSerializableObject[]>(Type.Array(Type.Unknown(), { description: "Array output used by the parent nesting example." })))
  .output("score", Type.Number({ description: "Finite numeric child output." }))
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;
    const multiplier = Math.max(1, Math.min(5, Math.floor(ctx.inputs.multiplier)));
    const checklist = [
      { step: "received-topic", ok: topic.trim().length > 0 },
      { step: "validated-multiplier", ok: true, multiplier },
      { step: "returned-json", ok: true },
    ];

    await ctx.stage("child-marker", { noTools: "all" }).prompt(
      [
        `This is the nested child workflow marker stage for topic: ${topic}.`,
        "Reply exactly: CONTRACT_CHILD_STAGE_OK",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    return {
      result: `child processed ${topic} with multiplier ${multiplier}`,
      metadata: {
        topic,
        multiplier,
        topicLength: topic.length,
        generatedBy: "contract-child",
      },
      checklist,
      score: topic.length * multiplier,
    };
  })
  .compile();
