import { defineWorkflow, Type } from "@bastani/workflows";
import type { WorkflowSerializableObject } from "@bastani/workflows";
import hilNestedChild from "./contract-hil-nested-child.js";

export default defineWorkflow("contract-hil-nested-parent")
  .description("Nested HIL parent workflow. Imports the HIL child, then asks its own HIL confirm/editor prompts.")
  .input("topic", Type.String())
  .output("result", Type.String())
  .output("parentHil", Type.Unsafe<WorkflowSerializableObject>(Type.Object({}, { additionalProperties: true })))
  .output("child", Type.Unsafe<WorkflowSerializableObject>(Type.Object({}, { additionalProperties: true })))
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;
    const child = await ctx.workflow(hilNestedChild, {
      stageName: "hil-child:imported",
      inputs: {
        topic,
        depth_label: "parent->child",
      },
    });

    const parentConfirmed = await ctx.ui.confirm(
      `Nested parent confirm after child run ${child.runId.slice(0, 8)}. Continue?`,
    );
    const parentEdit = await ctx.ui.editor(JSON.stringify({
      topic,
      childOutputs: child.outputs,
      parentConfirmed,
    }, null, 2));

    return {
      result: `parent HIL completed after ${child.outputs.result}`,
      parentHil: {
        topic,
        parentConfirmed,
        parentEditLength: parentEdit.length,
        parentEditPreview: parentEdit.slice(0, 100),
      },
      child: {
        workflow: child.workflow,
        runId: child.runId,
        outputs: child.outputs,
      },
    };
  })
  .compile();
