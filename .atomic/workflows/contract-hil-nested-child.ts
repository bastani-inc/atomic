import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("contract-hil-nested-child")
  .description("Nested HIL child workflow. Used by one-level and two-level nesting manual tests.")
  .input("topic", { type: "text", required: true })
  .input("depth_label", { type: "text", default: "child" })
  .output("result", { type: "text", required: true })
  .output("childHil", { type: "object", required: true })
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;
    const depthLabel = ctx.inputs.depth_label;
    await ctx.stage("nested-child-marker", { noTools: "all" }).prompt(
      [
        `Nested child marker for ${topic} (${depthLabel})`,
        "Reply exactly: CONTRACT_HIL_NESTED_CHILD_STAGE_OK",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    const childNote = await ctx.ui.input(`Nested child input for ${topic}. Type a child note.`);
    const childChoice = await ctx.ui.select("Nested child select. Pick a child branch.", [
      "child-a",
      "child-b",
    ] as const);

    return {
      result: `child HIL ${childChoice}: ${childNote}`,
      childHil: {
        topic,
        depthLabel,
        childNote,
        childChoice,
        lengths: [topic.length, childNote.length],
        nullable: null,
      },
    };
  })
  .compile();
