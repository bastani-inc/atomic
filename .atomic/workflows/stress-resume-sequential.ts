import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

function marker(label: string): string {
  return `${label}:${new Date().toISOString()}`;
}

export default workflow({
  name: "stress-resume-sequential",
  description: "Stress durable resume with sequential LM stages and tool checkpoints between them.",
  inputs: {},
  outputs: {
    boot_tool: Type.String(),
    plan: Type.String(),
    mid_tool: Type.String(),
    build: Type.String(),
    final_tool: Type.String(),
    review: Type.String(),
  },
  run: async (ctx) => {
    const bootTool = await ctx.tool("stress-sequential-boot", { version: 1 }, async () => marker("boot"));

    const plan = await ctx.stage("plan").prompt([
      "Stress test sequential durable resume.",
      "Stage 1: produce a compact plan with three bullets.",
      `Boot tool checkpoint: ${bootTool}`,
    ].join("\n"));

    const midTool = await ctx.tool("stress-sequential-mid", { version: 1, plan }, async () => marker("mid"));

    const build = await ctx.stage("build").prompt([
      "Stage 2: turn the plan into implementation notes.",
      `Plan: ${plan}`,
      `Mid tool checkpoint: ${midTool}`,
    ].join("\n"));

    const finalTool = await ctx.tool("stress-sequential-final", { version: 1, build }, async () => marker("final"));

    const review = await ctx.stage("review").prompt([
      "Stage 3: review the implementation notes for resume correctness.",
      `Build notes: ${build}`,
      `Final tool checkpoint: ${finalTool}`,
    ].join("\n"));

    return {
      boot_tool: bootTool,
      plan,
      mid_tool: midTool,
      build,
      final_tool: finalTool,
      review,
    };
  },
});
