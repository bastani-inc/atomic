import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

function marker(label: string): string {
  return `${label}:${new Date().toISOString()}`;
}

export default workflow({
  name: "stress-resume-hybrid-fanout",
  description: "Stress durable resume with sequential setup, parallel LM stages, ctx.parallel tasks, and tools.",
  inputs: {},
  outputs: {
    seed_tool: Type.String(),
    left_stage: Type.String(),
    right_stage: Type.String(),
    fanout_tool: Type.String(),
    task_summary: Type.String(),
    final: Type.String(),
  },
  run: async (ctx) => {
    const seedTool = await ctx.tool("stress-hybrid-seed", { version: 1 }, async () => marker("seed"));

    const setup = await ctx.stage("setup").prompt([
      "Hybrid resume stress test setup stage.",
      "Create a two-branch test plan for durable mid-session resume.",
      `Seed tool checkpoint: ${seedTool}`,
    ].join("\n"));

    const [leftStage, rightStage] = await Promise.all([
      ctx.stage("left-lm-branch").prompt([
        "Left LM branch: inspect risks in sequential replay.",
        `Setup: ${setup}`,
      ].join("\n")),
      ctx.stage("right-lm-branch").prompt([
        "Right LM branch: inspect risks in parallel replay.",
        `Setup: ${setup}`,
      ].join("\n")),
    ]);

    const fanoutTool = await ctx.tool("stress-hybrid-after-lm", {
      version: 1,
      leftStage,
      rightStage,
    }, async () => marker("after-lm"));

    const taskResults = await ctx.parallel([
      {
        name: "agent-red-team",
        prompt: `Red-team this resume flow. Left=${leftStage}; Right=${rightStage}; Tool=${fanoutTool}`,
      },
      {
        name: "agent-blue-team",
        prompt: `Defend this resume flow. Left=${leftStage}; Right=${rightStage}; Tool=${fanoutTool}`,
      },
    ], { failFast: false });
    const taskSummary = taskResults.map((result) => result.text).join("\n---\n");

    const final = await ctx.stage("final-fanin").prompt([
      "Final fan-in stage: combine the LM branches and ctx.parallel task results.",
      `Left stage: ${leftStage}`,
      `Right stage: ${rightStage}`,
      `Task summary: ${taskSummary}`,
    ].join("\n"));

    return {
      seed_tool: seedTool,
      left_stage: leftStage,
      right_stage: rightStage,
      fanout_tool: fanoutTool,
      task_summary: taskSummary,
      final,
    };
  },
});
