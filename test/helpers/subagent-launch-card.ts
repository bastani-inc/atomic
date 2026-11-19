import type { TUI } from "@bastani/atomic-tui";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import type { SubagentResultRenderState } from "../../packages/subagents/src/tui/render.js";

export function subagentLaunchCard(
	cwd: string,
	args: SubagentParamsLike,
	host?: AgentTaskHost,
): ToolExecutionComponent {
	initTheme("dark");
	const definition: ToolDefinition<typeof SubagentParams, Details, SubagentResultRenderState> = {
		name: "subagent",
		label: "Subagent",
		description: "Subagent launch card",
		parameters: SubagentParams,
		execute: async () => {
			throw new Error("Rendering must not execute the tool");
		},
		renderCall: (args, theme, context) => renderSubagentToolCall(args as SubagentParamsLike, theme, context),
		renderResult: renderSubagentToolResult,
	};
	return new ToolExecutionComponent(
		"subagent",
		"elapsed-card",
		args,
		{
			getTaskRecord: (id) => host?.taskRecords().find((task) => task.ref.taskId === id),
		},
		definition,
		{ requestRender() {} } as TUI,
		cwd,
	);
}
