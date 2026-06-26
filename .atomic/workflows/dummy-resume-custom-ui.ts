import { workflow, type WorkflowRunContext } from "@bastani/workflows";
import { Type } from "typebox";

async function waitForEnter(label: string, replayIdentity: string, ctx: WorkflowRunContext): Promise<string> {
  return await ctx.ui.custom<string>((tui, _theme, _keybindings, done) => ({
    render: (width: number) => [
      label,
      "",
      "Press enter to checkpoint this custom UI answer.",
      "Press esc to return 'cancelled'.",
    ].map((line) => line.slice(0, width)),
    handleInput: (data: string): void => {
      if (data === "\u001b" || data === "\u0003") {
        done("cancelled");
        return;
      }
      if (data === "\r" || data === "\n") done("entered");
      tui.requestRender?.();
    },
    invalidate: () => tui.requestRender?.(),
  }), { label, replayIdentity });
}

export default workflow({
  name: "dummy-resume-custom-ui",
  description: "Manual durable resume test: custom UI checkpoints before and after a ctx.tool call.",
  inputs: {},
  outputs: {
    first_ui_answer: Type.String(),
    tool_value: Type.String(),
    second_ui_answer: Type.String(),
  },
  run: async (ctx) => {
    const firstAnswer = await waitForEnter(
      "Dummy custom UI checkpoint #1",
      "dummy-resume-custom-ui:first:v1",
      ctx,
    );

    const toolValue = await ctx.tool("dummy-between-custom-ui", { firstAnswer, version: 1 }, async () =>
      `between:${firstAnswer}:${new Date().toISOString()}`,
    );

    const secondAnswer = await waitForEnter(
      "Dummy custom UI checkpoint #2",
      "dummy-resume-custom-ui:second:v1",
      ctx,
    );

    return {
      first_ui_answer: firstAnswer,
      tool_value: toolValue,
      second_ui_answer: secondAnswer,
    };
  },
});
