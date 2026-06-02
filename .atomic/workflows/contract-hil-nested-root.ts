import { defineWorkflow, Type } from "@bastani/workflows";
import type { WorkflowSerializableObject } from "@bastani/workflows";
import hilNestedParent from "./contract-hil-nested-parent.js";

export default defineWorkflow("contract-hil-nested-root")
  .description("Two-level nested HIL workflow: root imports parent, parent imports child. Use to verify one flattened graph with nested HIL prompts.")
  .input("topic", Type.String({ description: "Topic threaded through root -> parent -> child HIL prompts." }))
  .output("result", Type.String())
  .output(
    "rootHil",
    Type.Object({
      topic: Type.String(),
      rootChoice: Type.Union([Type.Literal("ship"), Type.Literal("retry"), Type.Literal("inspect")]),
      observedParentRun: Type.String(),
    }),
  )
  .output(
    "importChain",
    Type.Array(
      Type.Union([
        Type.Object({ level: Type.Number(), workflow: Type.String() }),
        Type.Object({ level: Type.Number(), workflow: Type.String(), runId: Type.String() }),
        Type.Object({ level: Type.Number(), workflow: Type.String(), via: Type.String() }),
      ]),
    ),
  )
  .output(
    "parent",
    Type.Object({
      workflow: Type.String(),
      runId: Type.String(),
      outputs: Type.Unsafe<WorkflowSerializableObject>(Type.Object({}, { additionalProperties: true })),
    }),
  )
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;
    await ctx.stage("root-before-import", { noTools: "all" }).prompt(
      [
        `Root stage before nested HIL import for topic: ${topic}`,
        "Reply exactly: CONTRACT_HIL_NESTED_ROOT_STAGE_OK",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    const parent = await ctx.workflow(hilNestedParent, {
      stageName: "hil-parent:imported-composition",
      inputs: { topic },
    });

    const rootChoice = await ctx.ui.select("Nested root select after parent composition. Pick final routing.", [
      "ship",
      "retry",
      "inspect",
    ] as const);

    return {
      result: `root HIL completed with final route ${rootChoice}`,
      rootHil: {
        topic,
        rootChoice,
        observedParentRun: parent.runId,
      },
      importChain: [
        { level: 0, workflow: "contract-hil-nested-root" },
        { level: 1, workflow: parent.workflow, runId: parent.runId },
        { level: 2, workflow: "contract-hil-nested-child", via: "contract-hil-nested-parent" },
      ],
      parent: {
        workflow: parent.workflow,
        runId: parent.runId,
        outputs: parent.outputs,
      },
    };
  })
  .compile();
