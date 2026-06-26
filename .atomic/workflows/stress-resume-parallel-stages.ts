import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

function marker(label: string): string {
  return `${label}:${new Date().toISOString()}`;
}

export default workflow({
  name: "stress-resume-parallel-stages",
  description: "Stress durable resume with three concurrent LM stages plus tool checkpoints before and after.",
  inputs: {},
  outputs: {
    pre_tool: Type.String(),
    alpha: Type.String(),
    beta: Type.String(),
    gamma: Type.String(),
    merge_tool: Type.String(),
    synthesis: Type.String(),
  },
  run: async (ctx) => {
    const preTool = await ctx.tool("stress-parallel-pre", { version: 1 }, async () => marker("pre"));

    const [alpha, beta, gamma] = await Promise.all([
      ctx.stage("parallel-alpha").prompt([
        "Parallel branch alpha.",
        "Summarize the resume lifecycle from the UI perspective.",
        `Pre tool checkpoint: ${preTool}`,
      ].join("\n")),
      ctx.stage("parallel-beta").prompt([
        "Parallel branch beta.",
        "Summarize the resume lifecycle from the durable checkpoint perspective.",
        `Pre tool checkpoint: ${preTool}`,
      ].join("\n")),
      ctx.stage("parallel-gamma").prompt([
        "Parallel branch gamma.",
        "Summarize the resume lifecycle from the stage-session perspective.",
        `Pre tool checkpoint: ${preTool}`,
      ].join("\n")),
    ]);

    const mergeTool = await ctx.tool("stress-parallel-merge", { version: 1, alpha, beta, gamma }, async () =>
      marker("merge"),
    );

    const synthesis = await ctx.stage("synthesis").prompt([
      "Synthesize the three parallel branches into a final checklist.",
      `Alpha: ${alpha}`,
      `Beta: ${beta}`,
      `Gamma: ${gamma}`,
      `Merge tool checkpoint: ${mergeTool}`,
    ].join("\n"));

    return {
      pre_tool: preTool,
      alpha,
      beta,
      gamma,
      merge_tool: mergeTool,
      synthesis,
    };
  },
});
