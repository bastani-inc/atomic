import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

const fixtureOutputs = {
  result: Type.String(),
  status: Type.Literal("completed"),
  answers: Type.Array(Type.String()),
};

function record(root: string, label: string, event: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, `${label}.events.jsonl`);
  appendFileSync(path, `${JSON.stringify({ event, timestamp: Date.now() })}\n`);
  return path;
}

const nestedPromptChild = workflow({
  name: "workflow-resume-e2e-nested-child",
  description: "Nested child used only by the workflow-resume E2E fixture.",
  inputs: {
    marker_root: Type.String(),
    label: Type.String(),
  },
  outputs: fixtureOutputs,
  run: async (ctx) => {
    await ctx.tool("nested-before-prompt", { label: ctx.inputs.label }, async () =>
      record(ctx.inputs.marker_root, ctx.inputs.label, "nested-before-prompt"));
    const answer = await ctx.ui.input(`E2E nested answer for ${ctx.inputs.label}`);
    await ctx.tool("nested-after-prompt", { answer, label: ctx.inputs.label }, async () =>
      record(ctx.inputs.marker_root, ctx.inputs.label, `nested-after:${answer}`));
    return { result: `nested:${answer}`, status: "completed" as const, answers: [answer] };
  },
});

export default workflow({
  name: "workflow-resume-e2e-fixture",
  description: "Durable checkpoint, prompt, failure, completion, and nested-child fixture for real /workflow resume QA.",
  inputs: {
    mode: Type.Union([
      Type.Literal("prompt"),
      Type.Literal("double-prompt"),
      Type.Literal("fail-once"),
      Type.Literal("completed"),
      Type.Literal("nested"),
    ]),
    marker_root: Type.String(),
    label: Type.String(),
  },
  outputs: fixtureOutputs,
  run: async (ctx) => {
    const { label, marker_root: markerRoot, mode } = ctx.inputs;
    const answers: string[] = [];

    await ctx.tool("checkpoint-before", { label, mode }, async () =>
      record(markerRoot, label, "checkpoint-before"));

    if (mode === "completed") {
      await ctx.tool("checkpoint-completed", { label }, async () =>
        record(markerRoot, label, "checkpoint-completed"));
      return { result: `completed:${label}`, status: "completed" as const, answers };
    }

    if (mode === "fail-once") {
      const sentinel = join(markerRoot, `${label}.fail-once-sentinel`);
      await ctx.tool("fail-exactly-once", { label }, async () => {
        mkdirSync(markerRoot, { recursive: true });
        if (!existsSync(sentinel)) {
          writeFileSync(sentinel, "first-attempt-failed\n");
          record(markerRoot, label, "intentional-first-failure");
          throw new Error(`E2E intentional recoverable failure: ${label}`);
        }
        return record(markerRoot, label, "recovered-after-failure");
      });
      await ctx.stage("recoverable-proof").complete(`recovered:${label}`);
    } else if (mode === "nested") {
      const child = await ctx.workflow(nestedPromptChild, {
        stageName: "nested-resume-prompt",
        inputs: { marker_root: markerRoot, label },
      });
      answers.push(...child.outputs.answers);
    } else {
      const first = await ctx.ui.input(`E2E first answer for ${label}`);
      answers.push(first);
      await ctx.tool("checkpoint-after-first-answer", { first, label }, async () =>
        record(markerRoot, label, `first-answer:${first}`));
      if (mode === "double-prompt") {
        const second = await ctx.ui.input(`E2E second answer for ${label}`);
        answers.push(second);
        await ctx.tool("checkpoint-after-second-answer", { label, second }, async () =>
          record(markerRoot, label, `second-answer:${second}`));
      }
    }

    await ctx.tool("checkpoint-final", { answers, label, mode }, async () =>
      record(markerRoot, label, `final:${answers.join("|")}`));
    return { result: `${mode}:${label}:${answers.join("|")}`, status: "completed" as const, answers };
  },
});
