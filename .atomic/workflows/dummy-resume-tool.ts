import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

const choices = ["continue", "finish"] as const;

type Choice = typeof choices[number] | "cancelled";

function renderPicker(selected: number, width: number): string[] {
  return [
    "Dummy resume tool test",
    "",
    "A durable ctx.tool checkpoint has already run.",
    "Restart Atomic, run /workflow resume, select this workflow, then press enter.",
    "",
    ...choices.map((choice, index) => `${index === selected ? "›" : " "} ${choice}`),
  ].map((line) => line.slice(0, width));
}

export default workflow({
  name: "dummy-resume-tool",
  description: "Manual durable resume test: ctx.tool runs before a custom UI pause point.",
  inputs: {},
  outputs: {
    before_tool_value: Type.String(),
    choice: Type.String(),
    after_tool_value: Type.String(),
  },
  run: async (ctx) => {
    const beforeTool = await ctx.tool("dummy-before-custom-ui", { version: 1 }, async () =>
      `before:${new Date().toISOString()}`,
    );

    const choice = await ctx.ui.custom<Choice>((tui, _theme, _keybindings, done) => {
      let selected = 0;
      const finish = (value: Choice): void => done(value);
      return {
        render: (width: number) => renderPicker(selected, width),
        handleInput: (data: string): void => {
          if (data === "\u001b" || data === "\u0003") {
            finish("cancelled");
            return;
          }
          if (data === "\r" || data === "\n") {
            finish(choices[selected] ?? "continue");
            return;
          }
          if (data === "\u001b[A" || data === "k") selected = Math.max(0, selected - 1);
          if (data === "\u001b[B" || data === "j") selected = Math.min(choices.length - 1, selected + 1);
          tui.requestRender?.();
        },
        invalidate: () => tui.requestRender?.(),
      };
    }, {
      label: "Dummy resume tool picker",
      replayIdentity: "dummy-resume-tool:v1",
    });

    const afterTool = await ctx.tool("dummy-after-custom-ui", { version: 1, choice }, async () =>
      `after:${choice}:${new Date().toISOString()}`,
    );

    return {
      before_tool_value: beforeTool,
      choice,
      after_tool_value: afterTool,
    };
  },
});
